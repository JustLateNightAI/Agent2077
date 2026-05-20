/**
 * Agent Stream — Decouples agent loop execution from SSE client connections.
 *
 * The agent loop writes events to an AgentStream instead of directly to `res`.
 * The AgentStream buffers all events in memory. SSE clients subscribe to the
 * stream and receive live events + replay of anything they missed.
 *
 * If the browser tab closes, the agent loop keeps running. When the user
 * reconnects (same conversation), they get the full event history replayed
 * and then live events from that point forward.
 *
 * Lifecycle:
 *   1. Route creates an AgentStream for the conversation
 *   2. Agent loop calls stream.write() instead of res.write()
 *   3. SSE clients call stream.subscribe(res) — gets replay + live
 *   4. When loop finishes, stream.end() marks it done
 *   5. Late subscribers still get the full replay
 *   6. Stream is cleaned up after TTL expires (default 30 min)
 */

import type { Response } from "express";

export interface AgentStreamEvent {
  /** Raw SSE data string (e.g., `data: {"type":"content",...}\n\n`) */
  raw: string;
  /** Parsed event type for filtering */
  eventType: string;
  /** Timestamp */
  ts: number;
}

interface Subscriber {
  res: Response;
  /** Index into events[] — next event to send */
  cursor: number;
}

export class AgentStream {
  private events: AgentStreamEvent[] = [];
  private subscribers = new Set<Subscriber>();
  private _done = false;
  private _cancelled = false;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    public readonly conversationId: number,
    public readonly requestId: string,
    /** Time-to-live after stream ends (ms). Default 30 minutes. */
    private ttlMs: number = 30 * 60 * 1000,
  ) {}

  /** Write an SSE event. Buffers it and pushes to all live subscribers. */
  write(sseData: string): boolean {
    if (this._done) return false;

    // Parse event type from JSON for filtering
    let eventType = "unknown";
    try {
      const match = sseData.match(/^data: (.+)$/m);
      if (match) {
        const parsed = JSON.parse(match[1]);
        eventType = parsed.type || "unknown";
      }
    } catch { /* non-JSON event */ }

    const event: AgentStreamEvent = {
      raw: sseData,
      eventType,
      ts: Date.now(),
    };
    this.events.push(event);

    // Push to all live subscribers
    const dead: Subscriber[] = [];
    this.subscribers.forEach(sub => {
      try {
        sub.res.write(sseData);
        sub.cursor = this.events.length;
      } catch {
        dead.push(sub);
      }
    });
    dead.forEach(d => this.subscribers.delete(d));

    return true;
  }

  // ── Mid-task message injection ───────────────────────────────────────────
  // Allows the user to send a nudge/correction while the agent loop is running.
  // The loop checks pendingUserMessage at the start of each iteration.
  private _pendingUserMessage: string | null = null;

  /** Queue a user message to be injected at the next iteration boundary. */
  injectUserMessage(message: string): void {
    this._pendingUserMessage = message;
  }

  /** Consume the pending message (returns it and clears the queue). */
  consumePendingMessage(): string | null {
    const msg = this._pendingUserMessage;
    this._pendingUserMessage = null;
    return msg;
  }

  /** Whether there's a pending message waiting to be injected. */
  get hasPendingMessage(): boolean {
    return this._pendingUserMessage !== null;
  }

  /** Mark the stream as complete. Late subscribers will still get replay. */
  end(): void {
    this._done = true;

    // Close all live subscriber connections gracefully
    this.subscribers.forEach(sub => {
      try { sub.res.end(); } catch { /* already closed */ }
    });
    this.subscribers.clear();

    // Schedule cleanup
    this.cleanupTimer = setTimeout(() => {
      activeStreams.delete(this.conversationId);
    }, this.ttlMs);
  }

  /** Whether the agent loop has finished */
  get done(): boolean { return this._done; }

  /** Mark as cancelled (user-initiated stop) */
  cancel(): void { this._cancelled = true; }

  /** Whether the stream was cancelled */
  get cancelled(): boolean { return this._cancelled; }

  /** Total buffered events */
  get eventCount(): number { return this.events.length; }

  /**
   * Subscribe an SSE response to this stream.
   * Replays all buffered events, then streams live.
   * Returns an unsubscribe function.
   */
  subscribe(res: Response): () => void {
    // Set SSE headers — but only if the route handler hasn't already set them.
    // When called from the initial POST /api/chat handler, headers are already sent
    // (the route writes request_id before subscribe). When called from the
    // reconnect endpoint GET /api/conversations/:id/stream, headers are fresh.
    if (!res.headersSent) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
    }

    // Replay all buffered events
    for (const event of this.events) {
      try {
        res.write(event.raw);
      } catch {
        // Client already gone during replay — don't add as subscriber
        return () => {};
      }
    }

    // If stream is already done, close the response
    if (this._done) {
      try { res.end(); } catch {}
      return () => {};
    }

    // Add as live subscriber
    const sub: Subscriber = { res, cursor: this.events.length };
    this.subscribers.add(sub);

    const unsub = () => {
      this.subscribers.delete(sub);
    };

    // Auto-unsubscribe on client disconnect
    res.on("close", unsub);

    return unsub;
  }

  /** Get a snapshot of the stream status (for polling endpoint) */
  status(): {
    done: boolean;
    cancelled: boolean;
    eventCount: number;
    subscriberCount: number;
    startedAt: number;
    lastEventAt: number | null;
  } {
    return {
      done: this._done,
      cancelled: this._cancelled,
      eventCount: this.events.length,
      subscriberCount: this.subscribers.size,
      startedAt: this.events[0]?.ts ?? 0,
      lastEventAt: this.events.length > 0 ? this.events[this.events.length - 1].ts : null,
    };
  }

  /** Get events since a cursor position (for polling) */
  eventsSince(cursor: number): { events: AgentStreamEvent[]; nextCursor: number } {
    const slice = this.events.slice(cursor);
    return { events: slice, nextCursor: this.events.length };
  }
}

