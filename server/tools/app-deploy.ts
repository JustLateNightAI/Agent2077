/**
 * App Deployment Tool — Deploys web apps to the Agent2077 App Store
 * Creates Docker containers from source files and registers them
 */
import { registerTool, type ToolResult, type ToolContext } from "./registry.js";
import { dockerManager } from "../docker/manager.js";
import { appStore, settingsStore } from "../storage.js";
import { registerAppPort } from "../lib/nginx-apps.js";
import path from "path";
import fs from "fs";
import os from "os";

/**
 * Resolve the hostname that apps should be advertised on.
 *
 * Priority:
 *  1. Explicit setting: "network.appHostname" (user-configurable)
 *  2. The mDNS hostname this server is reachable on (agent2077.local if avahi
 *     or Bonjour is active; falls back to the machine hostname + ".local")
 *  3. The primary LAN IP address
 *  4. "localhost" as last resort
 *
 * This ensures app URLs shown in the App Store and tool output are reachable
 * from any device on the local network, not just from the server itself.
 */
function getAgentHostname(): string {
  // 1. Explicit override in settings
  const override = settingsStore.get("network.appHostname");
  if (override && override.trim()) return override.trim();

  // 2. Try the mDNS hostname: <hostname>.local
  //    This works when avahi (Linux) or Bonjour (macOS/Windows) is running,
  //    which is exactly the setup that makes "agent2077.local" work.
  try {
    const mdnsHost = os.hostname().replace(/\.local$/, "") + ".local";
    return mdnsHost;
  } catch { /* fall through */ }

  // 3. Primary LAN IP — iterate network interfaces, pick first non-loopback IPv4
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      const addrs = ifaces[name] || [];
      for (const addr of addrs) {
        if (addr.family === "IPv4" && !addr.internal) {
          return addr.address;
        }
      }
    }
  } catch { /* fall through */ }

  return "localhost";
}

const WORKSPACE_DIR = path.join(process.cwd(), "workspace");
const APPS_DIR = path.join(WORKSPACE_DIR, "apps");

/**
 * Generate a Dockerfile for a static HTML/JS/CSS app served by nginx.
 * Port is always 80 inside the container.
 */
function staticDockerfile(): string {
  return [
    "FROM nginx:alpine",
    "COPY . /usr/share/nginx/html/",
    "EXPOSE 80",
    'CMD ["nginx", "-g", "daemon off;"]',
  ].join("\n");
}

/**
 * Generate a Dockerfile for a Node.js app.
 * Handles both with-package.json and bare-script cases cleanly.
 * Port must match what the app actually listens on.
 */
function nodeDockerfile(entryFile: string, port: number, hasPackageJson: boolean): string {
  const lines = [
    "FROM node:22-slim",
    "WORKDIR /app",
  ];
  if (hasPackageJson) {
    lines.push("COPY package*.json ./");
    lines.push("RUN npm install --production"); // no || true — fail loudly if deps missing
  }
  lines.push("COPY . .");
  lines.push(`EXPOSE ${port}`);
  lines.push(`CMD ["node", "${entryFile}"]`);
  return lines.join("\n");
}

/**
 * Generate a Dockerfile for a Python app.
 * Port must match what the app actually listens on.
 */
function pythonDockerfile(entryFile: string, port: number, hasRequirements: boolean): string {
  const lines = [
    "FROM python:3.12-slim",
    "WORKDIR /app",
  ];
  if (hasRequirements) {
    lines.push("COPY requirements.txt ./");
    lines.push("RUN pip install --no-cache-dir -r requirements.txt"); // fail loudly
  }
  lines.push("COPY . .");
  lines.push(`EXPOSE ${port}`);
  lines.push(`CMD ["python", "${entryFile}"]`);
  return lines.join("\n");
}

/**
 * Inspect a build directory and auto-detect the best app type + port.
 * Used when the agent specifies type='static' but the directory has a server file,
 * or to resolve the correct internal port without requiring the model to specify it.
 */
