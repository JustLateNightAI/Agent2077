/**
 * Git Tools — Local git version control tools for project workspaces.
 * All operations are LOCAL only — no GitHub, no cloud push.
 */
import { registerTool, type ToolResult } from "./registry.js";
import { projectStore } from "../storage.js";
import { execSync } from "child_process";

function runGit(projectPath: string, args: string, timeout = 30000): { output: string; success: boolean } {
  try {
    const output = execSync(`git ${args}`, {
      cwd: projectPath,
      timeout,
      maxBuffer: 1024 * 1024 * 5, // 5MB
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: process.env.HOME || "/root",
        GIT_AUTHOR_NAME: "Agent2077",
        GIT_AUTHOR_EMAIL: "agent@agent2077.local",
        GIT_COMMITTER_NAME: "Agent2077",
        GIT_COMMITTER_EMAIL: "agent@agent2077.local",
      },
    });
    return { output: output || "(no output)", success: true };
  } catch (err: any) {
    const stderr = err.stderr || "";
    const stdout = err.stdout || "";
    return {
      success: false,
      output: `git ${args.slice(0, 60)} failed (exit ${err.status}):\n${stdout}\n${stderr}`.trim(),
    };
  }
}

function getProject(projectId: number) {
  return projectStore.getById(projectId);
}

