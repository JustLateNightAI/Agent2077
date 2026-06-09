/**
 * useChatStream — one normalized SSE consumer shared by the three chat surfaces
 * (main chat, workspace chat, self-dev chat).
 *
 * Before this hook each page hand-rolled the exact same reader/decoder/
 * `data: `-split/`JSON.parse`/`switch(event.type)` loop, but handled a slightly
 * different and incompatible subset of events. That meant a backend event change
 * had to be mirrored in three places — and divergence had already crept in
 * (workspace populated confirmation/diff state from the stream but never rendered
 * it). This hook owns the canonical parse loop plus the state ActivityRail and
 * the message UI need (`streaming`, `streamContent`, `statusLog`, `steps`,
 * `planSteps`, `pendingConfirm`, `diffPreviews`, `activeDiff`). Page-specific
 * events (routing, subtask overlay, credit pause, skill proposal, files_changed,
 * conversation/user_message bookkeeping, etc.) are delegated to callbacks so each
 * page keeps its unique behavior.
 *
 * The caller supplies the endpoint + request body, so `/api/chat` vs
 * `/api/self-dev/chat` and their different payloads are preserved verbatim.
 */
import { useCallback, useRef, useState } from "react";
import {
  CHAT_STATUS_LOG_LIMIT,
  type ChatStreamEvent,
  type ChatStatusEntry,
  type ChatStep,
  type ChatPlanStep,
  type ChatDiffPreview,
  type PendingConfirmation,
} from "@shared/chat-events";

export interface StartStreamArgs {
  url: string;
  body: unknown;
}

export interface UseChatStreamOptions {
  /**
   * Endpoint that answers a confirmation request. Defaults to the shared
   * `/api/chat/confirm` used by main + workspace chat.
   */
  confirmEndpoint?: string;
  /** Endpoint used by `stop()` to cancel the server-side run by requestId. */
  stopEndpoint?: string;
  /**
   * Fires for EVERY parsed event, after the hook applies its own core handling.
   * Pages use this to layer page-specific behavior (e.g. main chat reads
   * iteration counts off `done`, or maps `routing` into a badge). Receives the
   * raw normalized event.
   */
  onEvent?: (event: ChatStreamEvent) => void;
  /** Called when the stream loop ends (success, abort, or error). */
  onClose?: (err?: unknown) => void;
}

export interface UseChatStreamResult {
  streaming: boolean;
  streamContent: string;
  statusLog: ChatStatusEntry[];
  steps: ChatStep[];
  planSteps: ChatPlanStep[];
  pendingConfirm: PendingConfirmation | null;
  diffPreviews: ChatDiffPreview[];
  activeDiff: ChatDiffPreview | null;
  requestIdRef: React.MutableRefObject<string>;

  setActiveDiff: (d: ChatDiffPreview | null) => void;
  setPendingConfirm: React.Dispatch<React.SetStateAction<PendingConfirmation | null>>;
  /**
   * Imperative setters for pages that drive the same stream state from a
   * bespoke secondary path (e.g. self-dev's mount-reconnect and
   * after-reset-decision SSE subscriptions, workspace's EventSource reconnect).
   * Using these keeps a single source of truth feeding ActivityRail.
   */
  setStreaming: React.Dispatch<React.SetStateAction<boolean>>;
  setStreamContent: React.Dispatch<React.SetStateAction<string>>;
  setSteps: React.Dispatch<React.SetStateAction<ChatStep[]>>;
  setPlanSteps: React.Dispatch<React.SetStateAction<ChatPlanStep[]>>;
  setStatusLog: React.Dispatch<React.SetStateAction<ChatStatusEntry[]>>;
  /** Imperatively append to the streamed assistant text (e.g. decline notice). */
  appendContent: (text: string) => void;
  /** Push a status entry (e.g. a client-side "Stopped" marker). */
  pushStatus: (entry: ChatStatusEntry) => void;

  /** Build a confirmation resolver that POSTs to `confirmEndpoint`. */
  makeConfirmResolver: (confirmId: string, onDecline?: () => void) => (approved: boolean) => void;
  /** Answer the active confirmation and clear the banner. */
  respondConfirm: (approved: boolean) => void;

  /** Reset all stream state before a new turn. */
  reset: () => void;
  /** Run the SSE request + parse loop. Resolves when the stream ends. */
  start: (args: StartStreamArgs) => Promise<void>;
  /** Cancel the in-flight stream (server-side stop + local abort). */
  stop: () => void;
}

function appendCapped(prev: ChatStatusEntry[], entry: ChatStatusEntry): ChatStatusEntry[] {
  const next = [...prev, entry];
  return next.length > CHAT_STATUS_LOG_LIMIT ? next.slice(-CHAT_STATUS_LOG_LIMIT) : next;
}

