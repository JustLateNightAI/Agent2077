/**
 * Self-Development Tools v13 — Complete tool suite for Agent2077 self-improvement.
 * Replaces the naive v12.2 tools with a proper dev-workspace workflow:
 *   Init → Edit → Build → Start → Test → Visual QA → Iterate → Package
 *
 * All operations happen in ~/agent2077-dev/dev-NNN/, never touching production.
 */
import { registerTool, type ToolResult } from "./registry.js";
import { settingsStore } from "../storage.js";
import {
  initDevSession, buildDev, startDevServer, stopDevServer,
  getDevInfo, getDevLogs, healthCheck, diffFile, resetFile,
  resetAll, packageZip, readDevFile, writeDevFile, editDevFile,
  writeDevLines, rewriteDevFile, listDevFiles, runDevCommand, httpRequest, syncStable,
  gitCheckpoint, gitLog, gitDiffWorking, gitRollback,
  resetEnvFailureCount, getEnvFailureCount,
  DEV_BASE, STABLE_DIR, SCREENSHOTS_DIR,
} from "../lib/dev-workspace.js";
import { runAllTests, getTestSummary } from "../lib/self-dev-tests.js";
import fs from "fs";
import path from "path";
import { execSync, execFileSync } from "child_process";
import { randomUUID } from "crypto";

// ── Reset Permission Gate ─────────────────────────────────────────────────────
// Any destructive reset (file or workspace) requires explicit user approval.
// The agent calls the tool → gets a pending token → user approves/denies in UI
// → agent must call again with the token to execute. Tokens are single-use and
// expire after 5 minutes. Approval never carries over to the next call.

interface ResetPermission {
  id: string;
  type: "file" | "all";
  filePath?: string;        // for file resets
  status: "pending" | "approved" | "denied";
  createdAt: number;
  usedAt?: number;          // set when token is consumed — prevents reuse
}

export const pendingResetPermissions = new Map<string, ResetPermission>();

// Expire tokens older than 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [id, p] of Array.from(pendingResetPermissions)) {
    if (p.createdAt < cutoff) pendingResetPermissions.delete(id);
  }
}, 30000);

function createResetPermission(type: "file" | "all", filePath?: string): ResetPermission {
  const permission: ResetPermission = {
    id: randomUUID(),
    type,
    filePath,
    status: "pending",
    createdAt: Date.now(),
  };
  pendingResetPermissions.set(permission.id, permission);
  return permission;
}

function consumeResetPermission(token: string): { ok: boolean; reason: string } {
  const p = pendingResetPermissions.get(token);
  if (!p) return { ok: false, reason: "Permission token not found or expired. You must request a new permission." };
  if (p.usedAt) return { ok: false, reason: "Permission token already used. Each reset requires a fresh approval — request a new permission." };
  if (p.status === "pending") return { ok: false, reason: "User has not yet approved this reset. Wait for approval or request a new permission." };
  if (p.status === "denied") {
    pendingResetPermissions.delete(token);
    return { ok: false, reason: "User denied this reset. Do NOT attempt to reset this file again without explicit user instruction." };
  }
  // Approved — consume it (mark used so it can't be reused)
  p.usedAt = Date.now();
  pendingResetPermissions.set(token, p);
  return { ok: true, reason: "approved" };
}

// ── Guard ──────────────────────────────────────────────────────────

function requireSelfDevEnabled(): string | null {
  const enabled = settingsStore.get("selfDevEnabled");
  if (enabled !== "true") {
    return "Self-development is disabled. Enable it in Settings → Self-Development to allow Agent2077 to modify its own code.";
  }
  return null;
}

// Update the category type to include "self-dev"
// The registry accepts any string for category, so "self-dev" works.

// ── 1. selfdev_init ────────────────────────────────────────────────

registerTool("selfdev_init", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_init",
      description: "Initialize a new self-development session. Creates ~/agent2077-dev/stable/ (read-only reference) and ~/agent2077-dev/dev-NNN/ (working copy). Run this before any other self-dev tools.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  async execute(): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    try {
      const result = initDevSession();
      return {
        success: true,
        output: `Dev session initialized:\n  Dev directory: ${result.devDir}\n  Stable reference: ${result.stableDir}\n  Session number: ${result.devNumber}\n\nYou can now edit files with selfdev_write_file or selfdev_edit_file, then build with selfdev_build.`,
      };
    } catch (err: any) {
      return { success: false, output: `Init failed: ${err.message}` };
    }
  },
});

// ── 2. selfdev_status ──────────────────────────────────────────────

