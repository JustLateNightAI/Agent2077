/**
 * LLM Inspector — captures every outgoing LLM request payload
 * and streams it to connected clients via SSE.
 * This lets users see exactly what's being sent to the model.
 */

export interface InspectorEntry {
  id: number;
  timestamp: string;
  requestId?: string;
  model: string;
  endpoint: string;
  temperature: number;
  topP?: number;
  stream: boolean;
  tools?: any[];
  messages: any[];
}

const MAX_ENTRIES = 50;
let nextId = 1;
const buffer: InspectorEntry[] = [];
const clients: Set<import("express").Response> = new Set();

export function recordInspectorRequest(entry: Omit<InspectorEntry, "id" | "timestamp">): void {
  const full: InspectorEntry = {
    id: nextId++,
    timestamp: new Date().toISOString(),
    ...entry,
  };

  buffer.push(full);
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }

  for (const client of clients) {
    try {
      client.write(`data: ${JSON.stringify(full)}\n\n`);
    } catch {
      clients.delete(client);
    }
  }
}

export function getRecentInspectorEntries(limit = 20): InspectorEntry[] {
  return buffer.slice(-limit);
}

export function addInspectorClient(res: import("express").Response): void {
  clients.add(res);
}

export function removeInspectorClient(res: import("express").Response): void {
  clients.delete(res);
}
