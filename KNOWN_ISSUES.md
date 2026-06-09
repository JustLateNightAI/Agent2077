# Known Issues & Root Cause Chain

This file documents every non-obvious bug, footgun, and architectural pitfall discovered during Agent2077 development. The self-development AI **must read this before making changes** to avoid repeating past mistakes.

---

## Build & Compilation

### 1. `.js` extensions required on local imports
TypeScript compiles to ESM, so all local imports must use `.js` extensions:
```typescript
// WRONG
import { foo } from "./bar";
// RIGHT
import { foo } from "./bar.js";
```
Forgetting this causes `ERR_MODULE_NOT_FOUND` at runtime even though `tsc` compiles fine.

### 2. `ws` package must be explicitly installed
Even though `ws` is in `package.json`, it may not be installed if `npm install` was run before it was added. Always verify with `npm ls ws`.

### 3. Playwright/chromium-bidi must be externalized in build
The `script/build.ts` esbuild config must list `playwright-core`, `playwright`, and `chromium-bidi` in the external array. Without this, the build bundles binary-dependent modules and crashes at runtime.

### 4. esbuild externals must include `better-sqlite3`
Native modules cannot be bundled. `better-sqlite3` is already in the external list but if new native modules are added, they must be externalized too.

---

## Database & Storage

### 5. Drizzle `better-sqlite3` driver is synchronous
Queries use `.get()` for single rows and `.all()` for arrays. Do NOT use destructuring:
```typescript
// WRONG — returns the query builder, not a row
const [row] = db.select().from(users).where(eq(users.id, id));
// RIGHT
const row = db.select().from(users).where(eq(users.id, id)).get();
```

### 6. SQLite does not support array columns
Store lists as JSON text columns and parse in application code.

### 7. Schema migrations must handle existing data
When adding a column, the `db.ts` migration must use `ALTER TABLE ... ADD COLUMN` with a default value, not recreate the table.

---

## Agent Loop

### 8. `shouldContinue()` can cause infinite loops
**Root cause**: The agent loop checks `shouldContinue()` to decide whether to keep iterating. If the model keeps making tool calls without ever producing a completion phrase, the loop runs forever.
**Fix**: Added `iterationsSinceLastToolCall` counter and completion phrase detection. If > 3 iterations pass without a tool call AND the response contains phrases like "I've completed", "here's the result", etc., force stop.

### 9. Tool call / result pairing must match exactly
When sending tool results back to the model, each `tool_call.id` must have a matching tool result message. Mismatched or missing IDs cause the model to hallucinate or error.

### 10. `res.write()` SSE broadcast must be wrapped
All `res.write()` calls for SSE events must follow the format `data: ${JSON.stringify(payload)}\n\n`. Missing the `data: ` prefix or the double newline breaks SSE parsing on the client.

### 11. Auto-fallback from native to prompted mode
If a model doesn't support the `tools` parameter, the agent loop automatically falls back to prompted tool calling. The fallback is triggered by HTTP 400/422 errors or specific error messages containing "tools". Don't assume all models support native tool calling.

---

## Frontend

### 12. Code blocks overflow off-screen
**Root cause**: `<pre>` and `<code>` elements had no max-width constraint.
**Fix**: Added `max-w-full whitespace-pre-wrap break-words` to pre/code in the markdown renderer.

### 13. Auto-scroll forces user to bottom while reading
**Root cause**: The chat auto-scrolled on every new token, even when the user had scrolled up to read history.
**Fix**: Track `isNearBottom` state. Only auto-scroll if user is within 150px of the bottom. Show a "jump to present" button when scrolled up.

### 14. Image lightbox must be explicitly implemented
Clicking on uploaded images should open a full-screen lightbox. This requires a portal-based overlay component — it's not built into shadcn.

### 15. Hash routing required for wouter
The app runs in an iframe, so path-based routing breaks. Must use `useHashLocation` from `wouter/use-hash-location` on the `<Router>` component. Routes use `/#/path` format.
```tsx
// WRONG — useHashLocation on Switch
<Switch hook={useHashLocation}>
// RIGHT — useHashLocation on Router
<Router hook={useHashLocation}>
  <Switch>
```

### 16. Never use `href="#section"` for in-page anchors
Hash routing intercepts these as route changes. Use `onClick` with `scrollIntoView()` instead.

### 17. Do NOT use localStorage/sessionStorage/indexedDB/cookies
These are blocked in the sandboxed iframe. Use React state for transient data and the backend API + SQLite for persistent data.

---

## Terminal & WebSocket

### 18. Terminal WebSocket uses session-based flow
**Root cause**: Client was connecting directly to `ws://host/terminal` which didn't exist.
**Fix**: The correct flow is:
1. POST `/api/terminal/sessions` to create a session (returns `sessionId`)
2. Connect WebSocket to `ws://host/terminal?sessionId=<id>`

### 19. WebSocket error on page load is normal
The WebSocket may fail to connect on initial page load if the terminal component mounts before the session is created. This is expected and the component retries.

---

## Docker & Apps

### 20. Docker container port allocation must check for conflicts
When deploying an app, the system assigns a port. If a previous container still holds that port, the deploy fails. Always check port availability before assigning.

---

## Self-Development

### 21. Dev workspace must exclude `node_modules`, `.git`, `data/`, `*.db`
Copying these to the dev workspace wastes space and causes conflicts. The `EXCLUDE_PATTERNS` in `dev-workspace.ts` handles this.

### 22. Dev server runs on port 5050, production on 5000
These must not conflict. The dev server uses `AGENT2077_DEV_MODE=true` env var to differentiate.

