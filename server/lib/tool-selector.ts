/**
 * Tool Selector — v16.73
 *
 * Picks a small, relevant subset of the ~102 registered tools to send to the
 * LLM on each turn, instead of dumping everything. Conservative by design:
 * if we can't tell, we include a useful floor rather than risk breaking a
 * turn by hiding a needed tool.
 *
 * Inputs:
 *   - the full pool of registered tool handlers (from registry)
 *   - the active plan (if any) — PlanStep.tools is the strongest hint
 *   - taskType from the orchestrator
 *   - model + modelSize + endpoint provider info (drives caps)
 *   - customPrompt / project-mode flag
 *   - last user message text (cheap keyword sniff for SSH/web/git intent)
 *
 * Output:
 *   - selected tool names (Set<string>)
 *   - reasonMap (debug: name → why it was kept)
 *   - the matching ToolDefinition[] for native tool calling
 *
 * Gated by settingsStore key "smart_tool_selection". Default: ON when the
 * setting is absent. Set to the string "false" to disable and restore v16.72
 * "send everything" behaviour. Documented in code comments below.
 */
import type { ToolHandler } from "../tools/registry.js";
import type { TaskPlan } from "./task-planner.js";
import type { Endpoint, Model, TaskType } from "../../shared/schema.js";
import type { ToolDefinition } from "./llm-client.js";
import type { RouteDecision } from "./request-router.js";

// ── Tunable caps (kept here so they're easy to find/change) ──────────────────
export const TOOL_CAP_MINIMAX = 18;        // MiniMax M2.7 spirals with large tool sets
export const TOOL_CAP_SMALL_MODEL = 20;    // <15B param models — also choke on big tool lists
export const TOOL_CAP_OPENROUTER = 30;     // Anthropic/Gemini hallucinate at higher counts
export const TOOL_CAP_DEFAULT = 40;        // Plenty for most coding/research turns

// Floor: tools we always want available so the agent isn't crippled.
// Kept small. Memory recall + skill discovery + session search cover the
// "I don't know where to start" cases. tool_list/tool_search let the agent
// (and the user via "what tools do you have?") look up anything the selector
// didn't pre-select this turn — without ever dumping all tools into the prompt.
const FLOOR_TOOLS = [
  "tool_list",
  "tool_search",
  "memory_recall",
  "skill_list",
  "skill_view",
  "session_search",
];

// Task-type bundles — broad-strokes "which tools usually matter".
// Concrete tool names; tools not registered are silently dropped later.
const TASK_TYPE_BUNDLES: Record<string, string[]> = {
  coding: [
    "read_file", "write_file", "edit_file", "list_files", "search_files",
    "read_project", "list_project_files", "read_project_file", "search_project_files",
    "write_project_file", "edit_project_file", "run_project_command",
    "search_codebase", "analyze_codebase", "find_symbol", "find_references", "get_file_outline",
    "shell_command", "execute_code",
    "git_status", "git_diff", "git_log", "git_add", "git_commit",
  ],
  research: [
    "web_search", "fetch_url", "browse_url", "browse_search", "browse_extract", "browse_screenshot",
    "read_file", "list_files", "search_files",
  ],
  creative: [
    "generate_image", "image_to_image", "upscale_image", "remove_background",
    "list_comfyui_models", "comfyui_status", "run_comfyui_workflow",
    "write_file", "read_file",
  ],
  math: [
    "execute_code", "read_file", "write_file",
  ],
  general: [
    "web_search", "fetch_url", "read_file",
  ],
};

// Tools that strongly imply "this is an app/game/build task".
// Used both for keeping deploy tools in scope and for prompt-module gating.
const APP_DEPLOY_TOOLS = [
  "deploy_app", "stop_app", "cleanup_apps", "rollback_app",
  "list_apps", "shell_command", "execute_code",
];

// Dependency repairs: if X is in the selection, also include Y.
// Keeps the agent from getting wedged — e.g. wants to edit but can't read.
const DEPENDENCY_PAIRS: Array<[string, string[]]> = [
  ["edit_file", ["read_file", "list_files"]],
  ["write_file", ["read_file", "list_files"]],
  ["edit_project_file", ["read_project_file", "list_project_files"]],
  ["write_project_file", ["read_project_file", "list_project_files"]],
  ["deploy_app", ["list_apps", "stop_app", "cleanup_apps"]],
  ["web_search", ["fetch_url"]],
  ["browse_search", ["browse_url", "browse_extract"]],
  ["git_commit", ["git_status", "git_diff", "git_add"]],
];

