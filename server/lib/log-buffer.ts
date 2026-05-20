/**
 * Log Buffer — Captures console output for the Console View page
 * Intercepts console.log/warn/error and stores in a ring buffer
 */

export interface LogEntry {
  id: number;
  timestamp: string;
  level: "log" | "warn" | "error" | "info" | "debug";
  message: string;
  source?: string;
}

const MAX_ENTRIES = 2000;
let nextId = 1;
const buffer: LogEntry[] = [];

// SSE clients listening for live logs
const clients: Set<import("express").Response> = new Set();

function addEntry(level: LogEntry["level"], args: any[]): void {
  const message = args.map(a =>
    typeof a === "string" ? a : JSON.stringify(a, null, 0)
  ).join(" ");

  // Extract source from common log prefixes like [Orchestrator], [Docker], etc.
  const sourceMatch = message.match(/^\[([^\]]+)\]/);
  const source = sourceMatch ? sourceMatch[1] : undefined;

  const entry: LogEntry = {
    id: nextId++,
    timestamp: new Date().toISOString(),
    level,
    message,
    source,
  };

  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }

  // Push to SSE clients
  for (const client of clients) {
    try {
      client.write(`data: ${JSON.stringify(entry)}\n\n`);
    } catch {
      clients.delete(client);
    }
  }
}

/**
 * Install console interceptors — call once at startup
 */
export function installLogCapture(): void {
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const origInfo = console.info;
  const origDebug = console.debug;

  console.log = (...args: any[]) => { origLog(...args); addEntry("log", args); };
  console.warn = (...args: any[]) => { origWarn(...args); addEntry("warn", args); };
  console.error = (...args: any[]) => { origError(...args); addEntry("error", args); };
  console.info = (...args: any[]) => { origInfo(...args); addEntry("info", args); };
  console.debug = (...args: any[]) => { origDebug(...args); addEntry("debug", args); };
}

/**
 * Get recent log entries
 */
export function getRecentLogs(limit: number = 200, afterId?: number): LogEntry[] {
  if (afterId) {
    return buffer.filter(e => e.id > afterId).slice(-limit);
  }
  return buffer.slice(-limit);
}

/**
 * Register an SSE client for live log streaming
 */
export function addLogClient(res: import("express").Response): void {
  clients.add(res);
}

/**
 * Remove an SSE client
 */
export function removeLogClient(res: import("express").Response): void {
  clients.delete(res);
}
