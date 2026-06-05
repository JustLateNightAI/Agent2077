/**
 * Tool Registry — Central hub for all agent tools
 * Each tool has a schema (for LLM) and a handler (for execution)
 */
import type { ToolDefinition } from "../lib/llm-client.js";

export interface ToolHandler {
  definition: ToolDefinition;
  execute: (args: Record<string, any>, context: ToolContext) => Promise<ToolResult>;
  requiresApproval?: boolean; // dangerous operations need user OK
  category: "search" | "code" | "file" | "docker" | "system" | "memory" | "skill" | "self-dev" | "image";
  maxResultSizeChars?: number; // Per-tool output cap (default: 50000)
  checkFn?: () => boolean; // Optional availability gate — return false to hide tool
}

export interface ToolContext {
  conversationId: number;
  requestId: string;
  onStep?: (step: AgentStep) => void;
  sseResponse?: any; // Express Response for streaming sub-agent progress to the client
  /** Running aggregate of tool output chars this turn — mutated by executeTool */
  turnBudget?: { usedChars: number; maxChars: number };
  /**
   * v16.40: Memory scope for this context.
   * 'general' = normal chat (only sees general memories).
   * 'project:{id}' = workspace project (sees general + that project's memories).
   */
  memoryScope?: string;
}

export interface ToolResult {
  success: boolean;
  output: string;
  metadata?: Record<string, any>;
}

export interface AgentStep {
  type: string;
  label: string;
  detail?: string;
  status: "running" | "completed" | "failed";
  timestamp: string;
}

/** Tools that are safe to execute in parallel (read-only, no side effects). */
export const PARALLEL_SAFE_TOOLS = new Set([
  'web_search',
  'web_extract',
  'read_file',
  'search_files',
  'list_files',
  'list_comfyui_models',
  'comfyui_status',
  'get_queue',
  'read_project_file',
  'list_project_files',
  'search_project_files',
  'session_search',
  'memory_recall',
  'skill_list',
  'skill_view',
  'get_image_metadata',
  'list_images',
]);

/** Tools that must NEVER run in parallel. */
export const NEVER_PARALLEL_TOOLS = new Set([
  'execute_command',
  'write_file',
  'edit_file',
  'delete_file',
  'deploy_app',
  'selfdev_build',
  'selfdev_start_server',
  'selfdev_stop_server',
]);

/**
 * Check if a set of tool calls can safely be executed in parallel.
 * All tools must be in PARALLEL_SAFE_TOOLS and none in NEVER_PARALLEL_TOOLS.
 * Additionally, check for overlapping file paths in args.
 */
export function canParallelize(toolCalls: Array<{ name: string; args: Record<string, any> }>): boolean {
  if (toolCalls.length <= 1) return false;

  // All must be in safe list
  if (!toolCalls.every(tc => PARALLEL_SAFE_TOOLS.has(tc.name))) return false;

  // None can be in never-parallel list
  if (toolCalls.some(tc => NEVER_PARALLEL_TOOLS.has(tc.name))) return false;

  // Check for overlapping file paths
  const paths = new Set<string>();
  for (const tc of toolCalls) {
    const filePath = tc.args.filePath || tc.args.path || tc.args.file;
    if (filePath) {
      if (paths.has(filePath)) return false;
      paths.add(filePath);
    }
  }

  return true;
}

// Tool registry — all tools register here
const tools = new Map<string, ToolHandler>();

export function registerTool(name: string, handler: ToolHandler) {
  tools.set(name, handler);
  console.log(`[Tools] Registered: ${name} (${handler.category})`);
}

export function unregisterTool(name: string): boolean {
  const removed = tools.delete(name);
  if (removed) console.log(`[Tools] Unregistered: ${name}`);
  return removed;
}

export function getTool(name: string): ToolHandler | undefined {
  return tools.get(name);
}

export function getAllTools(): Map<string, ToolHandler> {
  return tools;
}

export function getToolDefinitions(filter?: { categories?: string[] }): ToolDefinition[] {
  const defs: ToolDefinition[] = [];
  for (const [, handler] of tools) {
    if (filter?.categories && !filter.categories.includes(handler.category)) continue;
    // Check availability gate
    if (handler.checkFn && !handler.checkFn()) continue;
    defs.push(handler.definition);
  }
  return defs;
}

/**
 * Build a text description of all tools for the prompted fallback
 * (when a model doesn't support native tool calling).
 *
 * v16.73: optional `names` arg restricts the output to the given subset.
 * When omitted, behaviour is identical to v16.72 (every registered tool).
 */