function detectAppConfig(dir: string, declaredType: string, declaredEntry?: string, declaredPort?: number): {
  type: string;
  entryFile: string;
  internalPort: number;
  hasPackageJson: boolean;
  hasRequirements: boolean;
} {
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const hasIndexHtml    = entries.includes("index.html");
  const hasServerJs     = entries.includes("server.js")  || entries.includes("index.js") || entries.includes("app.js");
  const hasPackageJson  = entries.includes("package.json");
  const hasRequirements = entries.includes("requirements.txt");
  const hasAppPy        = entries.includes("app.py") || entries.includes("main.py");

  let type = declaredType;

  // Auto-promote: if declared static but directory has no index.html and has server.js → node
  if (type === "static" && !hasIndexHtml && hasServerJs) {
    type = "node";
  }
  // Auto-detect: if declared node but directory only has index.html → static
  if (type === "node" && !hasServerJs && hasIndexHtml) {
    type = "static";
  }

  if (type === "static") {
    return { type: "static", entryFile: "index.html", internalPort: 80, hasPackageJson: false, hasRequirements: false };
  }

  if (type === "python") {
    const entry = declaredEntry || (entries.includes("app.py") ? "app.py" : "main.py");
    const port  = declaredPort || 8080;
    return { type: "python", entryFile: entry, internalPort: port, hasPackageJson: false, hasRequirements };
  }

  // node (default)
  const candidateEntries = ["server.js", "index.js", "app.js", "main.js"];
  const foundEntry = candidateEntries.find(e => entries.includes(e));
  const entry = declaredEntry || foundEntry || "server.js";
  const port  = declaredPort || 8080;
  return { type: "node", entryFile: entry, internalPort: port, hasPackageJson, hasRequirements: false };
}

