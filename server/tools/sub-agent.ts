/**
 * Sub-Agent Tool — spawn_subtasks
 *
 * Allows the orchestrator agent to split complex work into parallel subtasks
 * that execute concurrently across available endpoints/models.
 *
 * Usage by the agent:
 *   spawn_subtasks({
 *     tasks: [
 *       { title: "Research topic X", description: "...", taskType: "research" },
 *       { title: "Write the code",   description: "...", taskType: "coding"   },
 *     ]
 *   })
 *
 * The tool creates a TaskPlan record, runs all subtasks in parallel (respecting
 * per-endpoint slot limits), waits for completion, and returns a combined result
 * summary.
 */

import { registerTool, type ToolResult, type ToolContext } from "./registry.js";
import { getDevInfo } from "../lib/dev-workspace.js";
import { subAgentExecutor, type SubtaskSpec } from "../lib/sub-agent-executor.js";
import { taskPlanStore } from "../storage.js";
import type { TaskType } from "../../shared/schema.js";

const VALID_TASK_TYPES = new Set<TaskType>(["coding", "research", "creative", "math", "general"]);

function normaliseTaskType(raw: string): TaskType {
  const lower = (raw ?? "").toLowerCase().trim() as TaskType;
  return VALID_TASK_TYPES.has(lower) ? lower : "general";
}

