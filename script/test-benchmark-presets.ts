/**
 * Benchmark preset seeding smoke tests:
 *  - preset module structure (every prompt has prompt+category; difficulty/requires valid)
 *  - all required general categories are represented
 *  - seedPresets() inserts all presets on a fresh DB
 *  - seedPresets() is idempotent (re-run inserts 0, no duplicates)
 *  - user-created suites and user-edited presets are never overwritten or deleted
 *
 * Runs against an isolated temp DB via AGENT2077_DB_PATH so the dev DB is
 * untouched. Run with: npx tsx script/test-benchmark-presets.ts
 */
import fs from "fs";
import os from "os";
import path from "path";

// Point the storage layer at a throwaway DB BEFORE importing it.
const tmpDb = path.join(os.tmpdir(), `a2077-bench-test-${Date.now()}.db`);
process.env.AGENT2077_DB_PATH = tmpDb;

const { bootstrapSchema } = await import("../server/db.js");
const { benchmarkStore } = await import("../server/storage.js");
const { PRESET_SUITES, totalPresetPrompts, PRESET_PREFIX } = await import("../server/lib/benchmark-presets.js");

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

try {
  // ── Structure validation (pure, no DB) ──────────────────────────────
  const validDifficulty = new Set(["easy", "medium", "hard", undefined]);
  const validRequires = new Set(["tools", "internet"]);
  let structOk = true;
  for (const suite of PRESET_SUITES) {
    if (!suite.name.startsWith(PRESET_PREFIX)) structOk = false;
    if (!suite.description || suite.prompts.length === 0) structOk = false;
    for (const p of suite.prompts) {
      if (!p.prompt || !p.category) structOk = false;
      if (!validDifficulty.has(p.difficulty)) structOk = false;
      if (p.requires && p.requires.some(r => !validRequires.has(r))) structOk = false;
    }
  }
  check("every preset prompt has prompt+category and valid difficulty/requires", structOk);

  check("at least 8 preset suites defined", PRESET_SUITES.length >= 8,
    `${PRESET_SUITES.length} suites`);

  // Required general capability areas (matched against suite names, case-insensitive)
  const names = PRESET_SUITES.map(s => s.name.toLowerCase());
  const requiredAreas = ["chat", "reasoning", "coding", "terminal", "tool", "research", "summar", "safety"];
  const missing = requiredAreas.filter(a => !names.some(n => n.includes(a)));
  check("covers chat/reasoning/coding/terminal/tool/research/summarization/safety", missing.length === 0,
    missing.length ? `missing: ${missing.join(", ")}` : `${totalPresetPrompts()} prompts total`);

  // ── Seeding behavior (DB) ───────────────────────────────────────────
  bootstrapSchema();

  const firstInsert = benchmarkStore.seedPresets(PRESET_SUITES as any);
  check("first seed inserts all preset suites", firstInsert === PRESET_SUITES.length,
    `${firstInsert}/${PRESET_SUITES.length}`);
  check("suite count equals preset count after first seed",
    benchmarkStore.getAllSuites().length === PRESET_SUITES.length);

  const secondInsert = benchmarkStore.seedPresets(PRESET_SUITES as any);
  check("re-seed is idempotent (inserts 0)", secondInsert === 0, `inserted ${secondInsert}`);
  check("no duplicate suites after re-seed",
    benchmarkStore.getAllSuites().length === PRESET_SUITES.length);

  // ── Non-destructive guarantees ──────────────────────────────────────
  const userSuite = benchmarkStore.createSuite({
    name: "My Custom Suite",
    description: "user made",
    prompts: JSON.stringify([{ prompt: "hi", category: "general" }]),
  } as any);

  // Simulate a user editing a preset's prompts in place.
  const presetName = PRESET_SUITES[0].name;
  const presetRow = benchmarkStore.getAllSuites().find(s => s.name === presetName)!;
  const { getDb } = await import("../server/db.js");
  getDb().prepare("UPDATE benchmark_suites SET prompts = ? WHERE id = ?")
    .run(JSON.stringify([{ prompt: "user-edited", category: "custom" }]), presetRow.id);

  const thirdInsert = benchmarkStore.seedPresets(PRESET_SUITES as any);
  check("re-seed after user changes inserts 0", thirdInsert === 0, `inserted ${thirdInsert}`);

  const after = benchmarkStore.getAllSuites();
  check("user-created suite still present", after.some(s => s.id === userSuite.id));
  const editedAfter = after.find(s => s.id === presetRow.id)!;
  check("user-edited preset prompts NOT overwritten",
    JSON.parse(editedAfter.prompts)[0].prompt === "user-edited");
  check("total suite count unchanged (presets + 1 user suite)",
    after.length === PRESET_SUITES.length + 1, `${after.length} suites`);

} finally {
  cleanup();
}

console.log(failures === 0 ? "\nAll benchmark-preset tests passed." : `\n${failures} test(s) failed.`);
