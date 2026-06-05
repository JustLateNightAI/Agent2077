/**
 * MCP (Model Context Protocol) Client
 *
 * Agent2077 acts as an MCP CLIENT that connects to external MCP servers
 * and registers their tools into the Agent2077 tool registry.
 *
 * Supports two transports:
 *  - stdio: spawns the server process, communicates via JSON-RPC over stdin/stdout
 *  - sse: connects to an SSE endpoint, communicates via JSON-RPC over HTTP
 */
import { spawn, type ChildProcess } from "child_process";
import { registerTool, unregisterTool, type ToolHandler } from "../tools/registry.js";
import { mcpServerStore } from "../storage.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

// Track active MCP connections
const activeConnections = new Map<number, McpConnection>();

interface McpConnection {
  serverId: number;
  transport: "stdio" | "sse";
  process?: ChildProcess;
  tools: McpTool[];
  registeredToolNames: string[]; // Agent2077-registry names to clean up on disconnect
  pendingRequests: Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>;
  nextId: number;
  buffer: string; // line buffer for stdout
}

/**
 * Build a registry-safe tool name. The LLM tool-call API only allows
 * [a-zA-Z0-9_-], so we sanitize both the server name and the MCP tool name
 * and prefix with `mcp_` to avoid colliding with Agent2077's native tools.
 */
export function mcpToolName(serverName: string, toolName: string): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return `mcp_${clean(serverName)}_${clean(toolName)}`;
}

/** Placeholder shown to the UI instead of real secret values. */
export const MCP_SECRET_MASK = "********";

/**
 * Return a copy of an MCP server record with env var *values* masked (keys
 * preserved) so the UI can show which vars are set without leaking secrets.
 */
export function redactMcpEnvVars<T extends { envVars?: string | null }>(server: T): T {
  if (!server?.envVars) return server;
  try {
    const parsed = JSON.parse(server.envVars);
    const masked: Record<string, string> = {};
    for (const k of Object.keys(parsed)) masked[k] = MCP_SECRET_MASK;
    return { ...server, envVars: JSON.stringify(masked) };
  } catch {
    return { ...server, envVars: MCP_SECRET_MASK };
  }
}

/**
 * Merge an incoming (possibly partially-masked) envVars payload from the UI
 * with the currently-stored envVars, so that:
 *   - keys whose value is the mask placeholder keep their stored secret
 *   - keys with a real new value are updated
 *   - keys absent from the incoming payload are dropped (user removed them)
 *
 * Returns the JSON string to persist, or `undefined` when there's nothing to
 * change (caller should leave the stored value untouched).
 */
export function mergeMaskedEnvVars(incoming: string | undefined, storedJson: string | null | undefined): string | undefined {
  if (typeof incoming !== "string") return undefined;
  let incomingObj: Record<string, unknown>;
  try { incomingObj = JSON.parse(incoming); } catch { return incoming; } // unparseable → store as-is
  if (incomingObj === null || typeof incomingObj !== "object") return incoming;

  let stored: Record<string, unknown> = {};
  if (storedJson) { try { stored = JSON.parse(storedJson); } catch { /* ignore */ } }

  const values = Object.values(incomingObj);
  // Fully-masked payload with no new keys → user changed nothing; skip update.
  if (values.length > 0 && values.every(v => v === MCP_SECRET_MASK) &&
      Object.keys(incomingObj).every(k => k in stored)) {
    return undefined;
  }

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(incomingObj)) {
    result[k] = v === MCP_SECRET_MASK && k in stored ? stored[k] : v;
  }
  return JSON.stringify(result);
}

/**
 * Connect to an MCP server by ID and register its tools.
 */
export async function connectMcpServer(serverId: number): Promise<void> {
  const server = mcpServerStore.getById(serverId);
  if (!server) throw new Error(`MCP server ${serverId} not found`);

  // Disconnect existing connection if any
  if (activeConnections.has(serverId)) {
    await disconnectMcpServer(serverId);
  }

  mcpServerStore.update(serverId, { status: "disconnected", lastError: null });

  if (server.transportType === "sse") {
    await connectViaSse(server);
  } else {
    await connectViaStdio(server);
  }
}

