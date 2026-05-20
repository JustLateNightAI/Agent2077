/**
 * Sub-Agent Executor — Parallel subtask execution engine for Agent2077
 *
 * Manages concurrent execution of subtasks across multiple LLM endpoints,
 * respecting per-endpoint parallelSlots limits via a slot-based semaphore.
 *
 * Key capabilities:
 * 1. DAG-aware scheduling: resolves dependsOn arrays before dispatching
 * 2. SlotManager: per-endpoint semaphore that queues when slots are full
 * 3. Simplified per-subtask agent loop: LLM + tool calling, no SSE streaming
 * 4. SSE progress events: subtask_progress updates streamed to the client
 * 5. Structured result manifest: sub-agents write JSON result to disk, parent reads it
 * 6. Change manifest: git diff snapshot before/after each subtask to know exactly what changed
 * 7. Post-subtask verification: parent verifies claimed file outputs actually exist on disk
 * 8. Rich briefing injection: parent context, expected outputs, conventions in system prompt
 * 9. Self-report template: sub-agents produce a structured completion report
 */

import { v4 as uuid } from "uuid";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execSync } from "child_process";
import type { Response } from "express";
import type { Endpoint, Model, TaskType } from "../../shared/schema.js";
import { subtaskStore, taskPlanStore, endpointStore, modelStore, messageStore, settingsStore } from "../storage.js";
import { chatCompletion, cancelRequest, type ChatMessage } from "./llm-client.js";
import { executeTool, getToolDefinitions, getToolDescriptionsText, getAllTools, type ToolContext } from "../tools/registry.js";
import { selectTools, readSmartSelectionSetting } from "./tool-selector.js";

// ── Sub-agent abort registry ─────────────────────────────────────────────────
// Maps parent requestId → Set of child requestIds currently running under it.
// When the parent is stopped, cancelChildRequests(parentRequestId) aborts all children.
const parentChildRegistry = new Map<string, Set<string>>();

export function registerChildRequest(parentRequestId: string, childRequestId: string): void {
  if (!parentChildRegistry.has(parentRequestId)) {
    parentChildRegistry.set(parentRequestId, new Set());
  }
  parentChildRegistry.get(parentRequestId)!.add(childRequestId);
}

export function unregisterChildRequest(parentRequestId: string, childRequestId: string): void {
  parentChildRegistry.get(parentRequestId)?.delete(childRequestId);
}

export function cancelChildRequests(parentRequestId: string): void {
  const children = parentChildRegistry.get(parentRequestId);
  if (!children || children.size === 0) return;
  console.log(`[SubAgentExecutor] Cancelling ${children.size} child request(s) for parent ${parentRequestId}`);
  for (const childId of children) {
    cancelRequest(childId);
  }
  parentChildRegistry.delete(parentRequestId);
}

const MAX_DELEGATION_DEPTH = 2;
// Tools that subtasks must never call.
// Safe self-dev tools (selfdev_read_file, selfdev_list_files, selfdev_diff,
// selfdev_search_files) are intentionally NOT blocked — subtasks can use them
// for parallel file reads. Write/build/server tools ARE blocked to prevent
// concurrent modification conflicts and shared-state corruption.
const SUBAGENT_BLOCKED_TOOLS = new Set([
  // Delegation (prevent infinite recursion)
  'delegate_task',
  'create_subtask_plan',
  'spawn_subtasks',           // No nested spawn — depth limit handles this but belt+suspenders

  // Memory / profile (should only be modified by the main agent)
  'memory_update',
  'user_profile_update',

  // Self-dev: state-mutating tools (would conflict with the main loop)
  'selfdev_init',             // Would create a new dev session, clobbering the current one
  'selfdev_build',            // Builds affect shared dist/ — must stay sequential
  'selfdev_run_tests',        // Test runner affects shared state
  'selfdev_start_server',     // Shared dev server port
  'selfdev_stop_server',
  'selfdev_package',          // Packages the whole workspace — main loop only
  'selfdev_reset',            // Resets entire workspace
  'selfdev_reset_all',
  'selfdev_reset_file',       // File resets: main loop only to avoid races
  // selfdev_write_file — create brand-new files: always allowed (rejects existing paths)
  // selfdev_edit_file, selfdev_write_lines, selfdev_rewrite_file — writes to existing files:
  // now allowed for sub-agents. Per-file async-lock in dev-workspace.ts serialises concurrent
  // access so two sub-agents editing different files proceed in parallel while two editing
  // the SAME file queue safely.
  'selfdev_git_checkpoint',   // Git ops: main loop only
  'selfdev_git_rollback',
  'selfdev_save_session_summary',
  'selfdev_sync_stable',
  'selfdev_run_command',      // Shell access — main loop only, subtasks must not run commands

  // General filesystem/execution tools — subtasks are READ-ONLY, these all allow writes
  'shell_command',            // Bypasses selfdev write restrictions via raw shell
  'execute_code',             // Can write files via Python/JS scripts
  'run_command',              // Alias patterns
  'write_file',               // General workspace write
  'edit_file',                // General workspace edit
  'run_project_command',      // Project-level shell access
  'deploy_app',               // Deployment — never in subtasks
]);
import { selectSubAgentModel, ensureModelLoaded } from "./orchestrator.js";

// ── Types ────────────────────────────────────────────────────────────────────

// ── Subtask result manifest ───────────────────────────────────────────────────
// Written to disk by the sub-agent itself (via a special tool) and read back
// by the parent after the subtask completes. This is the ground-truth record
// of what the sub-agent actually did, not just what it said in its final message.

export interface SubtaskResultManifest {
  taskId: string;          // matches the subtask DB id as string
  title: string;
  status: "completed" | "failed" | "partial";
  summary: string;         // what was actually done
  filesCreated: string[];  // new files written to disk
  filesRead: string[];     // files inspected
  toolsUsed: string[];     // tool call log
  errors: string[];        // any errors encountered
  verificationNotes: string; // how the agent verified its own work
  rawOutput: string;       // the full final text output
}

// Directory for inter-agent communication files
const AGENT_COMMS_DIR = path.join(process.env.HOME ?? "/root", "agent2077-dev", ".agent-comms");

/**
 * Ensure the agent comms directory exists.
 */
function ensureCommsDir(): void {
  try { fs.mkdirSync(AGENT_COMMS_DIR, { recursive: true }); } catch { /* already exists */ }
}

/**
 * Write a subtask result manifest to disk.
 * Called by post-processing in runSubtask once the sub-agent finishes.
 */
