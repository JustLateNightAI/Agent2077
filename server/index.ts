import express from "express";
import http from "http";
import https from "https";
import cookieParser from "cookie-parser";
import cors from "cors";
import { fileURLToPath } from "url";
import fs from "fs";
import os from "os";
import path from "path";
import { registerRoutes } from "./routes.js";
import { serveStatic } from "./static.js";
import { initFTS, runMigrations, initNewTables, bootstrapSchema } from "./db.js";
import { userStore, settingsStore, projectStore, conversationStore, getProjectsRoot } from "./storage.js";
import { isTlsEnabled, ensureCerts } from "./lib/tls-cert.js";
import { dockerManager } from "./docker/manager.js";
import { installLogCapture } from "./lib/log-buffer.js";
import { connectAllEnabledMcpServers } from "./lib/mcp-client.js";
import { startScheduler } from "./lib/background-tasks.js";
import { setupTerminalWs } from "./lib/terminal-ws.js";

// Install log capture EARLY so all console output is captured
installLogCapture();

// Import tools to register them
import "./tools/web-search.js";
import "./tools/code-execution.js";
import "./tools/file-tools.js";
import "./tools/memory-tools.js";
import "./tools/app-deploy.js";
import "./tools/edit-file.js";
import "./tools/read-project.js";
import "./tools/sub-agent.js";
import "./tools/project-tools.js";
import "./tools/git-tools.js";
import "./tools/browser-tools.js";
import "./tools/codebase-tools.js";
import "./tools/propose-edit.js";
import "./tools/self-dev-tools.js";
import "./tools/image-tools.js";
import "./tools/mask-tools.js";
import "./tools/session-search-tools.js";
import "./tools/skill-tools.js";
import "./tools/ssh-tools.js";
import "./tools/tool-discovery.js";

/**
 * Walk ~/projects and register any subdirectories that aren't already
 * tracked in the DB. Runs once on startup so existing project folders
 * survive version upgrades and fresh installs.
 */
async function scanAndRegisterProjects(): Promise<void> {
  const projectsRoot = getProjectsRoot();
  if (!fs.existsSync(projectsRoot)) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return;
  }

  const existingProjects = projectStore.getAll();
  const trackedPaths = new Set(existingProjects.map(p => p.path));

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(projectsRoot, entry.name);
    if (trackedPaths.has(fullPath)) continue;

    // Not tracked — register it
    try {
      const name = entry.name
        .split("-")
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");

      const conv = conversationStore.create({
        title: `[Project] ${name}`,
        systemPrompt: `(placeholder)`,
      });

      const project = projectStore.create({
        name,
        description: `Auto-discovered from ${fullPath}`,
        path: fullPath,
        language: null,
        conversationId: conv.id,
        status: "active",
      });

      // Update conversation system prompt with real project ID
      conversationStore.update(conv.id, {
        systemPrompt:
          `## CRITICAL — PROJECT CONTEXT\n` +
          `You are working inside the project "${name}" (projectId: ${project.id}).\n` +
          `The project is located at: ${fullPath}\n\n` +
          `## MANDATORY TOOL USAGE\n` +
          `You MUST use these project-specific tools (with projectId: ${project.id}):\n` +
          `- write_project_file(projectId: ${project.id}, filePath: "relative/path", content: "...")\n` +
          `- read_project_file(projectId: ${project.id}, filePath: "relative/path")\n` +
          `- edit_project_file(projectId: ${project.id}, filePath: "relative/path", oldText: "...", newText: "...")\n` +
          `- list_project_files(projectId: ${project.id})\n` +
          `- run_project_command(projectId: ${project.id}, command: "...")\n\n` +
          `Do NOT use write_file or read_file — those write to the wrong directory.`,
      });

      console.log(`[Startup] Auto-registered project: ${name} at ${fullPath}`);
    } catch (err: any) {
      console.warn(`[Startup] Failed to register ${fullPath}:`, err.message);
    }
  }
}

const app = express();

app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
app.use(cors({ origin: true, credentials: true }));

// Request logging in dev
if (process.env.NODE_ENV === "development") {
  app.use((req, res, next) => {
    if (req.path.startsWith("/api")) {
      console.log(`${req.method} ${req.path}`);
    }
    next();
  });
}

// Server instance — set after init() determines HTTP vs HTTPS
let server: http.Server | https.Server;

