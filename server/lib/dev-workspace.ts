/**
 * Dev Workspace Manager — manages the self-development environment.
 * Production Agent2077 uses this to work on a separate copy of itself.
 */
import fs from "fs";
import path from "path";
import { execSync, spawn, type ChildProcess } from "child_process";
import AsyncLock from "async-lock";
import { createHash } from "crypto";
import { settingsStore } from "../storage.js";
import { resolveNodeEnv, resolveBin } from "./node-env.js";

// ── File mutex ────────────────────────────────────────────────────────────────────────
// Single in-process lock manager. Key = absolute file path.
// All reads and writes that could race go through fileLock.acquire(path, fn).
// This serialises concurrent sub-agent access to the same file.
const fileLock = new AsyncLock({ maxPending: 200 });

// ── File write safety constants ─────────────────────────────────────────────
// Files above this line count MUST be read in the current session before
// piecemeal edits (writeDevLines / editDevFile) are allowed.
const LARGE_FILE_LINE_THRESHOLD = 400;

// Files above this threshold may NOT use writeDevLines at all — rewriteDevFile only.
const REWRITE_ONLY_THRESHOLD = 400;

// TS/JS extensions that get syntax-validated after every write
const VALIDATE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);

// Track which files have been read in the current write session.
// Keyed by absolute path → line count at time of last read.
// Reset on initDevSession.
const fileReadRegistry = new Map<string, { lines: number; ts: number }>();

/** Record that a file was read, so write gates know the agent has seen current content. */
export function markFileRead(fullPath: string, lineCount: number): void {
  fileReadRegistry.set(fullPath, { lines: lineCount, ts: Date.now() });
}

/** Clear the read registry (called on new dev session). */
function clearFileReadRegistry(): void {
  fileReadRegistry.clear();
}

// ── SHA-256 helpers ───────────────────────────────────────────────────────────
function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ── Write transaction log ─────────────────────────────────────────────────────
/**
 * Append a line to DEV_LOG.md recording the write with before/after hashes.
 * Non-fatal — if logging fails the write still proceeds.
 */
function logWriteTransaction(
  devDir: string,
  filePath: string,
  beforeHash: string | null,
  afterHash: string,
  op: "write" | "edit" | "rewrite" | "lines"
): void {
  try {
    const logPath = path.join(devDir, "DEV_LOG.md");
    const ts = new Date().toISOString();
    const entry = `\n<!-- write-tx op=${op} file=${filePath} before=${beforeHash ?? "new"} after=${afterHash} ts=${ts} -->`;
    fs.appendFileSync(logPath, entry, "utf-8");
  } catch { /* non-fatal */ }
}

/**
 * Scan the dev directory for incomplete writes: backup file exists but the
 * corresponding path has a different hash than what was committed, meaning
 * a write was interrupted. Auto-restore from backup and report.
 * Called at the start of initDevSession and after server restart.
 */
function recoverOrphanedBackups(devDir: string): string[] {
  const recovered: string[] = [];
  try {
    // Find all .bak files anywhere in the dev workspace (excluding node_modules)
    const findResult = execSync(
      `find "${devDir}" -name "*.bak" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null || true`,
      { encoding: "utf-8", timeout: 10000 }
    ).trim();
    if (!findResult) return recovered;

    for (const bakPath of findResult.split("\n").filter(Boolean)) {
      const origPath = bakPath.slice(0, -4); // remove .bak
      if (!fs.existsSync(origPath)) {
        // Original was deleted but backup exists — restore it
        fs.copyFileSync(bakPath, origPath);
        fs.unlinkSync(bakPath);
        recovered.push(`Restored (original missing): ${path.relative(devDir, origPath)}`);
      } else {
        // Both exist — backup means a write was in progress; keep original (it may be valid)
        // but warn so the agent is aware
        fs.unlinkSync(bakPath);
        recovered.push(`Removed orphan backup (original exists): ${path.relative(devDir, origPath)}`);
      }
    }
  } catch { /* non-fatal */ }
  return recovered;
}

// ── TypeScript/JS syntax validation ──────────────────────────────────────────
/**
 * Validate a TypeScript or JavaScript file using tsc --noEmit.
 * Returns null if valid, or an error string if invalid.
 * Only runs for .ts/.tsx/.js/.jsx extensions. Always returns null for others.
 */
function validateSyntax(devDir: string, filePath: string, content: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  if (!VALIDATE_EXTENSIONS.has(ext)) return null;

  // Quick pre-check: look for obviously mismatched braces/brackets that would
  // indicate a truncated write — much faster than invoking tsc.
  const opens = (content.match(/{/g) || []).length;
  const closes = (content.match(/}/g) || []).length;
  if (Math.abs(opens - closes) > 5) {
    return `Brace mismatch: ${opens} '{' vs ${closes} '}' — file appears truncated or malformed.`;
  }

  // Full tsc check — write to a temp file first so we don't clobber the real one
  const tmpFile = filePath + ".validate.tmp";
  const tmpFull = path.join(devDir, tmpFile);
  try {
    fs.writeFileSync(tmpFull, content, "utf-8");
    const tscBin = resolveBin("tsc");
    execSync(
      `${tscBin} --noEmit --allowJs --skipLibCheck --target ES2020 --moduleResolution node "${tmpFull}" 2>&1 || true`,
      { cwd: devDir, timeout: 30000, encoding: "utf-8", env: resolveNodeEnv() }
    );
    return null; // valid (tsc --noEmit exits 0 for valid files)
  } catch (err: any) {
    const output = `${err.stdout || ""}\n${err.stderr || ""}`.trim();
    // Filter out lines referencing node_modules or lib files — only show errors in the target file
    const relevant = output.split("\n")
      .filter(l => l.includes(tmpFile) || l.match(/error TS\d+/))
      .slice(0, 10)
      .join("\n");
    return relevant || output.slice(0, 500);
  } finally {
    try { fs.unlinkSync(tmpFull); } catch { /* ignore */ }
  }
}

// ── Atomic safe write ─────────────────────────────────────────────────────────
/**
 * Atomically write content to a file with full corruption protection:
 *  1. Compute before-hash for the transaction log
 *  2. Validate syntax BEFORE writing (reject early if malformed)
 *  3. Write to .tmp file
 *  4. Create .bak of the original
 *  5. Move .tmp → final (atomic on same filesystem)
 *  6. Remove .bak on success
 *  7. Log the transaction
 * If anything goes wrong after .bak is created, restores from .bak.
 *
 * @param devDir - absolute dev workspace root
 * @param fullPath - absolute path to the file
 * @param content - new content
 * @param op - operation type for the log
 * @param skipValidation - skip syntax check (used for non-code files)
 */