function writeResultManifest(dbId: number, manifest: SubtaskResultManifest): void {
  ensureCommsDir();
  const filePath = path.join(AGENT_COMMS_DIR, `subtask-${dbId}-result.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2), "utf-8");
  } catch (err: any) {
    console.warn(`[SubAgentExecutor] Failed to write result manifest for subtask ${dbId}:`, err.message);
  }
}

/**
 * Read a subtask result manifest from disk.
 * Returns null if not found (sub-agent didn't write one).
 */
export function readResultManifest(dbId: number): SubtaskResultManifest | null {
  const filePath = path.join(AGENT_COMMS_DIR, `subtask-${dbId}-result.json`);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as SubtaskResultManifest;
  } catch {
    return null;
  }
}

/**
 * Clean up result manifests for completed plan (call after parent has read them).
 */
export function cleanResultManifests(subtaskIds: number[]): void {
  for (const id of subtaskIds) {
    const filePath = path.join(AGENT_COMMS_DIR, `subtask-${id}-result.json`);
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
  }
}

// ── Change manifest: git diff snapshot ───────────────────────────────────────

interface FileSnapshot {
  path: string;
  hash: string;
}

/**
 * Snapshot all tracked files in a git repo directory.
 * Returns a map of relative path → SHA256 hash of content.
 * Falls back gracefully if git is not available.
 */
function snapshotGitFiles(repoDir: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  try {
    // Use git ls-files to get the tracked file list, which is fast
    const output = execSync("git ls-files", { cwd: repoDir, encoding: "utf-8", timeout: 5000 });
    const files = output.trim().split("\n").filter(Boolean);
    for (const relPath of files) {
      const absPath = path.join(repoDir, relPath);
      try {
        const content = fs.readFileSync(absPath);
        const hash = crypto.createHash("sha256").update(content).digest("hex");
        snapshot.set(relPath, hash);
      } catch { /* file disappeared between listing and reading */ }
    }
  } catch {
    // git not available or not a git repo — skip silently
  }
  return snapshot;
}

/**
 * Diff two snapshots and return which files were added, modified, or deleted.
 */
function diffSnapshots(
  before: Map<string, string>,
  after: Map<string, string>
): { added: string[]; modified: string[]; deleted: string[] } {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const [relPath, afterHash] of after) {
    if (!before.has(relPath)) {
      added.push(relPath);
    } else if (before.get(relPath) !== afterHash) {
      modified.push(relPath);
    }
  }
  for (const relPath of before.keys()) {
    if (!after.has(relPath)) deleted.push(relPath);
  }

  return { added, modified, deleted };
}

// ── Verification helper ───────────────────────────────────────────────────────

interface VerificationResult {
  passed: boolean;
  notes: string[];
  changeManifest: { added: string[]; modified: string[]; deleted: string[] } | null;
}

// ── Execution-based verification helpers ─────────────────────────────────────

const SYNTAX_CHECK_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);

/**
 * Run tsc --noEmit on a file to check for syntax/type errors.
 * Returns null if clean, or an error string with the relevant lines.
 */
function runSyntaxCheck(devDir: string, absPath: string): string | null {
  const ext = path.extname(absPath).toLowerCase();
  if (!SYNTAX_CHECK_EXTENSIONS.has(ext)) return null;
  try {
    const { execSync: exec } = require("child_process") as typeof import("child_process");
    const { resolveBin, resolveNodeEnv } = require("./node-env.js") as any;
    const tscBin = resolveBin("tsc");
    exec(
      `${tscBin} --noEmit --allowJs --skipLibCheck --target ES2020 --moduleResolution node "${absPath}" 2>&1 || true`,
      { cwd: devDir, timeout: 30000, encoding: "utf-8", env: resolveNodeEnv() }
    );
    return null; // exit 0 = clean
  } catch (err: any) {
    const output = `${err.stdout || ""}\n${err.stderr || ""}`.trim();
    const relevant = output.split("\n")
      .filter((l: string) => l.match(/error TS\d+/) || l.includes(absPath))
      .slice(0, 8)
      .join("\n");
    return relevant || output.slice(0, 400);
  }
}

/**
 * Check that all required exports exist in a file using fast regex.
 * Each entry in requiredExports is a string that must appear in the file content.
 * Returns array of missing export strings.
 */
function checkRequiredExports(absPath: string, requiredExports: string[]): string[] {
  let content = "";
  try { content = fs.readFileSync(absPath, "utf-8"); } catch { return requiredExports; }
  return requiredExports.filter(exp => !content.includes(exp));
}

/**
 * Check that a file meets a minimum byte size — catches empty/stub writes.
 */
function checkMinBytes(absPath: string, minBytes: number): number {
  try { return fs.statSync(absPath).size; } catch { return 0; }
}

/**
 * Check that required data patterns appear in the sub-agent's output text.
 * Returns array of { label, pattern } for patterns that did NOT match.
 */
function checkDataPatterns(
  outputText: string,
  patterns: NonNullable<ResultSpec["dataPatterns"]>
): Array<{ label: string; pattern: string; required: boolean }> {
  const failures: Array<{ label: string; pattern: string; required: boolean }> = [];
  for (const p of patterns) {
    try {
      const re = new RegExp(p.pattern, "s");
      if (!re.test(outputText)) {
        failures.push({ label: p.label, pattern: p.pattern, required: p.required !== false });
      }
    } catch {
      // Regex compile error — skip this check rather than crash
    }
  }
  return failures;
}

/**
 * Verify a subtask's claimed outputs against disk reality.
 * Layered checks (each builds on the previous):
 *   1. Git snapshot diff — ground truth of what changed on disk
 *   2. Manifest file existence — did claimed files actually get written?
 *   3. resultSpec file checks — size, required exports, tsc syntax (EXECUTION verification)
 *   4. resultSpec data patterns — did the output text contain expected data?
 *   5. Sub-agent self-reported errors
 */
function verifySubtaskOutputs(
  manifest: SubtaskResultManifest | null,
  beforeSnapshot: Map<string, string>,
  afterSnapshot: Map<string, string>,
  devDir: string | null,
  spec?: SubtaskSpec,
  rawOutput?: string
): VerificationResult {
  const notes: string[] = [];
  let passed = true;

  // ── Layer 1: Disk change manifest (git snapshot diff) ──────────────────
  const changeManifest = devDir
    ? diffSnapshots(beforeSnapshot, afterSnapshot)
    : null;

  if (changeManifest) {
    const totalChanges = changeManifest.added.length + changeManifest.modified.length + changeManifest.deleted.length;
    if (totalChanges === 0) {
      notes.push("No file changes detected on disk.");
    } else {
      if (changeManifest.added.length > 0) notes.push(`Files created: ${changeManifest.added.join(", ")}`);
      if (changeManifest.modified.length > 0) notes.push(`Files modified: ${changeManifest.modified.join(", ")}`);
      if (changeManifest.deleted.length > 0) notes.push(`Files deleted: ${changeManifest.deleted.join(", ")}`);
    }
  }

  // ── Layer 2: Manifest claimed-file existence check ─────────────────────
  if (manifest && devDir) {
    for (const claimedFile of manifest.filesCreated) {
      const absPath = path.isAbsolute(claimedFile)
        ? claimedFile
        : path.join(devDir, claimedFile);
      const exists = fs.existsSync(absPath);
      if (!exists) {
        notes.push(`⚠ EXISTENCE FAIL: Sub-agent claimed to create "${claimedFile}" but file not found on disk.`);
        passed = false;
      } else {
        const size = fs.statSync(absPath).size;
        notes.push(`✓ Exists: "${claimedFile}" (${size} bytes)`);
      }
    }

    // Unclaimed changes (files that changed but weren't in manifest)
    if (changeManifest && manifest.filesCreated.length > 0) {
      const unclaimed = [...changeManifest.added, ...changeManifest.modified].filter(
        f => !manifest.filesCreated.some(c => c.includes(f) || f.includes(c))
      );
      if (unclaimed.length > 0) {
        notes.push(`ℹ Additional disk changes not declared in manifest: ${unclaimed.join(", ")}`);
      }
    }

    if (manifest.errors.length > 0) {
      notes.push(`Sub-agent self-reported errors: ${manifest.errors.join("; ")}`);
      passed = false;
    }
  }

  // ── Layer 3: resultSpec file checks (EXECUTION verification) ───────────
  const resultSpec = spec?.resultSpec;
  if (resultSpec?.files && devDir) {
    for (const fileSpec of resultSpec.files) {
      const absPath = path.isAbsolute(fileSpec.path)
        ? fileSpec.path
        : path.join(devDir, fileSpec.path);

      // 3a. Existence
      if (!fs.existsSync(absPath)) {
        notes.push(`⚠ SPEC FAIL [existence]: Required file "${fileSpec.path}" does not exist.`);
        passed = false;
        continue; // no point running further checks if file missing
      }

      const fileSize = fs.statSync(absPath).size;

      // 3b. Minimum size guard (catches empty/stub files)
      const minBytes = fileSpec.minBytes ?? 50;
      if (fileSize < minBytes) {
        notes.push(`⚠ SPEC FAIL [size]: "${fileSpec.path}" is only ${fileSize} bytes (minimum: ${minBytes}). File may be empty or a stub.`);
        passed = false;
      } else {
        notes.push(`✓ Size OK: "${fileSpec.path}" (${fileSize} bytes)`);
      }

      // 3c. Required exports check (fast regex — no runtime needed)
      if (fileSpec.requiredExports && fileSpec.requiredExports.length > 0) {
        const missing = checkRequiredExports(absPath, fileSpec.requiredExports);
        if (missing.length > 0) {
          notes.push(`⚠ SPEC FAIL [exports]: "${fileSpec.path}" is missing required exports:\n  ${missing.join("\n  ")}`);
          passed = false;
        } else {
          notes.push(`✓ Exports OK: "${fileSpec.path}" has all ${fileSpec.requiredExports.length} required export(s)`);
        }
      }

      // 3d. Syntax check (tsc --noEmit) — skipped if validateSyntax explicitly false
      const shouldValidate = fileSpec.validateSyntax !== false &&
        SYNTAX_CHECK_EXTENSIONS.has(path.extname(fileSpec.path).toLowerCase());
      if (shouldValidate) {
        console.log(`[SubAgentVerify] Running tsc syntax check on ${fileSpec.path}...`);
        const syntaxError = runSyntaxCheck(devDir, absPath);
        if (syntaxError) {
          notes.push(`⚠ SPEC FAIL [syntax]: "${fileSpec.path}" has TypeScript/JavaScript errors:\n${syntaxError}`);
          passed = false;
        } else {
          notes.push(`✓ Syntax OK: "${fileSpec.path}" passes tsc --noEmit`);
        }
      }
    }
  }

  // ── Layer 4: resultSpec data pattern checks ────────────────────────────
  if (resultSpec?.dataPatterns && rawOutput) {
    const patternFailures = checkDataPatterns(rawOutput, resultSpec.dataPatterns);
    for (const failure of patternFailures) {
      if (failure.required) {
        notes.push(`⚠ SPEC FAIL [data]: Required output pattern "${failure.label}" not found in sub-agent response.`);
        passed = false;
      } else {
        notes.push(`⚠ WARNING [data]: Expected output pattern "${failure.label}" not found (non-required).`);
      }
    }
    const passCount = resultSpec.dataPatterns.length - patternFailures.length;
    if (passCount > 0) {
      notes.push(`✓ Data patterns: ${passCount}/${resultSpec.dataPatterns.length} matched`);
    }
  }

  return { passed, notes, changeManifest };
}

// ── Result spec: contract between parent and sub-agent ───────────────────────────────────────────
//
// The parent declares exactly what shape it expects back. The sub-agent sees this in its
// system prompt as a checklist. After the subtask finishes, the executor verifies every
// field mechanically against what actually exists on disk.

export interface ResultSpecFile {
  /** Path relative to dev workspace root (e.g. "client/src/components/my-widget.tsx") */
  path: string;
  /** Minimum acceptable file size in bytes. Catches empty/stub writes. Default 50. */
  minBytes?: number;
  /** Exports that MUST be present (checked via fast regex). E.g. ["export function myFn", "export interface MyType"] */
  requiredExports?: string[];
  /** Run tsc --noEmit on this file after creation. Only applies to .ts/.tsx/.js/.jsx. Default true for those extensions. */
  validateSyntax?: boolean;
  /** Optional free-text description of what the file should contain — shown to the sub-agent */
  description?: string;
}

export interface ResultSpec {
  /** Files the sub-agent MUST create or modify */
  files?: ResultSpecFile[];
  /** Data the sub-agent must return in its text output — checked with regex patterns */
  dataPatterns?: Array<{
    /** Human-readable label for this check */
    label: string;
    /** Regex pattern that must match somewhere in the sub-agent's final output */
    pattern: string;
    /** If true, a missing match is a hard failure (not just a warning). Default true. */
    required?: boolean;
  }>;
}

export interface SubtaskSpec {
  title: string;
  description: string;
  taskType: TaskType;
  dependsOn?: number[]; // indices into the tasks array (0-based)
  /** Injected when spawned from a self-dev session — gives subtasks workspace awareness */
  selfDevContext?: {
    devDir: string;
    stableDir: string;
    devToolsList: string; // pre-formatted list of allowed selfdev_* tools
  };
  /** Optional context from the parent conversation — injected into sub-agent system prompt.
   *  Use this to share relevant background the sub-agent would otherwise lack.
   */
  parentContext?: string;
  /** Expected outputs — files or artifacts the sub-agent should produce.
   *  Used in verification and surfaced in the system prompt so the sub-agent knows what success looks like.
   */
  expectedOutputs?: string[];
  /** Structured result contract — exact files, exports, and data patterns the sub-agent must produce.
   *  Injected into the sub-agent system prompt as a hard checklist.
   *  Verified mechanically after the subtask finishes: file existence, size, required exports, tsc syntax, data patterns.
   */
  resultSpec?: ResultSpec;
}

export interface SubtaskPlan {
  planId: number;
  tasks: SubtaskSpec[];
}

interface RunningSubtask {
  id: number;           // DB subtask id
  specIndex: number;    // index in the tasks array
  promise: Promise<SubtaskOutcome>;
}

interface SubtaskOutcome {
  specIndex: number;
  subtaskId: number;
  success: boolean;
  result: string;
  /** Ground-truth verification result — what actually happened on disk */
  verification?: VerificationResult;
  /** Parsed structured manifest written by the sub-agent */
  manifest?: SubtaskResultManifest | null;
}

// ── SlotManager ──────────────────────────────────────────────────────────────

/**
 * Per-endpoint slot semaphore.
 * acquire() returns a Promise that resolves when a slot is free, then
 * holds that slot until release() is called.
 */
export class SlotManager {
  private slots: Map<number, { active: number; max: number; queue: (() => void)[] }> = new Map();

  constructor(endpoints: Endpoint[]) {
    for (const ep of endpoints) {
      this.slots.set(ep.id, {
        active: 0,
        max: ep.parallelSlots ?? 1,
        queue: [],
      });
    }
  }

  /**
   * Acquire a slot for the given endpoint.
   * If the endpoint has no slot record (new endpoint added mid-run), allow 1 slot.
   * Resolves immediately if a slot is free, otherwise queues until one is released.
   */
  acquire(endpointId: number): Promise<void> {
    if (!this.slots.has(endpointId)) {
      this.slots.set(endpointId, { active: 0, max: 1, queue: [] });
    }
    const entry = this.slots.get(endpointId)!;

    if (entry.active < entry.max) {
      entry.active++;
      return Promise.resolve();
    }

    // Queue and wait
    return new Promise<void>((resolve) => {
      entry.queue.push(resolve);
    });
  }

  /**
   * Release a slot for the given endpoint.
   * If there are queued waiters, the next one is immediately granted the slot.
   */
  release(endpointId: number): void {
    const entry = this.slots.get(endpointId);
    if (!entry) return;

    if (entry.queue.length > 0) {
      const next = entry.queue.shift()!;
      next(); // hand the slot directly to the next waiter
    } else {
      entry.active = Math.max(0, entry.active - 1);
    }
  }

  /** Current slot status (for diagnostics) */
  status(): Record<number, { active: number; max: number; queued: number }> {
    const out: Record<number, { active: number; max: number; queued: number }> = {};
    Array.from(this.slots.entries()).forEach(([id, entry]) => {
      out[id] = { active: entry.active, max: entry.max, queued: entry.queue.length };
    });
    return out;
  }
}

// ── SubAgentExecutor ─────────────────────────────────────────────────────────

// ── Enriched result builder ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Build the enriched result string the parent agent receives after a subtask.
 * Combines:
 *   1. The sub-agent's raw output
 *   2. Structured manifest (if written by the sub-agent)
 *   3. Ground-truth verification notes (parent checks disk reality)
 *   4. Change manifest (what actually changed on disk — ground truth)
 *
 * This is what the parent sees in its tool result message — not just a text blob.
 */
function buildEnrichedResult(
  spec: SubtaskSpec,
  rawOutput: string,
  manifest: SubtaskResultManifest | null,
  verification: VerificationResult
): string {
  const sections: string[] = [];

  // 1. Sub-agent raw output
  sections.push(`## Sub-agent output\n${rawOutput.slice(0, 3000)}${rawOutput.length > 3000 ? "\n...(truncated)" : ""}`);

  // 2. Structured manifest (ground truth from sub-agent self-report)
  if (manifest) {
    const manifestLines: string[] = ["## Structured result"];
    manifestLines.push(`Status: ${manifest.status}`);
    manifestLines.push(`Summary: ${manifest.summary}`);
    if (manifest.filesCreated.length > 0) manifestLines.push(`Files created: ${manifest.filesCreated.join(", ")}`);
    if (manifest.filesRead.length > 0) manifestLines.push(`Files read: ${manifest.filesRead.join(", ")}`);
    if (manifest.errors.length > 0) manifestLines.push(`Errors: ${manifest.errors.join("; ")}`);
    if (manifest.verificationNotes) manifestLines.push(`Self-verification: ${manifest.verificationNotes}`);
    sections.push(manifestLines.join("\n"));
  }

  // 3. Verification — what the parent actually found on disk
  if (verification.notes.length > 0) {
    sections.push(`## Parent verification\n${verification.notes.join("\n")}`);
  }

  // 4. Change manifest — what actually changed, as ground truth
  if (verification.changeManifest) {
    const cm = verification.changeManifest;
    const hasChanges = cm.added.length + cm.modified.length + cm.deleted.length > 0;
    if (hasChanges) {
      const cmLines: string[] = ["## Disk change manifest (verified)"];
      if (cm.added.length > 0) cmLines.push(`  Created: ${cm.added.join(", ")}`);
      if (cm.modified.length > 0) cmLines.push(`  Modified: ${cm.modified.join(", ")}`);
      if (cm.deleted.length > 0) cmLines.push(`  Deleted: ${cm.deleted.join(", ")}`);
      sections.push(cmLines.join("\n"));
    } else {
      sections.push("## Disk change manifest\nNo file changes detected on disk.");
    }
  }

  return sections.join("\n\n");
}

export class SubAgentExecutor {
  private slotManager: SlotManager | null = null;

  /**
   * Get or refresh the slot manager from current endpoint configuration.
   * Re-reads parallelSlots from DB each time to pick up user changes
   * (e.g., user set parallelSlots=4 in Settings after server started).
   */
  private getSlotManager(): SlotManager {
    // Always refresh from DB — parallelSlots may have been changed in settings
    const endpoints = endpointStore.getAll();
    this.slotManager = new SlotManager(endpoints);
    console.log(`[SubAgentExecutor] SlotManager refreshed: ${endpoints.map(e => `${e.name}=${e.parallelSlots ?? 1} slots`).join(", ")}`);
    return this.slotManager;
  }

  /**
   * Main entry point.
   *
   * @param planId       - DB task_plan id already created by the caller
   * @param tasks        - Ordered array of subtask specs (with optional dependsOn index refs)
   * @param conversationId
   * @param res          - Express Response used for SSE; may be null when called headlessly
   * @param requestId    - Parent request id (used for logging)
   * @returns            - Array of results in spec order
   */
  async executeSubtasks(
    planId: number,
    tasks: SubtaskSpec[],
    conversationId: number,
    res: Response | null,
    requestId: string
  ): Promise<SubtaskOutcome[]> {
    if (tasks.length === 0) return [];

    // Refresh slot manager from current DB config (picks up parallelSlots changes)
    const slotManager = this.getSlotManager();

    console.log(`[SubAgentExecutor] Starting ${tasks.length} subtask(s) for plan=${planId}`);

    // Persist subtask records in the DB
    const subtaskIds: number[] = [];
    for (let i = 0; i < tasks.length; i++) {
      const spec = tasks[i];
      const row = subtaskStore.create({
        planId,
        title: spec.title,
        description: spec.description,
        taskType: spec.taskType,
        status: "pending",
        orderIndex: i,
        dependsOn: spec.dependsOn ? JSON.stringify(spec.dependsOn) : null,
      });
      subtaskIds.push(row.id);
    }

    // Track completion: subtaskOutcomes[specIndex] = outcome
    const outcomes: (SubtaskOutcome | null)[] = new Array(tasks.length).fill(null);

    // Set of spec indices that have been dispatched (to avoid double-dispatch)
    const dispatched = new Set<number>();

    // Active running promises
    const running: RunningSubtask[] = [];

    const sendProgress = (subtaskId: number, specIndex: number, status: string, result?: string) => {
      if (!res) return;
      try {
        // Send SSE event with full result so the UI can display it even if the overlay is cleared
        res.write(`data: ${JSON.stringify({
          type: "subtask_progress",
          subtaskId,
          specIndex,
          title: tasks[specIndex]?.title ?? `Subtask ${specIndex + 1}`,
          status,
          result: result ? result.slice(0, 500) : undefined, // cap to avoid huge SSE payloads
        })}

`);
        // For terminal states, also emit a status message to the activity feed so it's visible in chat
        if (status === "completed" || status === "failed" || status === "skipped") {
          const icon = status === "completed" ? "✓" : status === "failed" ? "✗" : "⏭";
          const taskTitle = tasks[specIndex]?.title ?? `Subtask ${specIndex + 1}`;
          res.write(`data: ${JSON.stringify({
            type: "status",
            message: `${icon} Sub-agent: ${taskTitle}`,
            detail: status === "completed" ? "Completed" : status === "failed" ? "Failed" : "Skipped",
            timestamp: Date.now(),
          })}

`);
        }
      } catch { /* client disconnected */ }
    };

    /**
     * Check which tasks are now unblocked (all deps completed successfully).
     * Returns spec indices that are ready to dispatch.
     */
    const findReady = (): number[] => {
      const ready: number[] = [];
      for (let i = 0; i < tasks.length; i++) {
        if (dispatched.has(i)) continue;
        const deps = tasks[i].dependsOn ?? [];
        const allDepsComplete = deps.every((depIdx) => {
          const outcome = outcomes[depIdx];
          return outcome !== null && outcome.success;
        });
        if (allDepsComplete) ready.push(i);
      }
      return ready;
    };

    /**
     * Launch a single subtask execution as a Promise.
     * Takes a before-snapshot of the dev workspace (if applicable) so we can
     * diff against it after the sub-agent finishes to get a ground-truth change manifest.
     */
    const launch = (specIndex: number): RunningSubtask => {
      const spec = tasks[specIndex];
      const dbId = subtaskIds[specIndex];

      dispatched.add(specIndex);

      // Snapshot before the sub-agent runs so we can detect real file changes
      const devDir = spec.selfDevContext?.devDir ?? null;
      const beforeSnapshot = devDir ? snapshotGitFiles(devDir) : new Map<string, string>();

      // Update DB to running
      subtaskStore.update(dbId, { status: "running" });
      sendProgress(dbId, specIndex, "running");

      const promise = this.runSubtask(spec, dbId, conversationId, requestId)
        .then((result): SubtaskOutcome => {
          // Read the structured manifest the sub-agent wrote (if it produced one)
          const manifest = readResultManifest(dbId);

          // Snapshot after and run full multi-layer verification (existence + size + exports + tsc + data patterns)
          const afterSnapshot = devDir ? snapshotGitFiles(devDir) : new Map<string, string>();
          const verification = verifySubtaskOutputs(manifest, beforeSnapshot, afterSnapshot, devDir, spec, result);

          // Build enriched result string for the parent agent
          const enrichedResult = buildEnrichedResult(spec, result, manifest, verification);

          outcomes[specIndex] = { specIndex, subtaskId: dbId, success: true, result: enrichedResult, verification, manifest };
          subtaskStore.update(dbId, {
            status: "completed",
            result: enrichedResult,
            completedAt: new Date().toISOString(),
          });
          sendProgress(dbId, specIndex, "completed", enrichedResult);
          console.log(`[SubAgentExecutor] Subtask ${dbId} (${spec.title}) completed — verification: ${verification.passed ? "PASS" : "FAIL"}`);
          return outcomes[specIndex]!;
        })
        .catch((err: any): SubtaskOutcome => {
          const errMsg = err?.message ?? String(err);
          // Still try to read manifest and snapshot on failure — partial work may have happened
          const manifest = readResultManifest(dbId);
          const afterSnapshot = devDir ? snapshotGitFiles(devDir) : new Map<string, string>();
          const verification = verifySubtaskOutputs(manifest, beforeSnapshot, afterSnapshot, devDir, spec, errMsg);
          const enrichedErr = verification.changeManifest
            ? `${errMsg}\n\n[Disk changes before failure: added=${verification.changeManifest.added.join(",")||"none"}, modified=${verification.changeManifest.modified.join(",")||"none"}]`
            : errMsg;
          outcomes[specIndex] = { specIndex, subtaskId: dbId, success: false, result: enrichedErr, verification, manifest };
          subtaskStore.update(dbId, {
            status: "failed",
            result: enrichedErr,
            completedAt: new Date().toISOString(),
          });
          sendProgress(dbId, specIndex, "failed", enrichedErr);
          console.error(`[SubAgentExecutor] Subtask ${dbId} (${spec.title}) failed:`, errMsg);
          return outcomes[specIndex]!;
        });

      return { id: dbId, specIndex, promise };
    };

    // Main scheduling loop
    while (true) {
      // Dispatch all currently ready tasks
      const ready = findReady();
      for (const idx of ready) {
        running.push(launch(idx));
      }

      // If nothing running and nothing will ever be ready → deadlock or done
      if (running.length === 0) break;

      // Wait for at least one to complete
      const completed = await Promise.race(running.map(r => r.promise));

      // Remove the completed task from running list
      const completedIdx = running.findIndex(r => r.specIndex === completed.specIndex);
      if (completedIdx >= 0) running.splice(completedIdx, 1);

      // Check if all tasks are done
      if (dispatched.size === tasks.length && running.length === 0) break;
    }

    // Mark any tasks that were never dispatched (blocked by failed deps) as skipped
    for (let i = 0; i < tasks.length; i++) {
      if (!dispatched.has(i)) {
        subtaskStore.update(subtaskIds[i], { status: "skipped" });
        sendProgress(subtaskIds[i], i, "skipped", "Skipped — dependency failed");
        outcomes[i] = { specIndex: i, subtaskId: subtaskIds[i], success: false, result: "Skipped — dependency failed" };
      }
    }

    console.log(`[SubAgentExecutor] All subtasks finished for plan=${planId}`);

    // Persist a consolidated status message to DB so the orchestrator loop can see what happened.
    // This is critical: the orchestrator reads conversation history from DB, not from SSE.
    // Without this, the orchestrator has no visibility into sub-agent completions.
    try {
      const completedCount = outcomes.filter(o => o?.success).length;
      const failedCount = outcomes.filter(o => o && !o.success).length;
      const statusLines = outcomes
        .filter(Boolean)
        .map(o => {
          const icon = o!.success ? "✓" : "✗";
          const title = tasks[o!.specIndex]?.title ?? `Subtask ${o!.specIndex + 1}`;
          const summary = o!.manifest?.summary ?? (o!.result?.slice(0, 120) ?? "no result");
          return `${icon} **${title}**: ${summary}`;
        });
      const statusBody = [
        `[Sub-agent orchestration complete: ${completedCount}/${tasks.length} succeeded${failedCount > 0 ? `, ${failedCount} failed` : ""}]`,
        ...statusLines,
      ].join("\n");

      messageStore.create({
        conversationId,
        role: "assistant",
        content: statusBody,
      });
    } catch (err: any) {
      console.warn("[SubAgentExecutor] Failed to persist sub-agent status message:", err.message);
    }

    return outcomes.filter(Boolean) as SubtaskOutcome[];
  }

  /**
   * Run a single subtask using a simplified agent loop.
   * Acquires a slot from the endpoint before calling the LLM, releases it after.
   */
  private async runSubtask(
    spec: SubtaskSpec,
    dbId: number,
    conversationId: number,
    parentRequestId: string,
    depth: number = 1
  ): Promise<string> {
    if (depth >= MAX_DELEGATION_DEPTH) {
      console.warn(`[SubAgentExecutor] Depth limit reached (${depth}/${MAX_DELEGATION_DEPTH}) for subtask ${dbId} — delegation tools will be restricted`);
    }
    const startTime = Date.now();

    // Select the best model for this task type — prefers isSubAgent-tagged models
    const routing = selectSubAgentModel(spec.taskType);
    if (!routing) {
      throw new Error(`No model available for task type: ${spec.taskType}`);
    }

    const { model, endpoint } = routing;

    // Ensure model is loaded with preferred context length before using it
    try {
      await ensureModelLoaded(model, endpoint);
    } catch (err: any) {
      console.warn(`[SubAgentExecutor] Model load check failed for subtask ${dbId}, continuing:`, err.message);
    }

    // Update DB with routing info
    subtaskStore.update(dbId, {
      modelUsed: model.modelId,
      endpointUsed: endpoint.id,
    });

    const requestId = `${parentRequestId}_sub_${dbId}`;

    // Register this child so the parent's stop button can cancel it
    registerChildRequest(parentRequestId, requestId);

    const slotManager = this.slotManager!; // guaranteed set by executeSubtasks before any runSubtask calls
    console.log(`[SubAgentExecutor] Subtask ${dbId} acquiring slot on endpoint ${endpoint.id} (${endpoint.name})`);
    await slotManager.acquire(endpoint.id);
    console.log(`[SubAgentExecutor] Subtask ${dbId} got slot — running on ${endpoint.name}/${model.modelId}`);

    const toolsUsed: string[] = [];

    try {
      const result = await this.runSubtaskLoop(spec, dbId, model, endpoint, conversationId, requestId, toolsUsed, depth);

      const durationMs = Date.now() - startTime;
      subtaskStore.update(dbId, {
        toolsUsed: JSON.stringify(toolsUsed),
        durationMs,
      });

      return result;
    } finally {
      slotManager.release(endpoint.id);
      unregisterChildRequest(parentRequestId, requestId);
      console.log(`[SubAgentExecutor] Subtask ${dbId} released slot on endpoint ${endpoint.id}`);
    }
  }

  /**
   * Simplified agentic loop for a single subtask.
   * - Up to 20 iterations (subtasks are scoped, so fewer are needed)
   * - Native tool calling when supported, otherwise prompted fallback
   * - Returns the final text result
   */
  private async runSubtaskLoop(
    spec: SubtaskSpec,
    dbId: number,
    model: Model,
    endpoint: Endpoint,
    conversationId: number,
    requestId: string,
    toolsUsed: string[],
    depth: number = 1
  ): Promise<string> {
    const MAX_ITERS = 20;
    // v16.73: smart subset selection for sub-agents — they used to get ~95+ tools
    // (full registry minus blocked). The selector caps to ~15-40 based on
    // task type and model so MiniMax/small models don't choke.
    // Conservative modelSize hint: assume "large" unless the model id reveals
    // a small parameter count.
    const idLc = (model.modelId || "").toLowerCase();
    let modelSizeHint: "small" | "medium" | "large" | "xlarge" = "large";
    const m = idLc.match(/(\d+(?:\.\d+)?)b/);
    if (m) {
      const n = parseFloat(m[1]);
      if (n < 15) modelSizeHint = "small";
      else if (n < 50) modelSizeHint = "medium";
    }
    const smartOn = readSmartSelectionSetting((k) => settingsStore.get(k));
    const selection = selectTools({
      allTools: getAllTools(),
      taskType: spec.taskType,
      model,
      endpoint,
      modelSize: modelSizeHint,
      lastUserMessage: `${spec.title}\n${spec.description}`,
      blockedTools: SUBAGENT_BLOCKED_TOOLS,
      smartSelectionEnabled: smartOn,
    });
    const tools = selection.definitions;
    console.log(
      `[SubAgentExecutor] tools selected for "${spec.title}": ${tools.length}/${getAllTools().size} ` +
      `(cap=${selection.cap}, mode=${selection.modeUsed}, smart=${smartOn})`
    );

    const systemPrompt = this.buildSubtaskSystemPrompt(spec, model);

    let messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Complete this subtask:\n\nTitle: ${spec.title}\n\nDescription: ${spec.description}` },
    ];

    // Prompted-fallback injection when model doesn't support native tools.
    // v16.73: only describe the selected subset, not the full ~95 tools.
    if (!model.supportsToolCalling && tools.length > 0) {
      const toolsText = getToolDescriptionsText(selection.selectedNames);
      messages[0].content += `\n\n## Available Tools\nYou can call tools using <tool_call> XML tags:\n<tool_call>\n{"name": "tool_name", "arguments": {"param": "value"}}\n</tool_call>\n\nAvailable tools:\n${toolsText}`;
    }

    const toolContext: ToolContext = {
      conversationId,
      requestId,
    };

    let totalContent = "";
    let iteration = 0;

    while (iteration < MAX_ITERS) {
      iteration++;

      const response = await chatCompletion(endpoint, model, messages, {
        tools: model.supportsToolCalling ? tools : undefined,
        temperature: spec.taskType === "creative" ? 0.9 : spec.taskType === "math" ? 0.2 : 0.7,
        requestId,
      });

      const content = response.content ?? "";
      totalContent += (content ? content + "\n" : "");

      if (response.toolCalls && response.toolCalls.length > 0) {
        // Native tool calls
        messages.push({
          role: "assistant",
          content: content || null,
          tool_calls: response.toolCalls,
        });

        for (const tc of response.toolCalls) {
          let args: Record<string, any> = {};
          try {
            args = JSON.parse(tc.function.arguments);
          } catch { /* leave empty */ }

          const toolName = tc.function.name;
          toolsUsed.push(toolName);

          console.log(`[SubAgentExecutor] Tool call: ${toolName}(${JSON.stringify(args).slice(0, 150)})`);

          const result = await executeTool(toolName, args, toolContext);

          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            name: toolName,
            content: result.output,
          });
        }
        continue;
      }

      // Prompted fallback: parse <tool_call> blocks
      if (!model.supportsToolCalling && content.includes("<tool_call>")) {
        messages.push({ role: "assistant", content });
        const calls = this.parseToolCalls(content);

        if (calls.length > 0) {
          for (const call of calls) {
            toolsUsed.push(call.name);
            console.log(`[SubAgentExecutor] Prompted tool call: ${call.name}(${JSON.stringify(call.arguments).slice(0, 150)})`);
            const result = await executeTool(call.name, call.arguments, toolContext);
            messages.push({
              role: "user",
              content: `Tool result for ${call.name}:\n${result.output}`,
            });
          }
          continue;
        }
      }

      // No tool calls — this is a final answer
      if (content.trim().length > 0) {
        const finalText = content.trim();
        // Parse structured completion report and write manifest to disk
        const parsedManifest = this.parseCompletionReport(finalText, dbId, spec.title, toolsUsed);
        if (parsedManifest) writeResultManifest(dbId, parsedManifest);
        return finalText;
      }

      // Empty response — nudge once then stop
      if (iteration < 3) {
        messages.push({ role: "user", content: "Please complete the subtask and provide your result. Remember to include the structured completion report at the end." });
        continue;
      }

      break;
    }

    const finalOutput = totalContent.trim() || "Subtask completed (no textual output)";
    // Parse structured completion report from accumulated output
    const parsedManifest = this.parseCompletionReport(finalOutput, dbId, spec.title, toolsUsed);
    if (parsedManifest) writeResultManifest(dbId, parsedManifest);
    return finalOutput;
  }

  /**
   * Parse the structured completion report from a sub-agent's final output.
   * Extracts STATUS, SUMMARY, FILES_CREATED, FILES_READ, ERRORS, VERIFICATION fields.
   * Returns a SubtaskResultManifest if the report was found, null otherwise.
   */
  private parseCompletionReport(
    text: string,
    dbId: number,
    title: string,
    toolsUsed: string[]
  ): SubtaskResultManifest | null {
    // Look for the structured report block — either in a code fence or inline
    const fenceMatch = text.match(/```[\s\S]*?STATUS:\s*(\S+)[\s\S]*?SUMMARY:\s*([^\n]+)[\s\S]*?FILES_CREATED:\s*([^\n]*)[\s\S]*?FILES_READ:\s*([^\n]*)[\s\S]*?ERRORS:\s*([^\n]*)[\s\S]*?VERIFICATION:\s*([^\n`]+)/i);
    const inlineMatch = !fenceMatch && text.match(/STATUS:\s*(\S+)[\s\S]*?SUMMARY:\s*([^\n]+)[\s\S]*?FILES_CREATED:\s*([^\n]*)[\s\S]*?FILES_READ:\s*([^\n]*)[\s\S]*?ERRORS:\s*([^\n]*)[\s\S]*?VERIFICATION:\s*([^\n]+)/i);
    const m = fenceMatch || inlineMatch;
    if (!m) return null;

    const statusRaw = (m[1] ?? "").toLowerCase().trim();
    const status: SubtaskResultManifest["status"] =
      statusRaw === "failed" ? "failed" : statusRaw === "partial" ? "partial" : "completed";

    const parseList = (s: string) =>
      s.split(",").map(x => x.trim()).filter(Boolean);

    const parseErrList = (s: string) =>
      s.split(";").map(x => x.trim()).filter(Boolean);

    return {
      taskId: String(dbId),
      title,
      status,
      summary: (m[2] ?? "").trim(),
      filesCreated: parseList(m[3] ?? ""),
      filesRead: parseList(m[4] ?? ""),
      errors: parseErrList(m[5] ?? ""),
      verificationNotes: (m[6] ?? "").trim(),
      toolsUsed,
      rawOutput: text,
    };
  }

  /**
   * Build a focused system prompt for a single subtask.
   */
  private buildSubtaskSystemPrompt(spec: SubtaskSpec, model: Model): string {
    // Build expected outputs section if provided
    const expectedOutputsSection = spec.expectedOutputs && spec.expectedOutputs.length > 0
      ? `\n\n## Expected outputs\nThe parent agent expects you to produce the following. Your work is not done until each of these exists:\n${spec.expectedOutputs.map(o => `  - ${o}`).join("\n")}`
      : "";

    // Build resultSpec section — hard contract the parent will verify mechanically
    let resultSpecSection = "";
    if (spec.resultSpec) {
      const rs = spec.resultSpec;
      const lines: string[] = ["\n\n## RESULT SPEC — hard contract (verified by parent after you finish)"];
      lines.push("The parent agent will mechanically verify every item below after you finish. Anything that fails is flagged as a verification failure.");

      if (rs.files && rs.files.length > 0) {
        lines.push("\n### Files you MUST produce:");
        for (const f of rs.files) {
          lines.push(`  File: ${f.path}`);
          if (f.description) lines.push(`    What it should contain: ${f.description}`);
          if (f.minBytes) lines.push(`    Minimum size: ${f.minBytes} bytes (must not be empty or a stub)`);
          if (f.requiredExports && f.requiredExports.length > 0) {
            lines.push(`    Required exports (must appear verbatim in the file):\n${f.requiredExports.map(e => `      - ${e}`).join("\n")}`);
          }
          if (f.validateSyntax !== false && SYNTAX_CHECK_EXTENSIONS.has(path.extname(f.path).toLowerCase())) {
            lines.push(`    Syntax: will be checked with tsc --noEmit — must compile clean`);
          }
        }
      }

      if (rs.dataPatterns && rs.dataPatterns.length > 0) {
        lines.push("\n### Data your response MUST contain:");
        for (const p of rs.dataPatterns) {
          const req = p.required !== false ? "(required)" : "(preferred)";
          lines.push(`  ${req} ${p.label}`);
        }
      }

      resultSpecSection = lines.join("\n");
    }

    const base = `You are a specialist sub-agent focused exclusively on a single subtask.

Your task type: ${spec.taskType}
Current time: ${new Date().toISOString()}${expectedOutputsSection}${resultSpecSection}

## Your role
You are executing one scoped subtask as part of a larger parallel workflow.
Focus ONLY on the subtask you are given. Be concise and complete.

## Rules
- Use your tools to do real work.
- After each tool result, continue working until the subtask is fully done.
- Do NOT repeat tool calls that already succeeded.
- If a tool fails, analyze the error and retry once with a fix. If it fails again, report the error and stop.
- Be explicit about what you actually did vs. what you attempted.

## CRITICAL: Structured completion report
When you are fully done, your FINAL response MUST be a structured report in this exact format. Do not skip any field.

\`\`\`
STATUS: completed | failed | partial
SUMMARY: One paragraph describing exactly what was accomplished.
FILES_CREATED: comma-separated list of file paths you created (empty if none)
FILES_READ: comma-separated list of file paths you read
ERRORS: semicolon-separated list of any errors encountered (empty if none)
VERIFICATION: How you confirmed your work is correct (e.g., "Read back the file and confirmed content matches spec", "Tool returned success", "File exists at path X with Y bytes")
\`\`\``;

    // Append parent context if provided
    const withParentContext = spec.parentContext
      ? `${base}\n\n---\n\n## Context from the parent agent\nThe following background was provided by the agent that spawned you. Use it to inform your work:\n\n${spec.parentContext}`
      : base;

    if (!spec.selfDevContext) return withParentContext;

    // Self-dev aware prompt — injected when spawned from a self-dev session
    return `${withParentContext}

---

## Self-Development Context
You are running as a subtask inside an Agent2077 self-development session. The main agent spawned you to do focused parallel work in the dev workspace.

- Dev workspace: ${spec.selfDevContext.devDir}
- Stable reference: ${spec.selfDevContext.stableDir}

## CRITICAL: File Access Rules
You are working inside the Agent2077 dev workspace — NOT a normal filesystem or /workspace directory.

**YOU MUST USE THESE TOOLS ONLY:**
${spec.selfDevContext.devToolsList}

**NEVER use:** \`search_files\`, \`read_file\`, \`list_files\`, \`write_file\`, \`shell_command\`, \`execute_code\`
These tools operate on /workspace which is completely separate from the dev workspace and will always return empty/wrong results.

## How to read a file
Call \`selfdev_read_file\` with the file path relative to the dev workspace root.
Example: \`selfdev_read_file({"filePath": "client/src/pages/chat.tsx"})\`

## How to create a NEW file (does not exist yet)
Call \`selfdev_write_file\` with the file path and full content.
Example: \`selfdev_write_file({"filePath": "client/src/components/my-component.tsx", "content": "..."})\`
IMPORTANT: \`selfdev_write_file\` will REJECT if the file already exists. Only use it for brand-new files.

## How to search file contents
Call \`selfdev_search_files\` with the pattern and optional subPath.
Example: \`selfdev_search_files({"pattern": "inpaint_request", "subPath": "server"})\`

## How to list a directory
Call \`selfdev_list_files\` with the directory path relative to the dev workspace.
Example: \`selfdev_list_files({"directory": "server/tools"})\`

## What you can and cannot do

**ALLOWED:**
- Read any file with \`selfdev_read_file\` or \`selfdev_read_files\`
- Search with \`selfdev_search_files\`, list with \`selfdev_list_files\`
- Create a BRAND-NEW file (one that does not exist yet) with \`selfdev_write_file\`
- Edit an existing file with \`selfdev_edit_file\`, \`selfdev_write_lines\`, or \`selfdev_rewrite_file\`
  - File writes are safe: only ONE sub-agent can write to a given file at a time. If another sub-agent is writing the same file, you will automatically wait until it finishes.

**NOT ALLOWED — these tools are blocked and will fail:**
- \`selfdev_build\`, \`selfdev_run_command\`, \`shell_command\`, \`execute_code\` — no builds or shell in subtasks
- \`selfdev_reset_file\`, \`selfdev_reset_all\`, \`selfdev_git_checkpoint\` — main loop only

**Your subtask description tells you exactly what to do.** Do only what it says. Do not explore beyond what is needed.`;
  }

  /**
   * Parse <tool_call> blocks from prompted-mode output.
   */
  private parseToolCalls(text: string): { name: string; arguments: Record<string, any> }[] {
    const calls: { name: string; arguments: Record<string, any> }[] = [];
    const regex = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g;
    let match;

    while ((match = regex.exec(text)) !== null) {
      const raw = match[1].trim();
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.name) {
          calls.push({ name: parsed.name, arguments: parsed.arguments ?? {} });
        }
      } catch {
        const nameMatch = raw.match(/"name"\s*:\s*"([^"]+)"/);
        if (nameMatch) {
          calls.push({ name: nameMatch[1], arguments: {} });
        }
      }
    }

    return calls;
  }
}

// ── Singleton instance ────────────────────────────────────────────────────────
export const subAgentExecutor = new SubAgentExecutor();