export function getToolDescriptionsText(names?: Iterable<string>): string {
  const filter = names ? new Set(names) : null;
  const sections: string[] = [];
  for (const [name, handler] of tools) {
    if (filter && !filter.has(name)) continue;
    // Check availability gate
    if (handler.checkFn && !handler.checkFn()) continue;
    const fn = handler.definition.function;
    const params = Object.entries(fn.parameters.properties || {})
      .map(([k, v]: [string, any]) => `  - ${k} (${v.type}): ${v.description || ""}`)
      .join("\n");
    sections.push(`### ${name}\n${fn.description}\nParameters:\n${params}`);
  }
  return sections.join("\n\n");
}

/**
 * v16.73: Return tool definitions matching the given set of names. Skips
 * tools whose `checkFn` says they're unavailable. Used by the tool selector
 * to feed only the chosen subset to native tool calling.
 */
export function getToolDefinitionsByNames(names: Iterable<string>): ToolDefinition[] {
  const wanted = new Set(names);
  const defs: ToolDefinition[] = [];
  for (const [name, handler] of tools) {
    if (!wanted.has(name)) continue;
    if (handler.checkFn && !handler.checkFn()) continue;
    defs.push(handler.definition);
  }
  return defs;
}

/**
 * Validate that all required parameters are present in args.
 * Returns null if valid, or an error message string if invalid.
 */
function validateToolArgs(tool: ToolHandler, args: Record<string, any>): string | null {
  const params = tool.definition.function.parameters;
  const required: string[] = params.required || [];
  const properties: Record<string, any> = params.properties || {};

  // Check for completely empty args when required params exist
  if (required.length > 0 && Object.keys(args).length === 0) {
    const paramDescriptions = required.map(name => {
      const prop = properties[name];
      return `  - ${name} (${prop?.type || 'string'}): ${prop?.description || 'required'}`;
    }).join('\n');
    return `Missing all required parameters. You must provide:\n${paramDescriptions}\n\nCall this tool again with the correct arguments.`;
  }

  // Check each required param individually
  const missing: string[] = [];
  for (const name of required) {
    if (args[name] === undefined || args[name] === null || args[name] === '') {
      const prop = properties[name];
      missing.push(`  - ${name} (${prop?.type || 'string'}): ${prop?.description || 'required'}`);
    }
  }

  if (missing.length > 0) {
    return `Missing required parameter(s):\n${missing.join('\n')}\n\nCall this tool again with the correct arguments.`;
  }

  return null;
}

/**
 * Execute a tool call, with optional approval gating
 */
export async function executeTool(
  toolName: string,
  args: Record<string, any>,
  context: ToolContext
): Promise<ToolResult> {
  const tool = tools.get(toolName);
  if (!tool) {
    return { success: false, output: `Unknown tool: ${toolName}. Available tools: ${[...tools.keys()].join(', ')}` };
  }

  // Validate required parameters BEFORE execution
  const validationError = validateToolArgs(tool, args);
  if (validationError) {
    console.warn(`[Tools] ${toolName} called with invalid args:`, JSON.stringify(args));
    context.onStep?.({
      type: tool.category,
      label: `${toolName} — invalid arguments`,
      detail: validationError.slice(0, 300),
      status: "failed",
      timestamp: new Date().toISOString(),
    });
    return { success: false, output: validationError };
  }

  context.onStep?.({
    type: tool.category,
    label: `Calling ${toolName}`,
    detail: JSON.stringify(args).slice(0, 200),
    status: "running",
    timestamp: new Date().toISOString(),
  });

  try {
    const result = await tool.execute(args, context);

    // ── Tool result budget enforcement ─────────────────────────────────
    const perToolCap = tool.maxResultSizeChars ?? 50000;
    if (result.output.length > perToolCap) {
      const originalLen = result.output.length;
      result.output = result.output.slice(0, perToolCap) + `\n...(truncated from ${originalLen} to ${perToolCap} chars)`;
    }

    // Per-turn aggregate budget (if set by the agent loop)
    if (context.turnBudget) {
      const remaining = context.turnBudget.maxChars - context.turnBudget.usedChars;
      if (result.output.length > remaining) {
        result.output = result.output.slice(0, Math.max(remaining, 500)) +
          `\n...(turn budget reached: ${context.turnBudget.usedChars + Math.max(remaining, 500)}/${context.turnBudget.maxChars} chars)`;
      }
      context.turnBudget.usedChars += result.output.length;
    }

    context.onStep?.({
      type: tool.category,
      label: `${toolName} ${result.success ? "completed" : "failed"}`,
      detail: result.output.slice(0, 300),
      status: result.success ? "completed" : "failed",
      timestamp: new Date().toISOString(),
    });

    return result;
  } catch (err: any) {
    const errResult: ToolResult = { success: false, output: `Tool error: ${err.message}` };
    context.onStep?.({
      type: tool.category,
      label: `${toolName} error`,
      detail: err.message,
      status: "failed",
      timestamp: new Date().toISOString(),
    });
    return errResult;
  }
}
