// Run with: npx tsx server/lib/llm-client.tool-attach.test.ts
// Excluded from the build and from tsconfig (**/*.test.ts).
//
// Covers v16.75.1: when a casual/non-actionable turn resolves to toolChoice
// "none", the tools array MUST be omitted from the request body entirely — not
// merely sent with tool_choice:"none". Local OpenAI-compatible servers (vLLM,
// llama.cpp, DeepSeek shims) ignore tool_choice:"none" and fire tools anyway,
// which is the "agent runs memory_recall/session_search on 'sup nerd'" bug.

import assert from "node:assert/strict";
import { resolveToolAttachment, type ToolDefinition } from "./llm-client.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

const tool = (name: string): ToolDefinition => ({
  type: "function",
  function: { name, description: `${name} tool`, parameters: {} },
});

const TOOLS: ToolDefinition[] = [
  tool("memory_recall"),
  tool("session_search"),
  tool("read_file"),
];

// ── The core bug: toolChoice "none" must omit tools entirely ────────────────
test("toolChoice 'none' omits tools array entirely (no tool_choice either)", () => {
  const r = resolveToolAttachment(TOOLS, true, "deepseek-v4-flash", "none");
  assert.equal(r.tools, undefined, "tools must NOT be attached on a casual turn");
  assert.equal(r.tool_choice, undefined, "tool_choice must NOT be sent when tools are omitted");
});

test("casual greeting on a local DeepSeek model attaches zero tools", () => {
  // Simulates exactly the screenshot path: 'sup nerd' → decideToolChoice 'none'.
  const r = resolveToolAttachment(TOOLS, true, "deepseek-v4-flash", "none");
  assert.equal(r.tools, undefined);
});

// ── Actionable turns still get tools ────────────────────────────────────────
test("toolChoice 'auto' attaches all tools with tool_choice auto", () => {
  const r = resolveToolAttachment(TOOLS, true, "deepseek-v4-flash", "auto");
  assert.deepEqual(r.tools, TOOLS);
  assert.equal(r.tool_choice, "auto");
});

test("undefined toolChoice defaults to auto with tools attached", () => {
  const r = resolveToolAttachment(TOOLS, true, "gpt-5", undefined);
  assert.deepEqual(r.tools, TOOLS);
  assert.equal(r.tool_choice, "auto");
});

test("toolChoice 'required' attaches tools and forces a call", () => {
  const r = resolveToolAttachment(TOOLS, true, "gpt-5", "required");
  assert.deepEqual(r.tools, TOOLS);
  assert.equal(r.tool_choice, "required");
});

// ── Guards unchanged ────────────────────────────────────────────────────────
test("no tools provided → empty result regardless of choice", () => {
  assert.deepEqual(resolveToolAttachment([], true, "x", "auto"), {});
  assert.deepEqual(resolveToolAttachment(undefined, true, "x", "auto"), {});
});

test("model without tool calling support → no tools attached", () => {
  assert.deepEqual(resolveToolAttachment(TOOLS, false, "x", "auto"), {});
});

test("MiniMax cap still trims to 18 on auto (not affected by none-suppression)", () => {
  const many = Array.from({ length: 25 }, (_, i) => tool(`t${i}`));
  const r = resolveToolAttachment(many, true, "minimax-m2", "auto");
  assert.equal(r.tools?.length, 18);
  // And on a casual turn even MiniMax sends nothing.
  assert.equal(resolveToolAttachment(many, true, "minimax-m2", "none").tools, undefined);
});

console.log(`\n${passed} passed`);
