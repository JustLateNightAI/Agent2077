import { registerTool, type ToolResult, type ToolContext } from "./registry.js";
import { projectStore } from "../storage.js";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import AsyncLock from "async-lock";
import { resolveNodeEnv } from "../lib/node-env.js";

const fileLock = new AsyncLock({ maxPending: 200 });
const MAX_READ_BYTES = 200 * 1024; // 200 KB
const MAX_OUTPUT_BYTES = 500 * 1024; // 500 KB

// Tool: list_project_files — List files in a coding project
registerTool("list_project_files", {
  category: "file",
  definition: {
    type: "function",
    function: {
      name: "list_project_files",
      description: "List files and directories in a coding workspace project. Returns the file tree structure.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "number", description: "The project ID" },
          directory: { type: "string", description: "Optional subdirectory path to list (relative to project root). Omit for root." },
        },
        required: ["projectId"],
      },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const project = projectStore.getById(args.projectId);
    if (!project) return { success: false, output: `Project ${args.projectId} not found` };

    const targetDir = args.directory
      ? path.join(project.path, args.directory)
      : project.path;

    if (!fs.existsSync(targetDir)) {
      return { success: false, output: `Directory not found: ${args.directory || "/"}` };
    }

    // Security: ensure path is within project
    const resolved = path.resolve(targetDir);
    if (!resolved.startsWith(path.resolve(project.path))) {
      return { success: false, output: "Path traversal not allowed" };
    }

    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    const SKIP = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv"]);

    const listing = entries
      .filter(e => !SKIP.has(e.name))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      })
      .map(e => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`)
      .join("\n");

    return { success: true, output: listing || "(empty directory)" };
  },
});

// Tool: read_project_file — Read a file from a coding project
registerTool("read_project_file", {
  category: "file",
  definition: {
    type: "function",
    function: {
      name: "read_project_file",
      description: "Read the contents of a file in a coding workspace project.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "number", description: "The project ID" },
          filePath: { type: "string", description: "File path relative to project root (e.g. 'src/index.ts')" },
        },
        required: ["projectId", "filePath"],
      },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const project = projectStore.getById(args.projectId);
    if (!project) return { success: false, output: `Project ${args.projectId} not found` };

    const fullPath = path.join(project.path, args.filePath);
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(project.path))) {
      return { success: false, output: "Path traversal not allowed" };
    }

    if (!fs.existsSync(fullPath)) {
      return { success: false, output: `File not found: ${args.filePath}` };
    }

    const stat = fs.statSync(fullPath);
    if (stat.size > MAX_READ_BYTES) {
      // Read only the first MAX_READ_BYTES and warn
      const fd = fs.openSync(fullPath, "r");
      const buf = Buffer.alloc(MAX_READ_BYTES);
      fs.readSync(fd, buf, 0, MAX_READ_BYTES, 0);
      fs.closeSync(fd);
      const truncated = buf.toString("utf-8");
      return {
        success: true,
        output: truncated + `

[TRUNCATED — file is ${Math.round(stat.size / 1024)}KB, showing first ${Math.round(MAX_READ_BYTES / 1024)}KB only]`,
      };
    }
    const content = fs.readFileSync(fullPath, "utf-8");
    return { success: true, output: content };
  },
});

// Tool: write_project_file — Write/create a file in a coding project
registerTool("write_project_file", {
  category: "file",
  definition: {
    type: "function",
    function: {
      name: "write_project_file",
      description: "Write or create a file in a coding workspace project. Creates parent directories automatically.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "number", description: "The project ID" },
          filePath: { type: "string", description: "File path relative to project root (e.g. 'src/index.ts')" },
          content: { type: "string", description: "The file content to write" },
        },
        required: ["projectId", "filePath", "content"],
      },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const project = projectStore.getById(args.projectId);
    if (!project) return { success: false, output: `Project ${args.projectId} not found` };

    const fullPath = path.join(project.path, args.filePath);
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(project.path))) {
      return { success: false, output: "Path traversal not allowed" };
    }

    return fileLock.acquire(fullPath, async () => {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, args.content, "utf-8");
      return { success: true, output: `Written ${args.filePath} (${args.content.length} bytes)` };
    });
  },
});

// Tool: run_project_command — Execute a shell command in the project directory
registerTool("run_project_command", {
  category: "code",
  definition: {
    type: "function",
    function: {
      name: "run_project_command",
      description: "Execute a shell command in a coding workspace project directory. Runs directly on the host machine. Use for building, testing, running code, installing dependencies, etc.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "number", description: "The project ID" },
          command: { type: "string", description: "Shell command to execute (e.g. 'npm install', 'python main.py', 'cargo build')" },
        },
        required: ["projectId", "command"],
      },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const project = projectStore.getById(args.projectId);
    if (!project) return { success: false, output: `Project ${args.projectId} not found` };

    // Safety: block destructive commands that could delete the project
    const cmd = args.command.trim();
    const dangerousPatterns = [
      /\brm\s+(-[a-zA-Z]*[rf]|--recursive|--force)/i,  // rm -rf, rm -r, rm -f, rm --recursive
      /\brm\s+(-[a-zA-Z]*\s+)?\.\/?\s*$/,  // rm . or rm ./
      /\brm\s+(-[a-zA-Z]*\s+)?\*\s*$/,  // rm *
      /\brmdir\b/i,
      /\bfind\s.*-delete/i,
      /\bgit\s+clean\s+-[a-zA-Z]*f/i,  // git clean -f (can delete untracked files)
    ];

    // Only block if targeting the project root or parent
    const isDestructive = dangerousPatterns.some(p => p.test(cmd));
    if (isDestructive) {
      // Allow rm of specific files/subdirectories, but NOT the root
      const targetsCwd = /\brm\s+(-[a-zA-Z]*\s+)?(\.\/|\.)\s*$/i.test(cmd) ||
                         /\brm\s+(-[a-zA-Z]*\s+)?\*\s*$/i.test(cmd);
      if (targetsCwd) {
        return { success: false, output: "BLOCKED: This command would delete the project root directory. Use specific file paths instead." };
      }
    }

    const truncate = (s: string, label: string) => {
      if (!s) return "";
      if (Buffer.byteLength(s) <= MAX_OUTPUT_BYTES) return s;
      const half = Math.floor(MAX_OUTPUT_BYTES / 2);
      const head = s.slice(0, half);
      const tail = s.slice(-half);
      return `${head}\n\n[... ${label} truncated — showing first and last ${Math.round(half / 1024)}KB ...]\n\n${tail}`;
    };

    try {
      const output = execSync(args.command, {
        cwd: project.path,
        timeout: 120000,
        maxBuffer: 1024 * 1024 * 20, // 20MB raw buffer — we truncate ourselves
        encoding: "utf-8",
        env: resolveNodeEnv(),
        shell: true,
      });
      const trimmed = truncate(output, "output");
      return { success: true, output: trimmed || "(command completed with no output)" };
    } catch (err: any) {
      const stderr = truncate(err.stderr || "", "stderr");
      const stdout = truncate(err.stdout || "", "stdout");
      const combined = [stdout && `STDOUT:\n${stdout}`, stderr && `STDERR:\n${stderr}`].filter(Boolean).join("\n\n");
      return {
        success: false,
        output: `Command failed (exit code ${err.status || "unknown"}):\n\n${combined || "(no output)"}`,
      };
    }
  },
});

// Tool: edit_project_file — Make targeted edits to a file (find and replace)
registerTool("edit_project_file", {
  category: "file",
  definition: {
    type: "function",
    function: {
      name: "edit_project_file",
      description: "Make a targeted edit to a file in a coding workspace project by replacing a specific string. More precise than rewriting the entire file.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "number", description: "The project ID" },
          filePath: { type: "string", description: "File path relative to project root" },
          oldText: { type: "string", description: "The exact text to find and replace (must be unique in the file)" },
          newText: { type: "string", description: "The replacement text" },
        },
        required: ["projectId", "filePath", "oldText", "newText"],
      },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const project = projectStore.getById(args.projectId);
    if (!project) return { success: false, output: `Project ${args.projectId} not found` };

    const fullPath = path.join(project.path, args.filePath);
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(project.path))) {
      return { success: false, output: "Path traversal not allowed" };
    }

    if (!fs.existsSync(fullPath)) {
      return { success: false, output: `File not found: ${args.filePath}` };
    }

    // Use fileLock so concurrent sub-agent edits to the same file are serialized
    return fileLock.acquire(fullPath, async () => {
      const currentContent = fs.readFileSync(fullPath, "utf-8");
      const count = currentContent.split(args.oldText).length - 1;
      if (count === 0) {
        return { success: false, output: `Text not found in ${args.filePath}. Make sure the old_text matches exactly (including whitespace).` };
      }
      if (count > 1) {
        return { success: false, output: `Found ${count} occurrences of the text in ${args.filePath}. The old_text must be unique.` };
      }
      const newContent = currentContent.replace(args.oldText, args.newText);
      fs.writeFileSync(fullPath, newContent, "utf-8");
      return { success: true, output: `Edited ${args.filePath}: replaced ${args.oldText.length} chars with ${args.newText.length} chars` };
    });
  },
});

// Tool: search_project_files — grep for a string across project files
registerTool("search_project_files", {
  category: "code",
  definition: {
    type: "function",
    function: {
      name: "search_project_files",
      description: "Search for a text pattern across all files in the project (like grep -r). Returns matching lines with file paths and line numbers. Skips node_modules, .git, dist, build, and __pycache__ automatically.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "number", description: "The project ID" },
          pattern: { type: "string", description: "Text or regex pattern to search for" },
          fileGlob: { type: "string", description: "Optional file glob to restrict search (e.g. '*.ts', '*.py'). Omit to search all files." },
          caseSensitive: { type: "boolean", description: "If false (default), search is case-insensitive." },
          maxResults: { type: "number", description: "Maximum number of matching lines to return. Default 100." },
        },
        required: ["projectId", "pattern"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const project = projectStore.getById(args.projectId);
    if (!project) return { success: false, output: `Project ${args.projectId} not found` };

    // Sanitize pattern — reject obviously dangerous inputs
    const pattern = String(args.pattern);
    if (pattern.length > 500) return { success: false, output: "Pattern too long" };

    const maxResults = Math.min(Number(args.maxResults) || 100, 500);
    const caseFlag = args.caseSensitive ? "" : "-i ";
    const globPart = args.fileGlob
      ? `--include="${String(args.fileGlob).replace(/[`$\\;|&]/g, "")}"`
      : "";

    // Use grep -rn with exclusions
    const excludes = [
      "--exclude-dir=node_modules",
      "--exclude-dir=.git",
      "--exclude-dir=dist",
      "--exclude-dir=build",
      "--exclude-dir=__pycache__",
      "--exclude-dir=.venv",
      "--exclude-dir=.next",
      "--exclude-dir=coverage",
    ].join(" ");

    const cmd = `grep -rn ${caseFlag}${excludes} ${globPart} -e ${JSON.stringify(pattern)} . 2>/dev/null | head -${maxResults}`;

    try {
      const output = execSync(cmd, {
        cwd: project.path,
        timeout: 30000,
        maxBuffer: 1024 * 1024 * 5,
        encoding: "utf-8",
        env: resolveNodeEnv(),
        shell: true,
      });

      if (!output || !output.trim()) {
        return { success: true, output: `No matches found for: ${pattern}` };
      }

      const lines = output.trim().split("\n");
      const note = lines.length >= maxResults
        ? `\n\n[Showing first ${maxResults} matches — use fileGlob or a more specific pattern to narrow results]`
        : "";

      return {
        success: true,
        output: `Found ${lines.length} match${lines.length === 1 ? "" : "es"} for "${pattern}":\n\n${output.trim()}${note}`,
      };
    } catch (err: any) {
      // grep exits 1 when no matches found — treat as success with no results
      if (err.status === 1) {
        return { success: true, output: `No matches found for: ${pattern}` };
      }
      return { success: false, output: `Search failed: ${err.message || String(err)}` };
    }
  },
});