registerTool("selfdev_status", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_status",
      description: "Get the current self-dev session status: dev number, directories, server status, last build/test results.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  async execute(): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    const info = getDevInfo();
    const lines = [
      `Dev Session: ${info.devNumber ?? "none"}`,
      `Dev Dir: ${info.devDir ?? "not initialized"}`,
      `Stable Dir: ${info.stableDir}`,
      `Server: ${info.serverStatus} (port ${info.serverPort})`,
    ];

    if (info.lastBuild) {
      lines.push(`\nLast Build: ${info.lastBuild.success ? "SUCCESS" : "FAILED"} at ${info.lastBuild.timestamp}`);
      if (!info.lastBuild.success) lines.push(`  Output: ${info.lastBuild.output.slice(0, 500)}`);
    }
    if (info.lastTests) {
      lines.push(`\nLast Tests: ${info.lastTests.passed}/${info.lastTests.total} passed at ${info.lastTests.timestamp}`);
    }

    return { success: true, output: lines.join("\n") };
  },
});

// ── 3. selfdev_read_file ──────────────────────────────────────────

registerTool("selfdev_read_file", {
  category: "self-dev",
  maxResultSizeChars: 250000, // Exempt from default 50K cap — self-dev needs full file access
  definition: {
    type: "function",
    function: {
      name: "selfdev_read_file",
      description: "Read a file from the dev workspace (or stable reference). Path is relative to the dev/stable root (e.g. 'server/routes.ts', 'client/src/pages/chat.tsx').",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "File path relative to dev root" },
          source: { type: "string", enum: ["dev", "stable"], description: "Read from 'dev' (working copy) or 'stable' (reference). Default: dev" },
        },
        required: ["filePath"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    const content = await readDevFile(args.filePath, args.source || "dev");
    if (content === null) return { success: false, output: `File not found: ${args.filePath} (in ${args.source || "dev"})` };

    if (content.length > 200000) {
      return { success: true, output: content.slice(0, 200000) + `\n\n[TRUNCATED — ${content.length} chars total, showing first 200K]` };
    }
    return { success: true, output: content };
  },
});

// ── 3b. selfdev_read_files (batch) ──────────────────────────────────────────

registerTool("selfdev_read_files", {
  category: "self-dev",
  maxResultSizeChars: 500000,
  definition: {
    type: "function",
    function: {
      name: "selfdev_read_files",
      description: "Read multiple files from the dev workspace in one call. Use this instead of calling selfdev_read_file repeatedly — it saves a round-trip per file. Returns each file's content labelled with its path. If a file is not found it is noted but other files are still returned.",
      parameters: {
        type: "object",
        properties: {
          filePaths: {
            type: "array",
            items: { type: "string" },
            description: "Array of file paths relative to dev root (e.g. ['server/routes.ts', 'client/src/pages/chat.tsx'])",
          },
          source: {
            type: "string",
            enum: ["dev", "stable"],
            description: "Read from 'dev' (working copy) or 'stable' (reference). Default: dev",
          },
        },
        required: ["filePaths"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    const filePaths: string[] = args.filePaths || [];
    if (filePaths.length === 0) return { success: false, output: "filePaths array is empty" };
    if (filePaths.length > 20) return { success: false, output: "Too many files — max 20 per call" };

    const source: "dev" | "stable" = args.source || "dev";
    const parts: string[] = [];
    let anyFound = false;

    for (const filePath of filePaths) {
      const content = await readDevFile(filePath, source);
      if (content === null) {
        parts.push(`${'='.repeat(60)}\nFILE: ${filePath}\nSTATUS: NOT FOUND\n`);
      } else {
        anyFound = true;
        const truncated = content.length > 100000
          ? content.slice(0, 100000) + `\n[TRUNCATED — ${content.length} chars total, showing first 100K]`
          : content;
        parts.push(`${'='.repeat(60)}\nFILE: ${filePath} (${content.length} chars)\n${'='.repeat(60)}\n${truncated}`);
      }
    }

    return {
      success: anyFound,
      output: parts.join("\n\n") || "No files found",
    };
  },
});

// ── 4. selfdev_write_file ─────────────────────────────────────────

registerTool("selfdev_write_file", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_write_file",
      description: "Create a NEW file in the dev workspace. Fails if the file already exists (use selfdev_rewrite_file to overwrite). SAFETY: Content is syntax-validated before writing; writes are atomic with transaction log. Always run selfdev_build after writing. Path relative to dev root.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "File path relative to dev root" },
          content: { type: "string", description: "Full file content" },
        },
        required: ["filePath", "content"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    // Safety guard — selfdev_write_file is for NEW files only.
    // Use selfdev_rewrite_file if you need to overwrite an existing file.
    const { devDir } = getDevInfo();
    if (devDir) {
      const fullPath = path.join(devDir, args.filePath);
      if (fs.existsSync(fullPath)) {
        return {
          success: false,
          output: `File already exists: ${args.filePath}. Use selfdev_rewrite_file to overwrite an existing file.`,
        };
      }
    }

    const result = await writeDevFile(args.filePath, args.content);
    return { success: result.success, output: result.message };
  },
});

// ── 5. selfdev_edit_file ──────────────────────────────────────────

registerTool("selfdev_edit_file", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_edit_file",
      description: "Edit a file in the dev workspace by replacing a unique text section. The oldText must appear exactly once. SAFETY: (1) For files ≥400 lines you must call selfdev_read_file first in the same turn or this will be blocked. (2) The new content is syntax-validated before writing — the file is NOT modified if validation fails. (3) Writes are atomic: a .bak is kept until the write commits cleanly. Always run selfdev_build after editing.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "File path relative to dev root" },
          oldText: { type: "string", description: "Exact text to find (must be unique in file)" },
          newText: { type: "string", description: "Replacement text" },
        },
        required: ["filePath", "oldText", "newText"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    const result = await editDevFile(args.filePath, args.oldText, args.newText);
    return { success: result.success, output: result.message };
  },
});