async function connectViaStdio(server: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const conn: McpConnection = {
      serverId: server.id,
      transport: "stdio",
      tools: [],
      registeredToolNames: [],
      pendingRequests: new Map(),
      nextId: 1,
      buffer: "",
    };

    // Parse additional args from JSON array
    let extraArgs: string[] = [];
    if (server.args) {
      try { extraArgs = JSON.parse(server.args); } catch { /* ignore */ }
    }

    // Parse env vars
    let envVars: Record<string, string> = {};
    if (server.envVars) {
      try { envVars = JSON.parse(server.envVars); } catch { /* ignore */ }
    }

    // Split command into program + args (first token = program, rest = args)
    const parts = server.command.trim().split(/\s+/);
    const program = parts[0];
    const cmdArgs = [...parts.slice(1), ...extraArgs];

    console.log(`[MCP] Spawning stdio server: ${program} ${cmdArgs.join(" ")}`);

    const proc = spawn(program, cmdArgs, {
      env: { ...process.env, ...envVars },
      stdio: ["pipe", "pipe", "pipe"],
    });

    conn.process = proc;
    activeConnections.set(server.id, conn);

    proc.stderr?.on("data", (data: Buffer) => {
      console.warn(`[MCP:${server.name}] stderr: ${data.toString().slice(0, 200)}`);
    });

    const rejectAllPending = (reason: string) => {
      for (const [, p] of conn.pendingRequests) p.reject(new Error(reason));
      conn.pendingRequests.clear();
    };

    proc.on("error", (err) => {
      // Most common: ENOENT when `command` isn't on PATH (e.g. npx missing).
      const msg = (err as any)?.code === "ENOENT"
        ? `Command not found: "${program}". Is it installed and on PATH?`
        : err.message;
      console.error(`[MCP:${server.name}] Process error:`, msg);
      mcpServerStore.update(server.id, { status: "error", lastError: msg });
      rejectAllPending(msg);
      activeConnections.delete(server.id);
      reject(new Error(msg));
    });

    proc.on("close", (code) => {
      console.log(`[MCP:${server.name}] Process closed with code ${code}`);
      rejectAllPending(`MCP process exited (code ${code})`);
      if (activeConnections.has(server.id)) {
        // Unexpected exit while we thought we were connected — surface it.
        const wasConnected = mcpServerStore.getById(server.id)?.status === "connected";
        mcpServerStore.update(server.id, {
          status: code === 0 ? "disconnected" : "error",
          ...(code !== 0 && wasConnected ? { lastError: `Process exited unexpectedly (code ${code})` } : {}),
          toolCount: 0,
        });
        for (const name of conn.registeredToolNames) unregisterTool(name);
        activeConnections.delete(server.id);
      }
    });

    // Accumulate stdout line-by-line — MCP uses newline-delimited JSON-RPC
    proc.stdout?.on("data", (data: Buffer) => {
      conn.buffer += data.toString();
      const lines = conn.buffer.split("\n");
      conn.buffer = lines.pop() || ""; // keep incomplete line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg: JsonRpcResponse = JSON.parse(trimmed);
          handleResponse(conn, msg);
        } catch (e) {
          // Not JSON — likely debug output, ignore
        }
      }
    });

    // Give the process a brief moment to spawn, then run the handshake. The
    // handshake awaits real JSON-RPC responses, so this delay only needs to
    // cover process startup — not the server becoming ready.
    const startupDelay = Number(process.env.MCP_STARTUP_DELAY_MS) || 150;
    setTimeout(async () => {
      // If the process already died (spawn error/close fired), bail — the
      // handlers above have already rejected and cleaned up.
      if (!activeConnections.has(server.id)) return;
      try {
        await initializeAndRegister(conn, server);
        resolve();
      } catch (err: any) {
        mcpServerStore.update(server.id, { status: "error", lastError: err.message });
        try { proc.kill("SIGTERM"); } catch { /* already dead */ }
        activeConnections.delete(server.id);
        reject(err);
      }
    }, startupDelay);
  });
}