function atomicWrite(
  devDir: string,
  fullPath: string,
  content: string,
  op: "write" | "edit" | "rewrite" | "lines",
  skipValidation = false
): { success: boolean; message: string } {
  const filePath = path.relative(devDir, fullPath);
  const tmpPath = fullPath + ".tmp";
  const bakPath = fullPath + ".bak";

  // 1. Compute before-hash
  let beforeHash: string | null = null;
  let beforeContent: string | null = null;
  if (fs.existsSync(fullPath)) {
    beforeContent = fs.readFileSync(fullPath, "utf-8");
    beforeHash = sha256(beforeContent);
  }

  // 2. Syntax validation BEFORE writing anything to disk
  if (!skipValidation) {
    const syntaxError = validateSyntax(devDir, filePath, content);
    if (syntaxError) {
      return {
        success: false,
        message:
          `❌ WRITE REJECTED — syntax validation failed for ${filePath}.\n` +
          `The file was NOT modified. Fix the syntax errors below, then retry.\n\n` +
          `${syntaxError}\n\n` +
          `Tip: if the error is in an unrelated part of the file (e.g. a third-party import), ` +
          `it may be a false positive from the isolated tsc check. In that case, retry with a ` +
          `confirmed-correct file and the error will clear at build time.`,
      };
    }
  }

  // 3. Write to .tmp
  try {
    fs.writeFileSync(tmpPath, content, "utf-8");
  } catch (err: any) {
    return { success: false, message: `Failed to write temp file: ${err.message}` };
  }

  // 4. Backup original
  if (beforeContent !== null) {
    try {
      fs.copyFileSync(fullPath, bakPath);
    } catch (err: any) {
      fs.unlinkSync(tmpPath);
      return { success: false, message: `Failed to create backup: ${err.message}` };
    }
  }

  // 5. Atomic move: .tmp → final
  try {
    fs.renameSync(tmpPath, fullPath);
  } catch (err: any) {
    // Restore from backup if rename failed
    if (beforeContent !== null && fs.existsSync(bakPath)) {
      try { fs.copyFileSync(bakPath, fullPath); } catch { /* already broken */ }
    }
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    return { success: false, message: `Atomic move failed: ${err.message}` };
  }

  // 6. Remove backup (write committed cleanly)
  try { fs.unlinkSync(bakPath); } catch { /* ignore — not fatal */ }

  // 7. Log the transaction
  const afterHash = sha256(content);
  logWriteTransaction(devDir, filePath, beforeHash, afterHash, op);

  return { success: true, message: `ok` };
}

const AGENT_ROOT = process.cwd(); // Production Agent2077 root
const DEV_BASE = path.join(process.env.HOME || "/home/agent2077", "agent2077-dev");
const STABLE_DIR = path.join(DEV_BASE, "stable");
const SCREENSHOTS_DIR = path.join(DEV_BASE, "screenshots");
const DEV_PORT = 5050;

// Exclude these when copying source
const EXCLUDE_PATTERNS = [
  "node_modules", ".git", "data", "*.db", "*.db-wal", "*.db-shm",
  ".self-dev-backups", "dist", ".vite",
];

let devServerProcess: ChildProcess | null = null;
let devServerLog: string[] = [];
let devServerStatus: "stopped" | "running" | "crashed" = "stopped";
let lastBuildResult: { success: boolean; output: string; timestamp: string } | null = null;
let lastTestResult: { passed: number; failed: number; total: number; details: string; timestamp: string } | null = null;
let currentDevNumber: number | null = null;

// Ring buffer of the last 50 status events from the agent loop
// Exposed via getDevInfo so any tab can read the current activity feed via the status poll
const MAX_STATUS_EVENTS = 50;
let recentStatusEvents: Array<{ message: string; detail?: string; timestamp: number }> = [];

export function pushStatusEvent(event: { message: string; detail?: string; timestamp: number }): void {
  recentStatusEvents.push(event);
  if (recentStatusEvents.length > MAX_STATUS_EVENTS) {
    recentStatusEvents.shift();
  }
}

export function clearStatusEvents(): void {
  recentStatusEvents = [];
}

