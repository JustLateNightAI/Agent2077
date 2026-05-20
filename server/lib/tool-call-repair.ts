/**
 * Tool-call Repair — v16.73.2
 *
 * Smallcode review idea #F, deterministic-only version. When a model produces
 * a malformed tool call (or one with bad/missing arguments), try a handful of
 * cheap fixes BEFORE counting it as a failed tool call. This reduces the rate
 * at which we burn the `agent.maxFailedToolCalls` budget on parser glitches.
 *
 * Scope (deliberately narrow):
 *   - Arguments arrived as a JSON-encoded string instead of an object
 *   - Stray Markdown fences / "json" prefixes around the args
 *   - `arguments: null/undefined` → `{}`
 *   - Tool name has obvious typos or whitespace that match exactly one
 *     registered tool when normalised (case+underscore-insensitive)
 *   - Unknown tool name: suggest `tool_search("<keyword>")` as a correction
 *     message (no LLM round-trip required)
 *
 * Out of scope: rewriting schemas, faking required arguments, calling another
 * model for repair. Smallcode's `repair_tool_call` uses a model round-trip;
 * we stay deterministic to keep the latency story honest.
 */
import { jsonrepair } from "jsonrepair";

export interface RepairInput {
  toolName: string;
  rawArgs: unknown;
  /** Names of currently registered tools (full registry, not just selected). */
  availableTools: Iterable<string>;
  /** Names of tools selected this turn. Used to favour selection-set matches. */
  selectedTools?: Iterable<string>;
}

export type RepairOutcome =
  | { kind: "ok"; name: string; arguments: Record<string, any>; notes: string[] }
  | { kind: "rename"; name: string; arguments: Record<string, any>; from: string; notes: string[] }
  | { kind: "unknown_tool"; suggestion: string; notes: string[] }
  | { kind: "unrepairable"; reason: string; notes: string[] };

/**
 * Normalise a tool name for fuzzy matching.
 * "Write_File" → "writefile", " ssh-exec " → "sshexec".
 */
function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Coerce `rawArgs` into a plain object. Handles:
 *  - already an object → returned as-is
 *  - JSON string → parsed
 *  - JSON string wrapped in ```json fences → stripped + parsed
 *  - jsonrepair fallback for near-JSON
 *  - null / undefined → {}
 */
export function coerceArguments(rawArgs: unknown): { ok: true; args: Record<string, any>; note?: string } | { ok: false; reason: string } {
  if (rawArgs === null || rawArgs === undefined) {
    return { ok: true, args: {}, note: "args were null/undefined → {}" };
  }
  if (typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    return { ok: true, args: rawArgs as Record<string, any> };
  }
  if (typeof rawArgs !== "string") {
    return { ok: false, reason: `args type ${typeof rawArgs} not supported` };
  }
  let s = rawArgs.trim();
  if (s.length === 0) return { ok: true, args: {}, note: "empty string args → {}" };
  // Strip Markdown code fences if present
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  // Direct parse
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ok: true, args: parsed, note: "args were JSON string → parsed" };
    }
    return { ok: false, reason: "args parsed to non-object" };
  } catch { /* try repair */ }
  // jsonrepair fallback
  try {
    const repaired = jsonrepair(s);
    const parsed = JSON.parse(repaired);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ok: true, args: parsed, note: "args required jsonrepair" };
    }
    return { ok: false, reason: "repaired args parsed to non-object" };
  } catch (e: any) {
    return { ok: false, reason: `unparseable args: ${e.message}` };
  }
}

/**
 * Find a registered tool that matches `name` after normalisation.
 * Prefers names from the selected set when there's a tie.
 */
export function resolveToolName(
  name: string,
  available: Iterable<string>,
  selected?: Iterable<string>,
): string | null {
  const want = normName(name);
  if (!want) return null;
  const selSet = selected ? new Set(selected) : null;
  let firstMatch: string | null = null;
  let selectedMatch: string | null = null;
  for (const candidate of available) {
    if (normName(candidate) === want) {
      if (!firstMatch) firstMatch = candidate;
      if (selSet?.has(candidate)) { selectedMatch = candidate; break; }
    }
  }
  return selectedMatch ?? firstMatch;
}

/**
 * Build a short, actionable correction message for an unknown tool.
 * Suggests `tool_search` since it's always in the floor.
 */
export function unknownToolSuggestion(name: string): string {
  const keyword = name.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
  return (
    `Unknown tool "${name}". Use tool_search({query:"${keyword || "..."}"}) to look ` +
    `it up — the full catalogue (not just this turn's selected set) is searchable. ` +
    `If the tool truly doesn't exist, pick a different approach.`
  );
}

/**
 * Main repair entry point. Pure, no I/O.
 */
export function repairToolCall(input: RepairInput): RepairOutcome {
  const notes: string[] = [];

  // 1. Argument coercion
  const argResult = coerceArguments(input.rawArgs);
  if (!argResult.ok) {
    notes.push(`arg coerce failed: ${argResult.reason}`);
    // We still try to resolve the name, but we can't continue without args
    // — return unrepairable so the caller can fall back to its existing
    // error path with a clearer reason.
    return { kind: "unrepairable", reason: argResult.reason, notes };
  }
  if (argResult.note) notes.push(argResult.note);

  // 2. Tool-name validation / rename
  const want = (input.toolName || "").trim();
  if (!want) {
    return { kind: "unrepairable", reason: "empty tool name", notes };
  }

  const availableArr = Array.isArray(input.availableTools)
    ? input.availableTools as string[]
    : Array.from(input.availableTools);
  const availableSet = new Set(availableArr);

  if (availableSet.has(want)) {
    if (notes.length > 0) {
      return { kind: "ok", name: want, arguments: argResult.args, notes };
    }
    return { kind: "ok", name: want, arguments: argResult.args, notes };
  }

  const resolved = resolveToolName(want, availableArr, input.selectedTools);
  if (resolved) {
    notes.push(`tool name normalised: "${want}" → "${resolved}"`);
    return { kind: "rename", name: resolved, arguments: argResult.args, from: want, notes };
  }

  return {
    kind: "unknown_tool",
    suggestion: unknownToolSuggestion(want),
    notes,
  };
}
