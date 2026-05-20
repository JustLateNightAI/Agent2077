/**
 * Codebase Understanding Tools
 *
 * Tools for searching, analyzing, and navigating code in project workspaces.
 * Uses grep/find/awk shell commands via execSync.
 */
import { registerTool, type ToolResult } from "./registry.js";
import { projectStore } from "../storage.js";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

function runCmd(cmd: string, cwd: string, timeout = 30000): { output: string; success: boolean } {
  try {
    const output = execSync(cmd, {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024 * 10, // 10MB
      encoding: "utf-8",
      env: { ...process.env, HOME: process.env.HOME || "/root" },
    });
    return { output: output || "(no output)", success: true };
  } catch (err: any) {
    const stderr = err.stderr || "";
    const stdout = err.stdout || "";
    // For grep, exit code 1 means no matches (not an error)
    if (err.status === 1 && !stderr) {
      return { output: stdout || "(no matches found)", success: true };
    }
    return {
      success: false,
      output: `Command failed (exit ${err.status}):\n${stdout}\n${stderr}`.trim(),
    };
  }
}

function getProject(projectId: number) {
  return projectStore.getById(projectId);
}

// ── search_codebase ──────────────────────────────────────────────────
registerTool("search_codebase", {
  category: "code",
  definition: {
    type: "function",
    function: {
      name: "search_codebase",
      description: "Search across all project files for a query string or pattern. Returns matching lines with file paths and line numbers.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "number", description: "The project ID" },
          query: { type: "string", description: "Search query (plain text or regex pattern)" },
          fileGlob: { type: "string", description: "Optional file glob pattern to restrict search (e.g. '*.ts', '*.py'). Defaults to all files." },
        },
        required: ["projectId", "query"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const project = getProject(args.projectId);
    if (!project) return { success: false, output: `Project ${args.projectId} not found` };

    // Sanitize query for shell safety — escape special chars
    const safeQuery = String(args.query).replace(/'/g, "'\\''");
    const globArg = args.fileGlob
      ? `--include='${String(args.fileGlob).replace(/'/g, "'\\''")}' `
      : "";

    // Exclude common non-code directories
    const excludes = "--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=__pycache__ --exclude-dir=.venv --exclude-dir=venv --exclude-dir=dist --exclude-dir=build --exclude-dir=.next";

    const cmd = `grep -rn ${excludes} ${globArg}-E '${safeQuery}' . 2>/dev/null | head -100`;
    const result = runCmd(cmd, project.path);

    if (!result.output || result.output === "(no output)") {
      return { success: true, output: `No matches found for: ${args.query}` };
    }

    // Truncate large outputs so they don't overwhelm the context window
    const MAX_OUTPUT = 8 * 1024; // 8KB
    let body = result.output;
    let truncated = false;
    if (body.length > MAX_OUTPUT) {
      body = body.slice(0, MAX_OUTPUT);
      // Cut at last newline to avoid split lines
      const lastNl = body.lastIndexOf("\n");
      if (lastNl > 0) body = body.slice(0, lastNl);
      truncated = true;
    }
    const suffix = truncated
      ? `\n\n[... output truncated at 8KB — use a more specific query or fileGlob to narrow results]`
      : "";

    return {
      success: true,
      output: `Search results for "${args.query}" in project ${project.name}:\n\n${body}${suffix}`,
      metadata: { query: args.query, projectPath: project.path, truncated },
    };
  },
});

// ── analyze_codebase ─────────────────────────────────────────────────
registerTool("analyze_codebase", {
  category: "code",
  definition: {
    type: "function",
    function: {
      name: "analyze_codebase",
      description: "Generate a comprehensive summary of a project: file listing, language detection, line counts, entry points, dependencies, and spec files.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "number", description: "The project ID" },
        },
        required: ["projectId"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const project = getProject(args.projectId);
    if (!project) return { success: false, output: `Project ${args.projectId} not found` };

    const parts: string[] = [`# Codebase Analysis: ${project.name}`, `Path: ${project.path}`, ""];

    // ── Spec/requirements files ──────────────────────────────────────
    const specFiles = ["SPEC.md", "spec.md", "ARCHITECTURE.md", "architecture.md", "requirements.md", "REQUIREMENTS.md", "design.md", "DESIGN.md", "README.md"];
    const foundSpecs: string[] = [];
    for (const sf of specFiles) {
      if (fs.existsSync(path.join(project.path, sf))) foundSpecs.push(sf);
    }
    if (foundSpecs.length > 0) {
      parts.push(`## Project Documentation`);
      for (const sf of foundSpecs) {
        try {
          const sfContent = fs.readFileSync(path.join(project.path, sf), "utf-8");
          // Inline up to 8KB per spec file to give the model immediate context
          const MAX_SPEC = 8 * 1024;
          const inlined = sfContent.length > MAX_SPEC
            ? sfContent.slice(0, MAX_SPEC) + `\n\n[... truncated — ${sf} is ${Math.round(sfContent.length / 1024)}KB, showing first 8KB]`
            : sfContent;
          parts.push(`### ${sf}`);
          parts.push(inlined);
          parts.push("");
        } catch {
          parts.push(`- ${sf} (found but could not read)`);
        }
      }
    }

    // ── File count by extension ──────────────────────────────────────
    try {
      const extCmd = `find . -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/__pycache__/*' -not -path '*/.venv/*' -not -path '*/dist/*' -not -path '*/build/*' -type f | grep -oE '\\.[a-zA-Z0-9]+$' | sort | uniq -c | sort -rn | head -20`;
      const extResult = runCmd(extCmd, project.path);
      if (extResult.success && extResult.output !== "(no output)") {
        parts.push("## File Types");
        parts.push(extResult.output);
        parts.push("");
      }
    } catch { /* ignore */ }

    // ── Total file count and line count ─────────────────────────────
    try {
      const countCmd = `find . -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/__pycache__/*' -not -path '*/.venv/*' -not -path '*/dist/*' -not -path '*/build/*' -type f | wc -l`;
      const countResult = runCmd(countCmd, project.path);
      parts.push(`## Summary`);
      parts.push(`Total files: ${countResult.output.trim()}`);

      const lineCountCmd = `find . -not -path '*/node_modules/*' -not -path '*/.git/*' -type f \\( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' -o -name '*.py' -o -name '*.rs' -o -name '*.go' -o -name '*.java' -o -name '*.c' -o -name '*.cpp' -o -name '*.cs' \\) -exec wc -l {} + 2>/dev/null | tail -1`;
      const lineResult = runCmd(lineCountCmd, project.path);
      parts.push(`Code lines: ${lineResult.output.trim().replace(/^\s+/, "")}`);
      parts.push("");
    } catch { /* ignore */ }

    // ── Entry points ─────────────────────────────────────────────────
    const entryPoints: string[] = [];
    const commonEntries = [
      "index.ts", "index.js", "main.ts", "main.js", "main.py", "app.ts", "app.js",
      "src/index.ts", "src/main.ts", "src/app.ts", "server.ts", "server.js",
      "main.go", "main.rs", "Program.cs", "App.java",
    ];
    for (const ep of commonEntries) {
      if (fs.existsSync(path.join(project.path, ep))) entryPoints.push(ep);
    }
    if (entryPoints.length > 0) {
      parts.push("## Entry Points");
      entryPoints.forEach(ep => parts.push(`- ${ep}`));
      parts.push("");
    }

    // ── Dependencies ─────────────────────────────────────────────────
    parts.push("## Dependencies");
    const depFiles = [
      { file: "package.json", key: "package.json" },
      { file: "requirements.txt", key: "requirements.txt" },
      { file: "Cargo.toml", key: "Cargo.toml" },
      { file: "go.mod", key: "go.mod" },
      { file: "pom.xml", key: "pom.xml" },
      { file: "build.gradle", key: "build.gradle" },
      { file: "Gemfile", key: "Gemfile" },
      { file: "pyproject.toml", key: "pyproject.toml" },
    ];

    for (const { file } of depFiles) {
      const fullPath = path.join(project.path, file);
      if (fs.existsSync(fullPath)) {
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          if (file === "package.json") {
            const pkg = JSON.parse(content);
            const deps = Object.keys(pkg.dependencies || {});
            const devDeps = Object.keys(pkg.devDependencies || {});
            parts.push(`**package.json** — ${pkg.name || "unknown"} v${pkg.version || "?"}`);
            if (pkg.scripts) parts.push(`  Scripts: ${Object.keys(pkg.scripts).join(", ")}`);
            if (deps.length) parts.push(`  Dependencies (${deps.length}): ${deps.slice(0, 15).join(", ")}${deps.length > 15 ? "..." : ""}`);
            if (devDeps.length) parts.push(`  DevDependencies (${devDeps.length}): ${devDeps.slice(0, 10).join(", ")}${devDeps.length > 10 ? "..." : ""}`);
          } else if (file === "requirements.txt") {
            const reqs = content.split("\n").filter(l => l.trim() && !l.startsWith("#")).map(l => l.split("==")[0].trim());
            parts.push(`**requirements.txt** — ${reqs.length} packages: ${reqs.slice(0, 15).join(", ")}${reqs.length > 15 ? "..." : ""}`);
          } else if (file === "Cargo.toml") {
            const nameMatch = content.match(/name\s*=\s*"([^"]+)"/);
            const versionMatch = content.match(/version\s*=\s*"([^"]+)"/);
            parts.push(`**Cargo.toml** — ${nameMatch?.[1] || "?"} v${versionMatch?.[1] || "?"}`);
          } else {
            parts.push(`**${file}** — found`);
          }
        } catch { parts.push(`**${file}** — found (could not parse)`); }
      }
    }
    parts.push("");

    // ── Top-level file listing ────────────────────────────────────────
    try {
      const lsResult = runCmd(
        `ls -la | head -50`,
        project.path
      );
      if (lsResult.success) {
        parts.push("## Root Directory");
        parts.push(lsResult.output);
        parts.push("");
      }
    } catch { /* ignore */ }

    return {
      success: true,
      output: parts.join("\n"),
      metadata: { projectPath: project.path },
    };
  },
});