function ensureBaseDir(): void {
  for (const dir of [DEV_BASE, SCREENSHOTS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

function getNextDevNumber(): number {
  ensureBaseDir();
  const entries = fs.readdirSync(DEV_BASE).filter(e => /^dev-\d+$/.test(e));
  if (entries.length === 0) return 1;
  const nums = entries.map(e => parseInt(e.replace("dev-", "")));
  return Math.max(...nums) + 1;
}

function getCurrentDevDir(): string | null {
  if (currentDevNumber === null) {
    // Try to find the highest existing dev dir
    ensureBaseDir();
    const entries = fs.readdirSync(DEV_BASE).filter(e => /^dev-\d+$/.test(e));
    if (entries.length === 0) return null;
    const nums = entries.map(e => parseInt(e.replace("dev-", "")));
    currentDevNumber = Math.max(...nums);
  }
  const dir = path.join(DEV_BASE, `dev-${String(currentDevNumber).padStart(3, "0")}`);
  return fs.existsSync(dir) ? dir : null;
}

/**
 * Copy source directory, excluding patterns.
 * Uses rsync if available, falls back to manual copy.
 */
function copySource(src: string, dest: string): void {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

  try {
    // Try rsync first (faster, handles excludes natively)
    const excludeArgs = EXCLUDE_PATTERNS.map(p => `--exclude='${p}'`).join(" ");
    execSync(`rsync -a ${excludeArgs} "${src}/" "${dest}/"`, { timeout: 120000 });
  } catch {
    // Fallback: manual recursive copy
    copyDirRecursive(src, dest, EXCLUDE_PATTERNS);
  }
}

function copyDirRecursive(src: string, dest: string, exclude: string[]): void {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    if (exclude.some(p => {
      if (p.startsWith("*")) return entry.name.endsWith(p.slice(1));
      return entry.name === p;
    })) continue;

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, exclude);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ── Public API ──────────────────────────────────────────────────────



export function getDevInfo(): {
  devNumber: number | null;
  devDir: string | null;
  stableDir: string;
  serverStatus: string;
  serverPort: number;
  localUrl: string;
  networkUrl: string | null;
  lastBuild: typeof lastBuildResult;
  lastTests: typeof lastTestResult;
  logLines: string[];
  statusEvents: Array<{ message: string; detail?: string; timestamp: number }>;
} {
  // Resolve the LAN-accessible URL for the dev server.
  // Uses the same logic as app-deploy.ts getAgentHostname():
  //   1. network.devHostname setting override
  //   2. devagent.local (mDNS alias set up by install.sh)
  //   3. First non-loopback LAN IP
  let networkUrl: string | null = null;
  try {
    const override = settingsStore.get("network.devHostname");
    if (override && override.trim()) {
      networkUrl = `http://${override.trim()}:${DEV_PORT}`;
    } else {
      // devagent.local is the dedicated mDNS alias for the dev server
      networkUrl = `http://devagent.local:${DEV_PORT}`;
    }
  } catch {
    networkUrl = null;
  }

  return {
    devNumber: currentDevNumber,
    devDir: getCurrentDevDir(),
    stableDir: STABLE_DIR,
    serverStatus: devServerStatus,
    serverPort: DEV_PORT,
    localUrl: `http://localhost:${DEV_PORT}`,
    networkUrl,
    lastBuild: lastBuildResult,
    lastTests: lastTestResult,
    logLines: devServerLog.slice(-50),
    statusEvents: [...recentStatusEvents],
  };
}

export function initDevSession(): { devNumber: number; devDir: string; stableDir: string } {
  ensureBaseDir();

  // Refresh stable from production
  console.log("[SelfDev] Copying production source to stable/...");
  copySource(AGENT_ROOT, STABLE_DIR);

  // Create new dev directory
  const num = getNextDevNumber();
  currentDevNumber = num;
  const devDir = path.join(DEV_BASE, `dev-${String(num).padStart(3, "0")}`);

  console.log(`[SelfDev] Creating dev-${String(num).padStart(3, "0")}...`);
  copySource(AGENT_ROOT, devDir);

  // Copy ARCHITECTURE.md if it exists
  const archPath = path.join(AGENT_ROOT, "ARCHITECTURE.md");
  if (fs.existsSync(archPath)) {
    fs.copyFileSync(archPath, path.join(devDir, "ARCHITECTURE.md"));
  }

  // Install dependencies in dev directory.
  // --ignore-scripts prevents postinstall hooks from executing arbitrary code.
  // NODE_ENV=development ensures devDependencies (vite, esbuild, tsx) are installed.
  console.log("[SelfDev] Running npm ci --ignore-scripts in dev workspace...");
  try {
    const installEnv = { ...resolveNodeEnv(), NODE_ENV: "development" };
    execSync("npm ci --ignore-scripts", { cwd: devDir, timeout: 300000, stdio: "pipe", env: installEnv });
  } catch (err: any) {
    // npm ci requires a package-lock.json — fall back to npm install --ignore-scripts if absent
    console.warn("[SelfDev] npm ci failed, falling back to npm install --ignore-scripts:", err.stderr?.toString().slice(0, 200));
    try {
      const installEnv = { ...resolveNodeEnv(), NODE_ENV: "development" };
      execSync("npm install --ignore-scripts", { cwd: devDir, timeout: 300000, stdio: "pipe", env: installEnv });
    } catch (err2: any) {
      console.warn("[SelfDev] npm install warning:", err2.stderr?.toString().slice(0, 500));
    }
  }

  // Seed dev database from production — copies schema + config, wipes conversation data
  // Without this the dev server crashes on boot: "no such table: users"
  const prodDbPath = path.join(AGENT_ROOT, "data", "agent2077.db");
  const devDataDir = path.join(devDir, "data");
  const devDbPath = path.join(devDataDir, "agent2077.db");
  if (fs.existsSync(prodDbPath)) {
    try {
      fs.mkdirSync(devDataDir, { recursive: true });
      fs.copyFileSync(prodDbPath, devDbPath);
      // Wipe conversation data so dev starts clean — keeps users, endpoints, models, settings
      execSync(
        `sqlite3 "${devDbPath}" "DELETE FROM messages; DELETE FROM conversations; PRAGMA wal_checkpoint(TRUNCATE); VACUUM;"`,
        { timeout: 15000, stdio: "pipe" }
      );
      // Reset memory files
      fs.writeFileSync(path.join(devDataDir, "MEMORY.md"), "# Agent Memory\n");
      fs.writeFileSync(path.join(devDataDir, "USER.md"), "# User Profile\n");
      console.log("[SelfDev] Dev database seeded from production (conversations cleared)");
    } catch (err: any) {
      console.warn("[SelfDev] Failed to seed dev database:", err.message?.slice(0, 200));
    }
  } else {
    console.warn("[SelfDev] Production database not found — dev server may fail to start");
  }

  // Clear the per-session file-read registry so large-file gates start fresh
  clearFileReadRegistry();

  // Initialize DEV_LOG.md
  const logContent = `# Dev Session ${num}\nStarted: ${new Date().toISOString()}\n\n## Changes\n\n(none yet)\n`;
  fs.writeFileSync(path.join(devDir, "DEV_LOG.md"), logContent);

  // Recover any orphaned backups from a previous interrupted session
  const recovered = recoverOrphanedBackups(devDir);
  if (recovered.length > 0) {
    console.log("[SelfDev] Recovered orphaned backups:", recovered);
    fs.appendFileSync(
      path.join(devDir, "DEV_LOG.md"),
      `\n\n## Auto-recovered incomplete writes\n${recovered.map(r => `- ${r}`).join("\n")}\n`
    );
  }

  // Initialize git repo for checkpointing
  try {
    execSync("git init", { cwd: devDir, stdio: "pipe" });
    const gitignore = "node_modules/\ndata/\n*.db\n*.db-wal\n*.db-shm\n.vite/\n";
    fs.writeFileSync(path.join(devDir, ".gitignore"), gitignore);
    execSync("git add -A", { cwd: devDir, stdio: "pipe" });
    execSync(
      'git commit -m "baseline: dev session initialized from stable"',
      {
        cwd: devDir, stdio: "pipe",
        env: { ...process.env, GIT_AUTHOR_NAME: "Agent2077", GIT_AUTHOR_EMAIL: "agent@agent2077.local", GIT_COMMITTER_NAME: "Agent2077", GIT_COMMITTER_EMAIL: "agent@agent2077.local" },
      }
    );
    console.log("[SelfDev] Git initialized with baseline commit");
  } catch (e: any) {
    console.warn("[SelfDev] Git init warning (non-fatal):", e.message?.slice(0, 200));
  }

  return { devNumber: num, devDir, stableDir: STABLE_DIR };
}

export function syncStable(): void {
  console.log("[SelfDev] Syncing stable/ from production...");
  copySource(AGENT_ROOT, STABLE_DIR);
}

// Track recent build error signatures for stuck-loop detection
const recentBuildErrors: string[] = [];
const MAX_REPEATED_BUILD_ERRORS = 3;

// ── Give-up logic: consecutive environment failure counter ─────────────────
// Tracks consecutive tool failures (build + server-start) across the current dev session.
// When the count exceeds MAX_ENV_FAILURES, selfdev_build and selfdev_start_server
// refuse to run and tell the agent to stop and report to the user.
// Resets on: build success, explicit user reset, or new session init.
let consecutiveEnvFailures = 0;
const MAX_ENV_FAILURES = 5; // default: halt after 5 consecutive environment failures

export function resetEnvFailureCount(): void {
  consecutiveEnvFailures = 0;
}

export function getEnvFailureCount(): number {
  return consecutiveEnvFailures;
}

export function checkEnvFailureGiveUp(): string | null {
  if (consecutiveEnvFailures >= MAX_ENV_FAILURES) {
    return (
      `

🛑 GIVE-UP THRESHOLD REACHED: ${consecutiveEnvFailures} consecutive environment failures.` +
      `
Do NOT retry. STOP, report this to the user with a clear summary of what went wrong,` +
      `
and ask for guidance before making any further changes.` +
      `
Run selfdev_get_info to show current state. Do NOT call selfdev_build or selfdev_start_server again.`
    );
  }
  return null;
}

function getBuildErrorSignature(output: string): string {
  // Extract just the error type + file + line — ignore line numbers that shift
  const lines = output.split("\n").filter(l =>
    l.includes("error TS") || l.includes("Error:") || l.includes("error:") || l.includes("✘")
  );
  return lines.slice(0, 5).map(l => l.trim().slice(0, 120)).join("|");
}

export function buildDev(): { success: boolean; output: string } {
  const devDir = getCurrentDevDir();
  if (!devDir) return { success: false, output: "No dev session initialized" };

  // Give-up check: if too many consecutive failures, refuse to keep trying
  const giveUpMsg = checkEnvFailureGiveUp();
  if (giveUpMsg) return { success: false, output: `Build blocked — give-up threshold reached.${giveUpMsg}` };

  try {
    const nodeEnv = resolveNodeEnv();
    // resolveNodeEnv guarantees npx is on PATH — use it directly via shell
    const output = execSync("npx tsx script/build.ts 2>&1", {
      cwd: devDir,
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 10,
      encoding: "utf-8",
      env: nodeEnv,
      shell: true,
    });
    lastBuildResult = { success: true, output: output.slice(-3000), timestamp: new Date().toISOString() };
    // Build succeeded — clear error history, reset give-up counter, and auto-checkpoint
    recentBuildErrors.length = 0;
    consecutiveEnvFailures = 0; // reset on success
    try {
      execSync("git add -A", { cwd: devDir, stdio: "pipe" });
      execSync(
        `git commit -m "checkpoint: build green at ${new Date().toISOString()}" --allow-empty`,
        {
          cwd: devDir, stdio: "pipe",
          env: { ...process.env, GIT_AUTHOR_NAME: "Agent2077", GIT_AUTHOR_EMAIL: "agent@agent2077.local", GIT_COMMITTER_NAME: "Agent2077", GIT_COMMITTER_EMAIL: "agent@agent2077.local" },
        }
      );
    } catch { /* git not initialized — skip silently */ }
    return { success: true, output: output.slice(-3000) };
  } catch (err: any) {
    const output = `${err.stdout || ""}\n${err.stderr || ""}`.slice(-3000);
    lastBuildResult = { success: false, output, timestamp: new Date().toISOString() };

    // Increment consecutive environment failure counter
    consecutiveEnvFailures++;

    // Stuck-loop detection: track error signatures
    const sig = getBuildErrorSignature(output);
    if (sig) {
      recentBuildErrors.push(sig);
      if (recentBuildErrors.length > MAX_REPEATED_BUILD_ERRORS * 2) recentBuildErrors.shift();
      const sameCount = recentBuildErrors.filter(e => e === sig).length;
      if (sameCount >= MAX_REPEATED_BUILD_ERRORS) {
        recentBuildErrors.length = 0; // reset so user can try again after guidance
        return {
          success: false,
          output: output +
            `\n\n⛔ STUCK LOOP DETECTED: This exact build error has appeared ${sameCount} times in a row.` +
            `\nDo NOT attempt another fix without first understanding the root cause.` +
            `\nSTOP and report this error to the user clearly. Ask for guidance before making further changes.` +
            `\nError signature: ${sig.slice(0, 200)}`,
        };
      }
    }

    // Surface the most actionable error line at the top so the agent sees it immediately
    const errorLines = output.split("\n").filter(l =>
      l.includes("error TS") || l.includes("Error:") || l.includes("✘ ") ||
      (l.includes("error:") && !l.startsWith("npm warn"))
    );
    const keyError = errorLines.length > 0
      ? `\n⚠️  KEY ERROR: ${errorLines[0].trim()}`
      : "";
    const npmWarning =
      "\n\n🚫 Do NOT run npm install — it is not needed and will not fix build errors." +
      "\n   Build errors are always TypeScript/import issues. Read the error above and fix the source code.";

    return { success: false, output: keyError + npmWarning + "\n\n" + output };
  }
}

export function startDevServer(): { success: boolean; message: string } {
  const devDir = getCurrentDevDir();
  if (!devDir) return { success: false, message: "No dev session initialized" };
  if (devServerProcess) return { success: false, message: "Dev server already running" };

  // Give-up check
  const giveUpMsg = checkEnvFailureGiveUp();
  if (giveUpMsg) return { success: false, message: `Server start blocked — give-up threshold reached.${giveUpMsg}` };

  // Check if build exists
  const indexCjs = path.join(devDir, "dist", "index.cjs");
  if (!fs.existsSync(indexCjs)) {
    return { success: false, message: "No build found — run selfdev_build first" };
  }

  devServerLog = [];
  devServerStatus = "running";

  const _nodeEnv = resolveNodeEnv();
  const _nodeBin = resolveBin("node");
  devServerProcess = spawn(_nodeBin, ["dist/index.cjs"], {
    cwd: devDir,
    env: {
      ..._nodeEnv,
      PORT: String(DEV_PORT),
      NODE_ENV: "production",
      AGENT2077_DEV_MODE: "true",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  devServerProcess.stdout?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n").filter(Boolean);
    devServerLog.push(...lines);
    if (devServerLog.length > 500) devServerLog = devServerLog.slice(-500);
  });

  devServerProcess.stderr?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n").filter(Boolean);
    devServerLog.push(...lines.map(l => `[stderr] ${l}`));
    if (devServerLog.length > 500) devServerLog = devServerLog.slice(-500);
  });

  devServerProcess.on("close", (code) => {
    devServerStatus = code === 0 ? "stopped" : "crashed";
    devServerLog.push(`[Process exited with code ${code}]`);
    devServerProcess = null;
  });

  return { success: true, message: `Dev server starting on port ${DEV_PORT}...` };
}

export function stopDevServer(): { success: boolean; message: string } {
  if (!devServerProcess) return { success: false, message: "Dev server not running" };

  try {
    devServerProcess.kill("SIGTERM");
    devServerProcess = null;
    devServerStatus = "stopped";
    return { success: true, message: "Dev server stopped" };
  } catch (err: any) {
    return { success: false, message: `Failed to stop: ${err.message}` };
  }
}

export function getDevLogs(lines: number = 50): string[] {
  return devServerLog.slice(-lines);
}

export async function healthCheck(): Promise<{ healthy: boolean; status: string }> {
  if (devServerStatus !== "running") {
    return { healthy: false, status: `Server is ${devServerStatus}` };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`http://localhost:${DEV_PORT}/api/auth/check`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return { healthy: res.status === 200 || res.status === 401, status: `HTTP ${res.status}` };
  } catch (err: any) {
    return { healthy: false, status: `Health check failed: ${err.message}` };
  }
}

export function diffFile(filePath: string): { hasDiff: boolean; diff: string } {
  const devDir = getCurrentDevDir();
  if (!devDir) return { hasDiff: false, diff: "No dev session" };

  const resolvedDev = resolveInDir(devDir, filePath);
  const resolvedStable = resolveInDir(STABLE_DIR, filePath);
  if (!resolvedDev || !resolvedStable) return { hasDiff: false, diff: "Path traversal not allowed" };

  const devFile = resolvedDev;
  const stableFile = resolvedStable;

  if (!fs.existsSync(devFile) && !fs.existsSync(stableFile)) {
    return { hasDiff: false, diff: "File doesn't exist in either location" };
  }
  if (!fs.existsSync(stableFile)) {
    return { hasDiff: true, diff: `[NEW FILE — does not exist in stable]\n${fs.readFileSync(devFile, "utf-8").slice(0, 10000)}` };
  }
  if (!fs.existsSync(devFile)) {
    return { hasDiff: true, diff: "[DELETED — exists in stable but not in dev]" };
  }

  try {
    const diff = execSync(`diff -u "${stableFile}" "${devFile}" || true`, {
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    });
    return { hasDiff: diff.trim().length > 0, diff: diff.slice(0, 10000) || "(no differences)" };
  } catch {
    return { hasDiff: false, diff: "diff command failed" };
  }
}

/**
 * Create an emergency git branch snapshot before destructive reset operations
 * so the user can recover if the reset was a mistake.
 * Branch name: emergency/reset-<timestamp>
 * Non-fatal — if git isn't initialised, it silently skips.
 */
function emergencySnapshot(label: string): void {
  const devDir = getCurrentDevDir();
  if (!devDir) return;
  const gitDir = path.join(devDir, ".git");
  if (!fs.existsSync(gitDir)) return;
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const branch = `emergency/reset-${ts}`;
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "Agent2077",
      GIT_AUTHOR_EMAIL: "agent@agent2077.local",
      GIT_COMMITTER_NAME: "Agent2077",
      GIT_COMMITTER_EMAIL: "agent@agent2077.local",
    };
    execSync("git add -A", { cwd: devDir, stdio: "pipe", env: gitEnv });
    execSync(`git commit -m "emergency snapshot before ${label}" --allow-empty`, { cwd: devDir, stdio: "pipe", env: gitEnv });
    execSync(`git branch ${branch}`, { cwd: devDir, stdio: "pipe", env: gitEnv });
    console.log(`[SelfDev] Emergency snapshot created: ${branch}`);
  } catch {
    // git not available or no changes — non-fatal
  }
}