### 23. ARCHITECTURE.md updates only after verified changes
Never update the architecture doc optimistically. Build must pass AND tests must pass before documenting a change. Otherwise the doc diverges from reality.

### 24. `npm install` timeout in dev workspace
The dev workspace runs `npm install` during init, which can take up to 5 minutes on first run. The timeout is set to 300000ms (5 min).

---

## Security

### 25. Path traversal prevention on all file operations
Any file read/write that accepts user input must resolve the path and verify it starts with the expected root directory. Both `dev-workspace.ts` and `project-tools.ts` implement this.

### 26. Dangerous shell commands must be blocked
`runDevCommand` and `run_project_command` block patterns like `rm -rf /`, `mkfs`, `dd if=`, `chmod -R 777 /`, etc.

### 27. Internet kill switch affects all outbound requests
When the kill switch is enabled (`internetKillSwitch: "true"`), the agent loop must not make any HTTP requests to external services. Only localhost and LAN addresses are allowed.

---

## Model Routing

### 28. Model task assignments are JSON arrays (or legacy strings)
The `taskAssignment` column on the models table stores a JSON array like `["coding","research"]`. Legacy entries may have a single string. Always parse safely:
```typescript
const tasks = JSON.parse(model.taskAssignment || "[]");
```

### 29. `ensureModelLoaded` may fail silently
If LM Studio can't load a model (out of VRAM, model file missing), the load request returns 200 but the model isn't actually available. Always verify with a subsequent `/v1/models` check.

---

## File System

### 30. `rmSync` vs `unlinkSync` — use the right one
- `unlinkSync` for individual files
- `rmSync({ recursive: true })` for directories
Using `unlinkSync` on a directory throws `EISDIR`.

### 31. File tree skip list must be maintained
The `FILE_TREE_SKIP` set in routes.ts excludes `node_modules`, `.git`, `dist`, etc. from file tree responses. If new heavy directories are added (like `screenshots/`), add them to this list.

---

## Self-Development (continued)

### 32. `selectModel()` must exclude `isSubAgent=true` models
`selectModel()` in `orchestrator.ts` filters out models flagged as sub-agent-only before scoring. Without this filter, the sub-agent model (e.g. a smaller fast model) could win the scoring for the primary agent loop too. Never remove the `!m.isSubAgent` filter from `selectModel()`.

### 33. Reset approval requires agent loop resume
When the agent requests a reset permission, it finishes its turn and goes idle. The approve route (`POST /api/self-dev/reset-permissions/:id/approve`) must inject a user message into the self-dev conversation and restart the agent loop via `runAgentLoop()`. Without this, approving the reset does nothing — the agent never wakes back up. Do not simplify the approve route to just update the Map entry.

### 34. `async-lock` file mutex is in-process only
`dev-workspace.ts` uses `AsyncLock` from the `async-lock` package for per-file locking. This only prevents races within the same Node.js process — it does NOT protect against multiple processes accessing the same file. Do not replace it with `proper-lockfile` or any cross-process locking mechanism; the entire dev workspace runs in a single process and in-process locking is sufficient and faster.

### 35. Sub-agents can now write files
As of v16.23, `selfdev_edit_file`, `selfdev_write_lines`, and `selfdev_rewrite_file` are no longer in `SUBAGENT_BLOCKED_TOOLS`. Sub-agents CAN write files safely because of the async-lock mutex. Do not re-add these to the blocked list.

### 36. `eval` warning in terminal-ws.ts is harmless
`script/build.ts` produces a warning: `Using direct eval with a bundler is not recommended`. This comes from `terminal-ws.ts` line 93 and is intentional — it's a runtime require() for `ws` inside a try/catch. Do not attempt to fix this warning; the code works correctly as-is.

### 37. WAL must be flushed before packaging
Before creating a distribution zip, always run `PRAGMA wal_checkpoint(TRUNCATE)` on the DB, then delete `*.db-wal` and `*.db-shm` files. If you package with a WAL file present, the DB inside the zip will be unreadable (sqlite3 returns "file is not a database" error). Always verify the DB by extracting it from the zip and running a query before delivering.

---

## Agent Loop (continued)

### 38. Over-eager tool calls on casual / new-chat turns
**Root cause**: Two compounding issues. (1) `tool_choice` was hardcoded to `"auto"` in both `chatCompletion` and `chatCompletionStream` (llm-client.ts), so even on a pure-chat turn — where the selector still ships a small "floor" of tools (`memory_recall`, `session_search`, etc.) plus any connected MCP tools — the model (especially small/local ones) would eagerly invoke them on a plain "hi". (2) The request-router only emitted the `respond` route for an exact set of greetings/"what is X" prefixes; broader small talk ("how's it going", new-chat openers) fell through to `unknown`, which loaded the full task bundle.
**Fix**: Added a `toolChoice?: "auto" | "none" | "required"` option to both LLM-client functions (default `"auto"`). Added `isCasualChat`/`hasActionableSignal`/`decideToolChoice` to request-router.ts: a turn is treated as casual (→ `tool_choice:"none"`) only when it has a casual marker or is very short AND has zero actionable signal (action verbs, file/path/url/code refs, app nouns). The agent loop applies this on the FIRST iteration only; once mid-task it's always `"auto"`. Project mode and the Deep Research toggle always keep `"auto"`. Tool schemas are STILL attached when `"none"` — so a genuine follow-up action works and the model can self-correct on later iterations. Do NOT hard-block tools globally; the gate is intent-based and conservative (ambiguous longer messages keep tools on). Covered by `server/lib/request-router.test.ts`.

---

*Last updated: ${new Date().toISOString()}*
*Add new entries at the bottom with the next sequential number.*
