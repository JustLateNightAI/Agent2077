// Run with: npx tsx client/src/lib/new-chat.test.ts
// Excluded from the build and from tsconfig (**/*.test.ts), so it adds no
// runtime/typecheck weight. Covers the no-selected-chat decision and the reset
// signal that fixes the dead "+" button.

import assert from "node:assert/strict";
import { planNewChat, emitNewChat, NEW_CHAT_EVENT } from "./new-chat.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

// planNewChat: always resets; only navigates when not already on chat root.
test("no chat selected (root '/'): resets without redundant navigation", () => {
  const plan = planNewChat("/");
  assert.equal(plan.resetState, true);
  assert.equal(plan.navigateHome, false);
});

test("empty location ('') treated as chat root: reset, no navigation", () => {
  const plan = planNewChat("");
  assert.equal(plan.resetState, true);
  assert.equal(plan.navigateHome, false);
});

test("chat selected ('/chat/123'): resets and navigates home", () => {
  const plan = planNewChat("/chat/123");
  assert.equal(plan.resetState, true);
  assert.equal(plan.navigateHome, true);
});

test("invalid/unmatched route ('/chat/abc'): resets and navigates home", () => {
  const plan = planNewChat("/chat/abc");
  assert.equal(plan.resetState, true);
  assert.equal(plan.navigateHome, true);
});

test("other tab route ('/settings'): resets and navigates home", () => {
  const plan = planNewChat("/settings");
  assert.equal(plan.resetState, true);
  assert.equal(plan.navigateHome, true);
});

// emitNewChat: dispatches the reset signal ChatPage listens for, even when the
// route doesn't change (the core of the fix).
test("emitNewChat dispatches NEW_CHAT_EVENT on window", () => {
  const listeners: Array<() => void> = [];
  (globalThis as any).window = {
    dispatchEvent: (ev: { type: string }) => {
      assert.equal(ev.type, NEW_CHAT_EVENT);
      listeners.forEach(l => l());
      return true;
    },
  };
  (globalThis as any).CustomEvent = class {
    type: string;
    constructor(type: string) { this.type = type; }
  };

  let fired = 0;
  listeners.push(() => { fired++; });
  emitNewChat();
  assert.equal(fired, 1);

  delete (globalThis as any).window;
  delete (globalThis as any).CustomEvent;
});

test("emitNewChat is a no-op when window is undefined (SSR-safe)", () => {
  assert.equal(typeof (globalThis as any).window, "undefined");
  assert.doesNotThrow(() => emitNewChat());
});

console.log(`\n${passed} passed`);
