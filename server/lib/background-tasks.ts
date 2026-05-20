/**
 * Background Task Queue
 *
 * Executes agent loops asynchronously in the background.
 * Supports one-shot tasks and scheduled (cron) tasks.
 * Progress and logs are persisted in the backgroundTasks table.
 */
import { backgroundTaskStore, endpointStore, modelStore } from "../storage.js";
import type { BackgroundTask } from "../../shared/schema.js";

// ── Cron expression matching ─────────────────────────────────────────

/**
 * Check if a cron expression matches the current time.
 * Supports standard 5-field cron: minute hour day-of-month month day-of-week
 */
function matchesCron(expr: string, now: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const [minF, hourF, domF, monF, dowF] = fields;

  function matches(field: string, value: number, min: number, max: number): boolean {
    if (field === "*") return true;
    if (field.includes("/")) {
      const [, step] = field.split("/");
      return value % parseInt(step) === 0;
    }
    if (field.includes(",")) {
      return field.split(",").some(v => parseInt(v) === value);
    }
    if (field.includes("-")) {
      const [lo, hi] = field.split("-").map(Number);
      return value >= lo && value <= hi;
    }
    return parseInt(field) === value;
  }

  return (
    matches(minF, now.getMinutes(), 0, 59) &&
    matches(hourF, now.getHours(), 0, 23) &&
    matches(domF, now.getDate(), 1, 31) &&
    matches(monF, now.getMonth() + 1, 1, 12) &&
    matches(dowF, now.getDay(), 0, 6)
  );
}

// ── Task queue ───────────────────────────────────────────────────────

let isProcessing = false;
let schedulerInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Add log entries to a task's log array.
 */
function appendLog(taskId: number, message: string) {
  const task = backgroundTaskStore.getById(taskId);
  if (!task) return;

  const logs: any[] = task.logs ? JSON.parse(task.logs) : [];
  logs.push({ timestamp: new Date().toISOString(), message });

  // Keep at most 500 log entries
  const trimmed = logs.slice(-500);
  backgroundTaskStore.update(taskId, { logs: JSON.stringify(trimmed) });
}

// Max automatic retry attempts for transient failures
const MAX_RETRIES = 3;

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute a single background task with automatic retry on failure.
 * Retries up to MAX_RETRIES times with exponential backoff (2s, 4s, 8s).
 * Runs the agent loop with its own conversation context.
 */
async function executeTask(task: BackgroundTask): Promise<void> {
  if (task.status === "cancelled") return;

  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    if (attempt > 0) {
      const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
      appendLog(task.id, `Retry attempt ${attempt}/${MAX_RETRIES} — waiting ${delay / 1000}s...`);
      await sleep(delay);
    }

    // Check if cancelled between retries
    const current = backgroundTaskStore.getById(task.id);
    if (current?.status === "cancelled") return;

    if (attempt === 0) {
      console.log(`[BgTasks] Starting task ${task.id}: ${task.title}`);
    } else {
      console.log(`[BgTasks] Retrying task ${task.id} (attempt ${attempt}/${MAX_RETRIES})`);
    }

    backgroundTaskStore.update(task.id, {
      status: "running",
      startedAt: new Date().toISOString(),
      progress: 0,
    });
    appendLog(task.id, attempt === 0 ? `Task started: ${task.title}` : `Retrying task (attempt ${attempt}/${MAX_RETRIES})`);

    let succeeded = false;
    try {
    // Find model and endpoint
    const endpoints = endpointStore.getAll().filter(e => e.isEnabled);
    const endpoint = task.endpointId
      ? endpointStore.getById(task.endpointId)
      : endpoints[0];

    if (!endpoint) {
      throw new Error("No enabled endpoint found. Configure an LLM endpoint in Settings.");
    }

    const models = modelStore.getByEndpoint(endpoint.id).filter(m => m.isEnabled);
    const model = task.modelId
      ? models.find(m => m.modelId === task.modelId)
      : models.find(m => m.supportsToolCalling) || models[0];

    if (!model) {
      throw new Error(`No enabled model found on endpoint ${endpoint.name}`);
    }

    appendLog(task.id, `Using model: ${model.modelId} on ${endpoint.name}`);

    // Dynamically import to avoid circular deps
    const { runAgentLoop } = await import("./agent-loop.js");
    const { conversationStore, messageStore } = await import("../storage.js");

    // Create a dedicated conversation for this task
    const conv = conversationStore.create({
      title: `[BgTask] ${task.title}`,
      systemPrompt: `You are executing a background task: ${task.title}`,
    });

    // Update task with new conversation ID
    backgroundTaskStore.update(task.id, { conversationId: conv.id });
    appendLog(task.id, `Created conversation: ${conv.id}`);

    // Create a fake SSE response object to capture agent output
    const outputChunks: string[] = [];
    let currentContent = "";

    const fakeRes = {
      write: (chunk: string) => {
        try {
          // Extract content from SSE data
          const dataMatch = chunk.match(/^data: (.+)$/m);
          if (dataMatch) {
            const payload = JSON.parse(dataMatch[1]);
            if (payload.type === "content" && payload.content) {
              currentContent += payload.content;
            }
            if (payload.type === "step") {
              appendLog(task.id, `Step: ${payload.label}${payload.detail ? ` — ${payload.detail}` : ""}`);
            }
            if (payload.type === "done") {
              backgroundTaskStore.update(task.id, { progress: 100 });
            }
          }
        } catch { /* ignore parse errors */ }
        return true;
      },
      end: () => {},
      on: (_event: string, _handler: any) => {},
      removeListener: (_event: string, _handler: any) => {},
      headersSent: false,
    } as any;

    // Run the agent loop
    await runAgentLoop({
      conversationId: conv.id,
      messages: [{ role: "user", content: task.description || task.title }],
      model,
      endpoint,
      taskType: "general",
      res: fakeRes,
      requestId: `bgtask-${task.id}`,
    });

    const result = currentContent || "(Task completed without text output)";
    backgroundTaskStore.update(task.id, {
      status: "completed",
      result,
      progress: 100,
      completedAt: new Date().toISOString(),
    });

      appendLog(task.id, `Task completed. Output length: ${result.length} chars`);
      console.log(`[BgTasks] Task ${task.id} completed`);
      succeeded = true;
    } catch (err: any) {
      const isLastAttempt = attempt >= MAX_RETRIES;
      console.error(`[BgTasks] Task ${task.id} failed (attempt ${attempt}/${MAX_RETRIES}):`, err.message);
      appendLog(task.id, `Attempt ${attempt} failed: ${err.message}${isLastAttempt ? " — no more retries" : ""}`);

      if (isLastAttempt) {
        backgroundTaskStore.update(task.id, {
          status: "failed",
          error: err.message,
          completedAt: new Date().toISOString(),
        });
      }
    }

    if (succeeded) break;
    attempt++;
  }
}

