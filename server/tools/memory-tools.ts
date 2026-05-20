/**
 * Memory Tools — Persistent file-based memory across sessions
 * 
 * Two-file pattern inspired by Hermes/OpenClaw:
 *   MEMORY.md — Agent-controlled scratchpad (facts, project notes, preferences)
 *   USER.md   — User profile (name, preferences, hardware, etc.)
 * 
 * Both files are read once at session start (frozen snapshot injected into system prompt).
 * Tools allow the agent to append/update entries during the conversation.
 * Character limits prevent unbounded growth: MEMORY.md=2200, USER.md=1375.
 * 
 * Also keeps the existing DB-backed memory for FTS search (backward compat).
 */
import { registerTool, type ToolResult, type ToolContext } from "./registry.js";
import { memoryStore } from "../storage.js";
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const MEMORY_FILE = path.join(DATA_DIR, "MEMORY.md");
const USER_FILE = path.join(DATA_DIR, "USER.md");

const MEMORY_CHAR_LIMIT = 2200;
const USER_CHAR_LIMIT = 1375;

/**
 * v16.40: Get the project-specific memory file path for a given scope string.
 * scope format: 'project:{projectId}'
 */
function getProjectMemoryFile(scope: string): string {
  const projectId = scope.replace("project:", "");
  const dir = path.join(DATA_DIR, "project-memories");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `project-${projectId}.md`);
}

/** Ensure data directory + files exist */
function ensureFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(MEMORY_FILE)) fs.writeFileSync(MEMORY_FILE, "# Agent Memory\n\n");
  if (!fs.existsSync(USER_FILE)) fs.writeFileSync(USER_FILE, "# User Profile\n\n");
}

/** Read a memory file safely */
function readMemoryFile(filepath: string): string {
  ensureFiles();
  try {
    return fs.readFileSync(filepath, "utf-8");
  } catch {
    return "";
  }
}

/** Write to a memory file with char limit enforcement */
function writeMemoryFile(filepath: string, content: string, charLimit: number): { written: boolean; truncated: boolean } {
  ensureFiles();
  let truncated = false;
  if (content.length > charLimit) {
    // Truncate from the MIDDLE, keeping header + most recent entries
    const header = content.slice(0, 200);
    const tail = content.slice(-(charLimit - 250));
    content = header + "\n\n...(older entries trimmed)...\n\n" + tail;
    truncated = true;
  }
  fs.writeFileSync(filepath, content, "utf-8");
  return { written: true, truncated };
}

/**
 * Read memory files and return a frozen snapshot for the system prompt.
 * v16.40: scope-aware — general chat only sees general memory,
 * project workspace sees general + its own project memory.
 * Called once at session start — the agent sees this as read-only context.
 */
export function getMemorySnapshot(memoryScope?: string): string {
  ensureFiles();
  const memContent = readMemoryFile(MEMORY_FILE);
  const userContent = readMemoryFile(USER_FILE);
  
  const parts: string[] = [];
  
  if (userContent.trim().length > "# User Profile\n\n".length) {
    parts.push("## User Profile (from USER.md)");
    parts.push(userContent.trim());
    parts.push("");
  }
  
  if (memContent.trim().length > "# Agent Memory\n\n".length) {
    parts.push("## Persistent Memory (from MEMORY.md)");
    parts.push(memContent.trim());
    parts.push("");
  }

  // v16.40: include project-specific memory if we are in a project context
  if (memoryScope && memoryScope !== "general") {
    const projectFile = getProjectMemoryFile(memoryScope);
    if (fs.existsSync(projectFile)) {
      const projectContent = readMemoryFile(projectFile);
      const projectId = memoryScope.replace("project:", "");
      if (projectContent.trim().length > 0) {
        parts.push(`## Project Memory (Project #${projectId})`);
        parts.push(projectContent.trim());
        parts.push("");
      }
    }
  }
  
  return parts.length > 0 ? parts.join("\n") : "";
}

