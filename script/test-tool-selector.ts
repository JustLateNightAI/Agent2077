/**
 * Smoke test for the v16.73 tool selector.
 * Run with: npx tsx script/test-tool-selector.ts
 *
 * Stubs the tool registry with a known set, then exercises the selector
 * across MiniMax/small/large/openrouter/project/intent scenarios.
 */
import { selectTools, TOOL_CAP_MINIMAX, TOOL_CAP_SMALL_MODEL, TOOL_CAP_OPENROUTER, TOOL_CAP_DEFAULT, readSmartSelectionSetting } from "../server/lib/tool-selector.js";
import type { ToolHandler } from "../server/tools/registry.js";

function mockHandler(name: string, category: string = "file"): ToolHandler {
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
  // file
  "read_file", "write_file", "edit_file", "list_files", "search_files",
  // project
  "read_project", "list_project_files", "read_project_file", "write_project_file",
  "edit_project_file", "run_project_command", "search_project_files",
  // shell/code
  "shell_command", "execute_code",
  // git
  "git_status", "git_diff", "git_log", "git_add", "git_commit", "git_branch_list",
  // web
  "web_search", "fetch_url", "browse_url", "browse_search", "browse_extract", "browse_screenshot",
  // app deploy
  "deploy_app", "stop_app", "cleanup_apps", "rollback_app", "list_apps",
  // image
  "generate_image", "image_to_image", "upscale_image", "remove_background",
  "list_comfyui_models", "comfyui_status", "run_comfyui_workflow",
  // ssh
  "ssh_exec", "ssh_list_targets",
  // memory + skill + session
  "memory_recall", "memory_store", "skill_list", "skill_view", "skill_create", "skill_edit",
  "session_search",
  // codebase
  "search_codebase", "find_symbol", "find_references", "get_file_outline", "analyze_codebase",
];

const allTools = new Map<string, ToolHandler>();
for (const n of ALL_NAMES) allTools.set(n, mockHandler(n));