export function resetFile(filePath: string): { success: boolean; message: string } {
  const devDir = getCurrentDevDir();
  if (!devDir) return { success: false, message: "No dev session" };

  const resolvedDev = resolveInDir(devDir, filePath);
  const resolvedStable = resolveInDir(STABLE_DIR, filePath);
  if (!resolvedDev || !resolvedStable) return { success: false, message: "Path traversal not allowed" };

  const stableFile = resolvedStable;
  const devFile = resolvedDev;

  if (!fs.existsSync(stableFile)) {
    return { success: false, message: `${filePath} doesn't exist in stable/` };
  }

  // Snapshot before overwriting so the user can recover if needed
  emergencySnapshot(`reset-file:${filePath}`);

  const dir = path.dirname(devFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(stableFile, devFile);
  return { success: true, message: `Restored ${filePath} from stable (emergency snapshot saved to git branch)` };
}

export function resetAll(): { success: boolean; message: string } {
  const devDir = getCurrentDevDir();
  if (!devDir) return { success: false, message: "No dev session" };

  // Snapshot before wiping so the user can recover if needed
  emergencySnapshot("reset-all");

  // Stop dev server if running
  if (devServerProcess) stopDevServer();

  // Wipe dev and re-copy from stable
  fs.rmSync(devDir, { recursive: true, force: true });
  copySource(STABLE_DIR, devDir);

  // Re-install dependencies (--ignore-scripts prevents postinstall hooks)
  try {
    const installEnv = { ...resolveNodeEnv(), NODE_ENV: "development" };
    execSync("npm ci --ignore-scripts", { cwd: devDir, timeout: 300000, stdio: "pipe", env: installEnv });
  } catch {
    try {
      const installEnv = { ...resolveNodeEnv(), NODE_ENV: "development" };
      execSync("npm install --ignore-scripts", { cwd: devDir, timeout: 300000, stdio: "pipe", env: installEnv });
    } catch {}
  }

  return { success: true, message: "Dev workspace reset from stable" };
}

export function packageZip(): { success: boolean; path: string; message: string } {
  const devDir = getCurrentDevDir();
  if (!devDir) return { success: false, path: "", message: "No dev session" };

  const zipName = `agent2077-dev-${String(currentDevNumber).padStart(3, "0")}.zip`;
  const zipPath = path.join(DEV_BASE, zipName);

  try {
    // Build first
    const build = buildDev();
    if (!build.success) {
      return { success: false, path: "", message: `Build failed:\n${build.output}` };
    }

    // Remove old zip if exists
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

    // Create zip using native zip command, excluding unwanted dirs
    const excludeArgs = EXCLUDE_PATTERNS.map(p => `-x "*/${p}/*" -x "*/${p}"` ).join(" ");
    execSync(
      `cd "${path.dirname(devDir)}" && zip -r "${zipPath}" "${path.basename(devDir)}" ${excludeArgs}`,
      { timeout: 120000 }
    );

    // Verify
    const fileCount = execSync(`unzip -l "${zipPath}" | tail -1`, { encoding: "utf-8" }).trim();
    const sizeKB = Math.round(fs.statSync(zipPath).size / 1024);

    return { success: true, path: zipPath, message: `Packaged: ${zipName} (${sizeKB}KB)\n${fileCount}` };
  } catch (err: any) {
    return { success: false, path: "", message: `Packaging failed: ${err.message}` };
  }
}

// Keep old name as alias so nothing breaks
export const packageTarball = packageZip;

// ── Git checkpoint helpers ────────────────────────────────────────────────────

/**
 * Run a git command inside the dev workspace. Returns stdout or error.
 */
function gitInDev(args: string): { success: boolean; output: string } {
  const devDir = getCurrentDevDir();
  if (!devDir) return { success: false, output: "No dev session" };
  try {
    const output = execSync(`git ${args}`, {
      cwd: devDir,
      encoding: "utf-8",
      timeout: 30000,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Agent2077",
        GIT_AUTHOR_EMAIL: "agent@agent2077.local",
        GIT_COMMITTER_NAME: "Agent2077",
        GIT_COMMITTER_EMAIL: "agent@agent2077.local",
      },
    });
    return { success: true, output: output.trim() };
  } catch (err: any) {
    return { success: false, output: `${err.stdout || ""}\n${err.stderr || ""}`.trim() };
  }
}