registerTool("deploy_app", {
  category: "docker",
  requiresApproval: true, // ALWAYS confirm with user before deploying
  definition: {
    type: "function",
    function: {
      name: "deploy_app",
      description:
        "Deploy a web application to the Agent2077 App Store. ONLY use this when the user EXPLICITLY asks you to build, create, or deploy an app/game/tool. Do NOT call this tool unless the user's message specifically requests an app. This is NOT for generating images, answering questions, writing code snippets, or any other task. When building apps, aim for professional production quality — clean UI, proper error handling, responsive design, no placeholder content.\n\nPREFERRED WORKFLOW: Write all app files to the workspace first using write_file (e.g. write to /apps/my-app/index.html, /apps/my-app/style.css, etc.), then call deploy_app with sourcePath pointing to that directory. This avoids JSON size limits. Only use the inline 'files' parameter for very small single-file apps.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Display name for the app (e.g., 'AgentPaint', 'Calculator', 'Snake Game')",
          },
          description: {
            type: "string",
            description: "Short description of what the app does (max 120 characters)",
            maxLength: 120,
          },
          category: {
            type: "string",
            enum: ["tool", "game", "web", "utility", "media"],
            description: "App category for the store",
          },
          type: {
            type: "string",
            enum: ["static", "node", "python", "custom"],
            description:
              "App type: 'static' for HTML/JS/CSS, 'node' for Node.js, 'python' for Python, 'custom' for a provided Dockerfile",
          },
          sourcePath: {
            type: "string",
            description:
              "PREFERRED: Workspace-relative path to a directory containing the app files you already wrote with write_file. Example: 'apps/todo-app'. The directory must already exist and contain the app files. Use this instead of 'files' for any app with more than one file or significant code.",
          },
          files: {
            type: "object",
            description:
              "Inline file contents as an object mapping paths to content. Only use for very small single-file apps. For anything larger, write files with write_file first and use sourcePath instead to avoid JSON truncation errors.",
          },
          icon: {
            type: "string",
            description: "Emoji icon for the app (default: 📦)",
          },
          entryFile: {
            type: "string",
            description:
              "Main entry file (default: 'index.html' for static, 'server.js' for node, 'app.py' for python)",
          },
          dockerfile: {
            type: "string",
            description: "Custom Dockerfile contents (only for type='custom')",
          },
          internalPort: {
            type: "number",
            description: "Port the app listens on inside the container (default: 80 for static, 8080 for node/python)",
          },
        },
        required: ["name", "description", "type"],
      },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const {
      name,
      category = "tool",
      type,
      files,
      sourcePath,
      icon = "📦",
      entryFile,
      dockerfile: customDockerfile,
      internalPort: customPort,
    } = args;
    // Clamp description to 120 chars in case the model over-generated
    const description: string = typeof args.description === "string"
      ? args.description.slice(0, 120)
      : String(args.description || "").slice(0, 120);

    // Validate: need either files or sourcePath
    if (!files && !sourcePath) {
      return {
        success: false,
        output: `deploy_app requires either 'files' (inline content) or 'sourcePath' (workspace directory path).\n` +
          `PREFERRED: Write your app files to the workspace first using write_file, then call deploy_app with sourcePath.\n` +
          `Example: write files to 'apps/${name?.toLowerCase().replace(/[^a-z0-9]/g, '-') || 'my-app'}/' then set sourcePath to that path.`,
      };
    }

    // Resolve sourcePath to an absolute path if provided
    let resolvedSourcePath: string | null = null;
    if (sourcePath) {
      const WORKSPACE_ROOT = path.join(process.cwd(), "workspace");
      // Strip leading slash if provided
      const cleanedPath = String(sourcePath).replace(/^\/+/, "");
      resolvedSourcePath = path.resolve(WORKSPACE_ROOT, cleanedPath);
      // Safety: must stay inside workspace
      if (!resolvedSourcePath.startsWith(WORKSPACE_ROOT)) {
        return { success: false, output: `sourcePath '${sourcePath}' is outside the workspace directory.` };
      }
      if (!fs.existsSync(resolvedSourcePath)) {
        return { success: false, output: `sourcePath '${sourcePath}' does not exist. Write your app files there first using write_file.` };
      }
      if (!fs.statSync(resolvedSourcePath).isDirectory()) {
        return { success: false, output: `sourcePath '${sourcePath}' is a file, not a directory. Point it at the folder containing your app files.` };
      }
    }

    // Check Docker is available
    if (!dockerManager.isReady()) {
      return {
        success: false,
        output:
          "Docker is not available, so apps cannot be deployed. This usually means the Docker daemon " +
          "is not running, or the Agent2077 process user lacks permission to access the Docker socket " +
          "(/var/run/docker.sock). Do NOT attempt to start Docker or change permissions from here — " +
          "ask the user to ensure Docker is running and that the Agent2077 user is in the 'docker' group " +
          "(e.g. they can run `sudo systemctl start docker` and `sudo usermod -aG docker $USER` themselves, " +
          "then restart Agent2077). Once Docker is reachable, retry the deployment.",
      };
    }

    let app: any = null;

    try {
      // 1. For custom type, require a dockerfile upfront before touching the FS
      if (type === "custom" && !customDockerfile) {
        return { success: false, output: "type='custom' requires a 'dockerfile' parameter." };
      }

      // Dockerfile content is determined after we know the build directory
      // (detectAppConfig inspects the actual files on disk). Declare here,
      // assign after files are in place in step 4.
      let dockerfileContent: string;
      let defaultPort: number;  // resolved after detection

      // 2. Check if an app with this name already exists — UPDATE instead of duplicate
      const existing = appStore.getByName(name);
      let isUpdate = false;
      let oldVersion = 0;

      if (existing) {
        isUpdate = true;
        oldVersion = (existing as any).version || 1;
        const newVersion = oldVersion + 1;

        // Backup the current build directory (keep up to 3 versions)
        const currentBuildDir = path.join(APPS_DIR, `app-${existing.id}`);
        const backupDir = path.join(APPS_DIR, `app-${existing.id}-v${oldVersion}`);
        if (fs.existsSync(currentBuildDir)) {
          // Copy current to versioned backup
          try {
            if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
            fs.cpSync(currentBuildDir, backupDir, { recursive: true });
            console.log(`[AppDeploy] Backed up v${oldVersion} to ${backupDir}`);
          } catch (err: any) {
            console.warn(`[AppDeploy] Failed to backup v${oldVersion}:`, err.message);
          }

          // Prune old backups — keep only the last 3 versions
          for (let v = oldVersion - 3; v >= 1; v--) {
            const oldBackup = path.join(APPS_DIR, `app-${existing.id}-v${v}`);
            if (fs.existsSync(oldBackup)) {
              try {
                fs.rmSync(oldBackup, { recursive: true, force: true });
                console.log(`[AppDeploy] Pruned old backup v${v}`);
              } catch { /* best effort */ }
            }
          }
        }

        // Update the existing app record
        appStore.update(existing.id, {
          description,
          category,
          dockerfile: dockerfileContent,
          iconEmoji: icon,
          status: "building",
          version: newVersion as any,
          createdByConversation: context.conversationId,
        });

        app = appStore.getById(existing.id);
        console.log(`[AppDeploy] Updating existing app "${name}" (id=${existing.id}) to v${newVersion}`);
      } else {
        // 3a. Get next available port
        const hostPort = appStore.getNextPort();

        // 3b. Register new app in the database
        app = appStore.create({
          name,
          description,
          category,
          imageName: `agent2077-app-${name.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
          port: hostPort,
          internalPort: 80,         // placeholder — overwritten after file detection in step 5a
          status: "building",
          dockerfile: "",            // placeholder — overwritten after file detection in step 5a
          iconEmoji: icon,
          createdByConversation: context.conversationId,
        });
        console.log(`[AppDeploy] Creating new app "${name}" (id=${app.id})`);
      }

      const hostPort = app.port;

      // 4. Write files to build directory (overwrites existing on update)
      const buildDir = path.join(APPS_DIR, `app-${app.id}`);
      // Clear old files on update to avoid stale files from previous version
      if (isUpdate && fs.existsSync(buildDir)) {
        const oldFiles = fs.readdirSync(buildDir);
        for (const f of oldFiles) {
          fs.rmSync(path.join(buildDir, f), { recursive: true, force: true });
        }
      }
      if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });

      if (resolvedSourcePath) {
        // sourcePath mode: copy all files from the workspace directory into the build dir
        const { execSync: cpSync } = await import("child_process");
        try {
          cpSync(
            `cp -a ${JSON.stringify(resolvedSourcePath + "/")}. ${JSON.stringify(buildDir + "/")}`,
            { stdio: "pipe" }
          );
          console.log(`[AppDeploy] Copied source from ${resolvedSourcePath} → ${buildDir}`);
        } catch (cpErr: any) {
          // fallback to rsync
          try {
            cpSync(
              `rsync -a --exclude=node_modules --exclude=.git ${JSON.stringify(resolvedSourcePath + "/")} ${JSON.stringify(buildDir + "/")}`,
              { stdio: "pipe" }
            );
          } catch {
            return { success: false, output: `Failed to copy source files from '${sourcePath}' to build directory: ${cpErr.message}` };
          }
        }
      } else if (files && typeof files === "object") {
        // Inline files mode: write each file from the args object
        for (const [filePath, content] of Object.entries(files)) {
          const fullPath = path.join(buildDir, filePath);
          const dir = path.dirname(fullPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(fullPath, content as string);
        }
      }

      // 5a. Detect app config from actual files on disk — this is the source of truth.
      //     We do this AFTER files are written so detectAppConfig can inspect them.
      if (type === "custom") {
        dockerfileContent = customDockerfile!;
        defaultPort = customPort || 8080;
      } else {
        const detected = detectAppConfig(buildDir, type, entryFile, customPort);
        switch (detected.type) {
          case "static":
            dockerfileContent = staticDockerfile();
            break;
          case "python":
            dockerfileContent = pythonDockerfile(detected.entryFile, detected.internalPort, detected.hasRequirements);
            break;
          default: // node
            dockerfileContent = nodeDockerfile(detected.entryFile, detected.internalPort, detected.hasPackageJson);
            break;
        }
        defaultPort = detected.internalPort;
        console.log(`[AppDeploy] Detected: type=${detected.type}, entry=${detected.entryFile}, port=${detected.internalPort}, hasPackageJson=${detected.hasPackageJson}`);
      }

      // Write Dockerfile — always overwrite so it always matches reality
      fs.writeFileSync(path.join(buildDir, "Dockerfile"), dockerfileContent);

      // Update DB with the correct detected internalPort and final dockerfile
      appStore.update(app.id, { internalPort: defaultPort, dockerfile: dockerfileContent });

      // 5b. Deploy via Docker manager (builds image + starts container for testing)
      // Bind to 0.0.0.0 so the app is reachable from the local network
      // (e.g. via agent2077.local:<port>) and not just from localhost.
      const result = await dockerManager.deployApp(
        app.id,
        dockerfileContent,
        buildDir,
        hostPort,
        defaultPort,  // always use freshly-detected port, not stale DB value
        "0.0.0.0"  // bindHost — bind to all interfaces, not just 127.0.0.1
      );

      // 6. App is now running for testing
      // Register nginx proxy so it's reachable via agent2077.local:<port> on LAN
      registerAppPort(hostPort);

      // Resolve the hostname Agent2077 is reachable on so the URL works from
      // any device on the local network, not just from the server itself.
      const hostname = getAgentHostname();
      const networkUrl = `http://${hostname}:${hostPort}`;
      const localUrl   = `http://localhost:${hostPort}`;
      const versionStr = isUpdate ? ` (v${oldVersion + 1}, updated from v${oldVersion})` : "";

      return {
        success: true,
        output: `App "${name}" ${isUpdate ? "updated" : "built"} and deployed successfully!${versionStr}\n` +
          `  Status: running (for testing)\n` +
          `  Port: ${hostPort}\n` +
          `  Local URL:   ${localUrl}\n` +
          `  Network URL: ${networkUrl}\n` +
          `  Container: ${result.containerId.slice(0, 12)}\n` +
          (isUpdate ? `  Previous version backed up as v${oldVersion} (up to 3 versions kept)\n` : "") +
          `\nThe app is now running so you can verify it works. ` +
          `It is accessible from any device on the local network at ${networkUrl}. ` +
          `When you're done testing, call stop_app to stop it. ` +
          `The user will launch it from the App Store when they want to use it.\n` +
          `\nIMPORTANT: After confirming the app works correctly, call stop_app with appId ${app.id} ` +
          `so it appears as 'stopped' in the App Store for the user to launch on demand.`,
        metadata: { appId: app.id, port: hostPort, networkUrl, localUrl, containerId: result.containerId, version: isUpdate ? oldVersion + 1 : 1 },
      };
    } catch (err: any) {
      // On failure for NEW apps: clean up DB entry + build dir
      // On failure for UPDATES: restore from backup if possible
      if (app?.id) {
        const buildDir = path.join(APPS_DIR, `app-${app.id}`);
        if (!existing) {
          // New app failed — remove everything
          try {
            if (fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true, force: true });
            appStore.delete(app.id);
          } catch { /* best effort cleanup */ }
        } else {
          // Update failed — try to restore previous version
          try {
            const backupDir = path.join(APPS_DIR, `app-${app.id}-v${(existing as any).version || 1}`);
            if (fs.existsSync(backupDir)) {
              if (fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true, force: true });
              fs.cpSync(backupDir, buildDir, { recursive: true });
              appStore.update(app.id, { status: "stopped", errorLog: `Update failed: ${err.message}. Restored v${(existing as any).version || 1}.` });
              console.log(`[AppDeploy] Update failed, restored backup`);
            } else {
              appStore.update(app.id, { status: "error", errorLog: err.message });
            }
          } catch { appStore.update(app.id, { status: "error", errorLog: err.message }); }
        }
      }
      return {
        success: false,
        output: `Failed to deploy app: ${err.message}`,
      };
    }
  },
});

