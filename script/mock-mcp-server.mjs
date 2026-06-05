#!/usr/bin/env node
/**
 * Minimal mock MCP server over stdio for tests.
 *
 * Speaks newline-delimited JSON-RPC 2.0 and implements just enough of the
 * protocol for Agent2077's MCP client. It deliberately mimics the behaviour of
 * a spec-compliant server so the tests catch real-world breakage:
 *
 *  - `initialize` → returns serverInfo + capabilities
 *  - REQUIRES the `notifications/initialized` notification before it will
 *    answer `tools/list` or `tools/call`. A client that forgets to send it
 *    (the bug that broke GitHub MCP) will hang and time out here.
 *  - `tools/list` → echo / get_env / boom
 *  - `tools/call` → executes the named tool
 *  - emits noisy stderr lines (banners, logs) to prove stdout JSON-RPC parsing
 *    is not corrupted by interleaved stderr — and even writes a non-JSON line
 *    to stdout, which the client must ignore.
 *
 * Env: MOCK_ECHO is echoed back via the get_env tool to prove env merging.
 */
import readline from "readline";

// ── stderr noise: real servers print banners/logs here ──────────────────────
process.stderr.write("[mock-mcp] starting up (this is stderr noise)\n");
process.stderr.write("[mock-mcp] warning: example diagnostic line\n");
const noise = setInterval(() => {
  process.stderr.write(`[mock-mcp] heartbeat ${Date.now()}\n`);
}, 25);

const rl = readline.createInterface({ input: process.stdin });

let initialized = false;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function notReady(id) {
  send({ jsonrpc: "2.0", id, error: { code: -32002, message: "Server not initialized (missing notifications/initialized)" } });
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }

  // Notifications have no id. The client must send notifications/initialized
  // after the initialize response and before any further request.
  if (msg.method === "notifications/initialized") {
    initialized = true;
    // Emit a stray non-JSON stdout line to ensure the client ignores it.
    process.stdout.write("mock-mcp: ready (this non-JSON stdout line must be ignored)\n");
    return;
  }

  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-mcp", version: "0.0.1" },
      },
    });
    return;
  }

  if (msg.method === "tools/list") {
    if (!initialized) return notReady(msg.id);
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echoes the provided text",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          },
          {
            name: "get_env",
            description: "Returns the value of MOCK_ECHO env var the server was started with",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "boom",
            description: "Always returns a JSON-RPC error, to test error surfacing",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });
    return;
  }

  if (msg.method === "tools/call") {
    if (!initialized) return notReady(msg.id);
    const { name, arguments: args } = msg.params || {};
    if (name === "boom") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "intentional boom" } });
      return;
    }
    let text = "";
    if (name === "echo") text = String(args?.text ?? "");
    else if (name === "get_env") text = process.env.MOCK_ECHO ?? "<unset>";
    else {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Unknown tool: ${name}` } });
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } });
    return;
  }

  // Unknown method
  if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
});

process.on("SIGTERM", () => { clearInterval(noise); process.exit(0); });
process.on("SIGINT", () => { clearInterval(noise); process.exit(0); });