// ── find_symbol ──────────────────────────────────────────────────────
registerTool("find_symbol", {
  category: "code",
  definition: {
    type: "function",
    function: {
      name: "find_symbol",
      description: "Find where a function, class, or variable is defined and used across the codebase.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "number", description: "The project ID" },
          symbolName: { type: "string", description: "Name of the function, class, or variable to find" },
        },
        required: ["projectId", "symbolName"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const project = getProject(args.projectId);
    if (!project) return { success: false, output: `Project ${args.projectId} not found` };

    const safeSymbol = String(args.symbolName).replace(/[^a-zA-Z0-9_$]/g, "");
    if (!safeSymbol) return { success: false, output: "Invalid symbol name" };

    const excludes = "--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=__pycache__ --exclude-dir=.venv --exclude-dir=dist --exclude-dir=build --exclude-dir=.next";

    // Look for definitions: function/class/const/let/var/def/type declarations
    const defPatterns = [
      `\\bfunction\\s+${safeSymbol}\\b`,
      `\\bclass\\s+${safeSymbol}\\b`,
      `\\bconst\\s+${safeSymbol}\\b`,
      `\\blet\\s+${safeSymbol}\\b`,
      `\\bvar\\s+${safeSymbol}\\b`,
      `\\bdef\\s+${safeSymbol}\\b`,
      `\\btype\\s+${safeSymbol}\\b`,
      `\\binterface\\s+${safeSymbol}\\b`,
      `\\benum\\s+${safeSymbol}\\b`,
      `\\bexport\\s+.*\\b${safeSymbol}\\b`,
      `\\bfn\\s+${safeSymbol}\\b`,  // Rust
      `\\bstruct\\s+${safeSymbol}\\b`,  // Rust/C/C++
    ].join("|");

    const defCmd = `grep -rn ${excludes} -E '(${defPatterns})' . 2>/dev/null | head -30`;
    const defResult = runCmd(defCmd, project.path);

    // Look for all usages
    const useCmd = `grep -rn ${excludes} -w '${safeSymbol}' . 2>/dev/null | head -50`;
    const useResult = runCmd(useCmd, project.path);

    let output = `# Symbol: ${safeSymbol}\n\n`;
    output += `## Definitions\n`;
    output += defResult.success && defResult.output !== "(no output)" && defResult.output !== "(no matches found)"
      ? defResult.output
      : "(no definitions found)\n";
    output += `\n## Usages\n`;
    output += useResult.success && useResult.output !== "(no output)" && useResult.output !== "(no matches found)"
      ? useResult.output
      : "(no usages found)\n";

    return { success: true, output };
  },
});

// ── find_references ──────────────────────────────────────────────────
registerTool("find_references", {
  category: "code",
  definition: {
    type: "function",
    function: {
      name: "find_references",
      description: "Find all files that reference a symbol (function, class, variable, module name).",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "number", description: "The project ID" },
          symbolName: { type: "string", description: "Symbol name to find references to" },
        },
        required: ["projectId", "symbolName"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const project = getProject(args.projectId);
    if (!project) return { success: false, output: `Project ${args.projectId} not found` };

    const safeSymbol = String(args.symbolName).replace(/[^a-zA-Z0-9_$./\\-]/g, "");
    if (!safeSymbol) return { success: false, output: "Invalid symbol name" };

    const excludes = "--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=__pycache__ --exclude-dir=.venv --exclude-dir=dist --exclude-dir=build";

    // Files that contain the symbol (whole word match)
    const filesCmd = `grep -rl ${excludes} -w '${safeSymbol}' . 2>/dev/null | head -30`;
    const filesResult = runCmd(filesCmd, project.path);

    if (!filesResult.success || filesResult.output === "(no output)" || filesResult.output === "(no matches found)") {
      return { success: true, output: `No references found for: ${safeSymbol}` };
    }

    const files = filesResult.output.trim().split("\n").filter(Boolean);

    // For each file, show the matching lines
    const details: string[] = [];
    for (const file of files.slice(0, 15)) {
      const lineCmd = `grep -n -w '${safeSymbol}' '${file}' 2>/dev/null | head -10`;
      const lineResult = runCmd(lineCmd, project.path);
      if (lineResult.success) {
        details.push(`\n### ${file}\n${lineResult.output}`);
      }
    }

    return {
      success: true,
      output: `References to "${safeSymbol}" found in ${files.length} file(s):\n${files.map(f => `- ${f}`).join("\n")}\n${details.join("\n")}`,
      metadata: { symbol: safeSymbol, fileCount: files.length },
    };
  },
});

// ── get_file_outline ─────────────────────────────────────────────────
registerTool("get_file_outline", {
  category: "code",
  definition: {
    type: "function",
    function: {
      name: "get_file_outline",
      description: "Extract the structure of a file: functions, classes, exports, imports, and other top-level declarations.",
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
  async execute(args): Promise<ToolResult> {
    const project = getProject(args.projectId);
    if (!project) return { success: false, output: `Project ${args.projectId} not found` };

    const fullPath = path.join(project.path, String(args.filePath));
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(project.path))) {
      return { success: false, output: "Path traversal not allowed" };
    }

    if (!fs.existsSync(fullPath)) {
      return { success: false, output: `File not found: ${args.filePath}` };
    }

    const stat = fs.statSync(fullPath);
    if (stat.size > 1024 * 1024) {
      return { success: false, output: "File too large for outline analysis (>1MB)" };
    }

    const content = fs.readFileSync(fullPath, "utf-8");
    const lines = content.split("\n");
    const outline: string[] = [`# Outline: ${args.filePath}`, ""];

    // Patterns to detect structure (language-agnostic, covers JS/TS/Python/Go/Rust/Java/C#)
    const patterns: { label: string; regex: RegExp }[] = [
      { label: "import",    regex: /^(?:import|from)\s+.+/           },
      { label: "export",    regex: /^export\s+(?:default\s+)?(?:const|let|var|function|class|type|interface|enum|async)\s+(\w+)/ },
      { label: "function",  regex: /^(?:async\s+)?function\s+(\w+)/  },
      { label: "function",  regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/ },
      { label: "const",     regex: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/ },
      { label: "class",     regex: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/ },
      { label: "interface", regex: /^(?:export\s+)?interface\s+(\w+)/ },
      { label: "type",      regex: /^(?:export\s+)?type\s+(\w+)\s*=/ },
      { label: "enum",      regex: /^(?:export\s+)?enum\s+(\w+)/     },
      { label: "def",       regex: /^(?:async\s+)?def\s+(\w+)/       }, // Python
      { label: "class",     regex: /^class\s+(\w+)/                   }, // Python
      { label: "func",      regex: /^func\s+(\w+)/                    }, // Go
      { label: "fn",        regex: /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/ }, // Rust
      { label: "struct",    regex: /^(?:pub\s+)?struct\s+(\w+)/       }, // Rust
      { label: "impl",      regex: /^impl\s+(\w+)/                    }, // Rust
    ];

    const importLines: string[] = [];
    const declarationLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith("//") || line.startsWith("*") || line.startsWith("#")) continue;

      for (const { label, regex } of patterns) {
        if (regex.test(line)) {
          const entry = `  L${i + 1}: ${line.slice(0, 100)}`;
          if (label === "import") {
            importLines.push(entry);
          } else {
            declarationLines.push(`[${label}] ${entry}`);
          }
          break; // Only match one pattern per line
        }
      }
    }

    if (importLines.length > 0) {
      outline.push(`## Imports (${importLines.length})`);
      importLines.slice(0, 20).forEach(l => outline.push(l));
      if (importLines.length > 20) outline.push(`  ... and ${importLines.length - 20} more imports`);
      outline.push("");
    }

    if (declarationLines.length > 0) {
      outline.push(`## Declarations (${declarationLines.length})`);
      declarationLines.forEach(l => outline.push(l));
      outline.push("");
    }

    outline.push(`## Stats`);
    outline.push(`  Total lines: ${lines.length}`);
    outline.push(`  File size: ${(stat.size / 1024).toFixed(1)} KB`);

    return {
      success: true,
      output: outline.join("\n"),
      metadata: { filePath: args.filePath, lines: lines.length },
    };
  },
});
