/**
 * Read Project Tool — Scan workspace and return a structured project overview
 *
 * Returns a file tree with sizes and optional content previews of key files.
 * Helps the agent understand what exists before making changes.
 * Uses native filesystem operations (NOT Docker).
 */
import { registerTool, type ToolResult, type ToolContext } from "./registry.js";
import fs from "fs";
import path from "path";

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

/** Directories to always skip during traversal */
const SKIP_DIRS = new Set(["node_modules", ".git", ".svn", ".hg", "dist", ".cache", ".next"]);

/** Key filenames whose content should be previewed */
const KEY_FILE_PATTERNS: RegExp[] = [
  /^package\.json$/,
  /^index\.html$/,
  /^index\.(ts|js|tsx|jsx)$/,
  /^main\.(ts|js|tsx|jsx|py|go|rs)$/,
  /^app\.(ts|js|tsx|jsx|py)$/,
  /^style(s)?\.css$/,
  /^README(\.md|\.txt|\.rst)?$/i,
  /^Dockerfile$/,
];

function isKeyFile(name: string): boolean {
  return KEY_FILE_PATTERNS.some((re) => re.test(name));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

interface TreeEntry {
  absPath: string;
  relPath: string;
  isDir: boolean;
  size: number;
  depth: number;
  name: string;
}

/**
 * Recursively walk a directory, collecting entries.
 * Skips SKIP_DIRS. Respects maxDepth.
 */
function walkDir(
  dir: string,
  rootDir: string,
  maxDepth: number,
  currentDepth: number,
  entries: TreeEntry[]
): void {
  if (currentDepth > maxDepth) return;

  let items: fs.Dirent[];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // permission denied or other error — skip silently
  }

  // Sort: directories first, then files, both alphabetically
  items.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const item of items) {
    if (item.name.startsWith(".") && item.name !== ".env" && item.name !== ".gitignore") {
      // Skip hidden files/dirs except a few useful ones
      if (item.isDirectory()) continue;
    }
    if (item.isDirectory() && SKIP_DIRS.has(item.name)) continue;

    const absPath = path.join(dir, item.name);
    const relPath = path.relative(rootDir, absPath);

    let size = 0;
    if (!item.isDirectory()) {
      try {
        size = fs.statSync(absPath).size;
      } catch {
        // ignore
      }
    }

    entries.push({
      absPath,
      relPath,
      isDir: item.isDirectory(),
      size,
      depth: currentDepth,
      name: item.name,
    });

    if (item.isDirectory()) {
      walkDir(absPath, rootDir, maxDepth, currentDepth + 1, entries);
    }
  }
}

/**
 * Build an indented tree string from the collected entries.
 */
function buildTreeString(entries: TreeEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    const indent = "  ".repeat(entry.depth);
    if (entry.isDir) {
      lines.push(`${indent}${entry.name}/`);
    } else {
      lines.push(`${indent}${entry.name}  (${formatSize(entry.size)})`);
    }
  }
  return lines.join("\n");
}

/**
 * Read the first N lines of a file, handling encoding errors gracefully.
 */
function readFirstLines(absPath: string, maxLines: number): string {
  try {
    const content = fs.readFileSync(absPath, "utf-8");
    const lines = content.split("\n");
    if (lines.length <= maxLines) return content;
    return lines.slice(0, maxLines).join("\n") + `\n... (${lines.length - maxLines} more lines)`;
  } catch {
    return "(could not read file)";
  }
}

registerTool("read_project", {
  category: "file",
  definition: {
    type: "function",
    function: {
      name: "read_project",
      description:
        "Scan the workspace to understand the project structure. Returns a file tree with sizes and optional content previews of key files (like package.json, index.html, etc). Use this BEFORE modifying existing projects.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path relative to /workspace (default: /workspace)",
          },
          include_previews: {
            type: "boolean",
            description:
              "Include first 20 lines of key files like package.json, index.html, README (default true)",
          },
          max_depth: {
            type: "number",
            description: "Maximum directory depth (default 4)",
          },
        },
        required: [],
      },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const {
      path: dirPath = "/workspace",
      include_previews = true,
      max_depth = 4,
    } = args;

    try {
      const absRoot = resolveSafePath(dirPath);

      if (!fs.existsSync(absRoot)) {
        return { success: false, output: `Directory not found: ${dirPath}` };
      }

      const rootStat = fs.statSync(absRoot);
      if (!rootStat.isDirectory()) {
        return { success: false, output: `Path is not a directory: ${dirPath}` };
      }

      // Walk the directory tree
      const entries: TreeEntry[] = [];
      walkDir(absRoot, absRoot, max_depth, 0, entries);

      // Build the tree string
      const rootLabel = dirPath.startsWith("/workspace") ? dirPath : `/workspace/${dirPath}`.replace(/\/+/g, "/");
      const treeLines = [`${rootLabel}/`, buildTreeString(entries)];
      const treeString = treeLines.join("\n");

      const parts: string[] = [];
      parts.push("=== Project Structure ===");
      parts.push(treeString);

      const totalFiles = entries.filter((e) => !e.isDir).length;
      const totalDirs = entries.filter((e) => e.isDir).length;
      const totalSize = entries.filter((e) => !e.isDir).reduce((sum, e) => sum + e.size, 0);
      parts.push(`\n${totalFiles} files, ${totalDirs} directories, ${formatSize(totalSize)} total`);

      // Optionally include previews of key files — capped per file and overall
      const MAX_FILE_PREVIEW = 8 * 1024; // 8KB per file
      const MAX_TOTAL_OUTPUT = 32 * 1024; // 32KB total output

      if (include_previews) {
        const keyFiles = entries.filter((e) => !e.isDir && isKeyFile(e.name));

        if (keyFiles.length > 0) {
          parts.push("\n=== Key File Previews ===");
          for (const entry of keyFiles) {
            const displayPath = `/workspace/${entry.relPath}`.replace(/\/+/g, "/");
            parts.push(`\n--- ${displayPath} (${formatSize(entry.size)}) ---`);
            try {
              const fc = fs.readFileSync(entry.absPath, "utf-8");
              if (fc.length > MAX_FILE_PREVIEW) {
                parts.push(fc.slice(0, MAX_FILE_PREVIEW));
                parts.push(`... [truncated — file is ${formatSize(entry.size)}, showing first 8KB]`);
              } else {
                parts.push(fc);
              }
            } catch {
              parts.push("(could not read file)");
            }
          }
        }
      }

      let outputStr = parts.join("\n");
      if (outputStr.length > MAX_TOTAL_OUTPUT) {
        outputStr = outputStr.slice(0, MAX_TOTAL_OUTPUT) + "\n\n... [read_project output truncated at 32KB — use read_file for specific files]";
      }

      return { success: true, output: outputStr };
    } catch (err: any) {
      return { success: false, output: `read_project failed: ${err.message}` };
    }
  },
});
