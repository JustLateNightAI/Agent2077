/**
 * Smoke test for the mid-run nudge queue on AgentStream.
 *
 * Verifies the inject/consume contract that powers the "Add context" / nudge
 * feature in main chat, workspace chat, and self-dev:
 *   - a queued message is consumed exactly once at the next iteration boundary
 *   - consuming clears the queue (so it is not re-injected forever)
 *   - the registry returns the active stream by conversation id and reports
 *     done state correctly after end()
 *
 * Run with: npx tsx scripts/test-nudge-queue.ts
 */
import {
  getOrCreateStream,
  getStream,
  hasActiveStream,
} from "../server/lib/agent-stream.js";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ok   - ${msg}`);
  } else {
    failures++;
    console.error(`  FAIL - ${msg}`);
  }
}

const convId = 999001;
const stream = getOrCreateStream(convId, "req-test");

assert(getStream(convId) === stream, "getStream returns the created stream");
assert(hasActiveStream(convId), "hasActiveStream true while running");

// No pending message initially.
assert(stream.hasPendingMessage === false, "no pending message at start");
assert(stream.consumePendingMessage() === null, "consume returns null when empty");

// Inject a nudge and consume it once.
stream.injectUserMessage("use the project tools");
assert(stream.hasPendingMessage === true, "hasPendingMessage true after inject");
const first = stream.consumePendingMessage();
assert(first === "use the project tools", "consume returns the injected message");
assert(stream.hasPendingMessage === false, "queue cleared after consume");
assert(stream.consumePendingMessage() === null, "second consume returns null (no re-inject)");

// Last-write-wins: a newer nudge replaces an unconsumed one.
stream.injectUserMessage("first");
stream.injectUserMessage("second");
assert(stream.consumePendingMessage() === "second", "latest inject wins before consume");

// After end(), the stream reports done — routes use this to 404 a stale nudge.
stream.end();
assert(stream.done === true, "stream done after end()");
assert(hasActiveStream(convId) === false, "hasActiveStream false after end()");

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll nudge-queue assertions passed");
