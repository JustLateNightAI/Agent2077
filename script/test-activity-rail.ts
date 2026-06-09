/**
 * v16.74.15 chat activity-rail smoke test.
 *
 * The ActivityRail UI maps the backend's human-readable `status` strings
 * (emitted by agent-loop.ts sendStatus()) into coarse phases so the rail can
 * pick an icon/color without any backend changes. This test pins that mapping
 * against the exact status strings the agent loop emits, so a future wording
 * change that would silently mis-categorise activity gets caught.
 *
 * Run with: npx tsx script/test-activity-rail.ts
 */
import { classify } from "../client/src/components/ActivityRail.js";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${label}${detail ? " — " + detail : ""}`);
  if (!ok) { failures++; process.exitCode = 1; }
}

// ── Real status strings emitted by server/lib/agent-loop.ts ──────────────────
check("Thinking… → thinking", classify("Thinking...") === "thinking");
check("Starting work → starting", classify("Starting work...") === "starting");
check("Continuing → starting", classify("Continuing...") === "starting");
check("describeToolCall web_search → searching",
  classify('Searching the web: "local AI"') === "searching");
check("describeToolCall fetch_url → browsing",
  classify("Fetching URL: example.com") === "browsing");
check("Writing file → tool", classify("Writing file: app.tsx") === "tool");
check("Reading file → tool", classify("Reading file: index.ts") === "tool");
check("Running code → tool", classify("Running code in sandbox") === "tool");
check("Using <unknown tool> → tool", classify("Using custom_tool") === "tool");
check("Fixing error → repair", classify("Fixing error...") === "repair");
check("Switching approach → retry", classify("Switching approach...") === "retry");
check("LLM error retrying → retry", classify("LLM error — retrying...") === "retry");
check("Context too large → context", classify("Context too large — compressing...") === "context");
check("Balance floor → paused",
  classify("OpenRouter balance floor reached ($1 < $5 limit)") === "paused");
check("Balance empty → paused", classify("OpenRouter balance empty") === "paused");
check("Stopped → paused", classify("Stopped") === "paused");
check("Repetition → error", classify("Repetition detected — response cut off") === "error");
check("Giving up → error", classify("LLM error — giving up") === "error");

// ── Phase keywords that may arrive from routing / plan / research events ─────
check("Planning → planning", classify("Planning the work") === "planning");
check("Routing → routing", classify("Routing to coding model") === "routing");
check("Research → research", classify("Deep research started") === "research");

// ── Defensive defaults ───────────────────────────────────────────────────────
check("empty → thinking (no crash)", classify("") === "thinking");
check("gibberish → thinking", classify("zxcvbnm") === "thinking");

console.log(failures === 0 ? "\nAll activity-rail tests passed." : `\n${failures} test(s) failed.`);
