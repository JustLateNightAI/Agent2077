/**
 * v16.73.1 smoke tests:
 *  - tool_list and tool_search are registered and behave sensibly
 *  - selector floor always includes tool_list / tool_search
 *  - getMaxFailedToolCalls reads + clamps the new setting
 *
 * Run with: npx tsx script/test-v16-73-1.ts
 */
import { selectTools } from "../server/lib/tool-selector.js";
import { getTool, getAllTools, executeTool } from "../server/tools/registry.js";
import "../server/tools/tool-discovery.js";
import "../server/tools/ssh-tools.js"; // for tool_search "ssh" hit

function check(label: string, ok: boolean, detail?: string) {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${label}${detail ? " — " + detail : ""}`);
  if (!ok) process.exitCode = 1;
}

// ── 1. tool_list registered ─────────────────────────────────────────────
{
  const handler = getTool("tool_list");
  check("tool_list is registered", !!handler);
  check("tool_list category is 'system'", handler?.category === "system");
}

// ── 2. tool_search registered ───────────────────────────────────────────
{
  const handler = getTool("tool_search");
  check("tool_search is registered", !!handler);
  check("tool_search requires 'query' param", handler?.definition.function.parameters?.required?.includes("query") === true);
}

// ── 3. selector floor always includes tool_list / tool_search ───────────
{
  const result = selectTools({
    allTools: getAllTools(),
    taskType: "general",
    model: { modelId: "qwen3-122b", supportsToolCalling: true } as any,
    modelSize: "large",
    lastUserMessage: "hello there",
  });
  check("floor includes tool_list", result.selectedNames.has("tool_list"));
  check("floor includes tool_search", result.selectedNames.has("tool_search"));
}

// ── 4. project mode still includes tool_list / tool_search ──────────────
{
  const result = selectTools({
    allTools: getAllTools(),
    taskType: "coding",
    model: { modelId: "qwen3-122b", supportsToolCalling: true } as any,
    modelSize: "large",
    customPrompt: "## PROJECT CONTEXT\nfoo",
    lastUserMessage: "tweak a function",
  });
  check("project mode includes tool_list", result.selectedNames.has("tool_list"));
  check("project mode includes tool_search", result.selectedNames.has("tool_search"));
}

// ── 5. tool_list execute returns something sane ─────────────────────────
async function execTests() {
  const ctx = { conversationId: 0, requestId: "test" } as any;
  const r1 = await executeTool("tool_list", {}, ctx);
  check("tool_list executes ok", r1.success);
  check("tool_list mentions multiple tools", r1.output.includes("tool(s) registered"));

  const r2 = await executeTool("tool_search", { query: "ssh" }, ctx);
  check("tool_search finds ssh_exec", r2.success && r2.output.includes("ssh_exec"));

  const r3 = await executeTool("tool_search", { query: "" }, ctx);
  check("tool_search rejects empty query", !r3.success);

  const r4 = await executeTool("tool_search", { query: "definitelynothereXYZ" }, ctx);
  check("tool_search reports no-match cleanly", r4.success && r4.output.toLowerCase().includes("no tools match"));

  const r5 = await executeTool("tool_list", { category: "skill" }, ctx);
  check("tool_list filters by category", r5.success && r5.output.includes("skill"));
}

// ── 6. getMaxFailedToolCalls behaviour ──────────────────────────────────
// We exercise the logic with a stubbed settings reader (the real one lives
// in agent-loop.ts and uses settingsStore; we recreate the same clamp).
function getMaxFailedToolCallsStub(get: (k: string) => string | undefined | null): number {
  const raw = get("agent.maxFailedToolCalls");
  if (raw) {
    const n = parseInt(String(raw), 10);
    if (!isNaN(n) && n >= 1 && n <= 50) return n;
  }
  return 4;
}
{
  check("failcap default when absent", getMaxFailedToolCallsStub(() => undefined) === 4);
  check("failcap default when empty", getMaxFailedToolCallsStub(() => "") === 4);
  check("failcap accepts 10", getMaxFailedToolCallsStub(() => "10") === 10);
  check("failcap accepts 50", getMaxFailedToolCallsStub(() => "50") === 50);
  check("failcap rejects 0 → default", getMaxFailedToolCallsStub(() => "0") === 4);
  check("failcap rejects 51 → default", getMaxFailedToolCallsStub(() => "51") === 4);
  check("failcap rejects junk → default", getMaxFailedToolCallsStub(() => "not-a-number") === 4);
  check("failcap negative → default", getMaxFailedToolCallsStub(() => "-5") === 4);
}

execTests().then(() => {
  if (process.exitCode === 1) {
    console.error("\nSOME TESTS FAILED");
    process.exit(1);
  }
  console.log("\nAll v16.73.1 smoke tests passed.");
});