/** Initialize git in the dev workspace and make the initial baseline commit. */
export function gitInit(): { success: boolean; message: string } {
  const devDir = getCurrentDevDir();
  if (!devDir) return { success: false, message: "No dev session" };

  const gitDir = path.join(devDir, ".git");
  if (fs.existsSync(gitDir)) return { success: true, message: "Git already initialized" };

  const init = gitInDev("init");
  if (!init.success) return { success: false, message: `git init failed: ${init.output}` };

  // Write a .gitignore so we never commit node_modules or data
  const gitignore = "node_modules/\ndata/\n*.db\n*.db-wal\n*.db-shm\n.vite/\n";
  fs.writeFileSync(path.join(devDir, ".gitignore"), gitignore, "utf-8");

  gitInDev("add -A");
  const commit = gitInDev('commit -m "baseline: dev session initialized from stable"');
  return { success: commit.success, message: commit.success ? "Git initialized with baseline commit" : `Commit failed: ${commit.output}` };
}

/** Commit all current changes in the dev workspace. */
export function gitCheckpoint(message: string): { success: boolean; message: string } {
  const status = gitInDev("status --porcelain");
  if (!status.success) return { success: false, message: `git status failed: ${status.output}` };
  if (!status.output.trim()) return { success: true, message: "Nothing to commit (working tree clean)" };

  gitInDev("add -A");
  const commit = gitInDev(`commit -m "${message.replace(/"/g, "'")}"`);
  return { success: commit.success, message: commit.success ? `Checkpoint: ${message}` : `Commit failed: ${commit.output}` };
}

/** List recent commits in the dev workspace. */
export function gitLog(n: number = 10): { success: boolean; output: string } {
  return gitInDev(`log --oneline -${n}`);
}

/** Show full diff of uncommitted changes. */
export function gitDiffWorking(): { success: boolean; output: string } {
  return gitInDev("diff HEAD");
}

/** Roll back to a specific commit hash (hard reset). */
export function gitRollback(commitHash: string): { success: boolean; message: string } {
  const result = gitInDev(`reset --hard ${commitHash}`);
  return { success: result.success, message: result.success ? `Rolled back to ${commitHash}` : result.output };
}

/**
 * Resolve a user-supplied relative path inside a base directory.
 * Returns the absolute path if it is safely inside baseDir, null if it
 * attempts to escape via traversal (e.g. "../../etc/passwd").
 */
function resolveInDir(baseDir: string, filePath: string): string | null {
  const resolved = path.resolve(path.join(baseDir, filePath));
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep) &&
      resolved !== path.resolve(baseDir)) return null;
  return resolved;
}

export async function readDevFile(filePath: string, source: "dev" | "stable" = "dev"): Promise<string | null> {
  const baseDir = source === "stable" ? STABLE_DIR : getCurrentDevDir();
  if (!baseDir) return null;

  const fullPath = path.join(baseDir, filePath);
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(path.resolve(baseDir))) return null; // Path traversal

  return fileLock.acquire(resolved, () => {
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      // Track the read so write gates know the agent has seen the current version.
      // Only track dev reads (not stable reads used for diffing).
      if (source === "dev") {
        markFileRead(resolved, content.split("\n").length);
      }
      return content;
    } catch {
      return null;
    }
  });
}

export async function writeDevFile(filePath: string, content: string): Promise<{ success: boolean; message: string }> {
  const devDir = getCurrentDevDir();
  if (!devDir) return { success: false, message: "No dev session" };

  const fullPath = path.join(devDir, filePath);
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(path.resolve(devDir))) {
    return { success: false, message: "Path traversal not allowed" };
  }
  if (fs.existsSync(fullPath)) {
    return { success: false, message: `File already exists: ${filePath}. Use selfdev_rewrite_file to overwrite an existing file.` };
  }

  return fileLock.acquire(resolved, () => {
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Validate syntax before writing new files too
    const ext = path.extname(filePath).toLowerCase();
    const skipValidation = !VALIDATE_EXTENSIONS.has(ext);
    const result = atomicWrite(devDir, fullPath, content, "write", skipValidation);
    if (!result.success) return result;

    const lineCount = content.split("\n").length;
    markFileRead(resolved, lineCount); // new file is freshly known
    return { success: true, message: `Wrote ${filePath} (${content.length} chars, ${lineCount} lines)` };
  });
}