// Tools that should be hidden when running in PROJECT MODE — the project
// override prompt already forbids these. Listing them here matches that.
const PROJECT_MODE_FORBIDDEN = new Set([
  "write_file", "read_file", "edit_file", "list_files", "search_files",
  "deploy_app", "stop_app", "cleanup_apps", "rollback_app",
  "shell_command",
]);

// Project-mode preferred tool surface.
const PROJECT_MODE_TOOLS = [
  "read_project", "list_project_files", "read_project_file",
  "write_project_file", "edit_project_file", "run_project_command",
  "search_project_files",
  "skill_list", "skill_view", "skill_create", "skill_edit",
  "memory_recall", "memory_store",
  "session_search",
  "tool_list", "tool_search",
];

// Cheap intent keywords — drive optional inclusion.
const SSH_INTENT_RX = /\b(ssh|remote|server|dgx|sparks?|deploy(?:\s+to)?|infra|provision|machine|host)\b/i;
const WEB_INTENT_RX = /\b(search|google|look\s*up|find\s+online|news|article|wikipedia|website|browse)\b/i;
const APP_INTENT_RX = /\b(app|game|website|web\s*app|tool|dashboard|build|deploy|launch|create.*(app|game|site)|make.*(app|game))\b/i;
const IMAGE_INTENT_RX = /\b(image|picture|photo|render|paint|draw|generate.*(image|picture|art)|comfyui|stable\s*diffusion)\b/i;

export interface ToolSelectionInput {
  allTools: Map<string, ToolHandler>;
  plan?: TaskPlan;
  taskType: TaskType;
  model: Model;
  endpoint?: Endpoint;
  modelSize: "small" | "medium" | "large" | "xlarge";
  customPrompt?: string;
  lastUserMessage?: string;
  // Subset of tools to exclude entirely (sub-agent block list, etc.)
  blockedTools?: Set<string>;
  // When false: skip the smart selection logic and return everything (minus blocked).
  smartSelectionEnabled?: boolean;
  // v16.73.2: optional route hint from the deterministic request-router.
  // When provided, biases selection toward the route's preferred categories
  // and `forceInclude` names. `respond` route trims to a minimal floor.
  route?: RouteDecision;
}

export interface ToolSelectionResult {
  selectedNames: Set<string>;
  reasonMap: Map<string, string>;
  definitions: ToolDefinition[];
  cap: number;
  modeUsed: "smart" | "full" | "fallback-floor";
  notes: string[];
}

function isMiniMax(modelId: string): boolean {
  const id = (modelId || "").toLowerCase();
  return id.includes("minimax") || id.includes("m2.7");
}

function isOpenRouter(ep?: Endpoint): boolean {
  if (!ep) return false;
  const t = (ep as any).providerType || "";
  return t === "openrouter" || (ep.url || "").includes("openrouter.ai");
}

function pickCap(input: ToolSelectionInput): number {
  if (isMiniMax(input.model.modelId)) return TOOL_CAP_MINIMAX;
  if (input.modelSize === "small") return TOOL_CAP_SMALL_MODEL;
  if (isOpenRouter(input.endpoint)) return TOOL_CAP_OPENROUTER;
  return TOOL_CAP_DEFAULT;
}

function addIfRegistered(
  name: string,
  reason: string,
  pool: Map<string, ToolHandler>,
  selected: Set<string>,
  reasons: Map<string, string>,
  blocked?: Set<string>,
): void {
  if (!pool.has(name)) return;
  if (blocked?.has(name)) return;
  if (selected.has(name)) return;
  // Respect availability gate
  const h = pool.get(name)!;
  if (h.checkFn && !h.checkFn()) return;
  selected.add(name);
  reasons.set(name, reason);
}

/**
 * Helper consumers can use to decide whether the prompt should include the
 * app-deployment module. Kept here so prompt logic and tool logic stay in sync.
 */
export function shouldIncludeAppModule(
  taskType: TaskType,
  selectedNames: Set<string>,
  lastUserMessage?: string,
): boolean {
  if (selectedNames.has("deploy_app")) return true;
  if (taskType === "coding" && APP_INTENT_RX.test(lastUserMessage || "")) return true;
  return false;
}

/**
 * Helper for the prompt module: are SSH targets relevant this turn?
 */
export function shouldIncludeSshModule(
  selectedNames: Set<string>,
  lastUserMessage?: string,
): boolean {
  if (selectedNames.has("ssh_exec") || selectedNames.has("ssh_list_targets")) return true;
  return SSH_INTENT_RX.test(lastUserMessage || "");
}

