/**
 * Workspace "Clear chat" smoke tests (v16.74.9):
 *  - messageStore.clearForConversation removes all messages for a project's
 *    conversation but PRESERVES the conversation record + its systemPrompt
 *    (project mode custom prompt/context) and the owning project.
 *  - Transient task plans / subtasks tied to the conversation are dropped.
 *  - Messages in OTHER conversations are untouched.
 *
 * Run with: npx tsx script/test-clear-chat.ts
 */
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Point the DB at a throwaway file BEFORE importing anything that opens it.
process.env.AGENT2077_DB_PATH = join(mkdtempSync(join(tmpdir(), "a2077-clear-")), "test.db");

const { bootstrapSchema, initFTS, runMigrations, initNewTables } = await import("../server/db.js");
bootstrapSchema();
initFTS();
runMigrations();
initNewTables();

const { conversationStore, messageStore, projectStore, taskPlanStore, subtaskStore } =
  await import("../server/storage.js");

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${label}${detail ? " — " + detail : ""}`);
  if (!ok) { failures++; process.exitCode = 1; }
}

// ── Setup: a project with its own conversation + messages + a task plan ─────
const PROJECT_PROMPT = "You are working inside the project \"Demo\" (projectId: 1). Keep this context.";
const conv = conversationStore.create({ title: "Demo project", systemPrompt: PROJECT_PROMPT });
const project = projectStore.create({
  name: "Demo", path: "/tmp/demo", conversationId: conv.id,
});

messageStore.create({ conversationId: conv.id, role: "user", content: "hello" });
messageStore.create({ conversationId: conv.id, role: "assistant", content: "hi there" });
messageStore.create({ conversationId: conv.id, role: "user", content: "do a thing" });

const plan = taskPlanStore.create({
  conversationId: conv.id, originalRequest: "do a thing", planJson: "[]", status: "running",
});
subtaskStore.create({
  planId: plan.id, title: "step", description: "d", taskType: "code_write", orderIndex: 0,
});

// ── A SECOND, unrelated conversation that must NOT be touched ───────────────
const other = conversationStore.create({ title: "Main chat", systemPrompt: "main" });
messageStore.create({ conversationId: other.id, role: "user", content: "unrelated" });

check("setup: project conversation has 3 messages",
  messageStore.getByConversation(conv.id).length === 3);
check("setup: task plan exists",
  taskPlanStore.getByConversation(conv.id).length === 1);

// ── Act: clear the project's chat ───────────────────────────────────────────
messageStore.clearForConversation(conv.id);

// ── Assert ──────────────────────────────────────────────────────────────────
check("clear: project messages all removed",
  messageStore.getByConversation(conv.id).length === 0,
  `got ${messageStore.getByConversation(conv.id).length}`);

const convAfter = conversationStore.getById(conv.id);
check("clear: conversation record preserved", !!convAfter);
check("clear: systemPrompt (project context) preserved",
  convAfter?.systemPrompt === PROJECT_PROMPT, `got ${convAfter?.systemPrompt}`);

const projAfter = projectStore.getById(project.id);
check("clear: project still active & linked to same conversation",
  projAfter?.status === "active" && projAfter?.conversationId === conv.id);

check("clear: transient task plans dropped",
  taskPlanStore.getByConversation(conv.id).length === 0);
check("clear: subtasks dropped",
  subtaskStore.getByPlan(plan.id).length === 0);

check("clear: unrelated conversation messages untouched",
  messageStore.getByConversation(other.id).length === 1);

// ── New messages can be sent in the same project context afterwards ─────────
messageStore.create({ conversationId: conv.id, role: "user", content: "fresh start" });
check("post-clear: can add new messages to same conversation",
  messageStore.getByConversation(conv.id).length === 1);

if (failures > 0) {
  console.error(`\n${failures} TEST(S) FAILED`);
  process.exit(1);
}
console.log("\nAll Clear chat smoke tests passed.");
