/**
 * File Tools — Read, write, list, search files in the workspace
 * 
 * v10.1: Uses native filesystem operations directly. Docker sandboxing
 * is only needed for arbitrary code execution, not for file I/O that
 * the agent controls. This fixes the critical bug where ALL file
 * operations silently failed when Docker was unavailable.
 */
import { registerTool, type ToolResult, type ToolContext } from "./registry.js";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

// Workspace root — all file operations are relative to this
const WORKSPACE_DIR = path.join(process.cwd(), "workspace");

/**
 * Resolve and validate a file path. Ensures the path is within the workspace.
 * Returns the absolute path or throws if the path tries to escape.
 */
function resolveSafePath(filePath: string): string {
  // Strip leading /workspace prefix if present (models often include it)
  let cleaned = filePath;
  if (cleaned.startsWith("/workspace/")) {
    cleaned = cleaned.slice("/workspace/".length);
  } else if (cleaned.startsWith("/workspace")) {
    cleaned = cleaned.slice("/workspace".length);
  }
  // Also handle relative paths
  if (cleaned.startsWith("/")) {
    cleaned = cleaned.slice(1);
  }

  const resolved = path.resolve(WORKSPACE_DIR, cleaned);

  // Security: ensure resolved path is within workspace
  if (!resolved.startsWith(WORKSPACE_DIR)) {
    throw new Error(`Path escapes workspace: ${filePath}`);
  }

  return resolved;
}

registerTool("read_file", {
  category: "file",
  definition: {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file from the workspace. Returns the file content as text.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to /workspace" },
          max_lines: { type: "number", description: "Maximum lines to read (default 500)" },
        },
        required: ["path"],
      },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const { path: filePath, max_lines = 500 } = args;
    try {
      const absPath = resolveSafePath(filePath);

      if (!fs.existsSync(absPath)) {
        return { success: false, output: `File not found: ${filePath}` };
      }

      const stat = fs.statSync(absPath);
      if (stat.isDirectory()) {
        return { success: false, output: `Path is a directory, not a file: ${filePath}` };
      }

      const content = fs.readFileSync(absPath, "utf-8");
      const lines = content.split("\n");

      if (lines.length > max_lines) {
        const truncated = lines.slice(0, max_lines).join("\n");
        return { success: true, output: `${truncated}\n\n... (${lines.length - max_lines} more lines truncated, ${lines.length} total)` };
      }

      return { success: true, output: content };
    } catch (err: any) {
      return { success: false, output: `Read failed: ${err.message}` };
    }
  },
});

registerTool("write_file", {
  category: "file",
  definition: {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file in the workspace. Creates the file and any parent directories if they don't exist.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to /workspace" },
          content: { type: "string", description: "Content to write to the file" },
        },
        required: ["path", "content"],
      },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const { path: filePath, content } = args;

    if (!content || content.length === 0) {
      return { success: false, output: `Write failed: content is empty. You must provide file content.` };
    }

    try {
      const absPath = resolveSafePath(filePath);

      // Create parent directories
      const dir = path.dirname(absPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(absPath, content, "utf-8");

      const stat = fs.statSync(absPath);
      return { success: true, output: `Written ${stat.size} bytes to ${filePath}` };
    } catch (err: any) {
      return { success: false, output: `Write failed: ${err.message}` };
    }
  },
});

registerTool("list_files", {
  category: "file",
  definition: {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and directories in the workspace. Returns a tree-like listing.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path relative to /workspace (default: /workspace)" },
          max_depth: { type: "number", description: "Maximum depth to recurse (default 3)" },
        },
        required: [],
      },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const { path: dirPath = "/workspace", max_depth = 3 } = args;
    try {
      const absPath = resolveSafePath(dirPath);

      if (!fs.existsSync(absPath)) {
        return { success: false, output: `Directory not found: ${dirPath}` };
      }

      // Use find command for tree listing (available on all Linux systems)
      try {
        const result = execSync(
          `find "${absPath}" -maxdepth ${max_depth} -not -path '*/node_modules/*' -not -path '*/.git/*' | head -200 | sort`,
          { encoding: "utf-8", timeout: 10000 }
        );
        return { success: true, output: result || "(empty directory)" };
      } catch {
        // Fallback: manual recursive listing
        const entries = listRecursive(absPath, max_depth, 0);
        return { success: true, output: entries.join("\n") || "(empty directory)" };
      }
    } catch (err: any) {
      return { success: false, output: `List failed: ${err.message}` };
    }
  },
});

