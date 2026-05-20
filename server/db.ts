import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import path from "path";
import * as schema from "../shared/schema.js";

// Use process.cwd() — works in both ESM (dev) and CJS (prod)
// The DB path can be overridden by:
//   1. AGENT2077_DB_PATH env variable
//   2. data/db-path.txt sidecar file (written by Settings → Storage)
// Falls back to data/agent2077.db relative to cwd.
import fs from "fs";

function resolveDbPath(): string {
  const defaultPath = path.join(process.cwd(), "data", "agent2077.db");
  // 1. Env override
  if (process.env.AGENT2077_DB_PATH) {
    const p = process.env.AGENT2077_DB_PATH.trim();
    return p.startsWith("~")
      ? path.join(process.env.HOME || process.cwd(), p.slice(1))
      : p;
  }
  // 2. Sidecar file override
  const sidecarPath = path.join(process.cwd(), "data", "db-path.txt");
  if (fs.existsSync(sidecarPath)) {
    const p = fs.readFileSync(sidecarPath, "utf8").trim();
    if (p) {
      return p.startsWith("~")
        ? path.join(process.env.HOME || process.cwd(), p.slice(1))
        : p;
    }
  }
  return defaultPath;
}

const DB_PATH = resolveDbPath();

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const sqlite = new Database(DB_PATH);

