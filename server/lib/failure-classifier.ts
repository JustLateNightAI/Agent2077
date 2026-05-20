/**
 * Failure Classifier — v16.73.2
 *
 * Smallcode review idea #C (targeted), distilled. The existing v16.73.1
 * `agent.maxFailedToolCalls` cap stops the loop when N tool calls fail in a
 * row — but a blunt "stop everything" is a worse user experience than nudging
 * the model with a sharper correction when a known failure pattern is
 * detected.
 *
 * This module is intentionally low-risk:
 *  - Stateful only across the current turn (instance per `runAgentLoop`).
 *  - Emits a short *string* message; the caller decides how to inject it
 *    (system/user message). No retries, no automatic recovery.
 *  - Each pattern fires at most once unless re-armed by a success.
 *  - The `agent.maxFailedToolCalls` cap is unchanged and still the backstop.
 *
 * Patterns recognised:
 *   identical_repeat      — same tool + same args + same error twice in a row
 *   malformed_args        — output begins with the registry's "Missing required" message
 *   project_forbidden     — output flagged a forbidden-in-project-mode tool
 *   unknown_tool          — output starts with "Unknown tool:" (from registry.ts)
 *   edit_mismatch         — edit_file / edit_project_file failed with mismatch/anchor errors twice for same path
 *   shell_repeat_fail     — shell_command / execute_code failed twice with same command
 *
 * Anything not recognised → no nudge. The give-up cap still applies.
 */

export interface FailureRecord {
  tool: string;
  args: Record<string, any>;
  output: string;
  success: boolean;
}

export type FailurePattern =
  | "identical_repeat"
  | "malformed_args"
  | "project_forbidden"
  | "unknown_tool"
  | "edit_mismatch"
  | "shell_repeat_fail";

export interface ClassifierNudge {
  pattern: FailurePattern;
  message: string;
  /** Where to inject. user is broadly safe; system is firmer. */
  role: "system" | "user";
}

const KEY_LIMIT = 800; // arg-key cap to keep state bounded

function safeJson(o: any): string {
  try { return JSON.stringify(o).slice(0, KEY_LIMIT); } catch { return ""; }
}

export class FailureClassifier {
  private firedOnce = new Set<FailurePattern>();
  private lastFailKey: string | null = null;
  private editFailsByPath = new Map<string, number>();
  private shellFailsByCmd = new Map<string, number>();

  /**
   * Record a tool result and return a nudge if a pattern fires.
   * Returns null when nothing actionable was detected.
   */
  record(rec: FailureRecord): ClassifierNudge | null {
    if (rec.success) {
      // Successes re-arm everything except identical_repeat (already track by key).
      this.firedOnce.clear();
      this.lastFailKey = null;
      this.editFailsByPath.clear();
      this.shellFailsByCmd.clear();
      return null;
    }

    const key = `${rec.tool}|${safeJson(rec.args)}|${rec.output.slice(0, 200)}`;
    const out = (rec.output || "").toString();
    const outLc = out.toLowerCase();
    const isRepeat = this.lastFailKey === key;
    this.lastFailKey = key;

    // Specific patterns are checked BEFORE the generic identical-repeat so a
    // sharp, actionable message wins over the generic "you repeated yourself".

    // 1. Malformed args (registry validation error) ──────────────────────
    if ((outLc.includes("missing required parameter") || outLc.includes("missing all required parameters"))
        && !this.firedOnce.has("malformed_args")) {
      this.firedOnce.add("malformed_args");
      return {
        pattern: "malformed_args",
        role: "system",
        message:
          `Your last \`${rec.tool}\` call was missing required parameters. ` +
          `Tool calls must include every required argument with a real value — never \`{}\`. ` +
          `Re-issue the call with all required fields filled in.`,
      };
    }

    // 2. Unknown tool ─────────────────────────────────────────────────────
    if (outLc.startsWith("unknown tool:") && !this.firedOnce.has("unknown_tool")) {
      this.firedOnce.add("unknown_tool");
      return {
        pattern: "unknown_tool",
        role: "system",
        message:
          `The tool name "${rec.tool}" isn't registered. ` +
          `Call \`tool_search({query:"<keyword>"})\` to find the right tool — it searches the full ` +
          `catalogue, not just this turn's pre-selected subset. If the tool truly doesn't exist, ` +
          `choose a different approach.`,
      };
    }