// ── 6. selfdev_list_files ─────────────────────────────────────────

registerTool("selfdev_list_files", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_list_files",
      description: "List files in a directory of the dev workspace. Use to explore the codebase structure.",
      parameters: {
        type: "object",
        properties: {
          directory: { type: "string", description: "Directory relative to dev root (e.g. 'server/tools', 'client/src/pages'). Default: root" },
        },
        required: [],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    const files = listDevFiles(args.directory || ".");
    return { success: true, output: files.length > 0 ? files.join("\n") : "(empty directory)" };
  },
});

// ── 7. selfdev_build ──────────────────────────────────────────────

registerTool("selfdev_build", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_build",
      description: "Build the dev workspace by running `npx tsx script/build.ts` (Vite client + esbuild server). This is the ONLY correct way to build — never use npm run build, npm run dev, or selfdev_run_command to build. Run after every file change. If build fails, fix the error and call selfdev_build again (up to 2 retries).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  async execute(): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    const result = buildDev();
    if (result.success) {
      return { success: true, output: `Build succeeded.\n${result.output.slice(-1000)}` };
    }
    // On failure: surface the full compiler output.
    // Do NOT run selfdev_run_command with npm run build to "see the full error" — this IS the full error.
    const outputLen = result.output.length;
    return {
      success: false,
      output:
        `Build FAILED (${outputLen} chars of compiler output below — this is the complete error, do NOT re-run npm build manually).\n` +
        `Fix the TypeScript/import errors shown below, then call selfdev_build again.\n\n` +
        result.output,
    };
  },
});

// ── 8. selfdev_start_server ───────────────────────────────────────

registerTool("selfdev_start_server", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_start_server",
      description: "Start the dev server on port 5050 (accessible at http://devagent.local). Must build first with selfdev_build. The dev server runs alongside the production server (port 5000).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  async execute(): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    const result = startDevServer();
    return { success: result.success, output: result.message };
  },
});

// ── 9. selfdev_stop_server ────────────────────────────────────────

registerTool("selfdev_stop_server", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_stop_server",
      description: "Stop the dev server.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  async execute(): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    const result = stopDevServer();
    return { success: result.success, output: result.message };
  },
});

// ── 10. selfdev_health_check ──────────────────────────────────────

registerTool("selfdev_health_check", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_health_check",
      description: "Check if the dev server is healthy and responding.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  async execute(): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    const result = await healthCheck();
    return { success: result.healthy, output: result.status };
  },
});

// ── 11. selfdev_run_tests ─────────────────────────────────────────

registerTool("selfdev_run_tests", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_run_tests",
      description: "Run the automated test suite against the dev server. The dev server must be running (selfdev_start_server). Returns pass/fail for each test category.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  async execute(): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    try {
      const results = await runAllTests();
      const summary = getTestSummary(results.results);
      return {
        success: results.failed === 0,
        output: `Test Results: ${results.passed}/${results.total} passed, ${results.failed} failed\n${summary}`,
      };
    } catch (err: any) {
      return { success: false, output: `Tests failed to run: ${err.message}. Is the dev server running?` };
    }
  },
});

// ── 12. selfdev_logs ──────────────────────────────────────────────

