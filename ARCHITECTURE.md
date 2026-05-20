# Agent2077 — Architecture Reference

> **Purpose**: This document is the primary reference for Agent2077's own self-development. It maps every layer of the codebase so the agent can make accurate, targeted edits without needing to re-read every file from scratch. Keep it up to date as the codebase evolves.

---

## Table of Contents

1. [Overview](#1-overview)
2. [System Architecture](#2-system-architecture)
3. [Request Lifecycle](#3-request-lifecycle)
4. [Database Schema](#4-database-schema)
5. [Tool System](#5-tool-system)
6. [Agent Loop Deep Dive](#6-agent-loop-deep-dive)
7. [Model Routing](#7-model-routing)
8. [Frontend Architecture](#8-frontend-architecture)
9. [Docker System](#9-docker-system)
10. [Security Model](#10-security-model)
11. [Configuration](#11-configuration)
12. [File Dependencies](#12-file-dependencies)
13. [Build System](#13-build-system)
14. [Common Pitfalls](#14-common-pitfalls)
15. [Changelog](#15-changelog)

---
---

## 0. Feature Map — Where to Find Things

Use this table before reading any code. It tells you exactly which file implements each feature or concept.

| Feature / Concept | Primary File(s) | Notes |
|---|---|---|
| **Add a new tool** | Create `server/tools/<name>.ts`, call `registerTool()` | Auto-loaded at startup — never touch `registry.ts` |
| **Main chat route** | `server/routes.ts` line ~160 | `POST /api/chat` |
| **Self-dev chat route** | `server/routes.ts` line ~2207 | `POST /api/self-dev/chat` |
| **Reset permission approve** | `server/routes.ts` line ~1895 | Approves + auto-resumes agent loop |
| **Agent loop** | `server/lib/agent-loop.ts` | `runAgentLoop()` — do not edit lightly |
| **Model routing / task scoring** | `server/lib/orchestrator.ts` | `selectModel()`, `selectSubAgentModel()`, `routeMessage()` |
| **Task classification (keywords)** | `server/lib/classifier.ts` | Pattern-based, no LLM call |
| **Sub-agent execution** | `server/lib/sub-agent-executor.ts` | `subAgentExecutor()`, abort registry |
| **DB schema + column types** | `shared/schema.ts` | Source of truth for all tables |
| **DB migrations** | `server/db.ts` | `runMigrations()` — always add here, never drop columns |
| **Storage layer (CRUD)** | `server/storage.ts` | 17 store objects — all synchronous, no `await` |
| **Settings read/write** | `server/storage.ts` → `settingsStore` | `settingsStore.get(key)` / `settingsStore.set(key, val)` |
| **Self-dev tools (reset, build, etc.)** | `server/tools/self-dev-tools.ts` | All `selfdev_*` tools |
| **Self-dev prompt builder** | `server/lib/self-dev-prompt.ts` | `buildSelfDevPrompt()` |
| **Dev workspace file I/O** | `server/lib/dev-workspace.ts` | `readDevFile`, `writeDevFile`, `editDevFile` — all async-locked |
| **File mutex (async-lock)** | `server/lib/dev-workspace.ts` | In-process `AsyncLock` — one lock per absolute path |
| **OpenAI-compatible rate guard** | `server/lib/llm-client.ts` | Optional URL-driven throttling for known rate-limited OpenAI-compatible hosts |
| **SSE fan-out to multiple tabs** | `server/lib/conversation-bus.ts` | `broadcast()`, `subscribe()` |
| **AgentStream (disconnect resilience)** | `server/lib/agent-stream.ts` | `getOrCreateStream()`, `createStreamWriter()` |
| **UI pages** | `client/src/pages/` | One file per route — see Section 8 |
| **Shared UI components** | `client/src/components/ui/` | shadcn/Radix generated |
| **Main sidebar** | `client/src/components/sidebar.tsx` | Nav + conversation list |
| **App routing** | `client/src/App.tsx` | Hash-based via wouter `useHashLocation` |
| **Auth (JWT cookie)** | `server/middleware/auth.ts` | `requireAuth` middleware |
| **Terminal WebSocket** | `server/lib/terminal-ws.ts` | Session-based: POST session first, then WS connect |
| **Docker app management** | `server/docker/manager.ts`, `server/tools/app-deploy.ts` | Port scan starts at 3100 |
| **Background task queue** | `server/lib/background-tasks.ts` | Cron scheduling, async queue |
| **MCP server integration** | `server/lib/mcp-client.ts` | stdio + SSE transports |
| **Build script** | `script/build.ts` | Vite client + esbuild server; check allowlist when adding packages |
| **isSubAgent model flag** | `shared/schema.ts` → models table | Column `is_sub_agent`; added via migration at startup |
| **parentContext on subtasks** | `server/tools/sub-agent.ts` → `SubtaskSpec` | Injected into sub-agent system prompt |

### Settings Keys Quick Reference

| Key | Type | Purpose |
|---|---|---|
| `selfDevEnabled` | `"true"/"false"` | Gate for all self-dev tools |
| `selfDevConversationId` | integer string | Active self-dev conversation ID |
| `autoRouting` | `"true"/"false"` | LLM-assisted task classification |
| `internetEnabled` | `"true"/"false"` | Kill switch for all outbound requests |
| `contextTokenBudget` | integer string | Manual context compression override |
| `skills.autoApprove` | `"true"/"false"` | Auto-approve agent-generated skills |

---



## 1. Overview

Agent2077 is a self-hosted AI agent IDE running on Ubuntu 24.04. It pairs a local LLM backend (primarily LM Studio) with a full-featured web UI so the agent can write, run, deploy, and iterate on code entirely on-device — no cloud required.

**Stack summary:**
- **Runtime**: Node.js (ESM in dev via `tsx`, CJS bundle in prod)
- **Server**: Express 4 with HTTP + WebSocket
- **Database**: SQLite via `better-sqlite3` + Drizzle ORM (synchronous driver)
- **Frontend**: React 18 SPA with wouter hash routing, TanStack Query, shadcn/ui
- **LLM**: LM Studio, OpenRouter, or any generic OpenAI-compatible endpoint
- **Containers**: Docker via dockerode for app deployment and code sandboxing
- **Auth**: JWT stored in an HTTP-only cookie (`agent2077_token`)
- **Default credentials**: `Agent2077` / `Agent2077`
- **LAN hostname**: `http://Agent2077.local:5000` (requires Avahi/mDNS on the host)

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Browser (React SPA)                          │
│  chat.tsx │ workspace.tsx │ settings.tsx │ app-store.tsx │ ...  │
└─────────────┬────────────────────────────────────────────────────┘
              │ HTTP (REST)  SSE (streaming)  WebSocket (terminal)
              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Express Server (server/index.ts)               │
│                                                                  │
│  routes.ts ─── agent-loop.ts ─── orchestrator.ts ─── llm-client │
│      │               │                                           │
│  storage.ts       tools/*                                        │
│      │            registry.ts                                    │
│  db.ts (SQLite)       │                                          │
│                   docker/manager.ts                              │
└──────────┬──────────────────────────┬────────────────────────────┘
           │                          │
           ▼                          ▼
    SQLite database           Docker Engine
    data/agent2077.db         App containers
           │                  Code sandbox
           │                          │
           ▼                          ▼
  LM Studio / OpenAI-compatible API
                              Deployed apps
```

**Key internal channels:**
- `conversation-bus.ts` — in-process pub/sub that fans out SSE events to all browser tabs watching the same conversation
- `terminal-ws.ts` — WebSocket + node-pty for interactive terminal sessions inside the workspace
- `background-tasks.ts` — async task queue with cron scheduling; runs agent loops detached from an HTTP request

---

## 3. Request Lifecycle

`POST /api/chat` (routes.ts) → orchestrator classifies task + selects model → task-planner optionally generates a plan → agent-loop.ts runs the main tool-use loop → SSE events stream back to client.

Key files in order: `server/routes.ts` → `server/lib/orchestrator.ts` → `server/lib/task-planner.ts` → `server/lib/sub-agent-executor.ts` (if parallel steps) → `server/lib/agent-loop.ts`.

SSE event types the client handles: `request_id`, `conversation`, `routing`, `content`, `step`, `plan`, `status`, `confidence`, `diff_preview`, `confirmation_needed`, `inpaint_request`, `done`, `error`.

After the loop: user + assistant messages saved to DB with `toolCalls`, `toolResults` (JSON), `tokenCount`, `durationMs`. An `analyticsEvents` record is also written.

---

## 4. Database Schema

**File**: `shared/schema.ts`  
**Engine**: SQLite (WAL mode, 64MB cache, foreign keys ON)  
**Driver**: `better-sqlite3` via Drizzle ORM — **fully synchronous**, no `await` anywhere in `storage.ts`

### All tables

| Table | Primary Key | Purpose |
|---|---|---|
| `users` | `id` (int) | Auth — single user system, default `Agent2077` |
| `endpoints` | `id` (int) | LM Studio / OpenRouter / OpenAI-compatible API endpoints |
| `models` | `id` (int) | Models synced from endpoints; per-model context config |
| `chat_groups` | `id` (int) | Conversation folder/labels (name, color) |
| `conversations` | `id` (int) | Chat sessions; optional `groupId`, `systemPrompt` |
| `messages` | `id` (int) | Individual messages; stores role, content, images, toolCalls JSON |
| `task_plans` | `id` (int) | Saved plan objects for multi-step tasks (planJson is a JSON DAG) |
| `subtasks` | `id` (int) | Individual steps within a plan; supports dependency DAG via `dependsOn` |
| `skills` | `id` (int) | Prompt-injected skill library; versioned; approval workflow |
| `skill_versions` | `id` (int) | Historical versions of skills |
| `apps` | `id` (int) | Docker app registry: name, Dockerfile, port mappings, status |
| `benchmark_suites` | `id` (int) | Named sets of prompts for LLM benchmarking |
| `benchmark_runs` | `id` (int) | Run results per suite+model combination |
| `analytics_events` | `id` (int) | Per-request telemetry: tokens, duration, model, task type |
| `memory_entries` | `id` (int) | Cross-session memory store; FTS5 search via `memory_fts` virtual table |
| `settings` | `key` (text PK) | Key-value settings store |
| `projects` | `id` (int) | Workspace projects; maps to a filesystem path |
| `mcp_servers` | `id` (int) | Model Context Protocol server configs (stdio or SSE transport) |
| `background_tasks` | `id` (int) | Async task queue with cron scheduling |

### Key column details

**`endpoints`**
- `providerType`: `"lmstudio" | "openrouter" | "openai_compatible"`; legacy `"nvidia"` rows are treated as `"openai_compatible"` at runtime
- `isOrchestrator`: marks the endpoint whose model classifies tasks when keyword confidence is low
- `parallelSlots`: how many concurrent requests this endpoint can handle

**`models`**
- `maxContextLength`: reported by LM Studio v0 API (model's maximum supported context)
- `loadedContextLength`: actual context loaded (may differ from max); updated by `ensureModelLoaded`
- `preferredContextLength`: user-configured target; used to reload the model at the right size
- `taskAssignment`: JSON array of tags `["coding","research"]` or legacy single string; drives model selection scoring
- `supportsToolCalling`: if `false`, agent loop uses prompted fallback instead of native tool calling

**`messages`**
- `role`: `"user" | "assistant" | "system" | "tool"`
- `confidence`: `"green" | "yellow" | "red"` — set after agent loop completes
- `toolCalls` / `toolResults`: JSON arrays; stored for display only — **not** re-injected as `tool_calls` in history (see [Common Pitfalls](#14-common-pitfalls))
- `images`: JSON array of `{ name, base64, mimeType }` for multimodal input

**`apps`**
- `status`: `"building" | "running" | "stopped" | "error"`
- `version`: incremented on each successful deploy (used for rollback)

**`settings` key-value store keys** (see [Section 11](#11-configuration))

### Storage layer exports (`server/storage.ts`)

17 store objects, one per domain:
```
userStore, endpointStore, modelStore, conversationStore, messageStore,
taskPlanStore, subtaskStore, skillStore, appStore, benchmarkStore,
analyticsStore, memoryStore, chatGroupStore, projectStore,
mcpServerStore, backgroundTaskStore, settingsStore
```

All methods are **synchronous** — use `.get()`, `.all()`, `.run()` (Drizzle's better-sqlite3 interface). Never `await` them.

---

## 5. Tool System

Tools are registered at import time via `registerTool(name, handler)` in `server/tools/registry.ts`. Each handler has a `definition` (OpenAI function schema) and `execute(args, context)`. Read the source directly when modifying a tool.

Two presentation modes: **native tool calling** (structured `tool_calls` in LLM response) and **prompted fallback** (`<tool_call>{...}</tool_call>` blocks parsed by `parsePromptedToolCalls()`). Mode is selected per-model based on `model.supportsToolCalling`.

Self-correction: on tool failure, `agent-loop.ts` injects the error back as a user turn (up to 2 retries per failure). After 2 failed corrections the loop continues without further injection.

### Tool categories and files

| Category | File | Key tools |
|---|---|---|
| `search` | `web-search.ts` | `web_search`, `fetch_url` |
| `search` | `browser-tools.ts` | `browse_url`, `browse_screenshot`, `browse_search`, `browse_extract` |
| `code` | `code-tools.ts` | `execute_code`, `shell_command`, `search_codebase`, `find_symbol` |
| `file` | `file-tools.ts` | `read_file`, `write_file`, `edit_file`, `list_files`, `search_files` |
| `file` | `file-tools.ts` | `read_project_file`, `write_project_file`, `edit_project_file`, `list_project_files` |
| `docker` | `docker-tools.ts` | `deploy_app`, `cleanup_apps`, `rollback_app`, `stop_app` |
| `memory` | `memory-tools.ts` | `memory_store`, `memory_recall`, `session_search` |
| `image` | `image-tools.ts` | `generate_image`, `image_to_image`, `inpaint_image`, `upscale_image` |
| `image` | `mask-tools.ts` | `create_inpaint_mask` |
| `image` | `comfyui-tools.ts` | `run_comfyui_workflow`, `build_comfyui_workflow`, `save_comfyui_workflow` |
| `skill` | `skill-tools.ts` | `skill_list`, `skill_view`, `skill_create`, `skill_edit` |
| `system` | `sub-agent.ts` | `spawn_subtasks` |
| `self-dev` | `self-dev-tools.ts` | all `selfdev_*` tools |

---

## 6. Agent Loop Deep Dive

**File**: `server/lib/agent-loop.ts` (~2200 lines) — the most complex file. Read it directly before making changes.

**Entry point**: `export async function runAgentLoop(req: AgentRequest): Promise<void>`

### Key constants
| Constant | Value | Purpose |
|---|---|---|
| `MAX_ITERATIONS` | 90 | Hard stop on loop iterations |
| `MAX_SELF_CORRECTIONS` | 2 | Retries per failed tool call |
| `MAX_NATIVE_FAILURES` | 3 | Before auto-switching to prompted mode |
| `MAX_ATTEMPTS` | 8 | LLM API retry attempts (429/5xx) |
| `KEEP_RECENT` | 6 | Messages always kept in full during compression |

### What the loop does (high level)
1. Classifies model size → trims history accordingly (small: 10 msgs, medium: 20, large: 200)
2. Builds system prompt via `buildSystemPrompt()` — injects plan, project spec, tool descriptions if prompted mode
3. `sanitizeMessages()` — repairs orphaned tool_calls, duplicate system msgs, undefined content
4. Each iteration: compress context if over budget → call LLM → parse response → execute tool calls → stream SSE events → repeat
5. Exits on: `finish_reason === "stop"` with content, `MAX_ITERATIONS` reached, stop signal, or unrecoverable error

### Context compression
When estimated tokens exceed budget, `compressContext()` truncates middle messages: tool results → 200 chars, write-tool `tool_calls` are **never** compressed (preserves file content integrity), long user messages → 500 chars. System prompt and last `KEEP_RECENT` messages always kept in full.

### Key helper functions (search for these when editing)
- `buildSystemPrompt()` — constructs the system message
- `sanitizeMessages()` — repairs message history before each LLM call
- `compressContext()` — token budget management
- `parsePromptedToolCalls()` — extracts `<tool_call>` blocks from text responses
- `classifyModelSize()` — small/medium/large from model name
- `stripToolCallSyntax()` — removes `<tool_call>...</tool_call>` blocks from visible text

---

## 7. Model Routing

**Files**: `server/lib/orchestrator.ts`, `server/lib/classifier.ts`

### Classification pipeline

`routeMessage(message, useAutoRouting, conversationId)`:

1. **Keyword classification**: `classifyByKeywords(message, conversationId)` in `classifier.ts` — pattern matches to assign a `TaskType` and confidence (0–1). Uses conversation history context to infer task continuity.

2. **LLM classification** (only if `autoRouting === true` AND keyword confidence < 0.6): calls the orchestrator endpoint's model with a one-shot classification prompt (`buildClassificationPrompt`), `temperature: 0.1`, `maxTokens: 20`. Falls back to keyword result on error.

3. `selectModel(taskType)` scores all enabled models:
   - Explicit `taskAssignment` tag match: +100 (or -20 if tagged for a different task)
   - Model name pattern match (e.g., `qwen.*coder` for coding): +40–60
   - Notes field mention: +10
   - `supportsToolCalling` for coding/research: +5
   - No tag (generalist) for "general" task: +10

   Returns the highest-scoring model's `{ model, endpoint }`.

### Orchestrator endpoint concept

An endpoint can be flagged `isOrchestrator: true`. This endpoint is used exclusively for:
- LLM-based task classification (when keyword confidence is low)
- Task planning via `task-planner.ts`

Worker endpoints handle the actual agent loop execution. The same endpoint can serve both roles.

### Model loading (`ensureModelLoaded`)

Only runs for local providers (LM Studio). Logic:
1. If `preferredContextLength` not set → skip (LM Studio manages loading).
2. Check `isModelLoaded(endpoint, modelId)` — if already loaded at the right context (±5% tolerance), skip.
3. If loaded at wrong context → `unloadModel()` then `loadModel()`.
4. If not loaded → `getLoadedModels()` and unload all others (frees VRAM), then `loadModel()`.
5. On success, updates `model.loadedContextLength` in DB.
6. If load fails after explicit unload → throws (no model available; routes.ts catches this and returns an error).

---

## 8. Frontend Architecture

### Routing

**File**: `client/src/App.tsx`

Uses `wouter` with **hash-based routing** (`useHashLocation`). All routes are prefixed `/#/`. The Chat page is always mounted but hidden (CSS `invisible`) when not on a chat route — this preserves SSE streaming state if the user navigates away and back.

### Pages

| Route | File | Lines | Purpose |
|---|---|---|---|
| `/#/` or `/#/chat/:id` | `pages/chat.tsx` | 1236 | Main chat; SSE streaming, image upload, lightbox, smart scroll |
| `/#/workspace/:id?` | `pages/workspace.tsx` | 2445 | IDE: file tree, Monaco-style editor, workspace chat, terminal, git panel, diff preview |
| `/#/settings` | `pages/settings.tsx` | 1458 | Endpoints, models, system prompt, skills, SearXNG, kill switch, MCP, self-dev |
| `/#/apps` | `pages/app-store.tsx` | 410 | Docker app dashboard |
| `/#/tasks` | `pages/tasks.tsx` | 357 | Background tasks |
| `/#/memory` | `pages/memory.tsx` | 455 | Memory browser |
| `/#/skills` | `pages/skills.tsx` | 496 | Skill manager with versioning |
| `/#/analytics` | `pages/analytics.tsx` | 529 | Token usage, model performance charts (recharts) |
| `/#/benchmark` | `pages/benchmark.tsx` | 523 | LLM benchmarking suite |
| `/#/console` | `pages/console.tsx` | 265 | Live server log viewer (SSE from `/api/console/stream`) |

### Data fetching

**File**: `client/src/lib/queryClient.ts`

- `TanStack Query` (`@tanstack/react-query`) for all REST data.
- `apiRequest(method, path, body?)` — wrapper around `fetch` with `credentials: "include"`. Throws `Error(data.message)` on non-2xx.
- `queryClient.invalidateQueries({ queryKey: [...] })` after mutations to trigger re-fetches.

### Auth context

`App.tsx` exports `useAuth()` — provides `{ authenticated, username, login(), logout() }`. Login sets a cookie via `/api/auth/login`; `auth/check` validates the cookie on page load.

### Styling

- Tailwind CSS + shadcn/ui components (Radix UI primitives)
- Dark mode always-on (cyberpunk aesthetic): `document.documentElement.classList.add("dark")` in `initTheme()`
- Custom CSS variables for neon/cyberpunk colors in `client/src/index.css`
- Component library: `client/src/components/ui/` (shadcn generated)

### Key patterns

- **SSE streaming** in `chat.tsx`: native `fetch()` + `ReadableStream` reader loop, not `EventSource` (allows POST with body).
- **Smart scroll**: auto-scrolls to bottom during streaming; stops if user scrolls up; resumes when user returns to bottom.
- **Workspace chat**: `workspace.tsx` runs its own chat panel that sends requests with `systemPrompt` including project context.
- **ChatPage always mounted**: `<div className={isChatRoute ? "z-10 visible" : "z-0 invisible"}>` — keeps component alive between navigations.

---

## 9. Docker System

### App lifecycle

**Files**: `server/docker/manager.ts`, `server/tools/app-deploy.ts`

Status states: `building → running | error`, `running → stopped`, `stopped → running`.

**Deploy flow** (`deploy_app` tool):
1. Write source files to a temp build directory.
2. Detect or generate a `Dockerfile` (auto-generated for common patterns: Node, Python, static HTML).
3. `docker build -t <imageName> <buildDir>` via dockerode.
4. Assign next available host port (starting from 3100, scanning upward).
5. `docker run -d -p <hostPort>:<internalPort> --name <containerName> <imageName>`.
6. Update `apps` record: `status: "running"`, `containerId`, `port`.
7. Agent loop emits `{ type: "files_changed" }` to refresh app-store UI.

**Rollback**: Each successful deploy increments `apps.version`. Rollback stops the current container, rebuilds from the stored `dockerfile` field of the previous version record (maintained in a separate version history queried via `/api/apps/:id/versions`).

**Code execution sandbox**: `execute_code` and `shell_command` tools run commands inside a Docker container (not the host), preventing filesystem escape. The container has access to `/workspace` via a volume mount.

**Manager** (`docker/manager.ts`):
- `init()` — connects to Docker daemon; sets `isReady()` flag.
- Wraps dockerode with typed helpers: `buildImage`, `createContainer`, `startContainer`, `stopContainer`, `removeContainer`, `getContainerLogs`.
- Port scanning: `findAvailablePort(start)` scans from 3100 upward, checking both OS and DB records.

---

## 10. Security Model

### Authentication
- JWT (`jsonwebtoken`) with 7-day expiry. Secret: `process.env.JWT_SECRET` (defaults to a hardcoded dev key — change in production).
- Token stored in `agent2077_token` HTTP cookie (set by `handleLogin`).
- `requireAuth` middleware checks `Authorization: Bearer <token>` header first, then falls back to cookie.
- Applied to all `/api/*` routes except `/api/auth/login`.

### Network isolation
- Server binds to `0.0.0.0:5000` by default — LAN accessible.
- Intended deployment: local Ubuntu machine on a private network (`Agent2077.local` via Avahi mDNS).
- No HTTPS by default — intended for LAN use only.

### Internet kill switch
- Setting `internetEnabled` in the `settings` table.
- `web-search.ts` checks this setting before making any outbound requests. Returns an error to the agent if disabled.
- SearXNG URL is also configurable; `web_search` routes through it.

### Shell command safety
- `isDestructiveOperation()` in `agent-loop.ts` checks for dangerous patterns: `rm -rf`, `rm -r`, `rmdir`, `mkfs`, `dd if=`, `chmod -R 777`, `> /dev/`, `format `, `rm .`, `rm ./`, `rm *`.
- Detected destructive operations are logged and a warning step is emitted; execution still proceeds (approval UI integration is noted as a future improvement in the code).
- Code execution runs inside Docker (not directly on host).

### Path traversal prevention
- `file-tools.ts` and `project-tools.ts` resolve paths relative to `/workspace` or the project's `path` field; `path.resolve` is used to detect traversal attempts.

---

## 11. Configuration

All settings are stored in the `settings` table (key-value, both columns text). Initialized with defaults by `settingsStore.initDefaults()` on startup.

### Key settings

| Key | Type | Default | Purpose |
|---|---|---|---|
| `autoRouting` | `"true"` / `"false"` | `"true"` | Enable LLM-assisted task classification |
| `internetEnabled` | `"true"` / `"false"` | `"true"` | Internet kill switch for web_search / fetch_url |
| `searxng.enabled` | `"true"` / `"false"` | `"false"` | Use SearXNG instead of direct DuckDuckGo |
| `searxng.url` | URL string | `""` | SearXNG instance URL |
| `selfDevEnabled` | `"true"` / `"false"` | `"false"` | Enable self-development mode |
| `systemPrompt` | text | (built-in) | Global system prompt override |
| `skills.autoApprove` | `"true"` / `"false"` | `"false"` | Auto-approve agent-generated skills |
| `skillAutoSave` | `"true"` / `"false"` | `"false"` | Auto-save skills from agent sessions |
| `contextTokenBudget` | integer string | `""` | Manual override for context compression budget |

### Reading / writing settings

```typescript
// Read
settingsStore.get("autoRouting");          // returns string | undefined

// Write
settingsStore.set("autoRouting", "false");

// Batch update (from PATCH /api/settings)
settingsStore.setMany({ autoRouting: "false", internetEnabled: "true" });
```

---

## 12. File Dependencies

Understanding these import chains prevents breaking changes when editing shared files.

### `shared/schema.ts`
**Imported by**: `server/storage.ts`, `server/db.ts`  
**Impact of changes**: Changing table definitions requires a matching `runMigrations()` entry in `db.ts` (or `initNewTables()` for new tables). Changing TypeScript types cascades to all store methods in `storage.ts` and any routes that use `Insert*` types.

### `server/storage.ts`
**Imported by**: `server/routes.ts`, `server/lib/agent-loop.ts`, `server/lib/orchestrator.ts`, `server/lib/task-planner.ts`, `server/lib/background-tasks.ts`, `server/middleware/auth.ts`, various tool files  
**Impact of changes**: A rename or signature change to any store method affects all of the above. The most-used stores are `messageStore`, `settingsStore`, `skillStore`, `projectStore`.

### `server/lib/agent-loop.ts`
**Imported by**: `server/routes.ts` (single export: `runAgentLoop`)  
**Impact of changes**: The `AgentRequest` interface is defined here — changes must be matched in `routes.ts`'s call site. SSE event types must match what `client/src/pages/chat.tsx` expects.

### `server/lib/llm-client.ts`
**Imported by**: `server/lib/agent-loop.ts`, `server/lib/orchestrator.ts`, `server/lib/task-planner.ts`, `server/lib/sub-agent-executor.ts`, `server/routes.ts`  
**Impact of changes**: `ChatMessage`, `ToolCall`, `ToolDefinition` types are central; changing them cascades everywhere.

### `server/tools/registry.ts`
**Imported by**: Every tool file (`registerTool`), `server/lib/agent-loop.ts` (`executeTool`, `getToolDefinitions`, `getToolDescriptionsText`), `server/lib/sub-agent-executor.ts`  
**Impact of changes**: `ToolHandler`, `ToolContext`, `ToolResult`, `AgentStep` interfaces affect all tool implementations.

### `server/lib/conversation-bus.ts`
**Imported by**: `server/routes.ts` (`subscribe`, `broadcast`, `markActive`, `markInactive`, `isActive`)  
**Impact of changes**: The wrapping of `res.write` in `routes.ts` (line 94–101) depends on this module. If the broadcast contract changes, the SSE fan-out to other tabs breaks.

### `server/db.ts`
**Imported by**: `server/storage.ts` (imports `db`, `sqlite`), `server/index.ts` (imports `initFTS`, `runMigrations`, `initNewTables`)  
**Impact of changes**: `DB_PATH` is `data/agent2077.db` relative to `process.cwd()`. Changing DB pragmas or the migration list affects startup behavior.

### Dependency graph summary

```
shared/schema.ts
  └── server/db.ts
        └── server/storage.ts
              ├── server/routes.ts
              │     ├── server/lib/agent-loop.ts
              │     ├── server/lib/orchestrator.ts
              │     └── server/lib/task-planner.ts
              └── server/lib/agent-loop.ts

server/tools/registry.ts
  └── (all tool files register to it)
  └── server/lib/agent-loop.ts (calls executeTool)

server/lib/llm-client.ts
  └── server/lib/agent-loop.ts
  └── server/lib/orchestrator.ts
  └── server/lib/task-planner.ts

server/lib/conversation-bus.ts
  └── server/routes.ts
```

---

## 13. Build System

### Scripts (`package.json`)

| Script | Command | Purpose |
|---|---|---|
| `npm run dev` | `NODE_ENV=development tsx watch server/index.ts` | Dev server with hot reload via tsx |
| `npm run build` | `tsx script/build.ts` | Production build |
| `npm run start` | `NODE_ENV=production node dist/index.cjs` | Run production bundle |
| `npm run db:push` | `drizzle-kit push` | Push schema changes to DB |
| `npm run db:studio` | `drizzle-kit studio` | Drizzle Studio GUI |

### Build script (`script/build.ts`)

1. `rm -rf dist`
2. **Client**: `viteBuild()` — outputs to `dist/public/`
3. **Server**: `esbuild({ entryPoints: ["server/index.ts"], format: "cjs", outfile: "dist/index.cjs" })`

**Bundling strategy**: An explicit `allowlist` of packages is bundled into the server binary for faster cold start. All other packages are marked `external`. The externals list is computed as `allDeps.filter(dep => !allowlist.includes(dep))`.

**Current allowlist** (bundled into `dist/index.cjs`):
`bcryptjs`, `cookie-parser`, `cors`, `drizzle-orm`, `drizzle-zod`, `eventsource-parser`, `express`, `express-session`, `helmet`, `jsonwebtoken`, `morgan`, `nanoid`, `uuid`, `zod`

**External packages** (loaded from `node_modules` at runtime): `better-sqlite3`, `dockerode`, `jsonrepair`, `ws`, `node-pty`, all Radix UI, etc. These must be present in `node_modules` for production to work.

**IMPORTANT**: If you add a new `npm install <package>` to server code, you must either add it to the `allowlist` in `script/build.ts` or ensure it's available in `node_modules` on the target machine. The build will silently not bundle external packages — they will just fail at runtime if missing.

### Output structure

```
dist/
  index.cjs          ← server bundle (run with: node dist/index.cjs)
  public/
    index.html
    assets/
      index-[hash].js
      index-[hash].css
```

---

## 14. Common Pitfalls

These are real bugs that have been fixed or are known gotchas. Refer to this section before making changes.

### SQLite is synchronous — use `.get()` / `.all()` / `.run()`

The `better-sqlite3` driver is synchronous. Drizzle's `.get()` returns a single row directly, `.all()` returns an array, `.run()` executes without returning rows. **Do not `await` storage calls.** Do not use Drizzle's async API (it doesn't exist with this driver).

```typescript
// WRONG
const user = await db.select().from(users).where(eq(users.id, id)).get();

// CORRECT
const user = db.select().from(users).where(eq(users.id, id)).get();
```

### LM Studio requires strict tool_call/tool message pairing

Every `assistant` message with a `tool_calls` array **must** be immediately followed by `tool` role messages with matching `tool_call_id` values. If the history has an assistant message with `tool_calls` but no matching `tool` messages, LM Studio returns a 400 error: `"Invalid 'messages' in payload"`.

`sanitizeMessages()` in `agent-loop.ts` handles this automatically for the current session, but when building history from DB, **do not reconstruct `tool_calls`** from the stored `toolCalls` JSON column. The current code in `routes.ts` (line 290–315) correctly strips `tool_calls` from historical messages.

### Don't reconstruct tool_calls in history messages

See the comment block in `routes.ts` around line 282–290. The `messages` table stores `toolCalls` (the raw calls) and `toolResults` (the outcomes) as JSON columns for display purposes — not for re-injection into LLM history. Injecting them creates orphaned tool_calls without matching tool responses.

### `fs.unlinkSync` doesn't work on directories — use `rmSync`

```typescript
// WRONG — throws EISDIR
fs.unlinkSync("/some/directory");

// CORRECT
fs.rmSync("/some/directory", { recursive: true, force: true });
```

### Always check `stat.isDirectory()` before delete operations

Use `fs.statSync(path).isDirectory()` to branch between `unlinkSync` (file) and `rmSync` (directory). File tools should already do this, but custom code must too.

### ESM imports need `.js` extension even for `.ts` files

The project uses `"type": "module"` in `package.json`. Node.js ESM requires explicit extensions. When importing a `.ts` file in another `.ts` file, use `.js`:

```typescript
// CORRECT (TypeScript resolves .js → .ts at compile time)
import { foo } from "./my-module.js";

// WRONG
import { foo } from "./my-module";
import { foo } from "./my-module.ts";
```

### esbuild external list must include new packages

When adding a new `npm install <package>` to server code: if you do **not** add it to the `allowlist` in `script/build.ts`, it will be treated as `external`. This is fine as long as `node_modules` is present in production. But if deploying a single-file bundle without `node_modules`, add the package to the allowlist.

### Context window overflow causes empty responses

When `messages` array token count exceeds the model's loaded context, LM Studio returns an empty response (or a 400). The `compressContext()` function handles this mid-loop, but if the initial history from DB is already over budget, the first LLM call will fail. `trimHistoryForModel()` handles this at startup, but be aware that very long conversations with large attachments can still overwhelm small models.

### `shouldContinue()` can cause infinite loops if not guarded

The `iterationsSinceLastToolCall` counter is the key guard: if the model produces 2+ content-only iterations in a row without calling any tools, `shouldContinue()` returns `false` regardless of any other signals. Without this guard, action phrases like `"I'll now summarize..."` would keep nudging the model forever.

### The chat SSE response object is wrapped to broadcast to other tabs

`routes.ts` replaces `res.write` with a wrapper that calls `broadcast(convId, chunk, res)` for every SSE event. This means any code that receives the `res` object (including `agent-loop.ts`) is already broadcasting to all subscribers. **Do not call `broadcast()` separately on the same `res` object** — it would double-send events.

### Orphaned tool responses become user messages

`sanitizeMessages()` converts tool-role messages with no matching `tool_call_id` in the history into user-role messages. This is a recovery mechanism, not desired behavior. If you see context corruption, check that assistant messages and their following tool messages are always built together as a pair.

### `node-pty` is an optional dependency

`package.json` lists `node-pty` under `optionalDependencies`. The terminal WebSocket feature degrades gracefully if it's not installed. Don't make it a hard dependency.

---

## 15. Changelog

Format for dev sessions: date, description of changes, files modified.

```
## [YYYY-MM-DD] — Session title

### Changes
- Description of what was added/changed/fixed
  - Files: server/lib/agent-loop.ts, server/routes.ts

### Notes
- Any caveats, known issues, or follow-up tasks
```

---