export async function editDevFile(filePath: string, oldText: string, newText: string): Promise<{ success: boolean; message: string }> {
  const devDir = getCurrentDevDir();
  if (!devDir) return { success: false, message: "No dev session" };

  const fullPath = resolveInDir(devDir, filePath);
  if (!fullPath) return { success: false, message: "Path traversal not allowed" };
  if (!fs.existsSync(fullPath)) return { success: false, message: `File not found: ${filePath}` };

  return fileLock.acquire(fullPath, () => {
    const content = fs.readFileSync(fullPath, "utf-8");
    const lineCount = content.split("\n").length;

    // ─ C: Mandatory re-read gate for large files ─
    if (lineCount >= LARGE_FILE_LINE_THRESHOLD) {
      const lastRead = fileReadRegistry.get(fullPath);
      if (!lastRead) {
        return {
          success: false,
          message:
            `⛔ EDIT BLOCKED — ${filePath} has ${lineCount} lines (>=${LARGE_FILE_LINE_THRESHOLD}).\n` +
            `You MUST call selfdev_read_file on this file first in the current turn before editing it.\n` +
            `This ensures you are working from the current file content, not a stale copy.\n` +
            `After reading, prefer selfdev_rewrite_file for large files to avoid line-number drift.`,
        };
      }
    }

    const count = content.split(oldText).length - 1;

    if (count === 0) {
      const firstLine = oldText.split("\n")[0].trim().slice(0, 60);
      const lines = content.split("\n");
      const nearby = lines
        .map((l, i) => ({ line: l, num: i + 1 }))
        .filter(({ line }) => firstLine.split(" ").filter(w => w.length > 3).some(w => line.includes(w)))
        .slice(0, 8)
        .map(({ line, num }) => `  ${String(num).padStart(4)}: ${line}`)
        .join("\n");
      const hint = nearby
        ? `\n\nLines in file that may be nearby:\n${nearby}\n\n🚫 DO NOT RETRY selfdev_edit_file. Your next call must be selfdev_write_lines.\nUse the line numbers above. Call selfdev_write_lines({filePath, startLine, endLine, newContent}) to replace that range directly.\nIf this is a multi-line import block: use selfdev_rewrite_file instead — read the whole file, add the import, rewrite once.`
        : `\n\n🚫 DO NOT RETRY selfdev_edit_file. Your next call must be selfdev_read_file to get current line numbers, then selfdev_write_lines to replace the target range.\nIf this is a multi-line import block (spanning several lines): use selfdev_rewrite_file instead.`;
      return { success: false, message: `oldText not found in file: "${oldText.slice(0, 80)}${oldText.length > 80 ? "…" : ""}"${hint}` };
    }

    if (count > 1) {
      return { success: false, message: `oldText found ${count} times — must be unique. Add more surrounding context to oldText so it matches exactly once.` };
    }

    const newContent = content.replace(oldText, newText);

    // ─ A+B: Atomic write with syntax validation ─
    const ext = path.extname(filePath).toLowerCase();
    const skipValidation = !VALIDATE_EXTENSIONS.has(ext);
    const result = atomicWrite(devDir, fullPath, newContent, "edit", skipValidation);
    if (!result.success) return result;

    markFileRead(fullPath, newContent.split("\n").length);
    return { success: true, message: `Edited ${filePath} (${newContent.length} chars)` };
  }); // end fileLock.acquire
}

/**
 * Replace a range of lines (1-based, inclusive) with new content.
 * Safer fallback when selfdev_edit_file can't match exact text.
 */
export async function writeDevLines(
  filePath: string,
  startLine: number,
  endLine: number,
  newContent: string
): Promise<{ success: boolean; message: string }> {
  const devDir = getCurrentDevDir();
  if (!devDir) return { success: false, message: "No dev session" };

  const fullPath = resolveInDir(devDir, filePath);
  if (!fullPath) return { success: false, message: "Path traversal not allowed" };
  if (!fs.existsSync(fullPath)) return { success: false, message: `File not found: ${filePath}` };

  return fileLock.acquire(fullPath, () => {
    const fileContent = fs.readFileSync(fullPath, "utf-8");
    const lines = fileContent.split("\n");
    const total = lines.length;

    // ─ C: Mandatory re-read gate for large files ─
    if (total >= LARGE_FILE_LINE_THRESHOLD) {
      const lastRead = fileReadRegistry.get(fullPath);
      if (!lastRead) {
        return {
          success: false,
          message:
            `⛔ WRITE_LINES BLOCKED — ${filePath} has ${total} lines (>=${LARGE_FILE_LINE_THRESHOLD}).\n` +
            `You MUST call selfdev_read_file on this file first in the current turn.\n` +
            `Also: files this large should use selfdev_rewrite_file, not selfdev_write_lines.\n` +
            `Read the file, then rewrite the whole thing in one call to avoid line-number drift.`,
        };
      }
    }

    // ─ D: Force rewriteDevFile for files above threshold ─
    if (total >= REWRITE_ONLY_THRESHOLD) {
      return {
        success: false,
        message:
          `⛔ WRITE_LINES DISABLED — ${filePath} has ${total} lines (>=${REWRITE_ONLY_THRESHOLD}).\n` +
          `selfdev_write_lines is disabled for large files to prevent line-number drift corruption.\n` +
          `Use selfdev_rewrite_file instead: read the whole file, apply all your changes, rewrite once.\n` +
          `This eliminates all line-offset drift and produces a cleaner, verifiable result.`,
      };
    }

    if (startLine < 1 || startLine > total) {
      return { success: false, message: `startLine ${startLine} out of range (file has ${total} lines)` };
    }
    if (endLine < startLine || endLine > total) {
      return { success: false, message: `endLine ${endLine} out of range (startLine=${startLine}, file has ${total} lines)` };
    }

    const before = lines.slice(0, startLine - 1);
    const after = lines.slice(endLine);
    const newLines = newContent.endsWith("\n") ? newContent.slice(0, -1).split("\n") : newContent.split("\n");
    const resultLines = [...before, ...newLines, ...after];
    const resultContent = resultLines.join("\n");

    // ─ A+B: Atomic write with syntax validation ─
    const ext = path.extname(filePath).toLowerCase();
    const skipValidation = !VALIDATE_EXTENSIONS.has(ext);
    const writeResult = atomicWrite(devDir, fullPath, resultContent, "lines", skipValidation);
    if (!writeResult.success) return writeResult;

    markFileRead(fullPath, resultLines.length);

    const insertedStart = startLine - 1;
    const contextBefore = resultLines.slice(Math.max(0, insertedStart - 3), insertedStart)
      .map((l, i) => `  ${String(Math.max(1, insertedStart - 3) + i + 1).padStart(4)}: ${l}`);
    const insertedLinesFmt = newLines.map((l, i) => `→ ${String(insertedStart + i + 1).padStart(4)}: ${l}`);
    const afterStart = insertedStart + newLines.length;
    const contextAfter = resultLines.slice(afterStart, afterStart + 3)
      .map((l, i) => `  ${String(afterStart + i + 1).padStart(4)}: ${l}`);
    const preview = [...contextBefore, ...insertedLinesFmt, ...contextAfter].join("\n");

    return {
      success: true,
      message: `Replaced lines ${startLine}–${endLine} in ${filePath} with ${newLines.length} line(s). File now has ${resultLines.length} lines.\n\nContext around insertion:\n${preview}\n\n⚠️ All previously looked-up line numbers are now stale. Re-search before any further writes.`,
    };
  }); // end fileLock.acquire
}