export function useChatStream(options: UseChatStreamOptions = {}): UseChatStreamResult {
  const {
    confirmEndpoint = "/api/chat/confirm",
    stopEndpoint = "/api/chat/stop",
    onEvent,
    onClose,
  } = options;

  const [streaming, setStreaming] = useState(false);
  const [streamContent, setStreamContent] = useState("");
  const [statusLog, setStatusLog] = useState<ChatStatusEntry[]>([]);
  const [steps, setSteps] = useState<ChatStep[]>([]);
  const [planSteps, setPlanSteps] = useState<ChatPlanStep[]>([]);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirmation | null>(null);
  const [diffPreviews, setDiffPreviews] = useState<ChatDiffPreview[]>([]);
  const [activeDiff, setActiveDiff] = useState<ChatDiffPreview | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef<string>("");
  // Mirror of accumulated content so the parse loop stays synchronous and pages
  // can append (decline notices, errors) without a stale closure.
  const contentRef = useRef<string>("");
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const appendContent = useCallback((text: string) => {
    contentRef.current += text;
    setStreamContent(contentRef.current);
  }, []);

  const pushStatus = useCallback((entry: ChatStatusEntry) => {
    setStatusLog(prev => appendCapped(prev, entry));
  }, []);

  const makeConfirmResolver = useCallback(
    (confirmId: string, onDecline?: () => void) =>
      (approved: boolean) => {
        fetch(confirmEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ confirmId, approved }),
        }).catch(() => {});
        if (!approved) onDecline?.();
      },
    [confirmEndpoint],
  );

  const respondConfirm = useCallback((approved: boolean) => {
    setPendingConfirm(prev => {
      prev?.resolve(approved);
      return null;
    });
  }, []);

  const reset = useCallback(() => {
    contentRef.current = "";
    setStreamContent("");
    setStatusLog([]);
    setSteps([]);
    setPlanSteps([]);
    setPendingConfirm(null);
    setDiffPreviews([]);
    setActiveDiff(null);
    requestIdRef.current = "";
  }, []);

  const start = useCallback(
    async ({ url, body }: StartStreamArgs) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setStreaming(true);

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        const reader = res.body?.getReader();
        if (!reader) return;

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            let event: ChatStreamEvent;
            try {
              event = JSON.parse(line.slice(6));
            } catch {
              continue;
            }

            // ── Core handling shared by all chat surfaces ──────────────────
            switch (event.type) {
              case "request_id":
                requestIdRef.current = (event as any).requestId || "";
                break;
              case "content":
                contentRef.current += (event as any).content || "";
                setStreamContent(contentRef.current);
                break;
              case "step":
                setSteps(prev => [...prev, event as ChatStep]);
                break;
              case "plan": {
                const planEvt = event as Extract<ChatStreamEvent, { type: "plan" }>;
                if (planEvt.steps && Array.isArray(planEvt.steps)) {
                  setPlanSteps(planEvt.steps.map(s => ({
                    step: s.step,
                    title: s.title,
                    status: "pending" as const,
                  })));
                }
                break;
              }
              case "status": {
                const s = event as Extract<ChatStreamEvent, { type: "status" }>;
                setStatusLog(prev => appendCapped(prev, {
                  message: s.message,
                  detail: s.detail,
                  timestamp: s.timestamp || Date.now(),
                }));
                break;
              }
              case "system_notice":
                setStatusLog(prev => appendCapped(prev, {
                  message: (event as any).content || "Note",
                  timestamp: Date.now(),
                }));
                break;
              case "confirmation_needed": {
                const c = event as Extract<ChatStreamEvent, { type: "confirmation_needed" }>;
                setPendingConfirm({
                  id: c.id,
                  tool: c.tool,
                  args: c.args,
                  reason: c.reason,
                  resolve: makeConfirmResolver(c.id, () => {
                    appendContent("\n\n*Operation declined by user.*");
                  }),
                });
                break;
              }
              case "diff_preview": {
                const d = event as Extract<ChatStreamEvent, { type: "diff_preview" }>;
                if (d.editId && d.filePath) {
                  const dp: ChatDiffPreview = {
                    editId: d.editId,
                    filePath: d.filePath,
                    description: d.description,
                    original: d.original || "",
                    proposed: d.proposed || "",
                  };
                  setDiffPreviews(prev => [...prev, dp]);
                  setActiveDiff(dp);
                }
                break;
              }
              case "error":
                appendContent(`\n\n**Error:** ${(event as any).content}`);
                break;
              case "done":
              case "stream_end":
                setPlanSteps(prev => prev.map(s => ({ ...s, status: "completed" as const })));
                break;
            }

            // ── Page-specific layering ─────────────────────────────────────
            onEventRef.current?.(event);
          }
        }
      } catch (err: any) {
        if (err?.name !== "AbortError") {
          appendContent(`\n\n**Error:** ${err?.message ?? String(err)}`);
        }
        onClose?.(err);
        return;
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
      onClose?.();
    },
    [appendContent, makeConfirmResolver, onClose],
  );

  const stop = useCallback(() => {
    if (requestIdRef.current) {
      fetch(stopEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ requestId: requestIdRef.current }),
      }).catch(() => {});
    }
    abortRef.current?.abort();
    pushStatus({ message: "Stopped", timestamp: Date.now() });
  }, [stopEndpoint, pushStatus]);

  return {
    streaming,
    streamContent,
    statusLog,
    steps,
    planSteps,
    pendingConfirm,
    diffPreviews,
    activeDiff,
    requestIdRef,
    setActiveDiff,
    setPendingConfirm,
    setStreaming,
    setStreamContent,
    setSteps,
    setPlanSteps,
    setStatusLog,
    appendContent,
    pushStatus,
    makeConfirmResolver,
    respondConfirm,
    reset,
    start,
    stop,
  };
}