// ── Initialize systems ──────────────────────────────────────────────
async function init() {
  console.log("┌─────────────────────────────────────┐");
  console.log("│         AGENT2077 Starting...        │");
  console.log("└─────────────────────────────────────┘");

  // Bootstrap base schema (CREATE TABLE IF NOT EXISTS) — safe on both fresh installs and existing DBs
  try { bootstrapSchema(); } catch (err) { console.warn("[Init] Bootstrap schema:", err); }

  // Run schema migrations for new columns
  try { runMigrations(); } catch (err) { console.warn("[Init] Migration:", err); }

  // Initialize FTS5 for memory search
  try { initFTS(); } catch (err) { console.warn("[Init] FTS5 init:", err); }

  // Initialize new feature tables (chat_groups, projects)
  try { initNewTables(); } catch (err) { console.warn("[Init] New tables init:", err); }

  // Scan ~/projects and register any untracked folders
  await scanAndRegisterProjects();

  // Ensure default user exists
  userStore.ensureDefaultUser();

  // Initialize default settings
  settingsStore.initDefaults();

  // Initialize Docker manager
  await dockerManager.init();

  // Register API routes on a temporary http server — WebSocket handlers will be
  // re-attached to the final server (http or https) at the bottom of init()
  const tempServer = http.createServer(app);
  registerRoutes(tempServer, app);

  // Connect enabled MCP servers
  connectAllEnabledMcpServers().catch(err => console.warn("[Init] MCP auto-connect:", err));

  // Start background task scheduler
  startScheduler();

  // WebSocket terminal is set up on the FINAL server at the end of init(),
  // after we know whether to use HTTP or HTTPS. See the listen() block below.

  // ── Fix 6: Bind to localhost by default; opt-in to LAN via settings ──────────
  const PORT = parseInt(process.env.PORT || "5000");
  const lanServing = settingsStore.get("network.lanServing") === "true";
  const listenFlag = process.argv.includes("--listen");
  // --listen flag or LAN serving setting both bind to all interfaces
  // HOST env var always wins over everything
  const HOST = process.env.HOST ?? (lanServing || listenFlag ? "0.0.0.0" : "127.0.0.1");

  // ── Fix 5: Auth validation — warn if still using default password ─────────
  if (!process.env.JWT_SECRET) {
    console.warn("⚠  [Agent2077] JWT_SECRET env var not set — using default secret. Set JWT_SECRET for better security.");
  }
  const defaultUser = userStore.getByUsername("Agent2077");
  if (defaultUser && userStore.verifyPassword(defaultUser, "Agent2077")) {
    console.warn("⚠  [Agent2077] Default password in use (Agent2077/Agent2077). Change it in Settings → Security before exposing to a network.");
  }

  // ── Fix 4: HTTPS/TLS — generate self-signed cert on first run ────────────
  const useTls = isTlsEnabled(settingsStore);
  const protocol = useTls ? "https" : "http";

  if (useTls) {
    try {
      const certs = ensureCerts();
      server = https.createServer({ key: certs.key, cert: certs.cert }, app);
      console.log("[Agent2077] HTTPS/TLS enabled with self-signed certificate");
    } catch (err: any) {
      console.error("[Agent2077] Failed to enable HTTPS, falling back to HTTP:", err.message);
      server = http.createServer(app);
    }
  } else {
    server = http.createServer(app);
  }

  // Attach WebSocket terminal handler to the final server
  setupTerminalWs(server);

  // Setup frontend serving (must come after server is created)
  if (process.env.NODE_ENV === "development") {
    const { setupVite } = await import("./vite.js");
    await setupVite(server, app);
  } else {
    serveStatic(app);
  }

  server.listen(PORT, HOST, () => {
    const bindDisplay = HOST === "127.0.0.1" ? "localhost only" : "all interfaces (LAN)";
    console.log(`\n[Agent2077] Server running on ${protocol}://${HOST}:${PORT} (${bindDisplay})`);
    if (HOST === "127.0.0.1") {
      console.log(`[Agent2077] LAN access is disabled. Enable it in Settings → Network → LAN Serving.`);
    } else {
      console.log(`[Agent2077] LAN access: ${protocol}://Agent2077.local:${PORT} (requires Avahi)`);
    }
    console.log(`[Agent2077] Dev server alias: http://devagent.local (port 5050, when running)`);
    console.log(`[Agent2077] Docker: ${dockerManager.isReady() ? "✓ connected" : "✗ unavailable"}`);
    if (useTls) {
      console.log(`[Agent2077] HTTPS enabled — accept the browser security warning (self-signed cert) or add to trusted store`);
    }
    console.log(`[Agent2077] Default login: Agent2077 / Agent2077\n`);
  });
}

init().catch(err => {
  console.error("[Agent2077] Fatal error during startup:", err);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGTERM", () => { console.log("[Agent2077] Shutting down..."); process.exit(0); });
process.on("SIGINT", () => { console.log("[Agent2077] Shutting down..."); process.exit(0); });
process.on("unhandledRejection", (err) => { console.error("[Agent2077] Unhandled rejection:", err); });
process.on("uncaughtException", (err) => { console.error("[Agent2077] Uncaught exception:", err); });