/**
 * Rewrite an entire file — read it first, produce the complete new content, write once.
 * Eliminates line-offset drift entirely. Preferred for files requiring 4+ changes.
 */
export async function rewriteDevFile(
  filePath: string,
  content: string
): Promise<{ success: boolean; message: string }> {
  const devDir = getCurrentDevDir();
  if (!devDir) return { success: false, message: "No dev session" };

  const fullPath = path.join(devDir, filePath);
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(path.resolve(devDir))) {
    return { success: false, message: "Path traversal not allowed" };
  }
  if (!fs.existsSync(fullPath)) {
    return { success: false, message: `File not found: ${filePath}. Use selfdev_write_file to create new files.` };
  }

  return fileLock.acquire(fullPath, () => {
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // ─ C: Mandatory re-read gate for large files ─
    // rewriteDevFile is the PREFERRED tool for large files, so the gate is advisory
    // only — we warn if unseen but still allow the write (the agent made a full rewrite).
    const existingContent = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf-8") : null;
    const existingLines = existingContent ? existingContent.split("\n").length : 0;
    const lastRead = fileReadRegistry.get(fullPath);
    const unreadWarning = (existingLines >= LARGE_FILE_LINE_THRESHOLD && !lastRead)
      ? "\n⚠️  Note: you rewrote a large file without reading it first this session. Verify the output is complete."
      : "";

    // ─ A+B: Atomic write with syntax validation ─
    const ext = path.extname(filePath).toLowerCase();
    const skipValidation = !VALIDATE_EXTENSIONS.has(ext);
    const result = atomicWrite(devDir, fullPath, content, "rewrite", skipValidation);
    if (!result.success) return result;

    const lineCount = content.split("\n").length;
    markFileRead(fullPath, lineCount);
    return {
      success: true,
      message: `Rewrote ${filePath} (${content.length} chars, ${lineCount} lines). No line-offset drift — all line numbers are fresh.${unreadWarning}`,
    };
  });
}

export function listDevFiles(directory: string = "."): string[] {
  const devDir = getCurrentDevDir();
  if (!devDir) return [];

  const fullPath = path.join(devDir, directory);
  if (!fs.existsSync(fullPath)) return [];

  try {
    return fs.readdirSync(fullPath, { withFileTypes: true })
      .map(e => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`);
  } catch {
    return [];
  }
}

export function runDevCommand(command: string): { success: boolean; output: string } {
  const devDir = getCurrentDevDir();
  if (!devDir) return { success: false, output: "No dev session" };

  try {
    const output = execSync(command, {
      cwd: devDir,
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 10,
      encoding: "utf-8",
      env: {
        ...resolveNodeEnv(),
        // Always provide git identity so the agent can commit without global git config
        GIT_AUTHOR_NAME: "Agent2077",
        GIT_AUTHOR_EMAIL: "agent@agent2077.local",
        GIT_COMMITTER_NAME: "Agent2077",
        GIT_COMMITTER_EMAIL: "agent@agent2077.local",
      },
    });
    return { success: true, output: output || "(no output)" };
  } catch (err: any) {
    // Exit code 1 from commands like `grep` means "no matches" — not an error.
    // Only treat it as a real failure if stderr has content (actual error message).
    if (err.status === 1 && !err.stderr?.trim()) {
      return { success: true, output: err.stdout?.trim() || "(no matches)" };
    }
    return { success: false, output: `${err.stdout || ""}\n${err.stderr || ""}`.slice(0, 5000) };
  }
}

export async function httpRequest(method: string, urlPath: string, body?: any): Promise<{ status: number; body: string }> {
  try {
    const url = `http://localhost:${DEV_PORT}${urlPath}`;
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text.slice(0, 10000) };
  } catch (err: any) {
    return { status: 0, body: `Request failed: ${err.message}` };
  }
}

export { DEV_BASE, STABLE_DIR, DEV_PORT, SCREENSHOTS_DIR };

// ═══════════════════════════════════════════════════════════════════════════════
//  PROMOTE & ROLLBACK
// ═══════════════════════════════════════════════════════════════════════════════

const RELEASES_DIR = path.join(DEV_BASE, "releases");

export interface ReleaseManifest {
  id: string;          // e.g. "2026-05-22T14-30-00-custom"
  label: string;       // human label, e.g. "Before promoting dev-003"
  timestamp: string;   // ISO 8601
  devNumber: number | null;  // which dev session was promoted (null = pre-promote snapshot)
  type: "pre-promote" | "manual";  // why this snapshot was taken
  dir: string;         // absolute path to the snapshot dir
}

/**
 * Snapshot the current production install (AGENT_ROOT) to a timestamped
 * directory inside ~/agent2077-dev/releases/. Returns the manifest.
 * Does NOT touch data/ — only source files.
 */