// ── memory_store — store facts/preferences/context ─────────────────
registerTool("memory_store", {
  category: "memory",
  maxResultSizeChars: 500,
  definition: {
    type: "function",
    function: {
      name: "memory_store",
      description: "Store a piece of information in long-term memory. Saved to MEMORY.md for persistence across sessions. Use this to remember user preferences, project details, important facts, or context that should persist. Also stored in the searchable database.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The information to remember" },
          category: {
            type: "string",
            enum: ["fact", "preference", "project", "context"],
            description: "Category of the memory entry",
          },
          importance: {
            type: "number",
            description: "Importance level 1-10 (10 = critical, 1 = trivial). Default 5.",
          },
        },
        required: ["content", "category"],
      },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const { content, category, importance = 5 } = args;
    // v16.40: write to the correct scope — project memories stay isolated
    const scope = context.memoryScope ?? "general";
    try {
      // 1. Store in DB (searchable via FTS) with correct scope
      const entry = memoryStore.create({
        content,
        category,
        importance: Math.max(1, Math.min(10, importance)),
        conversationId: context.conversationId,
        scope,
      });

      // 2. Append to MEMORY.md — use project-specific file for project scope
      const memFile = scope === "general" ? MEMORY_FILE : getProjectMemoryFile(scope);
      const current = readMemoryFile(memFile);
      const timestamp = new Date().toISOString().split("T")[0];
      const newEntry = `- [${category}] (${timestamp}) ${content}`;
      const updated = current.trimEnd() + "\n" + newEntry + "\n";
      const { truncated } = writeMemoryFile(memFile, updated, MEMORY_CHAR_LIMIT);

      return {
        success: true,
        output: `Stored memory #${entry.id} [scope: ${scope}]: "${content.slice(0, 80)}..." [${category}, importance: ${importance}]${truncated ? " (older entries trimmed to fit limit)" : ""}`,
      };
    } catch (err: any) {
      return { success: false, output: `Failed to store memory: ${err.message}` };
    }
  },
});

// ── memory_recall — search stored memories ─────────────────────────
registerTool("memory_recall", {
  category: "memory",
  maxResultSizeChars: 5000,
  definition: {
    type: "function",
    function: {
      name: "memory_recall",
      description: "Search long-term memory for previously stored information. Searches both the database (FTS) and the persistent MEMORY.md file. Use this to recall user preferences, project details, past conversations, or any previously stored context.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query to find relevant memories" },
        },
        required: ["query"],
      },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const { query } = args;
    // v16.40: search only within scope — general chat never sees project memories
    const scope = context.memoryScope ?? "general";
    try {
      const results = memoryStore.search(query, scope);
      if (results.length === 0) {
        return { success: true, output: `No memories found matching "${query}" in scope '${scope}'` };
      }
      const text = results.map((r, i) =>
        `[${i + 1}] (${r.category}, importance: ${r.importance}, scope: ${r.scope}) ${r.content}`
      ).join("\n\n");
      return {
        success: true,
        output: `Found ${results.length} memories [scope: ${scope}]:\n\n${text}`,
        metadata: { count: results.length },
      };
    } catch (err: any) {
      return { success: false, output: `Memory recall failed: ${err.message}` };
    }
  },
});

// ── user_profile_update — update USER.md with user info ────────────
registerTool("user_profile_update", {
  category: "memory",
  maxResultSizeChars: 500,
  definition: {
    type: "function",
    function: {
      name: "user_profile_update",
      description: "Update the persistent user profile (USER.md). Store user-specific info: name, hardware specs, OS, preferred tools, communication style, etc. This is separate from general memory — it's specifically about the user.",
      parameters: {
        type: "object",
        properties: {
          field: {
            type: "string",
            description: "Profile field to set (e.g. 'name', 'os', 'hardware', 'preferences', 'tools', 'notes')",
          },
          value: {
            type: "string",
            description: "The value to store for this field",
          },
        },
        required: ["field", "value"],
      },
    },
  },
  async execute(args, _context): Promise<ToolResult> {
    const { field, value } = args;
    try {
      let current = readMemoryFile(USER_FILE);
      
      // Check if field already exists — update it
      const fieldRegex = new RegExp(`^- \\*\\*${escapeRegex(field)}\\*\\*:.*$`, "mi");
      const newLine = `- **${field}**: ${value}`;
      
      if (fieldRegex.test(current)) {
        current = current.replace(fieldRegex, newLine);
      } else {
        current = current.trimEnd() + "\n" + newLine + "\n";
      }
      
      const { truncated } = writeMemoryFile(USER_FILE, current, USER_CHAR_LIMIT);
      
      return {
        success: true,
        output: `User profile updated: ${field} = "${value.slice(0, 80)}"${truncated ? " (profile trimmed to fit limit)" : ""}`,
      };
    } catch (err: any) {
      return { success: false, output: `Failed to update user profile: ${err.message}` };
    }
  },
});

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