registerTool("selfdev_logs", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_logs",
      description: "Get recent dev server logs. Useful for debugging crashes or errors after starting the dev server.",
      parameters: {
        type: "object",
        properties: {
          lines: { type: "number", description: "Number of lines to return (default: 50)" },
        },
        required: [],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    const logs = getDevLogs(args.lines || 50);
    return { success: true, output: logs.length > 0 ? logs.join("\n") : "(no logs yet)" };
  },
});

// ── 13. selfdev_diff ──────────────────────────────────────────────

registerTool("selfdev_diff", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_diff",
      description: "Show the diff between a file in dev/ vs stable/. Useful to review changes before packaging.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "File path relative to root (e.g. 'server/routes.ts')" },
        },
        required: ["filePath"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    const result = diffFile(args.filePath);
    return { success: true, output: result.hasDiff ? result.diff : "(no differences)" };
  },
});

// ── 14. selfdev_reset_file ────────────────────────────────────────
// REQUIRES USER APPROVAL — call without permissionToken to request permission,
// then call again with the token once the user approves in the UI.

registerTool("selfdev_reset_file", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_reset_file",
      description: [
        "Reset a single file in dev/ back to the stable/ version.",
        "⚠️  REQUIRES USER APPROVAL before executing.",
        "Step 1: Call WITHOUT permissionToken — this creates a permission request the user must approve in the UI.",
        "Step 2: Wait. Do NOT proceed until you receive confirmation that the user approved.",
        "Step 3: Call AGAIN with the permissionToken returned in step 1 to execute the reset.",
        "Each reset requires its own fresh approval — tokens are single-use and expire in 5 minutes.",
        "If the user denies: stop. Do NOT attempt to reset again without explicit user instruction.",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "File path relative to dev root (e.g. 'client/src/pages/chat.tsx')" },
          permissionToken: { type: "string", description: "Token from a prior permission request. Omit on first call to request approval." },
        },
        required: ["filePath"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    // No token — create a permission request
    if (!args.permissionToken) {
      const p = createResetPermission("file", args.filePath);
      return {
        success: false,
        output: [
          `⚠️  PERMISSION REQUIRED to reset '${args.filePath}'.`,
          `A permission request has been sent to the user (token: ${p.id}).`,
          `You must WAIT for the user to approve or deny in the UI before proceeding.`,
          `Once approved, call selfdev_reset_file again with permissionToken: "${p.id}".`,
          `Do NOT call any other tool or take any action until the user responds.`,
          `Token expires in 5 minutes.`,
        ].join("\n"),
        metadata: { permissionToken: p.id, status: "pending" },
      };
    }

    // Token provided — check approval
    const check = consumeResetPermission(args.permissionToken);
    if (!check.ok) {
      return { success: false, output: `Reset blocked: ${check.reason}` };
    }

    const result = resetFile(args.filePath);
    return { success: result.success, output: result.message };
  },
});

// ── 15. selfdev_reset_all ─────────────────────────────────────────
// REQUIRES USER APPROVAL — same two-step pattern as selfdev_reset_file.

registerTool("selfdev_reset_all", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_reset_all",
      description: [
        "Reset the ENTIRE dev workspace back to stable/. Stops the dev server. All uncommitted changes are lost.",
        "⚠️  REQUIRES USER APPROVAL — this is irreversible.",
        "Step 1: Call WITHOUT permissionToken to request approval.",
        "Step 2: Wait for the user to approve in the UI.",
        "Step 3: Call again with the permissionToken to execute.",
        "Single-use token, expires in 5 minutes. Never reuse a token.",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          permissionToken: { type: "string", description: "Token from prior permission request. Omit on first call." },
        },
        required: [],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    if (!args.permissionToken) {
      const p = createResetPermission("all");
      return {
        success: false,
        output: [
          `⚠️  PERMISSION REQUIRED to reset the ENTIRE dev workspace.`,
          `This will wipe all uncommitted changes. A permission request has been sent (token: ${p.id}).`,
          `Wait for user approval in the UI, then call selfdev_reset_all with permissionToken: "${p.id}".`,
          `Do NOT take any action until the user responds. Token expires in 5 minutes.`,
        ].join("\n"),
        metadata: { permissionToken: p.id, status: "pending" },
      };
    }

    const check = consumeResetPermission(args.permissionToken);
    if (!check.ok) {
      return { success: false, output: `Reset blocked: ${check.reason}` };
    }

    const result = resetAll();
    return { success: result.success, output: result.message };
  },
});

// ── 16. selfdev_package ───────────────────────────────────────────

