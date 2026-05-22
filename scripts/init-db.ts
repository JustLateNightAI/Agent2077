import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "agent2077.db");
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ── Create all tables ───────────────────────────────────────────────
db.exec(`
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
    is_orchestrator INTEGER NOT NULL DEFAULT 0,
    parallel_slots INTEGER NOT NULL DEFAULT 4,
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

  -- FTS5 for memory search
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    content,
    category
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_models_endpoint ON models(endpoint_id);
  CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_analytics_type ON analytics_events(event_type);
  CREATE INDEX IF NOT EXISTS idx_subtasks_plan ON subtasks(plan_id);
`);

// ── Migrations: add columns to existing tables ──────────────────────
// SQLite doesn't support IF NOT EXISTS on ALTER TABLE ADD COLUMN,
// so we check the column list first and only add if missing.

function hasColumn(table: string, column: string): boolean {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  return cols.some((c) => c.name === column);
}

function addColumn(table: string, column: string, definition: string): void {
  if (!hasColumn(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[DB] Migration: added ${table}.${column}`);
  }
}

// models — columns added after initial release
addColumn("models", "max_context_length",      "INTEGER");
addColumn("models", "loaded_context_length",   "INTEGER");
addColumn("models", "preferred_context_length","INTEGER");
addColumn("models", "is_sub_agent",            "INTEGER NOT NULL DEFAULT 0");
addColumn("models", "supports_vision",         "INTEGER NOT NULL DEFAULT 0");
addColumn("models", "temperature",             "REAL");
addColumn("models", "top_p",                   "REAL");
addColumn("models", "thinking_enabled",        "INTEGER NOT NULL DEFAULT 0");

// conversations — columns added after initial release
addColumn("conversations", "group_id",          "INTEGER");
addColumn("conversations", "parent_session_id", "INTEGER");

console.log("[DB] Schema initialised at", DB_PATH);
db.close();