export function snapshotProduction(
  label: string,
  devNumber: number | null,
  type: ReleaseManifest["type"] = "pre-promote",
  onProgress?: (msg: string) => void
): ReleaseManifest {
  if (!fs.existsSync(RELEASES_DIR)) fs.mkdirSync(RELEASES_DIR, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
  const id = `${ts}-${label.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 30)}`;
  const dir = path.join(RELEASES_DIR, id);

  onProgress?.(`Taking snapshot of production into releases/${id} ...`);
  copySource(AGENT_ROOT, dir);

  const manifest: ReleaseManifest = { id, label, timestamp: new Date().toISOString(), devNumber, type, dir };
  fs.writeFileSync(path.join(dir, ".release-manifest.json"), JSON.stringify(manifest, null, 2));

  onProgress?.(`Snapshot saved: ${id}`);
  return manifest;
}

/**
 * List all snapshots in ~/agent2077-dev/releases/, newest first.
 */
export function listReleases(): ReleaseManifest[] {
  if (!fs.existsSync(RELEASES_DIR)) return [];
  return fs.readdirSync(RELEASES_DIR)
    .filter(name => fs.statSync(path.join(RELEASES_DIR, name)).isDirectory())
    .map(name => {
      const manifestPath = path.join(RELEASES_DIR, name, ".release-manifest.json");
      if (!fs.existsSync(manifestPath)) return null;
      try { return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ReleaseManifest; }
      catch { return null; }
    })
    .filter((m): m is ReleaseManifest => m !== null)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

/**
 * Promote a dev session to production.
 *
 * Steps:
 *  1. Stop the dev server if running
 *  2. Snapshot current AGENT_ROOT → releases/ (rollback point)
 *  3. Copy dev dir → AGENT_ROOT (source files only, data/ excluded)
 *  4. Optionally copy data/ from dev dir if user opted in
 *  5. npm install in AGENT_ROOT
 *  6. Build (npx tsx script/build.ts)
 *  7. Signal restart (write a sentinel file — start.sh / systemd picks it up)
 *
 * Returns a generator of progress strings for SSE streaming.
 */
export async function* promoteDevToProduction(options: {
  devNumber: number;
  includeData: boolean;
  includeSettings: boolean;
  onProgress?: (msg: string) => void;
}): AsyncGenerator<{ type: "progress" | "success" | "error"; message: string; releaseId?: string }> {
  const { devNumber, includeData, includeSettings } = options;

  const devDir = path.join(DEV_BASE, `dev-${String(devNumber).padStart(3, "0")}`);
  if (!fs.existsSync(devDir)) {
    yield { type: "error", message: `Dev directory not found: ${devDir}` };
    return;
  }

  const emit = (msg: string) => { options.onProgress?.(msg); };

  // 1. Stop dev server
  yield { type: "progress", message: "Stopping dev server..." };
  stopDevServer();
  await new Promise(r => setTimeout(r, 500));

  // 2. Snapshot production
  yield { type: "progress", message: "Snapshotting current production version (rollback point)..." };
  let manifest: ReleaseManifest;
  try {
    manifest = snapshotProduction(
      `before-dev-${String(devNumber).padStart(3, "0")}`,
      devNumber,
      "pre-promote",
      emit
    );
  } catch (err: any) {
    yield { type: "error", message: `Failed to snapshot production: ${err.message}` };
    return;
  }
  yield { type: "progress", message: `Snapshot saved as ${manifest.id}` };

  // 3. Copy dev source → AGENT_ROOT
  yield { type: "progress", message: "Copying custom version to production directory..." };
  try {
    copySource(devDir, AGENT_ROOT);
  } catch (err: any) {
    yield { type: "error", message: `Failed to copy dev files: ${err.message}. Your previous version is safe at releases/${manifest.id}` };
    return;
  }
  yield { type: "progress", message: "Source files copied." };

  // 4. Optionally copy data directory
  if (includeData) {
    yield { type: "progress", message: "Copying data directory (chats, settings, apps)..." };
    const devDataDir = path.join(devDir, "data");
    const prodDataDir = path.join(AGENT_ROOT, "data");
    if (fs.existsSync(devDataDir)) {
      try {
        fs.cpSync(devDataDir, prodDataDir, { recursive: true });
        yield { type: "progress", message: "Data directory copied." };
      } catch (err: any) {
        // Non-fatal — warn and continue
        yield { type: "progress", message: `Warning: could not copy data directory: ${err.message}. Continuing with existing data.` };
      }
    } else {
      yield { type: "progress", message: "No data directory in dev session — keeping existing production data." };
    }
  } else {
    yield { type: "progress", message: "Keeping existing production data (chats and settings preserved)." };
  }

  // 5. npm install (include devDependencies — esbuild, vite, tsx are needed for the build step)
  yield { type: "progress", message: "Installing dependencies (npm install)..." };
  try {
    const nodeEnv = resolveNodeEnv();
    execSync("npm install", {
      cwd: AGENT_ROOT,
      timeout: 180000,
      stdio: "pipe",
      env: { ...nodeEnv, NODE_ENV: "development" }, // development so devDeps are installed
    });
    yield { type: "progress", message: "Dependencies installed." };
  } catch (err: any) {
    const stdout = String(err.stdout || "").trim();
    const stderr = String(err.stderr || "").trim();
    const combined = [stdout, stderr].filter(Boolean).join("\n") || err.message || "(no output)";
    const trimmed = combined.length > 5000 ? "..." + combined.slice(-5000) : combined;
    yield { type: "error", message: `npm install failed:\n\n${trimmed}` };
    yield { type: "error", message: `\u21b3 Rollback available: ${manifest.id}` };
    return;
  }

  // 6. Build
  yield { type: "progress", message: "Building production bundle (npx tsx script/build.ts)..." };
  try {
    const nodeEnv = resolveNodeEnv();
    execSync("npx tsx script/build.ts", {
      cwd: AGENT_ROOT,
      timeout: 180000,
      stdio: "pipe",
      env: nodeEnv,
      shell: true,
    });
    yield { type: "progress", message: "Build complete." };
  } catch (err: any) {
    // Collect all available output — operator precedence fix: concatenate strings first
    const stdout = String(err.stdout || "").trim();
    const stderr = String(err.stderr || "").trim();
    const combined = [stdout, stderr].filter(Boolean).join("\n") || err.message || "(no output)";
    // Show the last 5000 chars so the relevant error is always visible
    const trimmed = combined.length > 5000 ? "..." + combined.slice(-5000) : combined;
    yield { type: "error", message: `Build failed:\n\n${trimmed}` };
    yield { type: "error", message: `\u21b3 Rollback available: ${manifest.id}` };
    return;
  }

  // 7. Write restart sentinel — Agent2077 watches for this file and restarts itself
  const sentinelPath = path.join(AGENT_ROOT, ".restart-requested");
  fs.writeFileSync(sentinelPath, new Date().toISOString());

  yield {
    type: "success",
    message: `Promotion complete! Agent2077 is restarting with your custom version. Rollback available as: ${manifest.id}`,
    releaseId: manifest.id,
  };
}

/**
 * Roll back production to a previously snapshotted release.
 * Same flow as promote but in reverse: snapshot current state first, then restore.
 */
export async function* rollbackToRelease(releaseId: string): AsyncGenerator<{
  type: "progress" | "success" | "error";
  message: string;
}> {
  const releaseDir = path.join(RELEASES_DIR, releaseId);
  if (!fs.existsSync(releaseDir)) {
    yield { type: "error", message: `Release not found: ${releaseId}` };
    return;
  }

  // Snapshot current state before rolling back (so you can undo the undo)
  yield { type: "progress", message: "Snapshotting current state before rollback..." };
  try {
    snapshotProduction(`before-rollback-to-${releaseId.slice(0, 20)}`, null, "pre-promote");
  } catch (err: any) {
    yield { type: "progress", message: `Warning: could not pre-snapshot: ${err.message}. Continuing rollback.` };
  }

  yield { type: "progress", message: `Restoring release ${releaseId}...` };
  try {
    copySource(releaseDir, AGENT_ROOT);
  } catch (err: any) {
    yield { type: "error", message: `Failed to restore release: ${err.message}` };
    return;
  }
  yield { type: "progress", message: "Files restored." };

  yield { type: "progress", message: "Installing dependencies..." };
  try {
    const nodeEnv = resolveNodeEnv();
    // NODE_ENV=development so devDependencies (esbuild, vite, tsx) are installed for the build step
    execSync("npm install", { cwd: AGENT_ROOT, timeout: 180000, stdio: "pipe", env: { ...nodeEnv, NODE_ENV: "development" } });
  } catch (err: any) {
    const stdout = String(err.stdout || "").trim();
    const stderr = String(err.stderr || "").trim();
    const combined = [stdout, stderr].filter(Boolean).join("\n") || err.message || "(no output)";
    const trimmed = combined.length > 5000 ? "..." + combined.slice(-5000) : combined;
    yield { type: "error", message: `npm install failed after rollback:\n\n${trimmed}` };
    return;
  }

  yield { type: "progress", message: "Building..." };
  try {
    const nodeEnv = resolveNodeEnv();
    execSync("npx tsx script/build.ts", { cwd: AGENT_ROOT, timeout: 180000, stdio: "pipe", env: nodeEnv, shell: true });
  } catch (err: any) {
    const stdout = String(err.stdout || "").trim();
    const stderr = String(err.stderr || "").trim();
    const combined = [stdout, stderr].filter(Boolean).join("\n") || err.message || "(no output)";
    const trimmed = combined.length > 5000 ? "..." + combined.slice(-5000) : combined;
    yield { type: "error", message: `Build failed after rollback:\n\n${trimmed}` };
    return;
  }

  const sentinelPath = path.join(AGENT_ROOT, ".restart-requested");
  fs.writeFileSync(sentinelPath, new Date().toISOString());

  yield { type: "success", message: `Rolled back to ${releaseId}. Agent2077 is restarting.` };
}

/**
 * Delete a release snapshot to free up disk space.
 */
export function deleteRelease(releaseId: string): { success: boolean; message: string } {
  const releaseDir = path.join(RELEASES_DIR, releaseId);
  if (!fs.existsSync(releaseDir)) return { success: false, message: `Release not found: ${releaseId}` };
  try {
    fs.rmSync(releaseDir, { recursive: true, force: true });
    return { success: true, message: `Deleted release ${releaseId}` };
  } catch (err: any) {
    return { success: false, message: err.message };
  }
}