    // 3. Project-mode forbidden tool ──────────────────────────────────────
    if ((outLc.includes("project mode") || outLc.includes("forbidden in project")
         || (out.includes("PROJECT MODE") && outLc.includes("not allowed")))
        && !this.firedOnce.has("project_forbidden")) {
      this.firedOnce.add("project_forbidden");
      return {
        pattern: "project_forbidden",
        role: "system",
        message:
          `\`${rec.tool}\` isn't usable in PROJECT MODE. Use the project-scoped equivalents: ` +
          `read_project_file, write_project_file, edit_project_file, list_project_files, ` +
          `search_project_files, run_project_command.`,
      };
    }

    // 4. Edit mismatch (per-file repeat) ─────────────────────────────────
    if ((rec.tool === "edit_file" || rec.tool === "edit_project_file" ||
         rec.tool === "selfdev_edit_file") &&
        (outLc.includes("not found") || outLc.includes("no match") ||
         outLc.includes("mismatch") || outLc.includes("did not match") ||
         outLc.includes("anchor"))) {
      const filePath = (rec.args?.path || rec.args?.file || rec.args?.filePath || "") as string;
      if (filePath) {
        const prev = this.editFailsByPath.get(filePath) ?? 0;
        const next = prev + 1;
        this.editFailsByPath.set(filePath, next);
        if (next >= 2 && !this.firedOnce.has("edit_mismatch")) {
          this.firedOnce.add("edit_mismatch");
          const readerHint = rec.tool === "edit_project_file" ? "read_project_file"
                            : rec.tool === "selfdev_edit_file" ? "selfdev_read_file"
                            : "read_file";
          return {
            pattern: "edit_mismatch",
            role: "system",
            message:
              `\`${rec.tool}\` has failed twice on \`${filePath}\` because the search text doesn't match. ` +
              `Stop guessing the anchor — call \`${readerHint}({path:"${filePath}"})\` first, copy the ` +
              `exact bytes you need to replace (including whitespace), then re-issue the edit.`,
          };
        }
      }
    }

    // 5. Shell repeat fail (same command) ────────────────────────────────
    if ((rec.tool === "shell_command" || rec.tool === "execute_code" ||
         rec.tool === "run_project_command" || rec.tool === "selfdev_run_command" ||
         rec.tool === "ssh_exec")) {
      const cmdRaw = (rec.args?.command || rec.args?.code || rec.args?.cmd || "") as string;
      const cmd = String(cmdRaw).trim().slice(0, 200);
      if (cmd) {
        const prev = this.shellFailsByCmd.get(cmd) ?? 0;
        const next = prev + 1;
        this.shellFailsByCmd.set(cmd, next);
        if (next >= 2 && !this.firedOnce.has("shell_repeat_fail")) {
          this.firedOnce.add("shell_repeat_fail");
          return {
            pattern: "shell_repeat_fail",
            role: "system",
            message:
              `The command \`${cmd}\` has failed twice via \`${rec.tool}\`. ` +
              `Read the error message carefully — chances are a dependency is missing, a path is wrong, ` +
              `or the working directory isn't what you expected. Try a smaller diagnostic command first ` +
              `(\`pwd\`, \`ls\`, \`which …\`) rather than re-running the same command.`,
          };
        }
      }
    }

    // 6. Identical repeat (generic backstop) ─────────────────────────────
    if (isRepeat && !this.firedOnce.has("identical_repeat")) {
      this.firedOnce.add("identical_repeat");
      return {
        pattern: "identical_repeat",
        role: "system",
        message:
          `The last two calls to \`${rec.tool}\` used identical arguments and produced the same error. ` +
          `Stop repeating this call. Inspect the error message carefully and try a different approach — ` +
          `different arguments, a different tool, or report that you're stuck.`,
      };
    }

    return null;
  }
}
