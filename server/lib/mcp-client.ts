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
import { registerTool, type ToolHandler } from "../tools/registry.js";
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
  pendingRequests: Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>;
  nextId: number;
  buffer: string; // line buffer for stdout
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

    proc.on("error", (err) => {
      console.error(`[MCP:${server.name}] Process error:`, err.message);
      mcpServerStore.update(server.id, { status: "error", lastError: err.message });
      activeConnections.delete(server.id);
      reject(err);
    });

    proc.on("close", (code) => {
      console.log(`[MCP:${server.name}] Process closed with code ${code}`);
      if (activeConnections.has(server.id)) {
        mcpServerStore.update(server.id, { status: "disconnected" });
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

    // Give the process a moment to start, then initialize
    setTimeout(async () => {
      try {
        await initializeAndRegister(conn, server);
        resolve();
      } catch (err: any) {
        mcpServerStore.update(server.id, { status: "error", lastError: err.message });
        reject(err);
      }
    }, 500);
  });
}

async function connectViaSse(server: any): Promise<void> {
  if (!server.sseUrl) throw new Error("SSE transport requires sseUrl");

  const conn: McpConnection = {
    serverId: server.id,
    transport: "sse",
    tools: [],
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

function sendRequest(conn: McpConnection, method: string, params?: any): Promise<any> {
  const id = conn.nextId++;
  const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
  const json = JSON.stringify(request) + "\n";

  return new Promise((resolve, reject) => {
    conn.pendingRequests.set(id, { resolve, reject });

    // Timeout after 30s
    const timer = setTimeout(() => {
      if (conn.pendingRequests.has(id)) {
        conn.pendingRequests.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }
    }, 30000);

    const wrappedResolve = (v: any) => { clearTimeout(timer); resolve(v); };
    const wrappedReject = (e: any) => { clearTimeout(timer); reject(e); };
    conn.pendingRequests.set(id, { resolve: wrappedResolve, reject: wrappedReject });

    if (conn.transport === "stdio" && conn.process) {
      try {
        conn.process.stdin?.write(json);
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

  // Step 2: list tools
  const toolsResult = await sendRequest(conn, "tools/list", {});
  const mcpTools: McpTool[] = toolsResult?.tools || [];

  conn.tools = mcpTools;
  console.log(`[MCP:${server.name}] Connected! Found ${mcpTools.length} tools`);

  // Step 3: register each MCP tool in the Agent2077 registry
  for (const mcpTool of mcpTools) {
    const toolName = `mcp_${server.name.toLowerCase().replace(/\s+/g, "_")}_${mcpTool.name}`;

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

  if (conn.process) {
    try { conn.process.kill("SIGTERM"); } catch { /* already dead */ }
  }

  activeConnections.delete(serverId);
  mcpServerStore.update(serverId, { status: "disconnected" });
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