function check(label: string, ok: boolean, detail?: string) {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${label}${detail ? " — " + detail : ""}`);
  if (!ok) process.exitCode = 1;
}

// ── 1. MiniMax cap ───────────────────────────────────────────────────────
{
  const r = selectTools({
    allTools,
    taskType: "coding",
    model: { modelId: "minimax-m2.7", supportsToolCalling: true } as any,
    modelSize: "large",
    lastUserMessage: "build me an app please",
  });
  check("MiniMax: respects cap=18", r.definitions.length <= TOOL_CAP_MINIMAX, `got ${r.definitions.length}`);
  check("MiniMax: includes deploy_app via intent", r.selectedNames.has("deploy_app"));
}

// ── 2. Small model cap ──────────────────────────────────────────────────
{
  const r = selectTools({
    allTools,
    taskType: "coding",
    model: { modelId: "phi-3-7b", supportsToolCalling: true } as any,
    modelSize: "small",
    lastUserMessage: "fix this bug",
  });
  check("small model: cap=20", r.cap === TOOL_CAP_SMALL_MODEL && r.definitions.length <= 20);
}

// ── 3. OpenRouter cap ───────────────────────────────────────────────────
{
  const r = selectTools({
    allTools,
    taskType: "coding",
    model: { modelId: "anthropic/claude-3-opus", supportsToolCalling: true } as any,
    endpoint: { url: "https://openrouter.ai/api", providerType: "openrouter" } as any,
    modelSize: "large",
    lastUserMessage: "refactor this module",
  });
  check("OpenRouter: cap=30", r.cap === TOOL_CAP_OPENROUTER && r.definitions.length <= 30);
}

// ── 4. Project mode ─────────────────────────────────────────────────────
{
  const r = selectTools({
    allTools,
    taskType: "coding",
    model: { modelId: "qwen3-32b", supportsToolCalling: true } as any,
    modelSize: "large",
    customPrompt: "## PROJECT CONTEXT\nproject root: /workspace/myproj",
    lastUserMessage: "add a function to utils.ts",
  });
  check("project mode: excludes write_file", !r.selectedNames.has("write_file"));
  check("project mode: excludes shell_command", !r.selectedNames.has("shell_command"));
  check("project mode: includes write_project_file", r.selectedNames.has("write_project_file"));
}

// ── 5. Research task ────────────────────────────────────────────────────
{
  const r = selectTools({
    allTools,
    taskType: "research",
    model: { modelId: "qwen3-122b", supportsToolCalling: true } as any,
    modelSize: "large",
    lastUserMessage: "find the latest news about RTX 5060",
  });
  check("research: includes web_search", r.selectedNames.has("web_search"));
  check("research: includes fetch_url", r.selectedNames.has("fetch_url"));
  check("research: no deploy_app", !r.selectedNames.has("deploy_app"));
}

// ── 6. Conversational with no intent ────────────────────────────────────
{
  const r = selectTools({
    allTools,
    taskType: "general",
    model: { modelId: "qwen3-122b", supportsToolCalling: true } as any,
    modelSize: "large",
    lastUserMessage: "hello, how are you?",
  });
  check("general: subset stays small", r.definitions.length < 20, `got ${r.definitions.length}`);
  check("general: floor present (skill_view)", r.selectedNames.has("skill_view"));
}

// ── 7. Plan-driven selection ────────────────────────────────────────────
{
  const r = selectTools({
    allTools,
    taskType: "coding",
    model: { modelId: "qwen3-122b", supportsToolCalling: true } as any,
    modelSize: "large",
    plan: {
      needsPlan: true,
      reasoning: "",
      estimatedTools: 3,
      steps: [
        { step: 1, title: "scan", description: "", tools: ["read_project", "list_project_files"] },
        { step: 2, title: "edit", description: "", tools: ["edit_file"] },
        { step: 3, title: "verify", description: "", tools: ["execute_code"] },
      ],
    } as any,
    lastUserMessage: "do the plan",
  });
  check("plan: includes plan-step tools", r.selectedNames.has("read_project") && r.selectedNames.has("edit_file"));
  check("plan: dependency-pair adds read_file alongside edit_file", r.selectedNames.has("read_file"));
}

// ── 8. SSH intent ───────────────────────────────────────────────────────
{
  const r = selectTools({
    allTools,
    taskType: "general",
    model: { modelId: "qwen3-122b", supportsToolCalling: true } as any,
    modelSize: "large",
    lastUserMessage: "ssh into dgx1 and check uptime",
  });
  check("ssh intent: includes ssh_exec", r.selectedNames.has("ssh_exec"));
  check("ssh intent: includes ssh_list_targets", r.selectedNames.has("ssh_list_targets"));
}

// ── 9. Disabled selector returns full set ───────────────────────────────
{
  const r = selectTools({
    allTools,
    taskType: "coding",
    model: { modelId: "qwen3-122b", supportsToolCalling: true } as any,
    modelSize: "large",
    smartSelectionEnabled: false,
  });
  check("disabled: returns all tools", r.definitions.length === ALL_NAMES.length, `got ${r.definitions.length}`);
  check("disabled: modeUsed=full", r.modeUsed === "full");
}

// ── 10. Setting reader ──────────────────────────────────────────────────
{
  check("setting absent → ON", readSmartSelectionSetting(() => undefined) === true);
  check("setting null → ON", readSmartSelectionSetting(() => null) === true);
  check('setting "false" → OFF', readSmartSelectionSetting(() => "false") === false);
  check('setting "true" → ON', readSmartSelectionSetting(() => "true") === true);
  check('setting "0" → OFF', readSmartSelectionSetting(() => "0") === false);
}

if (process.exitCode === 1) {
  console.error("\nSOME TESTS FAILED");
  process.exit(1);
}
console.log("\nAll tool-selector smoke tests passed.");
