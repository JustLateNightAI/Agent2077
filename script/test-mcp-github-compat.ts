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
  redactMcpEnvVars,
  mergeMaskedEnvVars,
  MCP_SECRET_MASK,
} = await import("../server/lib/mcp-client.js");
const { getTool, getAllTools } = await import("../server/tools/registry.js");
const { selectTools } = await import("../server/lib/tool-selector.js");

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
  check("tools/list discovered 3 tools", tools.length === 3, `${tools.map(t => t.name).join(", ")}`);

  const echoName = mcpToolName("MockServer", "echo");
  const registered = getTool(echoName);
  check("echo tool registered under sanitized name", !!registered, echoName);

  const dbAfterConnect = mcpServerStore.getById(mock.id)!;
  check("status persisted as connected with toolCount", dbAfterConnect.status === "connected" && dbAfterConnect.toolCount === 3);

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

  // ── tool-name sanitization edge cases ───────────────────────────────
  check("mcpToolName lowercases + collapses unsafe runs",
    mcpToolName("  Weird   Name  ", "Tool@@Name") === "mcp_weird_name_toolname" ||
    /^mcp_weird_name_tool_+name$/.test(mcpToolName("  Weird   Name  ", "Tool@@Name")),
    mcpToolName("  Weird   Name  ", "Tool@@Name"));
  check("mcpToolName output is always LLM-safe ([a-z0-9_-])",
    /^[a-z0-9_-]+$/.test(mcpToolName("Über/Server", "do—it.now!")),
    mcpToolName("Über/Server", "do—it.now!"));

  // ── env redaction (response masking) ────────────────────────────────
  const redacted = redactMcpEnvVars({ envVars: JSON.stringify({ GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_realtoken", FOO: "bar" }) });
  const redObj = JSON.parse(redacted.envVars!);
  check("redaction masks all secret values but keeps keys",
    redObj.GITHUB_PERSONAL_ACCESS_TOKEN === MCP_SECRET_MASK && redObj.FOO === MCP_SECRET_MASK &&
    Object.keys(redObj).length === 2);

  // ── partial masked env update (preserve unchanged secrets) ──────────
  const stored = JSON.stringify({ GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_realtoken", OTHER: "keepme" });
  // User edits only OTHER, leaves the token masked.
  const merged1 = mergeMaskedEnvVars(JSON.stringify({ GITHUB_PERSONAL_ACCESS_TOKEN: MCP_SECRET_MASK, OTHER: "changed" }), stored);
  const m1 = JSON.parse(merged1!);
  check("partial update keeps masked secret, applies real change",
    m1.GITHUB_PERSONAL_ACCESS_TOKEN === "ghp_realtoken" && m1.OTHER === "changed", merged1);
  // Fully masked, no new keys → no update.
  const merged2 = mergeMaskedEnvVars(JSON.stringify({ GITHUB_PERSONAL_ACCESS_TOKEN: MCP_SECRET_MASK, OTHER: MCP_SECRET_MASK }), stored);
  check("fully-masked unchanged payload yields no DB write", merged2 === undefined, String(merged2));
  // New key with real value alongside masked existing.
  const merged3 = mergeMaskedEnvVars(JSON.stringify({ GITHUB_PERSONAL_ACCESS_TOKEN: MCP_SECRET_MASK, NEWKEY: "newval" }), stored);
  const m3 = JSON.parse(merged3!);
  check("adding a new key preserves masked existing secret",
    m3.GITHUB_PERSONAL_ACCESS_TOKEN === "ghp_realtoken" && m3.NEWKEY === "newval" && !("OTHER" in m3), merged3);

  // ── connect again to test selector + error tool + bad command ───────
  await connectMcpServer(mock.id);
  await sleep(100);
  check("reconnect works (initialized handshake)", getMcpConnectionStatus(mock.id) === "connected");
  const tools2 = getMcpServerTools(mock.id);
  check("reconnect discovers all 3 tools (incl boom)", tools2.length === 3, tools2.map(t => t.name).join(", "));

  // Error surfacing from a tools/call error response.
  const boom = getTool(mcpToolName("MockServer", "boom"));
  if (boom) {
    const r = await boom.execute({}, {} as any);
    check("MCP tool error is surfaced readably",
      !r.success && /boom/i.test(r.output), r.output);
  } else {
    check("boom tool registered", false);
  }

  // Smart tool selector MUST include connected mcp_* tools even when the
  // task bundle/keywords don't mention them.
  const selection = selectTools({
    allTools: getAllTools(),
    taskType: "coding" as any,
    model: { modelId: "gpt-4o", supportsToolCalling: true } as any,
    modelSize: "large",
    lastUserMessage: "refactor this function",   // no MCP/github keywords
    smartSelectionEnabled: true,
  });
  const selectedMcp = [...selection.selectedNames].filter(n => n.startsWith("mcp_"));
  check("tool selector includes connected MCP tools regardless of keywords",
    selectedMcp.includes(mcpToolName("MockServer", "echo")), selectedMcp.join(", "));

  await disconnectMcpServer(mock.id);
  await sleep(50);

  // ── bad command produces a clear error + stored lastError ───────────
  const broken = mcpServerStore.create({
    name: "Broken",
    command: "definitely-not-a-real-binary-xyz",
    args: "[]",
    envVars: "{}",
    transportType: "stdio",
    isEnabled: false,
  } as any);
  let badErr = "";
  try {
    await connectMcpServer(broken.id);
  } catch (e: any) {
    badErr = e?.message || String(e);
  }
  check("bad command rejects with a clear error", /not found|ENOENT|definitely-not-a-real-binary/i.test(badErr), badErr);
  const brokenDb = mcpServerStore.getById(broken.id)!;
  check("bad command stores status=error + lastError",
    brokenDb.status === "error" && !!brokenDb.lastError, `${brokenDb.status} / ${brokenDb.lastError}`);
  check("bad command leaves no registered tools",
    ![...getAllTools().keys()].some(k => k.startsWith("mcp_broken_")));

} catch (err: any) {
  check(`unexpected error: ${err?.message || err}`, false);
} finally {
  cleanup();
}

console.log(failures === 0 ? "\nAll MCP compat tests passed." : `\n${failures} test(s) failed.`);
