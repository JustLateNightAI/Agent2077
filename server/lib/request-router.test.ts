// Run with: npx tsx server/lib/request-router.test.ts
// Excluded from the build and from tsconfig (**/*.test.ts), so it adds no
// runtime/typecheck weight. Covers the v16.75 casual-chat tool-choice gate that
// fixes "agent uses tools when I'm just chatting / starting a new chat".

import assert from "node:assert/strict";
import {
  isCasualChat,
  hasActionableSignal,
  decideToolChoice,
  routeRequest,
} from "./request-router.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

// ── Casual chat / new-chat openers → no tools ──────────────────────────────
const CASUAL: string[] = [
  "hi",
  "hey there",
  "hello!",
  "sup nerd",       // v16.75.1: slang greeting from the bug report
  "sup",
  "yo nerd",
  "sup dude",
  "hey nerd lol",
  "good morning",
  "thanks",
  "thank you so much",
  "ok cool",
  "lol that's wild",
  "how's it going?",
  "how are you doing today",
  "what's up",
  "who are you?",
  "what can you do?",
  "tell me about yourself",
  "just wanted to say hi",
  "nice to meet you",
  "yeah", // single-word ack
  "what do you think?", // short, no action cue
  "", // brand-new empty chat
];

for (const msg of CASUAL) {
  test(`casual → tool_choice none: ${JSON.stringify(msg)}`, () => {
    assert.equal(isCasualChat(msg), true, "should be casual");
    assert.equal(hasActionableSignal(msg), false, "should have no actionable signal");
    assert.equal(decideToolChoice(msg), "none", "should disable tools");
  });
}

// ── Actionable requests → tools stay enabled ───────────────────────────────
const ACTIONABLE: string[] = [
  "create a snake game",
  "read the file server/index.ts",
  "fix the bug in agent-loop.ts",
  "search the web for the latest react version",
  "run npm install",
  "deploy my app",
  "what does the routeRequest function do?",
  "edit the config and add a new field",
  "look up the weather in Tokyo",
  "build me a dashboard for sales data",
  "can you find where selectTools is defined",
  "fetch https://example.com",
  "show me the contents of package.json",
  "implement a binary search function",
  "commit and push my changes",
];

for (const msg of ACTIONABLE) {
  test(`actionable → tool_choice auto: ${JSON.stringify(msg)}`, () => {
    assert.equal(isCasualChat(msg), false, "should NOT be casual");
    assert.equal(decideToolChoice(msg), "auto", "should allow tools");
  });
}

// ── Context overrides: project mode + deep research keep tools on ──────────
test("project mode keeps tools even for a bare greeting", () => {
  const choice = decideToolChoice("hi", {
    customPrompt: "PROJECT CONTEXT: some project override",
  });
  assert.equal(choice, "auto");
});

test("deep research toggle keeps tools even for small talk", () => {
  const choice = decideToolChoice("hey", { deepResearch: true });
  assert.equal(choice, "auto");
});

// ── Router still classifies casual turns as respond (defense in depth) ─────
test("router routes a plain greeting to respond", () => {
  const d = routeRequest("hi");
  assert.equal(d.route, "respond");
});

test("router routes an explicit code task away from respond", () => {
  const d = routeRequest("fix the bug in the parser function");
  assert.notEqual(d.route, "respond");
});

// ── Edge: a longer small-talk sentence WITH a casual marker is casual ──────
test("longer sentence with a 'how's it going' marker is casual", () => {
  const msg = "anyway it was good to chat, how's it going on your end today";
  assert.equal(isCasualChat(msg), true);
  assert.equal(decideToolChoice(msg), "none");
});

// ── Edge (conservative default): a long sentence with neither an action cue
// nor a casual marker stays "auto". We only suppress tools when confident the
// turn is small talk; ambiguous longer messages keep tools enabled so we never
// hide a tool the user actually needed.
test("ambiguous long sentence (no action, no casual marker) keeps tools auto", () => {
  const msg = "anyway that was a really funny story you told earlier";
  assert.equal(isCasualChat(msg), false);
  assert.equal(decideToolChoice(msg), "auto");
});

// ── Edge: action verb inside otherwise-chatty text disables casual ─────────
test("chatty wrapper around a real request is NOT casual", () => {
  const msg = "hey so anyway can you create a new file for me";
  assert.equal(isCasualChat(msg), false);
  assert.equal(decideToolChoice(msg), "auto");
});

console.log(`\n${passed} passed`);