registerTool("selfdev_package", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_package",
      description: "Build and package the dev workspace into a tarball (.tar.gz). The tarball is saved to ~/agent2077-dev/. This does NOT auto-promote to production — the user must manually deploy.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  async execute(): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    const result = packageZip();
    if (!result.success) return { success: false, output: result.message };
    return { success: true, output: result.message };
  },
});

// ── 17. selfdev_run_command ───────────────────────────────────────

registerTool("selfdev_run_command", {
  category: "self-dev",
  maxResultSizeChars: 250000, // Needs full output for reading files, build logs, etc.
  definition: {
    type: "function",
    function: {
      name: "selfdev_run_command",
      description: "Run a shell command in the dev workspace directory. Use for: npm install, git commands, running tests, and grep. Do NOT use for builds — always use selfdev_build instead (never npm run build or npx tsx script/build.ts directly). Do NOT use to read file contents — use selfdev_read_file or selfdev_search_files instead. Dangerous commands are blocked. NOTE: grep returning no matches is a SUCCESS (success:true, output:'(no matches)') — not an error. Only treat failure (success:false) as a real problem.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run in the dev directory" },
        },
        required: ["command"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    // Block dangerous commands
    const dangerous = ["rm -rf /", "rm -rf ~", "mkfs", "dd if=", ":(){", "chmod -R 777 /", "shutdown", "reboot"];
    if (dangerous.some(d => args.command.includes(d))) {
      return { success: false, output: "Command blocked — contains dangerous pattern." };
    }

    // Block anything targeting port 5000 — that is the production server.
    // The dev server runs on port 5050. Never kill, bind to, or interact with port 5000.
    if (/(?:^|\s|:)5000(?:\s|$|[^0-9])/.test(args.command) && !args.command.includes("5050")) {
      return { success: false, output: "Command blocked — port 5000 is the production server. The dev server runs on port 5050. Use port 5050 for all dev server interactions." };
    }

    // Block any command that writes to the stable directory.
    // stable/ is the clean reference baseline — it must never be modified by the agent.
    // Only selfdev_sync_stable (which copies from production) is allowed to touch it.
    const stablePathVariants = [
      STABLE_DIR,                          // absolute path e.g. /home/.../agent2077-dev/stable
      "agent2077-dev/stable",              // relative segment
      "/stable/",                          // path fragment
      "../stable",                         // relative traversal from dev dir
      "../../stable",                      // deeper traversal
    ];
    const writingPatterns = /\bcp\b|\bmv\b|\brm\b|\brsync\b|\btee\b|\btouch\b|\bchmod\b|\bchown\b|>>|>(?!>?\s*\/dev\/null)|\bwrite\b|\binstall\b/;
    if (writingPatterns.test(args.command) && stablePathVariants.some(p => args.command.includes(p))) {
      return {
        success: false,
        output: "Command blocked — stable/ is a protected reference baseline and cannot be modified by commands. " +
          "Only selfdev_sync_stable is allowed to update stable/ (it re-copies from production). " +
          "Make your changes in the dev workspace (dev-NNN/) only.",
      };
    }

    // Block file-reading commands — these waste iterations. Use selfdev_read_file / selfdev_search_files instead.
    // Detect: sed -n, awk NR, cat <file>, head <file>, tail <file>, python3 -c with open(), python3 << with open()
    const fileReadPatterns = [
      /^\s*sed\s+-n/,                        // sed -n 'Xp' file
      /^\s*awk\s+['"]/,                      // awk 'NR>=X' file
      /^\s*head\s+/,                         // head -N file
      /^\s*tail\s+/,                         // tail -N file
      /^\s*cat\s+[^|]/,                      // cat file (not piping)
      /open\s*\(['"][^'"]*\.tsx?['"].*['"]r['"]\)/, // python open("*.ts", "r")
      /open\s*\(['"][^'"]*\.tsx?['"]\)/,    // python open("*.ts")
    ];
    if (fileReadPatterns.some(p => p.test(args.command))) {
      return {
        success: false,
        output: "selfdev_run_command cannot be used to read file contents. Use selfdev_read_file with the file path instead — it is faster and returns the full content with line numbers. Example: selfdev_read_file({\"filePath\": \"client/src/pages/chat.tsx\"})",
      };
    }

    const result = runDevCommand(args.command);
    return { success: result.success, output: result.output };
  },
});

// ── 18. selfdev_http_test ─────────────────────────────────────────

registerTool("selfdev_http_test", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_http_test",
      description: "Make an HTTP request to the dev server for exploratory testing. Useful for testing API endpoints directly.",
      parameters: {
        type: "object",
        properties: {
          method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH"], description: "HTTP method" },
          path: { type: "string", description: "URL path (e.g. '/api/conversations')" },
          body: { type: "string", description: "JSON body for POST/PUT/PATCH (optional)" },
        },
        required: ["method", "path"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    const body = args.body ? JSON.parse(args.body) : undefined;
    const result = await httpRequest(args.method, args.path, body);
    return {
      success: result.status >= 200 && result.status < 400,
      output: `HTTP ${result.status}\n${result.body}`,
    };
  },
});

// ── 19. selfdev_sync_stable ───────────────────────────────────────

registerTool("selfdev_sync_stable", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_sync_stable",
      description: "Re-sync the stable/ reference directory from production. Use if production was updated and you want stable/ to reflect the latest.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  async execute(): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    try {
      syncStable();
      return { success: true, output: "Stable reference updated from production." };
    } catch (err: any) {
      return { success: false, output: `Sync failed: ${err.message}` };
    }
  },
});