registerTool("spawn_subtasks", {
  category: "system",
  definition: {
    type: "function",
    function: {
      name: "spawn_subtasks",
      description:
        "Split a complex task into parallel subtasks and execute them concurrently across " +
        "available LLM endpoints. Each subtask runs its own focused agent loop. " +
        "Use this when work can be done in parallel (e.g. reading multiple files, parallel searches, creating independent new files). " +
        "Returns an ENRICHED result for each subtask containing: (1) sub-agent output, (2) structured self-report manifest, " +
        "(3) parent verification of claimed outputs against disk reality, and (4) ground-truth disk change manifest. " +
        "ALWAYS read the 'Parent verification' and 'Disk change manifest' sections — they tell you what ACTUALLY happened on disk, " +
        "not just what the sub-agent claimed. " +
        "Use 'parentContext' to give each sub-agent background it needs. " +
        "Use 'expectedOutputs' to declare what files/data it must produce — the parent will verify these exist after completion.",
      parameters: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            description:
              "Array of subtasks to execute in parallel. Each item describes one unit of work.",
            items: {
              type: "object",
              properties: {
                title: {
                  type: "string",
                  description: "Short title for the subtask (e.g. 'Write authentication module')",
                },
                description: {
                  type: "string",
                  description:
                    "Detailed description of exactly what this subtask should accomplish. " +
                    "Be specific — this is the full instruction the sub-agent will receive.",
                },
                taskType: {
                  type: "string",
                  enum: ["coding", "research", "creative", "math", "general"],
                  description:
                    "Task category — used to route the subtask to the best available model. " +
                    "Choose the type that best matches the work (e.g. 'coding' for code writing, " +
                    "'research' for web search and analysis).",
                },
                dependsOn: {
                  type: "array",
                  items: { type: "number" },
                  description:
                    "Optional: zero-based indices of other tasks in this array that must " +
                    "complete successfully before this task starts. Omit for tasks with no dependencies.",
                },
                parentContext: {
                  type: "string",
                  description:
                    "Optional: relevant background from the current conversation that this sub-agent needs to do its work. " +
                    "Use this when the sub-agent needs facts, decisions, or findings from the parent conversation that " +
                    "it cannot discover on its own (e.g. the user's chosen architecture, earlier research results, " +
                    "constraints already established). Keep it concise — a few sentences to a short paragraph.",
                },
                expectedOutputs: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Optional: list of specific outputs this sub-agent must produce, stated as concrete deliverables. " +
                    "Examples: ['client/src/components/my-widget.tsx', 'Full content of routes.ts starting at line 50']. " +
                    "Use resultSpec for stricter verification with file size, export, and syntax checks.",
                },
                resultSpec: {
                  type: "object",
                  description:
                    "Optional: structured contract defining EXACTLY what the sub-agent must produce. " +
                    "Stricter than expectedOutputs — each file spec is verified mechanically: " +
                    "(1) existence check, (2) minimum byte size guard, (3) required exports regex scan, " +
                    "(4) tsc --noEmit syntax check for TS/JS files. " +
                    "dataPatterns checks that specific content appears in the sub-agent's text output. " +
                    "Use this for any subtask that creates a new file or must return specific data. " +
                    "Violations are flagged as SPEC FAIL in the parent's verification result.",
                  properties: {
                    files: {
                      type: "array",
                      description: "Files the sub-agent must create or modify.",
                      items: {
                        type: "object",
                        properties: {
                          path: { type: "string", description: "Path relative to dev workspace root, e.g. 'client/src/components/my-widget.tsx'" },
                          minBytes: { type: "number", description: "Minimum file size in bytes. Default 50. Catches empty/stub writes." },
                          requiredExports: {
                            type: "array",
                            items: { type: "string" },
                            description: "Strings that must appear verbatim in the file. E.g. ['export function MyWidget', 'export interface MyWidgetProps']. Checked via fast regex."
                          },
                          validateSyntax: { type: "boolean", description: "Run tsc --noEmit after creation (TS/JS only). Default true." },
                          description: { type: "string", description: "Human-readable description shown to the sub-agent of what this file should contain." },
                        },
                        required: ["path"],
                      },
                    },
                    dataPatterns: {
                      type: "array",
                      description: "Patterns that must appear in the sub-agent's text output.",
                      items: {
                        type: "object",
                        properties: {
                          label: { type: "string", description: "Human-readable label for this check, e.g. 'Must list all route handlers'" },
                          pattern: { type: "string", description: "Regex pattern that must match somewhere in the sub-agent's final output." },
                          required: { type: "boolean", description: "If true (default), a missing match is a hard failure." },
                        },
                        required: ["label", "pattern"],
                      },
                    },
                  },
                },
              },
              required: ["title", "description", "taskType"],
            },
            minItems: 1,
          },
          description: {
            type: "string",
            description: "Optional: brief description of the overall goal of this parallel batch.",
          },
        },
        required: ["tasks"],
      },
    },
  },

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const { tasks: rawTasks, description: batchDescription } = args;

    // ── Validate input ────────────────────────────────────────────────────
    if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
      return {
        success: false,
        output: "spawn_subtasks requires a non-empty 'tasks' array. Each task must have: title (string), description (string), taskType ('coding'|'research'|'creative'|'math'|'general'). Do NOT include extra fields like tool_name or path — put those instructions in the description field.",
      };
    }

    const tasks: SubtaskSpec[] = rawTasks.map((t: any, idx: number) => {
      if (!t.title || typeof t.title !== "string") {
        throw new Error(`Task at index ${idx} is missing a 'title' string.`);
      }
      if (!t.description || typeof t.description !== "string") {
        throw new Error(`Task at index ${idx} is missing a 'description' string.`);
      }
      return {
        title: t.title,
        description: t.description,
        taskType: normaliseTaskType(t.taskType ?? "general"),
        dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(Number) : undefined,
        parentContext: typeof t.parentContext === "string" && t.parentContext.trim() ? t.parentContext.trim() : undefined,
        expectedOutputs: Array.isArray(t.expectedOutputs) ? t.expectedOutputs.map(String).filter(Boolean) : undefined,
        resultSpec: t.resultSpec && typeof t.resultSpec === "object" ? t.resultSpec : undefined,
      };
    });

    // ── Self-dev context injection ────────────────────────────────────────
    // If we're running inside a self-dev session, inject workspace context into
    // each subtask so buildSubtaskSystemPrompt can generate a dev-workspace-aware prompt.
    const devInfo = getDevInfo();
    if (devInfo.devDir) {
      const devToolsList = [
        "- selfdev_read_file(filePath, source?) — read a file from dev or stable workspace",
        "- selfdev_list_files(directory) — list files in a dev workspace directory",
        "- selfdev_search_files(pattern, subPath?, fileGlob?) — search file contents in dev workspace",
        "- selfdev_diff(filePath) — show diff between dev and stable for a file",
      ].join("\n");
      for (const task of tasks) {
        task.selfDevContext = {
          devDir: devInfo.devDir,
          stableDir: devInfo.stableDir,
          devToolsList,
        };
      }
      console.log(`[spawn_subtasks] Injected self-dev context (devDir=${devInfo.devDir}) into ${tasks.length} subtask(s)`);
    }

    console.log(
      `[spawn_subtasks] Launching ${tasks.length} subtask(s) for conversation ${context.conversationId}`
    );

    // ── Create a TaskPlan record ──────────────────────────────────────────
    let planId: number;
    try {
      const plan = taskPlanStore.create({
        conversationId: context.conversationId,
        originalRequest: batchDescription ?? `spawn_subtasks: ${tasks.map(t => t.title).join(", ")}`,
        planJson: JSON.stringify(tasks),
        status: "running",
      });
      planId = plan.id;
    } catch (err: any) {
      return {
        success: false,
        output: `Failed to create task plan: ${err.message}`,
      };
    }

    // Notify the UI that subtasks are starting
    context.onStep?.({
      type: "system",
      label: `Spawning ${tasks.length} parallel subtask(s)`,
      detail: tasks.map(t => t.title).join(", "),
      status: "running",
      timestamp: new Date().toISOString(),
    });

    // ── Execute all subtasks ──────────────────────────────────────────────
    let outcomes: { specIndex: number; subtaskId: number; success: boolean; result: string }[];

    try {
      // Pass the SSE response from the parent agent loop so sub-agent progress
      // events (subtask_progress) stream directly to the client UI
      outcomes = await subAgentExecutor.executeSubtasks(
        planId,
        tasks,
        context.conversationId,
        context.sseResponse ?? null,
        context.requestId
      );
    } catch (err: any) {
      taskPlanStore.update(planId, { status: "failed" });
      return {
        success: false,
        output: `Parallel execution failed: ${err.message}`,
      };
    }

    // ── Mark plan complete ────────────────────────────────────────────────
    const anyFailed = outcomes.some(o => !o.success);
    taskPlanStore.update(planId, {
      status: anyFailed ? "failed" : "completed",
      completedAt: new Date().toISOString(),
    } as any);

    // ── Build combined result ─────────────────────────────────────────────
    // Collect all verified file changes across all subtasks for the parent summary
    const allCreated: string[] = [];
    const allModified: string[] = [];
    const allVerificationFails: string[] = [];

    for (const outcome of outcomes) {
      if ((outcome as any).verification?.changeManifest) {
        allCreated.push(...(outcome as any).verification.changeManifest.added);
        allModified.push(...(outcome as any).verification.changeManifest.modified);
      }
      if ((outcome as any).verification && !(outcome as any).verification.passed) {
        allVerificationFails.push(tasks[outcome.specIndex].title);
      }
    }

    const lines: string[] = [
      `Parallel subtask execution complete (plan #${planId}):`,
      `  Total tasks         : ${tasks.length}`,
      `  Succeeded           : ${outcomes.filter(o => o.success).length}`,
      `  Failed              : ${outcomes.filter(o => !o.success).length}`,
      `  Verification passed : ${outcomes.filter(o => !(o as any).verification || (o as any).verification.passed).length}/${outcomes.length}`,
      "",
    ];

    // Consolidated change manifest across all subtasks — ground truth
    if (allCreated.length > 0 || allModified.length > 0) {
      lines.push(`## Combined disk change manifest`);
      if (allCreated.length > 0) lines.push(`  Files created : ${allCreated.join(", ")}`);
      if (allModified.length > 0) lines.push(`  Files modified: ${allModified.join(", ")}`);
      lines.push("");
    }

    if (allVerificationFails.length > 0) {
      lines.push(`## ⚠ Verification failures (claimed outputs not found on disk)`);
      lines.push(allVerificationFails.map(t => `  - ${t}`).join("\n"));
      lines.push("These subtasks may not have completed successfully. Check their output and consider re-running or fixing manually.");
      lines.push("");
    }

    for (const outcome of outcomes.sort((a, b) => a.specIndex - b.specIndex)) {
      const spec = tasks[outcome.specIndex];
      const ver = (outcome as any).verification;
      const verTag = ver?.passed === false ? " ⚠VERIFY-FAIL" : (ver ? " ✓verified" : "");
      const status = outcome.success ? `✓ completed${verTag}` : `✗ failed${verTag}`;
      lines.push(`### ${status}: ${spec.title}`);
      // The enriched result already contains sub-agent output + manifest + verification + change manifest
      lines.push(outcome.result.slice(0, 3000));
      if (outcome.result.length > 3000) {
        lines.push(`...(truncated — full output stored in subtask #${outcome.subtaskId})`);
      }
      lines.push("");
    }

    context.onStep?.({
      type: "system",
      label: `Parallel subtasks complete`,
      detail: `${outcomes.filter(o => o.success).length}/${tasks.length} succeeded`,
      status: anyFailed ? "failed" : "completed",
      timestamp: new Date().toISOString(),
    });

    const successCount = outcomes.filter(o => o.success).length;
    const failCount = outcomes.filter(o => !o.success).length;

    // Partial success: if at least one subtask succeeded, return success=true so the
    // main agent can use the results rather than discarding everything and retrying.
    // A single 429/timeout failure (e.g. rate limit) should not invalidate good results.
    const partialSuccess = successCount > 0;

    return {
      success: partialSuccess,
      output: lines.join("\n"),
      metadata: {
        planId,
        subtaskCount: tasks.length,
        successCount,
        failCount,
        partial: anyFailed && partialSuccess,
        outcomes: outcomes.map(o => ({
          specIndex: o.specIndex,
          subtaskId: o.subtaskId,
          title: tasks[o.specIndex].title,
          success: o.success,
        })),
      },
    };
  },
});