// ── Module-level registry of active streams ────────────────────────

const activeStreams = new Map<number, AgentStream>();

/** Get or create an AgentStream for a conversation */
export function getOrCreateStream(conversationId: number, requestId: string): AgentStream {
  // If there's an existing stream that's still running, return it
  const existing = activeStreams.get(conversationId);
  if (existing && !existing.done) {
    return existing;
  }

  const stream = new AgentStream(conversationId, requestId);
  activeStreams.set(conversationId, stream);
  return stream;
}

/** Get an active stream for a conversation (or null) */
export function getStream(conversationId: number): AgentStream | null {
  return activeStreams.get(conversationId) ?? null;
}

/** Check if a conversation has an active (non-done) stream */
export function hasActiveStream(conversationId: number): boolean {
  const stream = activeStreams.get(conversationId);
  return !!stream && !stream.done;
}

/**
 * Create a res-like write adapter for the agent loop.
 * The agent loop currently does `res.write(...)` — this adapter redirects
 * those writes to the AgentStream while maintaining the same interface.
 */
export function createStreamWriter(stream: AgentStream): StreamWriter {
  return new StreamWriter(stream);
}

export class StreamWriter {
  constructor(private stream: AgentStream) {}

  /** Mimics res.write() — the agent loop calls this */
  write(chunk: any, ...args: any[]): boolean {
    if (typeof chunk === "string") {
      return this.stream.write(chunk);
    }
    return false;
  }

  /**
   * Mimics res.end() — called at the end of the agent loop.
   * Does NOT actually close the stream (the route handler does that).
   */
  end(): void {
    // No-op — the route handler calls stream.end()
  }

  /**
   * Mimics res.on("close", handler) — for the disconnect listener in agent-loop.
   * Since we DON'T want client disconnects to cancel the loop, this is a no-op
   * by default. The explicit stop button still works via cancelRequest().
   */
  on(event: string, handler: (...args: any[]) => void): this {
    // Intentionally no-op for "close" events — the agent loop should NOT
    // be cancelled when the browser disconnects. Only the stop button
    // (POST /api/chat/stop → cancelRequest) should cancel.
    return this;
  }

  /** Mimics res.removeListener() */
  removeListener(event: string, handler: (...args: any[]) => void): this {
    return this;
  }

  /** Mimics res.setHeader() — no-op since we're not a real HTTP response */
  setHeader(name: string, value: string): void {}

  /** Mimics res.flushHeaders() — no-op */
  flushHeaders(): void {}
}