function listRecursive(dir: string, maxDepth: number, currentDepth: number): string[] {
  if (currentDepth >= maxDepth) return [];
  const entries: string[] = [];

  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.name === "node_modules" || item.name === ".git") continue;
      const fullPath = path.join(dir, item.name);
      entries.push(fullPath);
      if (item.isDirectory()) {
        entries.push(...listRecursive(fullPath, maxDepth, currentDepth + 1));
      }
    }
  } catch { /* permission denied etc */ }

  return entries;
}

registerTool("search_files", {
  category: "file",
  definition: {
    type: "function",
    function: {
      name: "search_files",
      description: "Search for text patterns in files using grep. Returns matching lines with file paths and line numbers.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Search pattern (regex supported)" },
          path: { type: "string", description: "Directory to search in (default /workspace)" },
          file_glob: { type: "string", description: "File pattern to match (e.g., '*.py', '*.ts')" },
        },
        required: ["pattern"],
      },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const { pattern, path: searchPath = "/workspace", file_glob } = args;
    try {
      const absPath = resolveSafePath(searchPath);
      const includeFlag = file_glob ? `--include="${file_glob}"` : "";

      try {
        const result = execSync(
          `grep -rn ${includeFlag} "${pattern.replace(/"/g, '\\"')}" "${absPath}" 2>/dev/null | head -100`,
          { encoding: "utf-8", timeout: 15000 }
        );
        return { success: true, output: result || `No matches found for "${pattern}"` };
      } catch (err: any) {
        // grep returns exit code 1 when no matches found — that's not an error
        if (err.status === 1) {
          return { success: true, output: `No matches found for "${pattern}"` };
        }
        return { success: false, output: `Search failed: ${err.message}` };
      }
    } catch (err: any) {
      return { success: false, output: `Search failed: ${err.message}` };
    }
  },
});

// ── rename_file ───────────────────────────────────────────────────────────────
registerTool("rename_file", {
  category: "file",
  definition: {
    type: "function",
    function: {
      name: "rename_file",
      description:
        "Rename or move a file or directory within the workspace. Preserves git history if the project is a git repo (uses git mv when available, falls back to fs.rename). Use this instead of delete + recreate.",
      parameters: {
        type: "object",
        properties: {
          from: {
            type: "string",
            description: "Current file path relative to /workspace",
          },
          to: {
            type: "string",
            description: "New file path relative to /workspace (can be in a different directory to move)",
          },
        },
        required: ["from", "to"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const { from: fromRaw, to: toRaw } = args;

    try {
      const absFrom = resolveSafePath(String(fromRaw));
      const absTo   = resolveSafePath(String(toRaw));

      if (!fs.existsSync(absFrom)) {
        return { success: false, output: `Source not found: ${fromRaw}` };
      }
      if (fs.existsSync(absTo)) {
        return { success: false, output: `Destination already exists: ${toRaw}. Delete it first if you want to overwrite.` };
      }

      // Ensure destination parent directory exists
      const toDir = path.dirname(absTo);
      fs.mkdirSync(toDir, { recursive: true });

      // Try git mv first (preserves history)
      let usedGitMv = false;
      try {
        const { execSync } = await import("child_process");
        execSync(`git mv "${absFrom}" "${absTo}"`, { cwd: WORKSPACE_DIR, stdio: "pipe" });
        usedGitMv = true;
      } catch {
        // Not a git repo, or git mv failed — fall back to fs.rename
        fs.renameSync(absFrom, absTo);
      }

      return {
        success: true,
        output: `Renamed ${fromRaw} → ${toRaw}${usedGitMv ? " (via git mv — history preserved)" : ""}`,
        metadata: { from: fromRaw, to: toRaw, gitMv: usedGitMv },
      };
    } catch (err: any) {
      return { success: false, output: `Rename failed: ${err.message}` };
    }
  },
});
