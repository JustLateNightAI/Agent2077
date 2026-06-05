/**
 * Benchmark run-completion smoke tests:
 *  - a run is created with status "running"
 *  - updateRun() flips it to a terminal "completed" state with results persisted
 *  - getRunsBySuite() reflects the terminal status + results after completion
 *  - a failed run is recorded as "failed"
 *  - the "any run still active" predicate used by the UI poller stops once all
 *    runs are terminal (mirrors the refetchInterval logic in benchmark.tsx)
 *
 * This guards the fix for: a finished benchmark not showing as done/with results
 * until another run is started. The backend always reaches a terminal status;
 * the UI now polls until that predicate goes false.
 *
 * Runs against an isolated temp DB via AGENT2077_DB_PATH. Run with:
 *   npx tsx script/test-benchmark-completion.ts
 */
import fs from "fs";
import os from "os";
import path from "path";

const tmpDb = path.join(os.tmpdir(), `a2077-bench-completion-${Date.now()}.db`);
process.env.AGENT2077_DB_PATH = tmpDb;

const { bootstrapSchema } = await import("../server/db.js");
const { benchmarkStore } = await import("../server/storage.js");

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${label}${detail ? " — " + detail : ""}`);
  if (!ok) { failures++; process.exitCode = 1; }
}

function cleanup() {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(tmpDb + ext); } catch {}
  }
}

// Mirror of the predicate the UI poller uses to decide whether to keep polling.
const TERMINAL = new Set(["completed", "failed"]);
const hasActive = (runs: { status: string }[]) =>
  runs.some(r => !TERMINAL.has(r.status));

try {
  bootstrapSchema();

  const suite = benchmarkStore.createSuite({
    name: "Completion Test Suite",
    description: "transition test",
    prompts: JSON.stringify([{ prompt: "hi", category: "general" }]),
  } as any);

  // ── A run starts as "running" ───────────────────────────────────────
  const run = benchmarkStore.createRun({
    suiteId: suite.id,
    modelId: "test/model",
    endpointId: 1,
    status: "running",
  } as any);
  check("new run starts in 'running' status", run.status === "running");

  let runs = benchmarkStore.getRunsBySuite(suite.id);
  check("poller would keep polling while a run is running", hasActive(runs) === true);

  // ── Completion flips status + persists results ──────────────────────
  const results = [{ promptIndex: 0, response: "hello", durationMs: 123, rating: null }];
  benchmarkStore.updateRun(run.id, {
    status: "completed",
    results: JSON.stringify(results),
    totalTokens: 42,
    totalDurationMs: 123,
    completedAt: new Date().toISOString(),
  } as any);

  runs = benchmarkStore.getRunsBySuite(suite.id);
  const done = runs.find(r => r.id === run.id)!;
  check("run reaches terminal 'completed' status", done.status === "completed");
  check("results are persisted on completion", !!done.results && JSON.parse(done.results).length === 1);
  check("totals persisted on completion", done.totalTokens === 42 && done.totalDurationMs === 123);
  check("completedAt persisted", !!done.completedAt);
  check("poller stops once all runs are terminal", hasActive(runs) === false);

  // ── A failed run is recorded as terminal "failed" ───────────────────
  const failRun = benchmarkStore.createRun({
    suiteId: suite.id,
    modelId: "test/model",
    endpointId: 1,
    status: "running",
  } as any);
  check("poller resumes while the new run is running", hasActive(benchmarkStore.getRunsBySuite(suite.id)) === true);

  benchmarkStore.updateRun(failRun.id, { status: "failed" } as any);
  runs = benchmarkStore.getRunsBySuite(suite.id);
  check("failed run reaches terminal 'failed' status",
    runs.find(r => r.id === failRun.id)!.status === "failed");
  check("poller stops again once all runs terminal", hasActive(runs) === false);

} finally {
  cleanup();
}

console.log(failures === 0 ? "\nAll benchmark-completion tests passed." : `\n${failures} test(s) failed.`);
