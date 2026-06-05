/**
 * MCP client smoke tests — focuses on the command/env stdio servers that the
 * GitHub MCP server (`npx -y @modelcontextprotocol/server-github` with a
 * GITHUB_PERSONAL_ACCESS_TOKEN env var) relies on.
 *
 * Covers:
 *  - tool-name sanitization (mcpToolName) collision-avoidance + LLM-safe chars
 *  - config parsing: command split, JSON args array, JSON env object
 *  - end-to-end stdio connect against a mock MCP server: handshake,
 *    tools/list discovery, tool registration, tools/call execution
 *  - env merging: the child process receives configured env vars
 *  - disconnect cleanup: tools are unregistered and process is killed
 *
 * Runs against an isolated temp DB via AGENT2077_DB_PATH.
 * Run with: npx tsx script/test-mcp-github-compat.ts
 */
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const tmpDb = path.join(os.tmpdir(), `a2077-mcp-test-${Date.now()}.db`);
process.env.AGENT2077_DB_PATH = tmpDb;

const here = path.dirname(fileURLToPath(import.meta.url));
const mockServer = path.join(here, "mock-mcp-server.mjs");

const { bootstrapSchema, initNewTables } = await import("../server/db.js");
const { mcpServerStore } = await import("../server/storage.js");
const {
  connectMcpServer,
  disconnectMcpServer,
  getMcpServerTools,
  getMcpConnectionStatus,
  mcpToolName,
} = await import("../server/lib/mcp-client.js");
const { getTool, getAllTools } = await import("../server/tools/registry.js");

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${detail ? " — " + detail : ""}`);
  if (!ok) { failures++; process.exitCode = 1; }
}

function cleanup() {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(tmpDb + ext); } catch {}
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

try {
  // ── Pure unit: tool-name sanitization ───────────────────────────────
  check("mcpToolName prefixes with mcp_ to avoid native collisions",
    mcpToolName("GitHub", "create_issue") === "mcp_github_create_issue",
    mcpToolName("GitHub", "create_issue"));

  check("mcpToolName sanitizes spaces and unsafe chars",
    /^[a-z0-9_-]+$/.test(mcpToolName("My Server!", "do.thing/now")),
    mcpToolName("My Server!", "do.thing/now"));

  // ── Config parsing: what the UI stores for a GitHub MCP server ───────
  // Simulates the documented GitHub MCP config:
  //   command: npx, args: ["-y","@modelcontextprotocol/server-github"],
  //   env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_xxx" }
  const ghArgs = JSON.parse('["-y", "@modelcontextprotocol/server-github"]');
  const ghEnv = JSON.parse('{"GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_placeholder"}');
  check("GitHub args parse to a 2-element array", Array.isArray(ghArgs) && ghArgs.length === 2);
  check("GitHub env parses to object with the PAT key",
    ghEnv.GITHUB_PERSONAL_ACCESS_TOKEN === "ghp_placeholder");

  // ── DB round-trip with correct column names ─────────────────────────
  bootstrapSchema();
  initNewTables();
  const created = mcpServerStore.create({
    name: "GitHub",
    command: "npx",
    args: JSON.stringify(ghArgs),
    envVars: JSON.stringify(ghEnv),
    transportType: "stdio",
    isEnabled: false,
  } as any);
  const reread = mcpServerStore.getById(created.id)!;
  check("envVars persisted (not dropped)", !!reread.envVars && JSON.parse(reread.envVars).GITHUB_PERSONAL_ACCESS_TOKEN === "ghp_placeholder");
  check("transportType persisted as stdio", reread.transportType === "stdio");

  // ── End-to-end stdio connect against the mock MCP server ────────────
  const mock = mcpServerStore.create({
    name: "MockServer",
    command: `node ${mockServer}`,
    args: "[]",
    envVars: JSON.stringify({ MOCK_ECHO: "env-was-merged" }),
    transportType: "stdio",
    isEnabled: false,
  } as any);

  await connectMcpServer(mock.id);
  await sleep(100);

  check("connection reports connected", getMcpConnectionStatus(mock.id) === "connected");

  const tools = getMcpServerTools(mock.id);
  check("tools/list discovered 2 tools", tools.length === 2, `${tools.map(t => t.name).join(", ")}`);

  const echoName = mcpToolName("MockServer", "echo");
  const registered = getTool(echoName);
  check("echo tool registered under sanitized name", !!registered, echoName);

  const dbAfterConnect = mcpServerStore.getById(mock.id)!;
  check("status persisted as connected with toolCount", dbAfterConnect.status === "connected" && dbAfterConnect.toolCount === 2);

  // Execute the echo tool through the registry handler.
  if (registered) {
    const result = await registered.execute({ text: "hello-mcp" }, {} as any);
    check("echo tool returns the text via tools/call", result.success && result.output === "hello-mcp", result.output);
  }

  // Prove the child got merged env vars.
  const envTool = getTool(mcpToolName("MockServer", "get_env"));
  if (envTool) {
    const r = await envTool.execute({}, {} as any);
    check("child process received configured env var", r.success && r.output === "env-was-merged", r.output);
  }

  // ── Disconnect cleanup ──────────────────────────────────────────────
  await disconnectMcpServer(mock.id);
  await sleep(50);
  check("connection reports disconnected after disconnect", getMcpConnectionStatus(mock.id) === "disconnected");
  check("tools unregistered on disconnect", !getTool(echoName));
  check("no leftover mcp_mockserver_ tools in registry",
    ![...getAllTools().keys()].some(k => k.startsWith("mcp_mockserver_")));
  const dbAfterDisconnect = mcpServerStore.getById(mock.id)!;
  check("status persisted as disconnected with toolCount 0",
    dbAfterDisconnect.status === "disconnected" && dbAfterDisconnect.toolCount === 0);

} catch (err: any) {
  check(`unexpected error: ${err?.message || err}`, false);
} finally {
  cleanup();
}

console.log(failures === 0 ? "\nAll MCP compat tests passed." : `\n${failures} test(s) failed.`);