// ── 20. selfdev_update_architecture ───────────────────────────────

registerTool("selfdev_update_architecture", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_update_architecture",
      description: "Update ARCHITECTURE.md in the dev workspace. Call this ONLY after changes are verified (build + tests pass). Provide the section to update and the new content.",
      parameters: {
        type: "object",
        properties: {
          section: { type: "string", description: "Section heading to update (e.g. '## Tool System', '## Database Schema')" },
          content: { type: "string", description: "New content for this section (replaces from heading to next heading)" },
        },
        required: ["section", "content"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    const archContent = await readDevFile("ARCHITECTURE.md");
    if (!archContent) return { success: false, output: "ARCHITECTURE.md not found in dev workspace" };

    // Find section boundaries
    const sectionIdx = archContent.indexOf(args.section);
    if (sectionIdx === -1) {
      // Append new section
      const updated = archContent.trimEnd() + "\n\n" + args.section + "\n\n" + args.content + "\n";
      const result = await writeDevFile("ARCHITECTURE.md", updated);
      return { success: result.success, output: `Added new section: ${args.section}` };
    }

    // Find next section of same level
    const level = args.section.match(/^#+/)?.[0] || "##";
    const rest = archContent.slice(sectionIdx + args.section.length);
    const nextSectionMatch = rest.match(new RegExp(`^${level} `, "m"));
    const endIdx = nextSectionMatch
      ? sectionIdx + args.section.length + (nextSectionMatch.index ?? rest.length)
      : archContent.length;

    const updated = archContent.slice(0, sectionIdx) + args.section + "\n\n" + args.content + "\n\n" + archContent.slice(endIdx);
    const result = await writeDevFile("ARCHITECTURE.md", updated);
    return { success: result.success, output: `Updated section: ${args.section}` };
  },
});

// ── 21. selfdev_log_change ────────────────────────────────────────

registerTool("selfdev_log_change", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_log_change",
      description: "Append a change entry to the dev session's DEV_LOG.md. Call after each verified change (build + tests pass).",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "What was changed and why" },
          filesChanged: { type: "string", description: "Comma-separated list of files modified" },
          testsPassing: { type: "boolean", description: "Whether tests are passing after this change" },
        },
        required: ["description", "filesChanged"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    const logContent = await readDevFile("DEV_LOG.md");
    if (!logContent) return { success: false, output: "DEV_LOG.md not found — run selfdev_init first" };

    const entry = `\n### ${new Date().toISOString()}\n- **Change**: ${args.description}\n- **Files**: ${args.filesChanged}\n- **Tests**: ${args.testsPassing !== false ? "passing" : "FAILING"}\n`;

    const updated = logContent + entry;
    const result = await writeDevFile("DEV_LOG.md", updated);
    return { success: result.success, output: `Logged change: ${args.description}` };
  },
});

// ── 22. selfdev_analyze_screenshot ────────────────────────────────

registerTool("selfdev_analyze_screenshot", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_analyze_screenshot",
      description: "Analyze a screenshot provided by the user to identify visual bugs. The user can upload a screenshot in the self-dev chat and you describe what needs fixing.",
      parameters: {
        type: "object",
        properties: {
          screenshotDescription: { type: "string", description: "Describe what you see in the screenshot and what appears broken" },
          suggestedFix: { type: "string", description: "Your analysis of what file/component likely needs fixing and how" },
        },
        required: ["screenshotDescription", "suggestedFix"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    return {
      success: true,
      output: `Screenshot Analysis:\n${args.screenshotDescription}\n\nSuggested Fix:\n${args.suggestedFix}\n\nUse selfdev_read_file to examine the relevant files, then selfdev_edit_file to fix the issue.`,
    };
  },
});