// Performance pragmas
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("synchronous = NORMAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("cache_size = -64000"); // 64MB cache


/**
 * Bootstrap the database schema on a fresh install.
 * Uses CREATE TABLE IF NOT EXISTS — completely safe on existing DBs.
 * Must run BEFORE runMigrations() and initNewTables().
 */
function bootstrapSchema() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS endpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      provider_type TEXT NOT NULL DEFAULT 'lmstudio',
      api_key TEXT,
      is_orchestrator INTEGER NOT NULL DEFAULT 0,
      parallel_slots INTEGER NOT NULL DEFAULT 1,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      last_seen TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint_id INTEGER NOT NULL REFERENCES endpoints(id),
      model_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'llm',
      params_string TEXT,
      quantization TEXT,
      max_context_length INTEGER,
      loaded_context_length INTEGER,
      preferred_context_length INTEGER,
      is_enabled INTEGER NOT NULL DEFAULT 0,
      is_sub_agent INTEGER NOT NULL DEFAULT 0,
      task_assignment TEXT,
      supports_tool_calling INTEGER NOT NULL DEFAULT 0,
      supports_vision INTEGER NOT NULL DEFAULT 0,
      temperature REAL,
      top_p REAL,
      thinking_enabled INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chat_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT,
      order_index INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT 'New Chat',
      system_prompt TEXT,
      is_archived INTEGER NOT NULL DEFAULT 0,
      group_id INTEGER REFERENCES chat_groups(id),
      parent_session_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      model_id TEXT,
      endpoint_id INTEGER,
      tool_calls TEXT,
      tool_results TEXT,
      token_count INTEGER,
      duration_ms INTEGER,
      task_type TEXT,
      confidence TEXT,
      images TEXT,
      attachments TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS task_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      message_id INTEGER REFERENCES messages(id),
      original_request TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS subtasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL REFERENCES task_plans(id),
      parent_id INTEGER,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      task_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      model_used TEXT,
      endpoint_used INTEGER,
      tools_used TEXT,
      duration_ms INTEGER,
      order_index INTEGER NOT NULL DEFAULT 0,
      depends_on TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      trigger_patterns TEXT,
      system_prompt TEXT,
      tools_required TEXT,
      instructions TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      usage_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      created_by TEXT NOT NULL DEFAULT 'user',
      approval_status TEXT NOT NULL DEFAULT 'approved',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS skill_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id INTEGER NOT NULL REFERENCES skills(id),
      version INTEGER NOT NULL,
      instructions TEXT NOT NULL,
      system_prompt TEXT,
      change_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS apps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'tool',
      container_id TEXT,
      image_name TEXT NOT NULL,
      port INTEGER,
      internal_port INTEGER NOT NULL DEFAULT 8080,
      status TEXT NOT NULL DEFAULT 'stopped',
      build_path TEXT,
      dockerfile TEXT,
      env_vars TEXT,
      volume_mounts TEXT,
      icon_emoji TEXT DEFAULT '📦',
      version INTEGER NOT NULL DEFAULT 1,
      last_started TEXT,
      last_stopped TEXT,
      error_log TEXT,
      created_by_conversation INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS benchmark_suites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      prompts TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS benchmark_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      suite_id INTEGER NOT NULL REFERENCES benchmark_suites(id),
      model_id TEXT NOT NULL,
      endpoint_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      results TEXT,
      average_rating REAL,
      total_tokens INTEGER,
      total_duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS analytics_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      model_id TEXT,
      endpoint_id INTEGER,
      task_type TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      duration_ms INTEGER,
      success INTEGER NOT NULL DEFAULT 1,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 5,
      conversation_id INTEGER,
      scope TEXT NOT NULL DEFAULT 'general',
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      path TEXT NOT NULL,
      language TEXT,
      conversation_id INTEGER REFERENCES conversations(id),
      status TEXT NOT NULL DEFAULT 'active',
      last_opened_file TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// Create FTS5 virtual table for memory search (after schema tables exist)
function initFTS() {
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      content,
      category,
      content_rowid='id'
    );
  `);

  // FTS5 virtual table for cross-session message search
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content=messages,
      content_rowid=id,
      tokenize='porter unicode61'
    );
  `);

  // Triggers to keep messages_fts in sync with messages table
  sqlite.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `);
}

/**
 * Run lightweight schema migrations for new columns.
 * SQLite ALTER TABLE ADD COLUMN is safe and fast.
 * Each migration checks if the column exists first to be idempotent.
 */
function runMigrations() {
  const migrations: { table: string; column: string; type: string }[] = [
    { table: "models", column: "max_context_length", type: "INTEGER" },
    { table: "models", column: "loaded_context_length", type: "INTEGER" },
    { table: "models", column: "preferred_context_length", type: "INTEGER" },
    { table: "apps", column: "version", type: "INTEGER DEFAULT 1" },
    { table: "conversations", column: "group_id", type: "INTEGER REFERENCES chat_groups(id)" },
    { table: "endpoints", column: "provider_type", type: "TEXT NOT NULL DEFAULT 'lmstudio'" },
    { table: "endpoints", column: "api_key", type: "TEXT" },
    { table: "conversations", column: "parent_session_id", type: "INTEGER" },
    { table: "models", column: "is_sub_agent", type: "INTEGER NOT NULL DEFAULT 0" },
    { table: "models", column: "supports_vision", type: "INTEGER NOT NULL DEFAULT 0" },
    // v16.40: memory scoping — 'general' for normal chat, 'project:{id}' for workspace projects
    { table: "memory_entries", column: "scope", type: "TEXT NOT NULL DEFAULT 'general'" },
    // v16.63: thinking/reasoning mode toggle per model
    { table: "models", column: "thinking_enabled", type: "INTEGER NOT NULL DEFAULT 0" },
  ];

  for (const { table, column, type } of migrations) {
    try {
      // Check if column exists
      const info = sqlite.pragma(`table_info(${table})`) as any[];
      const exists = info.some((col: any) => col.name === column);
      if (!exists) {
        sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        console.log(`[DB Migration] Added ${table}.${column} (${type})`);
      }
    } catch (err: any) {
      console.warn(`[DB Migration] Failed to add ${table}.${column}:`, err.message);
    }
  }
}

function initNewTables() {
  // Create chat_groups table if not exists
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS chat_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT,
      order_index INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Create projects table if not exists
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      path TEXT NOT NULL,
      language TEXT,
      conversation_id INTEGER REFERENCES conversations(id),
      status TEXT NOT NULL DEFAULT 'active',
      last_opened_file TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Create mcp_servers table if not exists
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      args TEXT,
      env_vars TEXT,
      transport_type TEXT NOT NULL DEFAULT 'stdio',
      sse_url TEXT,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'disconnected',
      last_error TEXT,
      tool_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Create background_tasks table if not exists
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS background_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      type TEXT NOT NULL DEFAULT 'one-shot',
      cron_expression TEXT,
      result TEXT,
      progress INTEGER NOT NULL DEFAULT 0,
      logs TEXT,
      conversation_id INTEGER,
      model_id TEXT,
      endpoint_id INTEGER,
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      next_run_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Add confidence column to messages if not exists
  try {
    const info = sqlite.pragma('table_info(messages)') as any[];
    if (!info.some((col: any) => col.name === 'confidence')) {
      sqlite.exec(`ALTER TABLE messages ADD COLUMN confidence TEXT`);
      console.log('[DB] Added messages.confidence column');
    }
  } catch (err: any) {
    console.warn('[DB] Could not add confidence column:', err.message);
  }
  // Add images column to messages if not exists
  try {
    const info2 = sqlite.pragma('table_info(messages)') as any[];
    if (!info2.some((col: any) => col.name === 'images')) {
      sqlite.exec(`ALTER TABLE messages ADD COLUMN images TEXT`);
      console.log('[DB] Added messages.images column');
    }
  } catch (err: any) {
    console.warn('[DB] Could not add images column:', err.message);
  }
  // Add attachments column to messages if not exists
  try {
    const info3 = sqlite.pragma('table_info(messages)') as any[];
    if (!info3.some((col: any) => col.name === 'attachments')) {
      sqlite.exec(`ALTER TABLE messages ADD COLUMN attachments TEXT`);
      console.log('[DB] Added messages.attachments column');
    }
  } catch (err: any) {
    console.warn('[DB] Could not add attachments column:', err.message);
  }

  // Create generated_images table if not exists
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS generated_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt TEXT NOT NULL,
      negative_prompt TEXT,
      model TEXT,
      workflow_id INTEGER,
      workflow_json TEXT,
      seed INTEGER,
      width INTEGER,
      height INTEGER,
      steps INTEGER,
      cfg REAL,
      sampler TEXT,
      scheduler TEXT,
      denoise REAL,
      file_path TEXT NOT NULL,
      thumbnail_path TEXT,
      file_size INTEGER,
      mime_type TEXT NOT NULL DEFAULT 'image/png',
      generation_type TEXT NOT NULL DEFAULT 'txt2img',
      source_image_id INTEGER,
      conversation_id INTEGER,
      project_id INTEGER,
      duration_ms INTEGER,
      comfyui_prompt_id TEXT,
      tags TEXT,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Create comfyui_workflows table if not exists
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS comfyui_workflows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      workflow_json TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'custom',
      is_built_in INTEGER NOT NULL DEFAULT 0,
      parameters TEXT,
      thumbnail_path TEXT,
      usage_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export const db = drizzle(sqlite, { schema });
export { sqlite, initFTS, runMigrations, initNewTables, bootstrapSchema, DB_PATH };

/** Returns the raw better-sqlite3 instance (for FTS5 queries and raw SQL). */
export function getDb() { return sqlite; }