/**
 * Process the next queued task (FIFO order).
 */
async function processQueue(): Promise<void> {
  if (isProcessing) return;

  const queued = backgroundTaskStore.getByStatus("queued");
  if (queued.length === 0) return;

  isProcessing = true;
  const task = queued[0]; // Take the oldest queued task

  try {
    await executeTask(task);
  } finally {
    isProcessing = false;
    // Process next task if any
    const next = backgroundTaskStore.getByStatus("queued");
    if (next.length > 0) {
      setImmediate(processQueue);
    }
  }
}

/**
 * Enqueue a task (sets status to "queued" and triggers processing).
 */
export function enqueueTask(taskId: number): void {
  backgroundTaskStore.update(taskId, { status: "queued" });
  setImmediate(processQueue);
}

/**
 * Cancel a running or queued task.
 */
export function cancelTask(taskId: number): void {
  const task = backgroundTaskStore.getById(taskId);
  if (!task) return;

  if (task.status === "running" || task.status === "queued") {
    backgroundTaskStore.update(taskId, {
      status: "cancelled",
      completedAt: new Date().toISOString(),
    });
    appendLog(taskId, "Task cancelled by user");
  }
}

/**
 * Retry a failed task.
 */
export function retryTask(taskId: number): void {
  const task = backgroundTaskStore.getById(taskId);
  if (!task) return;

  if (task.status === "failed" || task.status === "cancelled") {
    backgroundTaskStore.update(taskId, {
      status: "queued",
      error: null,
      result: null,
      progress: 0,
      startedAt: null,
      completedAt: null,
      logs: null,
    });
    setImmediate(processQueue);
  }
}

/**
 * Start the cron scheduler for scheduled tasks.
 * Checks every minute if any scheduled tasks should run.
 */

export function startScheduler(): void {
  if (schedulerInterval) return;

  console.log("[BgTasks] Starting task scheduler");

  schedulerInterval = setInterval(() => {
    const now = new Date();
    const scheduled = backgroundTaskStore.getScheduled();

    for (const task of scheduled) {
      if (!task.cronExpression) continue;
      if (task.status === "cancelled") continue; // skip cancelled scheduled tasks

      try {
        if (matchesCron(task.cronExpression, now)) {
          // Only run if not already queued/running
          if (task.status !== "queued" && task.status !== "running") {
            console.log(`[BgTasks] Cron trigger for task ${task.id}: ${task.title}`);
            backgroundTaskStore.update(task.id, {
              nextRunAt: new Date(Date.now() + 60000).toISOString(), // rough next estimate
            });
            enqueueTask(task.id);
          }
        }
      } catch (err: any) {
        console.warn(`[BgTasks] Cron check failed for task ${task.id}:`, err.message);
      }
    }
  }, 60000); // Check every minute

  console.log("[BgTasks] Scheduler running (checks every 60s)");
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}