// ── 23. selfdev_write_lines ───────────────────────────────────────

registerTool("selfdev_write_lines", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_write_lines",
      description: "Replace a range of lines (startLine to endLine, 1-based inclusive) with new content. SAFETY: (1) DISABLED for files ≥400 lines — use selfdev_rewrite_file instead. (2) For files ≥400 lines you must call selfdev_read_file first or this will be blocked. (3) New content is syntax-validated before writing. (4) Writes are atomic with backup. Returns surrounding context to verify placement. Every call makes all previously looked-up line numbers stale.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "File path relative to dev root" },
          startLine: { type: "number", description: "First line to replace (1-based)" },
          endLine: { type: "number", description: "Last line to replace (1-based, inclusive)" },
          newContent: { type: "string", description: "Replacement content (will replace lines startLine through endLine)" },
        },
        required: ["filePath", "startLine", "endLine", "newContent"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    const result = await writeDevLines(args.filePath, args.startLine, args.endLine, args.newContent);
    return { success: result.success, output: result.message };
  },
});

// ── 23b. selfdev_rewrite_file ─────────────────────────────────────
// Full-file rewrite — eliminates line-offset drift for files needing 4+ changes.

registerTool("selfdev_rewrite_file", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_rewrite_file",
      description: "Rewrite an EXISTING file with completely new content — the PREFERRED tool for any file ≥400 lines or when making 4+ changes. Read the whole file first, incorporate ALL changes, write once. SAFETY: Content is syntax-validated before writing; writes are atomic with .bak backup and transaction log. Eliminates line-offset drift entirely. Do NOT use for new files (use selfdev_write_file). Do NOT use if you only have a partial view of the file.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "File path relative to dev root (file must already exist)" },
          content: { type: "string", description: "Complete new file content — must include the entire file, not just changed sections" },
        },
        required: ["filePath", "content"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    const result = await rewriteDevFile(args.filePath, args.content);
    return { success: result.success, output: result.message };
  },
});

// ── 24. selfdev_git_checkpoint ─────────────────────────────────────

registerTool("selfdev_git_checkpoint", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_git_checkpoint",
      description: "Commit all current changes in the dev workspace as a named checkpoint. Call this after a successful build + test pass to create a safe rollback point. Git is automatically initialized when a dev session starts.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Short description of what was done (e.g. 'added inpaint canvas component')" },
        },
        required: ["message"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    const result = gitCheckpoint(args.message);
    return { success: result.success, output: result.message };
  },
});

// ── 25. selfdev_git_log ────────────────────────────────────────────

registerTool("selfdev_git_log", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_git_log",
      description: "Show recent git commits in the dev workspace. Use to review checkpoint history or find a hash to roll back to.",
      parameters: {
        type: "object",
        properties: {
          count: { type: "number", description: "Number of commits to show (default: 10)" },
        },
        required: [],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    const result = gitLog(args.count || 10);
    return { success: result.success, output: result.output || "(no commits yet)" };
  },
});

// ── 26. selfdev_git_diff ───────────────────────────────────────────

registerTool("selfdev_git_diff", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_git_diff",
      description: "Show all uncommitted changes in the dev workspace as a unified diff. Useful to review what has changed since the last checkpoint before committing or rolling back.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  async execute(): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    const result = gitDiffWorking();
    return { success: result.success, output: result.output || "(no uncommitted changes)" };
  },
});

// ── 27. selfdev_git_rollback ───────────────────────────────────────

registerTool("selfdev_git_rollback", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_git_rollback",
      description: "Hard reset the dev workspace to a previous git commit. Use selfdev_git_log to find the commit hash first. This discards all changes since that commit — use with care.",
      parameters: {
        type: "object",
        properties: {
          commitHash: { type: "string", description: "The commit hash to roll back to (from selfdev_git_log output)" },
        },
        required: ["commitHash"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    const result = gitRollback(args.commitHash);
    return { success: result.success, output: result.message };
  },
});

// ── 28. selfdev_save_session_summary ──────────────────────────────

