/**
 * Conversation Event Bus
 * 
 * Lightweight pub/sub for streaming events per conversation.
 * When the agent-loop or routes.ts emit events (content, status, steps, plan, done),
 * they get broadcast to ALL subscribers on that conversation — not just the tab
 * that initiated the request.
 * 
 * This lets a second browser tab (or the same tab after a reconnect) see live
 * streaming content and status updates for an active conversation.
 */

import type { Response } from "express";

interface Subscriber {
  res: Response;
  addedAt: number;
}

// Map of conversationId → set of SSE response objects
const subscribers = new Map<number, Set<Subscriber>>();

// Track which conversations are currently active (being streamed to)
const activeConversations = new Map<number, { startedAt: number }>();

/**
 * Subscribe an SSE response to a conversation's event stream.
 * Returns an unsubscribe function.
 */
export function subscribe(conversationId: number, res: Response): () => void {
  if (!subscribers.has(conversationId)) {
    subscribers.set(conversationId, new Set());
  }
  const sub: Subscriber = { res, addedAt: Date.now() };
  subscribers.get(conversationId)!.add(sub);

  // If conversation is currently active, notify subscriber immediately
  const active = activeConversations.get(conversationId);
  if (active) {
    try {
      res.write(`data: ${JSON.stringify({ type: "active", startedAt: active.startedAt })}\n\n`);
    } catch { /* client gone */ }
  }

  return () => {
    const subs = subscribers.get(conversationId);
    if (subs) {
      subs.delete(sub);
      if (subs.size === 0) subscribers.delete(conversationId);
    }
  };
}

/**
 * Broadcast a raw SSE event string to all subscribers of a conversation.
 * The event should already be formatted as `data: {...}\n\n`.
 * 
 * `exclude` is the Response object of the initiating tab — we don't want
 * to double-send events to the tab that's already receiving them directly.
 */
export function broadcast(conversationId: number, sseData: string, exclude?: Response): void {
  const subs = subscribers.get(conversationId);
  if (!subs || subs.size === 0) return;

  const dead: Subscriber[] = [];
  for (const sub of subs) {
    if (sub.res === exclude) continue; // Skip the initiating tab
    try {
      sub.res.write(sseData);
    } catch {
      dead.push(sub); // Client disconnected
    }
  }

  // Clean up dead subscribers
  for (const d of dead) subs.delete(d);
  if (subs.size === 0) subscribers.delete(conversationId);
}

/**
 * Mark a conversation as actively streaming.
 */
export function markActive(conversationId: number): void {
  activeConversations.set(conversationId, { startedAt: Date.now() });
}

/**
 * Mark a conversation as no longer streaming.
 * Broadcasts a "done_stream" event to all remaining subscribers.
 */
export function markInactive(conversationId: number): void {
  activeConversations.delete(conversationId);
  broadcast(conversationId, `data: ${JSON.stringify({ type: "stream_end" })}\n\n`);
}

/**
 * Check if a conversation is currently active.
 */
export function isActive(conversationId: number): boolean {
  return activeConversations.has(conversationId);
}

/**
 * Get count of subscribers for a conversation (for debugging).
 */
export function subscriberCount(conversationId: number): number {
  return subscribers.get(conversationId)?.size || 0;
}