/**
 * Main entry point. Pure function — no I/O.
 */
export function selectTools(input: ToolSelectionInput): ToolSelectionResult {
  const notes: string[] = [];
  const reasons = new Map<string, string>();
  const selected = new Set<string>();
  const cap = pickCap(input);

  const isProjectMode = !!input.customPrompt && input.customPrompt.includes("PROJECT CONTEXT");

  // ── Disable path: return all tools (minus blocked) for parity with v16.72 ──
  if (input.smartSelectionEnabled === false) {
    const defs: ToolDefinition[] = [];
    for (const [name, h] of input.allTools) {
      if (input.blockedTools?.has(name)) continue;
      if (h.checkFn && !h.checkFn()) continue;
      defs.push(h.definition);
      reasons.set(name, "smart-selection-off");
    }
    return {
      selectedNames: new Set(defs.map(d => d.function.name)),
      reasonMap: reasons,
      definitions: defs,
      cap,
      modeUsed: "full",
      notes: ["smart_tool_selection is OFF — returning full registry"],
    };
  }

  // ── 0. Route-driven short-circuits (v16.73.2) ─────────────────────────────
  // The deterministic router runs first; certain routes let us trim hard.
  // `respond` (pure chat) only needs discoverability + memory recall in case
  // the user asks "do you remember…" or "what tools do you have". Returning
  // ZERO tools is also valid (LM Studio/vLLM/OpenRouter all accept omitted
  // `tools` array), but a minimal floor is safer and costs ~6 schemas.
  if (input.route?.route === "respond" && !isProjectMode) {
    const MIN_RESPOND_FLOOR = ["tool_list", "tool_search", "skill_view", "memory_recall"];
    for (const name of MIN_RESPOND_FLOOR) {
      addIfRegistered(name, "route:respond-floor", input.allTools, selected, reasons, input.blockedTools);
    }
    // Honour any forceInclude the router asked for (currently empty for respond)
    for (const name of input.route.forceInclude || []) {
      addIfRegistered(name, "route:force", input.allTools, selected, reasons, input.blockedTools);
    }
    notes.push(`route=respond (conf=${input.route.confidence.toFixed(2)}) — minimal floor only`);

    const defs: ToolDefinition[] = [];
    for (const name of selected) {
      const h = input.allTools.get(name);
      if (h) defs.push(h.definition);
    }
    return {
      selectedNames: selected,
      reasonMap: reasons,
      definitions: defs,
      cap,
      modeUsed: "smart",
      notes,
    };
  }

  // ── 1. Project mode override (when active) ─────────────────────────────────
  if (isProjectMode) {
    for (const name of PROJECT_MODE_TOOLS) {
      addIfRegistered(name, "project-mode", input.allTools, selected, reasons, input.blockedTools);
    }
    notes.push("project mode active — restricted to project-scoped tools");
    // Project tasks may still need a couple of read-only safety nets — but NOT
    // the forbidden write_file/shell_command set. They are excluded below.
  }

  // ── 1b. Route forceInclude (always wins, before plan/intent) ──────────────
  if (input.route && input.route.forceInclude.length > 0) {
    for (const name of input.route.forceInclude) {
      if (isProjectMode && PROJECT_MODE_FORBIDDEN.has(name)) continue;
      addIfRegistered(name, `route:${input.route.route}-force`, input.allTools, selected, reasons, input.blockedTools);
    }
    if (input.route.route !== "respond" && input.route.route !== "unknown") {
      notes.push(`route=${input.route.route} (conf=${input.route.confidence.toFixed(2)})`);
    }
  }

  // ── 2. Plan step tools (strongest signal) ─────────────────────────────────
  if (input.plan?.needsPlan && input.plan.steps.length > 0) {
    for (const step of input.plan.steps) {
      for (const t of step.tools || []) {
        if (isProjectMode && PROJECT_MODE_FORBIDDEN.has(t)) continue;
        addIfRegistered(t, `plan-step-${step.step}`, input.allTools, selected, reasons, input.blockedTools);
      }
    }
    if (selected.size > 0) notes.push(`plan contributed ${selected.size} tool(s)`);
  }

  // ── 3. Intent-keyword nudges (higher priority than bulk task bundle) ─────
  // Run BEFORE task-type defaults so explicit user intent always survives the cap.
  const msg = input.lastUserMessage || "";
  if (msg) {
    if (APP_INTENT_RX.test(msg) && !isProjectMode) {
      for (const name of APP_DEPLOY_TOOLS) {
        addIfRegistered(name, "intent:app", input.allTools, selected, reasons, input.blockedTools);
      }
    }
    if (SSH_INTENT_RX.test(msg)) {
      addIfRegistered("ssh_exec", "intent:ssh", input.allTools, selected, reasons, input.blockedTools);
      addIfRegistered("ssh_list_targets", "intent:ssh", input.allTools, selected, reasons, input.blockedTools);
    }
    if (WEB_INTENT_RX.test(msg)) {
      addIfRegistered("web_search", "intent:web", input.allTools, selected, reasons, input.blockedTools);
      addIfRegistered("fetch_url", "intent:web", input.allTools, selected, reasons, input.blockedTools);
    }
    if (IMAGE_INTENT_RX.test(msg)) {
      addIfRegistered("generate_image", "intent:image", input.allTools, selected, reasons, input.blockedTools);
      addIfRegistered("list_comfyui_models", "intent:image", input.allTools, selected, reasons, input.blockedTools);
      addIfRegistered("comfyui_status", "intent:image", input.allTools, selected, reasons, input.blockedTools);
    }
  }

  // ── 4. Task-type defaults (bulk fill — yields to cap) ────────────────────
  const bundle = TASK_TYPE_BUNDLES[input.taskType] || TASK_TYPE_BUNDLES.general;
  for (const name of bundle) {
    if (isProjectMode && PROJECT_MODE_FORBIDDEN.has(name)) continue;
    if (selected.size >= cap) break;
    addIfRegistered(name, `task:${input.taskType}`, input.allTools, selected, reasons, input.blockedTools);
  }

  // ── 5. Floor (always-useful safety net) ───────────────────────────────────
  for (const name of FLOOR_TOOLS) {
    if (selected.size >= cap) break;
    addIfRegistered(name, "floor", input.allTools, selected, reasons, input.blockedTools);
  }

  // ── 6. Dependency repair ──────────────────────────────────────────────────
  // If the user wants to edit, make sure they can read first, etc.
  for (const [trigger, deps] of DEPENDENCY_PAIRS) {
    if (!selected.has(trigger)) continue;
    for (const d of deps) {
      if (selected.size >= cap) break;
      if (isProjectMode && PROJECT_MODE_FORBIDDEN.has(d)) continue;
      addIfRegistered(d, `dep:${trigger}`, input.allTools, selected, reasons, input.blockedTools);
    }
  }

  // ── 7. Memory writer if we already have memory_recall + the task looks worth remembering ─
  if (selected.has("memory_recall") && selected.size < cap) {
    addIfRegistered("memory_store", "memory-pair", input.allTools, selected, reasons, input.blockedTools);
  }

  // ── 8. Cap enforcement ────────────────────────────────────────────────────
  // If somehow we're over the cap (plan contributed a lot), trim from the
  // lowest-priority end. We keep insertion order; later additions get dropped.
  let modeUsed: ToolSelectionResult["modeUsed"] = "smart";
  if (selected.size > cap) {
    const keep = Array.from(selected).slice(0, cap);
    selected.clear();
    keep.forEach(n => selected.add(n));
    notes.push(`trimmed to cap=${cap}`);
  }

  // ── 9. Safety: never return zero tools when tools exist ──────────────────
  if (selected.size === 0) {
    for (const name of FLOOR_TOOLS) {
      addIfRegistered(name, "fallback-floor", input.allTools, selected, reasons, input.blockedTools);
    }
    // Tiny extra: include a single conservative read tool so the model can do *something*
    addIfRegistered("read_file", "fallback-floor", input.allTools, selected, reasons, input.blockedTools);
    modeUsed = "fallback-floor";
    notes.push("no tools matched signals — emitted floor only");
  }

  // ── 10. Materialise definitions ──────────────────────────────────────────
  const defs: ToolDefinition[] = [];
  for (const name of selected) {
    const h = input.allTools.get(name);
    if (h) defs.push(h.definition);
  }

  return {
    selectedNames: selected,
    reasonMap: reasons,
    definitions: defs,
    cap,
    modeUsed,
    notes,
  };
}

/**
 * Resolve the smart_tool_selection setting. Accepts either "true"/"false" or
 * boolean true/false. Default: ON when the setting is absent.
 *
 * Stored under settingsStore key "smart_tool_selection".
 */
export function readSmartSelectionSetting(getter: (k: string) => string | undefined | null): boolean {
  const v = getter("smart_tool_selection");
  if (v === undefined || v === null || v === "") return true;
  const s = String(v).toLowerCase();
  return !(s === "false" || s === "0" || s === "off" || s === "no");
}