registerTool("selfdev_save_session_summary", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_save_session_summary",
      description: "Write a structured SESSION_SUMMARY.md at the end of a dev session. This summary is injected at the top of the next session's context so the next agent instance knows exactly where to pick up. Call this before packaging.",
      parameters: {
        type: "object",
        properties: {
          featuresAdded: { type: "string", description: "Bullet list of features or improvements added this session" },
          bugsFixed: { type: "string", description: "Bullet list of bugs fixed this session" },
          knownIssues: { type: "string", description: "Any remaining issues or things that didn't work" },
          nextSteps: { type: "string", description: "What should be done in the next session" },
          filesChanged: { type: "string", description: "Comma-separated list of files that were modified" },
        },
        required: ["featuresAdded", "nextSteps"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    const content = `# Session Summary\nGenerated: ${new Date().toISOString()}\n\n## Features Added\n${args.featuresAdded}\n\n## Bugs Fixed\n${args.bugsFixed || "(none)"}\n\n## Known Issues\n${args.knownIssues || "(none)"}\n\n## Files Changed\n${args.filesChanged || "(not recorded)"}\n\n## Next Steps\n${args.nextSteps}\n`;

    const result = await writeDevFile("SESSION_SUMMARY.md", content);
    // Also checkpoint the summary
    gitCheckpoint("session summary written");
    return { success: result.success, output: result.success ? "SESSION_SUMMARY.md saved. This will be injected at the start of the next dev session." : result.message };
  },
});

// ── 29. selfdev_search_files ──────────────────────────────────────
// Replaces `search_files` in self-dev context — searches the dev workspace
// directly, bypassing the workspace/ path restriction that makes search_files
// return no results when called from self-dev.

registerTool("selfdev_search_files", {
  category: "self-dev",
  definition: {
    type: "function",
    function: {
      name: "selfdev_search_files",
      description: "Search for text patterns in the dev workspace using grep. Use this instead of search_files — search_files cannot reach the dev workspace directory. Returns matching lines with file paths, line numbers, and surrounding context lines so you can act on results without a follow-up selfdev_read_file call.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Search pattern (regex supported, e.g. 'inpaint_request', 'useState.*null', 'export function')",
          },
          subPath: {
            type: "string",
            description: "Subdirectory within the dev workspace to search (e.g. 'client/src', 'server/lib'). Omit to search the entire dev workspace.",
          },
          fileGlob: {
            type: "string",
            description: "File pattern to match (e.g. '*.ts', '*.tsx', '*.json'). Omit to search all files.",
          },
          contextLines: {
            type: "number",
            description: "Number of lines of context to show before and after each match (default: 4). Increase to see more surrounding code.",
          },
        },
        required: ["pattern"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireSelfDevEnabled();
    if (err) return { success: false, output: err };

    const info = getDevInfo();
    if (!info.devDir) {
      return { success: false, output: "No active dev session. Run selfdev_init first." };
    }

    const { pattern, subPath, fileGlob } = args;
    const contextLines = Math.min(Math.max(Number(args.contextLines ?? 4), 0), 20);
    const searchRoot = subPath
      ? path.join(info.devDir, subPath)
      : info.devDir;

    if (!fs.existsSync(searchRoot)) {
      return { success: false, output: `Path does not exist in dev workspace: ${subPath || "(root)"}` };
    }

    // Build argv for grep — no shell interpolation so pattern/subPath/fileGlob
    // cannot inject commands regardless of what the model passes.
    const grepArgs: string[] = ["-rn", `-C${contextLines}`];
    if (fileGlob) grepArgs.push(`--include=${fileGlob}`);
    grepArgs.push(pattern, searchRoot);

    try {
      // execFileSync spawns grep directly (no shell), result is raw bytes
      const rawResult = execFileSync("grep", grepArgs, {
        encoding: "utf-8",
        timeout: 15000,
        maxBuffer: 1024 * 1024 * 5,
      });
      // Strip the dev dir prefix from paths so results are relative and readable
      const devDirPrefix = info.devDir.endsWith("/") ? info.devDir : info.devDir + "/";
      const stripped = rawResult.split("\n").map(l => l.startsWith(devDirPrefix) ? l.slice(devDirPrefix.length) : l).join("\n");
      const trimmed = stripped.trim();
      // Limit output to first 200 lines
      const lines = trimmed.split("\n");
      const limited = lines.slice(0, 200).join("\n");
      if (!limited.trim()) {
        return { success: true, output: `No matches found for "${pattern}" in ${subPath || "(dev root)"}` };
      }
      return {
        success: true,
        output: `Matches for "${pattern}" (with ${contextLines} lines of context) — ${Math.min(lines.length, 200)} lines returned:\n\n${limited}\n\n[END OF SEARCH RESULTS — if you expected more matches, use a narrower subPath or fileGlob to reduce output]`,
      };
    } catch (err: any) {
      // grep exits with code 1 for "no matches" — that is not a failure
      if (err.status === 1) {
        return { success: true, output: `No matches found for "${pattern}" in ${subPath || "(dev root)"}` };
      }
      return { success: false, output: `Search failed: ${err.message}` };
    }
  },
});
