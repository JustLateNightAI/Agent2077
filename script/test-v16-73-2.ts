/**
 * v16.73.2 smoke tests:
 *  - request-router classifies common phrasings
 *  - selector honours route hints (respond → minimal floor; forceInclude)
 *  - tool-call-repair handles common malformed shapes
 *  - failure-classifier emits expected patterns
 *
 * Run with: npx tsx script/test-v16-73-2.ts
 */
import { routeRequest } from "../server/lib/request-router.js";
import { selectTools } from "../server/lib/tool-selector.js";
import { coerceArguments, resolveToolName, repairToolCall } from "../server/lib/tool-call-repair.js";
import { FailureClassifier } from "../server/lib/failure-classifier.js";
import type { ToolHandler } from "../server/tools/registry.js";

function mockHandler(name: string, category = "file"): ToolHandler {
  return {
    category: category as any,
    definition: {
      type: "function",
      function: {
        name,
        description: `mock ${name}`,
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    async execute() { return { success: true, output: "" }; },
  };
}

const ALL_NAMES = [
  "read_file", "write_file", "edit_file", "list_files", "search_files",
  "read_project_file", "write_project_file", "list_project_files", "edit_project_file",
  "search_project_files", "run_project_command", "read_project",
  "shell_command", "execute_code",
  "git_status", "git_diff", "git_log", "git_add", "git_commit",
  "web_search", "fetch_url", "browse_url", "browse_search", "browse_extract",
  "deploy_app", "stop_app", "cleanup_apps", "list_apps",
  "generate_image", "list_comfyui_models", "comfyui_status",
  "ssh_exec", "ssh_list_targets",
  "memory_recall", "memory_store", "skill_list", "skill_view",
  "session_search", "tool_list", "tool_search",
];
const allTools = new Map<string, ToolHandler>();
for (const n of ALL_NAMES) allTools.set(n, mockHandler(n));

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${label}${detail ? " — " + detail : ""}`);
  if (!ok) { failures++; process.exitCode = 1; }
}

// ── Router ───────────────────────────────────────────────────────────────
{
  const r = routeRequest("hello");
  check("router: 'hello' → respond", r.route === "respond", `got ${r.route}`);
}
{
  const r = routeRequest("thanks");
  check("router: 'thanks' → respond", r.route === "respond");
}
{
  const r = routeRequest("what tools do you have?");
  check("router: 'what tools' → tool_discovery", r.route === "tool_discovery");
  check("router: tool_discovery forceInclude tool_list", r.forceInclude.includes("tool_list"));
}
{
  const r = routeRequest("can you fetch https://example.com");
  check("router: URL → web", r.route === "web");
}
{
  const r = routeRequest("search the web for RTX 5060 reviews");
  check("router: web search → research", r.route === "research");
}
{
  const r = routeRequest("build me a calculator app");
  check("router: build app → app_build", r.route === "app_build");
}
{
  const r = routeRequest("ssh into dgx1 and check uptime");
  check("router: ssh → shell_run", r.route === "shell_run");
}
{
  const r = routeRequest("refactor the login function in auth.ts");
  check("router: refactor → code_write", r.route === "code_write");
}
{
  const r = routeRequest("show me the contents of utils.ts");
  check("router: show me file → code_read", r.route === "code_read");
}
{
  const r = routeRequest("foobar baz quux");
  check("router: no match → unknown", r.route === "unknown");
}
{
  const r = routeRequest("add a function to utils.ts", { customPrompt: "## PROJECT CONTEXT" });
  check("router: project mode → project route wins", r.route === "project");
}
{
  const r = routeRequest("");
  check("router: empty → respond", r.route === "respond");
}

// ── Selector with route hint ─────────────────────────────────────────────
{
  const sel = selectTools({
    allTools,
    taskType: "general",
    model: { modelId: "qwen3-122b", supportsToolCalling: true } as any,
    modelSize: "large",
    lastUserMessage: "hello",
    route: routeRequest("hello"),
  });
  check("selector respond: small floor only", sel.definitions.length <= 6 && sel.selectedNames.has("tool_list"));
  check("selector respond: no write_file leaked", !sel.selectedNames.has("write_file"));
  check("selector respond: no deploy_app leaked", !sel.selectedNames.has("deploy_app"));
}
{
  const sel = selectTools({
    allTools,
    taskType: "general",
    model: { modelId: "qwen3-122b", supportsToolCalling: true } as any,
    modelSize: "large",
    lastUserMessage: "what tools can you use?",
    route: routeRequest("what tools can you use?"),
  });
  check("selector tool_discovery: has tool_list", sel.selectedNames.has("tool_list"));
  check("selector tool_discovery: has tool_search", sel.selectedNames.has("tool_search"));
}
{
  const sel = selectTools({
    allTools,
    taskType: "research",
    model: { modelId: "qwen3-122b", supportsToolCalling: true } as any,
    modelSize: "large",
    lastUserMessage: "fetch https://news.example.com/article",
    route: routeRequest("fetch https://news.example.com/article"),
  });
  check("selector web route: forceInclude fetch_url", sel.selectedNames.has("fetch_url"));
}
{
  // Respond + project mode → respond short-circuit must NOT fire (project rules win)
  const sel = selectTools({
    allTools,
    taskType: "coding",
    model: { modelId: "qwen3-122b", supportsToolCalling: true } as any,
    modelSize: "large",
    customPrompt: "## PROJECT CONTEXT\nfoo",
    lastUserMessage: "hi",
    route: { route: "respond", confidence: 0.5, reasons: [], preferCategories: [], forceInclude: [] },
  });
  check("selector respond+project: write_project_file still selected", sel.selectedNames.has("write_project_file"));
  check("selector respond+project: write_file still forbidden", !sel.selectedNames.has("write_file"));
}

// ── coerceArguments ──────────────────────────────────────────────────────
{
  const r = coerceArguments({ a: 1 });
  check("coerce: object passthrough", r.ok && (r as any).args.a === 1);
}
{
  const r = coerceArguments(null);
  check("coerce: null → {}", r.ok && Object.keys((r as any).args).length === 0);
}
{
  const r = coerceArguments(`{"path":"x.txt"}`);
  check("coerce: JSON string → object", r.ok && (r as any).args.path === "x.txt");
}
{
  const r = coerceArguments("```json\n{\"path\":\"y\"}\n```");
  check("coerce: fenced JSON → object", r.ok && (r as any).args.path === "y");
}
{
  const r = coerceArguments(`{path: "z", content: "abc"}`);  // missing quotes on keys
  check("coerce: jsonrepair near-JSON", r.ok && (r as any).args.path === "z");
}
{
  const r = coerceArguments(123);
  check("coerce: number rejected", !r.ok);
}

// ── resolveToolName ──────────────────────────────────────────────────────
{
  check("resolve exact", resolveToolName("read_file", ALL_NAMES) === "read_file");
  check("resolve case-insensitive", resolveToolName("Read_File", ALL_NAMES) === "read_file");
  check("resolve dash → underscore", resolveToolName("read-file", ALL_NAMES) === "read_file");
  check("resolve spaces", resolveToolName(" web search ", ALL_NAMES) === "web_search");
  check("resolve no match", resolveToolName("xyzzy_unknown", ALL_NAMES) === null);
}

// ── repairToolCall ───────────────────────────────────────────────────────
{
  const r = repairToolCall({ toolName: "read_file", rawArgs: `{"path":"a"}`, availableTools: ALL_NAMES });
  check("repair: ok with stringified args", r.kind === "ok" && (r as any).arguments.path === "a");
}
{
  const r = repairToolCall({ toolName: "Read-File", rawArgs: { path: "a" }, availableTools: ALL_NAMES });
  check("repair: rename Read-File → read_file", r.kind === "rename" && (r as any).name === "read_file");
}
{
  const r = repairToolCall({ toolName: "frobnicate", rawArgs: {}, availableTools: ALL_NAMES });
  check("repair: unknown tool → suggestion includes tool_search",
    r.kind === "unknown_tool" && (r as any).suggestion.includes("tool_search"));
}
{
  const r = repairToolCall({ toolName: "", rawArgs: {}, availableTools: ALL_NAMES });
  check("repair: empty name → unrepairable", r.kind === "unrepairable");
}

// ── FailureClassifier ────────────────────────────────────────────────────
{
  const fc = new FailureClassifier();
  const first = fc.record({ tool: "edit_file", args: { path: "a.ts" }, output: "search text did not match", success: false });
  check("classifier: first edit_file fail → no nudge yet", first === null);
  const second = fc.record({ tool: "edit_file", args: { path: "a.ts" }, output: "search text did not match", success: false });
  check("classifier: second same-path edit fail → edit_mismatch",
    second?.pattern === "edit_mismatch" && /read_file/.test(second!.message));
}
{
  const fc = new FailureClassifier();
  fc.record({ tool: "shell_command", args: { command: "ls /nope" }, output: "no such file", success: false });
  const r2 = fc.record({ tool: "shell_command", args: { command: "ls /nope" }, output: "no such file", success: false });
  check("classifier: shell repeat → shell_repeat_fail", r2?.pattern === "shell_repeat_fail");
}
{
  const fc = new FailureClassifier();
  const r = fc.record({ tool: "frobnicate", args: {}, output: "Unknown tool: frobnicate.", success: false });
  check("classifier: unknown tool fires", r?.pattern === "unknown_tool");
}
{
  const fc = new FailureClassifier();
  const r = fc.record({ tool: "write_file", args: {}, output: "Missing required parameter(s):\n - path", success: false });
  check("classifier: malformed_args fires", r?.pattern === "malformed_args");
}
{
  const fc = new FailureClassifier();
  // First failure → caches key; second identical → identical_repeat
  fc.record({ tool: "list_files", args: { path: "/x" }, output: "boom", success: false });
  const r = fc.record({ tool: "list_files", args: { path: "/x" }, output: "boom", success: false });
  check("classifier: identical_repeat fires on second identical fail", r?.pattern === "identical_repeat");
}
{
  const fc = new FailureClassifier();
  fc.record({ tool: "list_files", args: { path: "/x" }, output: "boom", success: false });
  fc.record({ tool: "list_files", args: { path: "/x" }, output: "ok!", success: true });
  // Success re-arms; same identical-repeat key now starts over
  fc.record({ tool: "list_files", args: { path: "/x" }, output: "boom", success: false });
  const r = fc.record({ tool: "list_files", args: { path: "/x" }, output: "boom", success: false });
  check("classifier: success resets identical_repeat arming", r?.pattern === "identical_repeat");
}
{
  const fc = new FailureClassifier();
  // Same pattern fires at most once
  fc.record({ tool: "list_files", args: {}, output: "Missing required parameter(s)", success: false });
  const second = fc.record({ tool: "write_file", args: {}, output: "Missing required parameter(s)", success: false });
  check("classifier: malformed_args fires at most once per turn", second?.pattern !== "malformed_args");
}

if (failures > 0) {
  console.error(`\n${failures} TEST(S) FAILED`);
  process.exit(1);
}
console.log("\nAll v16.73.2 smoke tests passed.");