async function connectViaSse(server: any): Promise<void> {
  if (!server.sseUrl) throw new Error("SSE transport requires sseUrl");

  const conn: McpConnection = {
    serverId: server.id,
    transport: "sse",
    tools: [],
    registeredToolNames: [],
    pendingRequests: new Map(),
    nextId: 1,
    buffer: "",
  };

  activeConnections.set(server.id, conn);

  // For SSE transport, we send requests via POST and receive via SSE stream
  // The SSE endpoint delivers server→client messages; client→server go via POST
  // This is a simplified implementation for the standard MCP SSE transport
  try {
    await initializeAndRegister(conn, server);
  } catch (err: any) {
    mcpServerStore.update(server.id, { status: "error", lastError: err.message });
    activeConnections.delete(server.id);
    throw err;
  }
}

function handleResponse(conn: McpConnection, msg: JsonRpcResponse) {
  if (msg.id !== undefined) {
    const pending = conn.pendingRequests.get(msg.id as number);
    if (pending) {
      conn.pendingRequests.delete(msg.id as number);
      if (msg.error) {
        pending.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        pending.resolve(msg.result);
      }
    }
  }
}

/** Per-request timeout for JSON-RPC calls (ms). */
const REQUEST_TIMEOUT_MS = 30000;

/**
 * Send a JSON-RPC *notification* (no id, no response expected). The MCP spec
 * requires the client to send `notifications/initialized` after the
 * `initialize` response and before any further requests — spec-compliant
 * servers (e.g. GitHub MCP) will not answer `tools/list` until they get it.
 */
function sendNotification(conn: McpConnection, method: string, params?: any): void {
  const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
  if (conn.transport === "stdio" && conn.process?.stdin?.writable) {
    try { conn.process.stdin.write(payload); } catch { /* process gone */ }
  } else if (conn.transport === "sse") {
    const server = mcpServerStore.getById(conn.serverId);
    if (server?.sseUrl) {
      fetch(server.sseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      }).catch(() => { /* notifications are fire-and-forget */ });
    }
  }
}

function sendRequest(conn: McpConnection, method: string, params?: any): Promise<any> {
  const id = conn.nextId++;
  const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
  const json = JSON.stringify(request) + "\n";

  return new Promise((resolve, reject) => {
    // Timeout — also covers a server that goes silent.
    const timer = setTimeout(() => {
      if (conn.pendingRequests.has(id)) {
        conn.pendingRequests.delete(id);
        reject(new Error(`MCP request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${method}`));
      }
    }, REQUEST_TIMEOUT_MS);

    const wrappedResolve = (v: any) => { clearTimeout(timer); resolve(v); };
    const wrappedReject = (e: any) => { clearTimeout(timer); reject(e); };
    conn.pendingRequests.set(id, { resolve: wrappedResolve, reject: wrappedReject });

    if (conn.transport === "stdio") {
      if (!conn.process?.stdin?.writable) {
        conn.pendingRequests.delete(id);
        clearTimeout(timer);
        return reject(new Error("MCP process stdin is not writable (process not running)"));
      }
      try {
        conn.process.stdin.write(json);
      } catch (err: any) {
        conn.pendingRequests.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    } else if (conn.transport === "sse") {
      // SSE: POST the request to the server's endpoint
      const server = mcpServerStore.getById(conn.serverId);
      if (!server?.sseUrl) {
        conn.pendingRequests.delete(id);
        clearTimeout(timer);
        return reject(new Error("No SSE URL configured"));
      }
      fetch(server.sseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      })
        .then(r => r.json())
        .then(data => {
          conn.pendingRequests.delete(id);
          clearTimeout(timer);
          if (data.error) wrappedReject(new Error(data.error.message));
          else wrappedResolve(data.result);
        })
        .catch(e => { conn.pendingRequests.delete(id); clearTimeout(timer); wrappedReject(e); });
    }
  });
}

