#!/usr/bin/env node
/**
 * Minimal mock MCP server over stdio for tests.
 *
 * Speaks newline-delimited JSON-RPC 2.0 and implements just enough of the
 * protocol for Agent2077's MCP client: `initialize`, `tools/list`,
 * `tools/call`. It echoes the env var MOCK_ECHO back through a tool so tests
 * can prove the child process received merged env vars.
 */
import readline from "readline";

const rl = readline.createInterface({ input: process.stdin });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }

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
        ],
      },
    });
    return;
  }

  if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params || {};
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