// ── git_init ────────────────────────────────────────────────────────
registerTool("git_init", {
  category: "code",
  definition: {
    type: "function",
    function: {
      name: "git_init",
      description: "Initialize a git repository in a project directory.",
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
    const result = runGit(project.path, "init");
    return result;
  },
});

// ── git_status ───────────────────────────────────────────────────────
registerTool("git_status", {
  category: "code",
  definition: {
    type: "function",
    function: {
      name: "git_status",
      description: "Show the working tree status of a project's git repository.",
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
    return runGit(project.path, "status");
  },
});

// ── git_add ──────────────────────────────────────────────────────────
registerTool("git_add", {
  category: "code",
  definition: {
    type: "function",
    function: {
      name: "git_add",
      description: "Stage files for the next commit. Use '.' to stage all changes.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "number", description: "The project ID" },
          files: { type: "string", description: "Files to stage. Use '.' for all, or specific paths like 'src/index.ts'" },
        },
        required: ["projectId", "files"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const project = getProject(args.projectId);
    if (!project) return { success: false, output: `Project ${args.projectId} not found` };
    // Sanitize: prevent shell injection via simple quoting
    const files = String(args.files).replace(/[`$\\]/g, "");
    return runGit(project.path, `add ${files}`);
  },
});

// ── git_commit ───────────────────────────────────────────────────────
registerTool("git_commit", {
  category: "code",
  definition: {
    type: "function",
    function: {
      name: "git_commit",
      description: "Commit staged changes with a message.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "number", description: "The project ID" },
          message: { type: "string", description: "Commit message" },
        },
        required: ["projectId", "message"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const project = getProject(args.projectId);
    if (!project) return { success: false, output: `Project ${args.projectId} not found` };
    const safeMsg = String(args.message).replace(/"/g, '\\"');
    return runGit(project.path, `commit -m "${safeMsg}"`);
  },
});

// ── git_log ──────────────────────────────────────────────────────────
registerTool("git_log", {
  category: "code",
  definition: {
    type: "function",
    function: {
      name: "git_log",
      description: "Show commit history for a project's git repository.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "number", description: "The project ID" },
          limit: { type: "number", description: "Maximum number of commits to show (default 20)" },
        },
        required: ["projectId"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const project = getProject(args.projectId);
    if (!project) return { success: false, output: `Project ${args.projectId} not found` };
    const limit = Math.min(parseInt(String(args.limit || 20)), 100);
    return runGit(project.path, `log --oneline --graph -${limit}`);
  },
});

// ── git_diff ─────────────────────────────────────────────────────────
registerTool("git_diff", {
  category: "code",
  definition: {
    type: "function",
    function: {
      name: "git_diff",
      description: "Show diff of unstaged changes in a project. Optionally specify a file.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "number", description: "The project ID" },
          file: { type: "string", description: "Optional specific file path to diff" },
        },
        required: ["projectId"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const project = getProject(args.projectId);
    if (!project) return { success: false, output: `Project ${args.projectId} not found` };
    const fileArg = args.file ? ` -- ${String(args.file).replace(/[`$\\]/g, "")}` : "";
    return runGit(project.path, `diff${fileArg}`);
  },
});

// ── git_diff_staged ──────────────────────────────────────────────────
registerTool("git_diff_staged", {
  category: "code",
  definition: {
    type: "function",
    function: {
      name: "git_diff_staged",
      description: "Show diff of staged (indexed) changes in a project.",
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
    return runGit(project.path, "diff --staged");
  },
});

// ── git_branch_list ──────────────────────────────────────────────────
registerTool("git_branch_list", {
  category: "code",
  definition: {
    type: "function",
    function: {
      name: "git_branch_list",
      description: "List all branches in a project's git repository.",
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
    return runGit(project.path, "branch -v");
  },
});

// ── git_branch_create ────────────────────────────────────────────────
registerTool("git_branch_create", {
  category: "code",
  definition: {
    type: "function",
    function: {
      name: "git_branch_create",
      description: "Create a new branch in a project's git repository.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "number", description: "The project ID" },
          name: { type: "string", description: "Branch name (e.g. 'feature/new-ui')" },
        },
        required: ["projectId", "name"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const project = getProject(args.projectId);
    if (!project) return { success: false, output: `Project ${args.projectId} not found` };
    const safeName = String(args.name).replace(/[^a-zA-Z0-9/_.-]/g, "-");
    return runGit(project.path, `branch ${safeName}`);
  },
});

// ── git_checkout ─────────────────────────────────────────────────────
registerTool("git_checkout", {
  category: "code",
  definition: {
    type: "function",
    function: {
      name: "git_checkout",
      description: "Switch to a branch in a project's git repository.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "number", description: "The project ID" },
          branch: { type: "string", description: "Branch name to switch to" },
        },
        required: ["projectId", "branch"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const project = getProject(args.projectId);
    if (!project) return { success: false, output: `Project ${args.projectId} not found` };
    const safeBranch = String(args.branch).replace(/[^a-zA-Z0-9/_.-]/g, "-");
    return runGit(project.path, `checkout ${safeBranch}`);
  },
});

// ── git_stash ────────────────────────────────────────────────────────
registerTool("git_stash", {
  category: "code",
  definition: {
    type: "function",
    function: {
      name: "git_stash",
      description: "Manage git stash — push, pop, or list stashed changes.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "number", description: "The project ID" },
          action: { type: "string", description: "Stash action: 'push', 'pop', or 'list'" },
        },
        required: ["projectId", "action"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const project = getProject(args.projectId);
    if (!project) return { success: false, output: `Project ${args.projectId} not found` };
    const action = ["push", "pop", "list"].includes(args.action) ? args.action : "list";
    return runGit(project.path, `stash ${action}`);
  },
});

// ── git_reset ────────────────────────────────────────────────────────
registerTool("git_reset", {
  category: "code",
  definition: {
    type: "function",
    function: {
      name: "git_reset",
      description: "Unstage files (git reset HEAD). Optionally specify a file to unstage only that file.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "number", description: "The project ID" },
          file: { type: "string", description: "Optional file path to unstage. Omit to unstage all." },
        },
        required: ["projectId"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const project = getProject(args.projectId);
    if (!project) return { success: false, output: `Project ${args.projectId} not found` };
    const fileArg = args.file ? ` ${String(args.file).replace(/[`$\\]/g, "")}` : "";
    return runGit(project.path, `reset HEAD${fileArg}`);
  },
});

// ── git_revert ───────────────────────────────────────────────────────
registerTool("git_revert", {
  category: "code",
  definition: {
    type: "function",
    function: {
      name: "git_revert",
      description: "Revert a commit (creates a new commit that undoes the specified one).",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "number", description: "The project ID" },
          commitHash: { type: "string", description: "The commit hash to revert (e.g. 'abc1234')" },
        },
        required: ["projectId", "commitHash"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const project = getProject(args.projectId);
    if (!project) return { success: false, output: `Project ${args.projectId} not found` };
    // Allow only valid hex commit hashes
    const safeHash = String(args.commitHash).replace(/[^a-fA-F0-9]/g, "");
    if (safeHash.length < 6) return { success: false, output: "Invalid commit hash" };
    return runGit(project.path, `revert --no-edit ${safeHash}`);
  },
});

// ── git_diff ─────────────────────────────────────────────────────────
registerTool("git_diff", {
  category: "code",
  definition: {
    type: "function",
    function: {
      name: "git_diff",
      description: "Show a diff of uncommitted changes in the project. Use before committing to review what will be included. Optionally scope to a specific file.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "number", description: "The project ID" },
          filePath: { type: "string", description: "Optional: scope diff to a specific file (relative to project root)" },
          staged: { type: "boolean", description: "If true, show staged (--cached) diff instead of unstaged. Default false." },
        },
        required: ["projectId"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const project = getProject(args.projectId);
    if (!project) return { success: false, output: `Project ${args.projectId} not found` };

    const stagedFlag = args.staged ? "--cached " : "";
    const fileArg = args.filePath
      ? ` -- ${String(args.filePath).replace(/[`$\\;|&]/g, "")}`
      : "";

    const result = runGit(project.path, `diff ${stagedFlag}--stat${fileArg}`);
    if (!result.success) return result;

    const statOutput = result.output?.trim();

    // Also get the full diff (limited to 500 lines to avoid flooding context)
    const fullDiff = runGit(project.path, `diff ${stagedFlag}${fileArg}`);
    const diffLines = (fullDiff.output || "").split("\n");
    const truncated = diffLines.length > 500;
    const diffOutput = diffLines.slice(0, 500).join("\n");

    const output = [
      statOutput || "No changes",
      "",
      diffOutput || "(no diff output)",
      truncated ? `\n[TRUNCATED — showing first 500 lines of ${diffLines.length} total]` : "",
    ].filter(s => s !== "").join("\n");

    return { success: true, output };
  },
});