async function initializeAndRegister(conn: McpConnection, server: any): Promise<void> {
  const serverId = server.id;

  // Step 1: initialize handshake
  await sendRequest(conn, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    clientInfo: { name: "agent2077", version: "1.0.0" },
  });

  // Step 1b: MUST send the `initialized` notification before any other request.
  // Spec-compliant servers (GitHub MCP, the official SDK servers) hold all
  // requests until they receive this — omitting it makes tools/list hang.
  sendNotification(conn, "notifications/initialized", {});

  // Step 2: list tools
  const toolsResult = await sendRequest(conn, "tools/list", {});
  const mcpTools: McpTool[] = toolsResult?.tools || [];

  conn.tools = mcpTools;
  console.log(`[MCP:${server.name}] Connected! Found ${mcpTools.length} tools`);

  // Step 3: register each MCP tool in the Agent2077 registry
  conn.registeredToolNames = [];
  for (const mcpTool of mcpTools) {
    const toolName = mcpToolName(server.name, mcpTool.name);

    const handler: ToolHandler = {
      category: "system",
      definition: {
        type: "function",
        function: {
          name: toolName,
          description: `[MCP:${server.name}] ${mcpTool.description || mcpTool.name}`,
          parameters: mcpTool.inputSchema || { type: "object", properties: {} },
        },
      },
      async execute(args, context) {
        const activeConn = activeConnections.get(serverId);
        if (!activeConn) {
          return { success: false, output: `MCP server ${server.name} is not connected` };
        }
        try {
          const result = await sendRequest(activeConn, "tools/call", {
            name: mcpTool.name,
            arguments: args,
          });
          // MCP tools/call result: { content: [{type: "text", text: "..."}] }
          const output = (result?.content || [])
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n") || JSON.stringify(result);
          return { success: true, output };
        } catch (err: any) {
          return { success: false, output: `MCP tool error: ${err.message}` };
        }
      },
    };

    registerTool(toolName, handler);
    conn.registeredToolNames.push(toolName);
  }

  // Update DB
  mcpServerStore.update(serverId, {
    status: "connected",
    lastError: null,
    toolCount: mcpTools.length,
  });
}

/**
 * Disconnect from an MCP server and clean up its tools.
 */
export async function disconnectMcpServer(serverId: number): Promise<void> {
  const conn = activeConnections.get(serverId);
  if (!conn) return;

  // Remove this server's tools from the registry so they aren't offered to the
  // model while the server is down.
  for (const name of conn.registeredToolNames) unregisterTool(name);

  if (conn.process) {
    try { conn.process.kill("SIGTERM"); } catch { /* already dead */ }
  }

  activeConnections.delete(serverId);
  mcpServerStore.update(serverId, { status: "disconnected", toolCount: 0 });
  console.log(`[MCP] Disconnected server ${serverId}`);
}

/**
 * Get tools from an active connection.
 */
export function getMcpServerTools(serverId: number): McpTool[] {
  return activeConnections.get(serverId)?.tools || [];
}

/**
 * Get connection status.
 */
export function getMcpConnectionStatus(serverId: number): "connected" | "disconnected" {
  return activeConnections.has(serverId) ? "connected" : "disconnected";
}

/**
 * Connect all enabled MCP servers on startup.
 */
export async function connectAllEnabledMcpServers(): Promise<void> {
  const servers = mcpServerStore.getAll().filter(s => s.isEnabled);
  for (const server of servers) {
    try {
      console.log(`[MCP] Auto-connecting server: ${server.name}`);
      await connectMcpServer(server.id);
    } catch (err: any) {
      console.warn(`[MCP] Failed to auto-connect ${server.name}:`, err.message);
    }
  }
}