// ── cleanup_apps: remove all errored/building orphans ──────────────
registerTool("cleanup_apps", {
  category: "docker",
  definition: {
    type: "function",
    function: {
      name: "cleanup_apps",
      description:
        "Remove all apps in 'error' or 'building' state from the App Store. " +
        "Use this to clean up after failed deployments.",
      parameters: { type: "object", properties: {} },
    },
  },
  async execute(_args, _context): Promise<ToolResult> {
    const allApps = appStore.getAll();
    const orphans = allApps.filter(
      (a) => a.status === "error" || a.status === "building"
    );
    if (orphans.length === 0) {
      return { success: true, output: "No errored or stale apps to clean up." };
    }
    const removed: string[] = [];
    for (const app of orphans) {
      try {
        await dockerManager.removeApp(app.id);
      } catch {
        // removeApp may fail if no container — still delete from DB
        appStore.delete(app.id);
      }
      // Clean up build dir
      const dir = path.join(APPS_DIR, `app-${app.id}`);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      removed.push(`${app.name} (id ${app.id})`);
    }
    return {
      success: true,
      output: `Cleaned up ${removed.length} app(s): ${removed.join(", ")}`,
    };
  },
});

// ── rollback_app: roll back to a previous version ──────────────
registerTool("rollback_app", {
  category: "docker",
  definition: {
    type: "function",
    function: {
      name: "rollback_app",
      description:
        "Roll back an app in the App Store to a previous version. " +
        "The current version is backed up before rollback. " +
        "Use this if the latest update broke something.",
      parameters: {
        type: "object",
        properties: {
          appId: {
            type: "number",
            description: "The app ID to roll back",
          },
          targetVersion: {
            type: "number",
            description: "The version number to roll back to (e.g., 1, 2). If not specified, rolls back to the most recent previous version.",
          },
        },
        required: ["appId"],
      },
    },
  },
  async execute(args, _context): Promise<ToolResult> {
    const { appId, targetVersion } = args;

    const app = appStore.getById(appId);
    if (!app) return { success: false, output: `App with id ${appId} not found` };

    const currentVersion = (app as any).version || 1;
    if (currentVersion <= 1 && !targetVersion) {
      return { success: false, output: `App "${app.name}" is at version 1 — nothing to roll back to.` };
    }

    // Determine target version
    let rollbackTo = targetVersion;
    if (!rollbackTo) {
      // Find the most recent backup
      for (let v = currentVersion - 1; v >= 1; v--) {
        const backupDir = path.join(APPS_DIR, `app-${appId}-v${v}`);
        if (fs.existsSync(backupDir)) {
          rollbackTo = v;
          break;
        }
      }
    }

    if (!rollbackTo) {
      return { success: false, output: `No previous version backups found for "${app.name}".` };
    }

    const backupDir = path.join(APPS_DIR, `app-${appId}-v${rollbackTo}`);
    if (!fs.existsSync(backupDir)) {
      return { success: false, output: `Backup for version ${rollbackTo} not found.` };
    }

    const buildDir = path.join(APPS_DIR, `app-${appId}`);

    try {
      // Backup the current version before rolling back
      const currentBackupDir = path.join(APPS_DIR, `app-${appId}-v${currentVersion}`);
      if (fs.existsSync(buildDir) && !fs.existsSync(currentBackupDir)) {
        fs.cpSync(buildDir, currentBackupDir, { recursive: true });
        console.log(`[Rollback] Saved current v${currentVersion} as backup`);
      }

      // Wipe current build dir and copy backup
      if (fs.existsSync(buildDir)) {
        fs.rmSync(buildDir, { recursive: true, force: true });
      }
      fs.cpSync(backupDir, buildDir, { recursive: true });

      // Update DB record
      appStore.update(appId, {
        version: rollbackTo as any,
        status: "stopped",
        errorLog: null,
      });

      // Rebuild Docker container from the restored files
      if (app.dockerfile && dockerManager.isReady()) {
        try {
          const result = await dockerManager.deployApp(
            appId,
            app.dockerfile,
            buildDir,
            app.port!,
            app.internalPort,
            "0.0.0.0"  // bindHost — bind to all interfaces for LAN access
          );
          // Stop after rebuild so it's ready to launch
          await dockerManager.stopApp(appId);
        } catch (err: any) {
          console.warn(`[Rollback] Docker rebuild failed:`, err.message);
          // Files are restored even if Docker rebuild fails
        }
      }

      console.log(`[Rollback] App "${app.name}" rolled back from v${currentVersion} to v${rollbackTo}`);

      return {
        success: true,
        output: `App "${app.name}" rolled back to version ${rollbackTo} (was v${currentVersion}).\n` +
          `The previous v${currentVersion} has been saved as a backup.\n` +
          `The app is now stopped — launch it from the App Store to test.`,
        metadata: { appId, previousVersion: currentVersion, restoredVersion: rollbackTo },
      };
    } catch (err: any) {
      return {
        success: false,
        output: `Rollback failed: ${err.message}`,
      };
    }
  },
});

registerTool("stop_app", {
  category: "docker",
  definition: {
    type: "function",
    function: {
      name: "stop_app",
      description:
        "Stop a running app in the App Store. Use this after deploying and verifying an app works correctly, so it appears as 'stopped' in the App Store for the user to launch on demand.",
      parameters: {
        type: "object",
        properties: {
          appId: {
            type: "number",
            description: "The app ID returned by deploy_app",
          },
        },
        required: ["appId"],
      },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const { appId } = args;
    try {
      await dockerManager.stopApp(appId);
      const app = appStore.getById(appId);
      return {
        success: true,
        output: `App "${app?.name || appId}" stopped. It is now listed in the App Store and the user can launch it whenever they want.`,
      };
    } catch (err: any) {
      return {
        success: false,
        output: `Failed to stop app: ${err.message}`,
      };
    }
  },
});
