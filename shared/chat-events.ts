/**
 * Normalized chat stream event types — shared across all three chat surfaces
 * (main chat, workspace chat, self-dev chat).
 *
 * The backend agent loop (server/lib/agent-loop.ts + the chat bus) emits a
 * single SSE format for every chat endpoint: lines of `data: <json>\n` where
 * the JSON is discriminated on a `type` field. Historically each client page
 * re-declared an opaque `{ type: string; [k: string]: any }` and hand-rolled an
 * incompatible subset of the switch. These types capture the full event
 * vocabulary once so `useChatStream()` and the three pages stay in sync.
 */

// ── Normalized client-side shapes consumed by ActivityRail & message UI ──────

/** A status-log entry as ActivityRail expects it (see ActivityRail.tsx). */
export interface ChatStatusEntry {
  message: string;
  detail?: string;
  timestamp: number;
}

/** An execution-plan step, normalized to ActivityRail's status enum. */
export interface ChatPlanStep {
  step: number;
  title: string;
  status: "pending" | "running" | "completed";
}

/** A tool/step entry fed to ActivityRail's `steps` prop. */
export interface ChatStep {
  type?: "step";
  label?: string;
  status?: "running" | "completed" | "failed" | string;
  detail?: string;
  [key: string]: any;
}

/** A pending tool-confirmation request surfaced as a banner. */
export interface ChatConfirmation {
  id: string;
  tool: string;
  args?: Record<string, any>;
  reason: string;
}

/** A pending confirmation plus the resolver that answers the server. */
export interface PendingConfirmation extends ChatConfirmation {
  resolve: (approved: boolean) => void;
}

/** A proposed file edit shown in the diff-preview dialog. */
export interface ChatDiffPreview {
  editId: number;
  filePath: string;
  description?: string;
  original: string;
  proposed: string;
}

// ── Raw SSE events (discriminated on `type`) ─────────────────────────────────

export type ChatStreamEvent =
  | { type: "request_id"; requestId: string }
  | { type: "conversation"; id: number }
  | { type: "user_message"; [key: string]: any }
  | { type: "routing"; model?: string; taskType?: string; [key: string]: any }
  | {
      type: "context_usage";
      estimatedPromptTokens?: number;
      contextWindowTokens?: number;
      contextUsedPercent?: number;
      source?: string;
      detail?: string;
    }
  | { type: "content"; content: string }
  | { type: "step"; label?: string; status?: string; detail?: string; [key: string]: any }
  | { type: "plan"; steps?: Array<{ step: number; title: string }> }
  | { type: "skill_proposal"; skill?: any; [key: string]: any }
  | { type: "status"; message: string; detail?: string; timestamp?: number }
  | { type: "system_notice"; content?: string }
  | { type: "subtask_progress"; subtaskId: number; status?: string; title?: string; specIndex?: number; [key: string]: any }
  | { type: "paused_credit"; reason?: string; provider?: string; resumeMessage?: string; currentBalance?: number; floorBalance?: number; [key: string]: any }
  | { type: "confirmation_needed"; id: string; tool: string; args?: Record<string, any>; reason: string }
  | { type: "diff_preview"; editId?: number; filePath?: string; description?: string; original?: string; proposed?: string; [key: string]: any }
  | { type: "files_changed"; [key: string]: any }
  | { type: "error"; content?: string }
  | { type: "done"; iterations?: number; toolCallCount?: number; [key: string]: any }
  | { type: "stream_end"; [key: string]: any }
  // Forward-compat fallback for any event the backend adds before the client
  // is updated. Keeps `JSON.parse` results assignable without `any`.
  | { type: string; [key: string]: any };

/** Max status-log entries retained in memory (matches prior per-page cap). */
export const CHAT_STATUS_LOG_LIMIT = 20;
