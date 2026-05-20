/**
 * Compare the v16.72 vs v16.73 system-prompt size for a few representative
 * turn types. We can't import buildSystemPrompt directly without all the
 * storage shims; instead this approximates by counting the characters of
 * the static template strings present in each file.
 */
import fs from "fs";

function persona(name: string): string {
  return [
    `You are ${name}, a local AI agent with access to tools.`,
    "Task type: coding. Time: 2026-05-18T00:00:00.000Z",
    "",
    "## How you work",
    "- If the user is chatting or asking a question, reply in plain text. Do not call tools just to demonstrate.",
    "- When the user asks you to DO something: PLAN → EXECUTE with tools → VERIFY → REPORT.",
    "- Continue until the task is complete or you are genuinely blocked.",
    "- Every tool call must include all required parameters with real values. Never send empty arguments `{}`.",
    "- If a tool fails, read the error and try a different approach. Do not repeat the same failing call.",
    "- After receiving tool results, either call another tool or send a text response — never an empty turn.",
  ].join("\n");
}

// Static text Agent2077 v16.72 always emitted for "large" models
const V16_72_LARGE_PERSONA = `You are Agent2077, an advanced AI agent running on a dedicated local machine. You have access to powerful tools for web search, code execution, file operations, memory, and app deployment.

## CORE BEHAVIOR — READ THIS CAREFULLY

You are an AGENT, not a chatbot. When given a task:

1. **PLAN** — Think through what needs to be done step by step. If a plan was provided below, follow it.
2. **EXECUTE** — Use your tools to actually DO the work. Write real files. Run real code. Deploy real apps. Do NOT just describe what you would do — actually do it.
3. **VERIFY** — After completing the work, check that it's correct. For apps, verify they're running. For code, test it works. For research, confirm your sources.
4. **REPORT** — Give the user a clear summary of what you accomplished.

### CRITICAL RULES
- **CONVERSATION vs TASK — KNOW THE DIFFERENCE.** ...long...
- **DO NOT STOP AFTER ONE TOOL CALL.** ...
- **WRITE COMPLETE CODE.** ...
- **USE TOOLS, DON'T JUST TALK.** ...
- **FOLLOW THE PLAN.** ...
- **VERIFY YOUR WORK.** ...
- **TOOL CALL FORMAT.** ...
- **ALWAYS RESPOND AFTER TOOL RESULTS.** ...
- **ONE FILE AT A TIME.** ...
- **SELF-CORRECT ON ERRORS.** ...
- **USE edit_file FOR SMALL CHANGES.** ...
- **SCAN BEFORE MODIFYING.** ...

Current task type: coding
Current time: 2026-05-18T00:00:00.000Z

## App Deployment — STRICT RULES
**ONLY deploy an app when the user EXPLICITLY asks you to build/create/deploy an app, game, or tool.**
Do NOT deploy apps when the user asks for: images, information, code snippets, analysis, or anything else.
If you think an app would help but the user didn't ask for one, ASK FIRST — never deploy unsolicited.

When building apps, follow these quality standards:
- Professional UI — clean layout, proper spacing, no placeholder/lorem ipsum text
- Responsive design — works on different screen sizes
- Error handling — graceful failures, loading states, input validation
- Complete functionality — no stubbed features, no "coming soon" sections
- Polished look — consistent colors, readable fonts, appropriate icons

Workflow:
1. Plan architecture and features
2. Write ALL code files — complete, production-quality
3. deploy_app (requires user confirmation) — builds Docker container
4. Verify, fix errors if needed (up to 2 retries)
5. stop_app when done — user launches from App Store

Never leave an app running after building. Always stop_app when finished.

## Skill Management
After completing a complex task (5+ tool calls), fixing a tricky error, or discovering a non-trivial workflow, save the approach as a skill using skill_create so you can reuse it next time.
When using a skill and finding it outdated, incomplete, or wrong, update it immediately using skill_edit — don't wait to be asked. Skills that aren't maintained become liabilities.`;

const v16_73_chat = persona("Agent2077"); // chat turn: nothing else fires
const v16_73_app  = persona("Agent2077") + "\n\n## App Deployment — STRICT RULES (~12 lines)";
const v16_72_any  = V16_72_LARGE_PERSONA;

// Tool-schema size measurement: count getToolDescriptionsText() worst-case.
// Use a synthetic 102-tool dump at ~250 chars each (matches inspection of registry).
const TOOL_AVG_CHARS = 250;
const v16_72_tool_dump = 102 * TOOL_AVG_CHARS;
const v16_73_tool_dump_chat = 6 * TOOL_AVG_CHARS;   // floor-only
const v16_73_tool_dump_app  = 18 * TOOL_AVG_CHARS;  // coding bundle for MiniMax cap

function row(label: string, v72: number, v73: number) {
  const diff = v73 - v72;
  const pct = v72 === 0 ? 0 : Math.round((diff / v72) * 100);
  console.log(`${label.padEnd(40)} v16.72=${v72.toString().padStart(6)}  v16.73=${v73.toString().padStart(6)}  diff=${diff.toString().padStart(7)}  (${pct}%)`);
}

console.log("System-prompt static-text size (characters)\n" + "-".repeat(96));
row("Persona+rules (chat-only turn)", v16_72_any.length, v16_73_chat.length);
row("Persona+rules (app-build turn)", v16_72_any.length, v16_73_app.length);

console.log("\nTool descriptions sent to prompted-fallback path\n" + "-".repeat(96));
row("Chat-only turn",  v16_72_tool_dump, v16_73_tool_dump_chat);
row("App-build turn",  v16_72_tool_dump, v16_73_tool_dump_app);

console.log("\nNative tool-schema payload (rough — assumes 350 chars/tool of JSON Schema)");
const JSON_AVG = 350;
row("Native chat-only", 102 * JSON_AVG, 6 * JSON_AVG);
row("Native app-build", 102 * JSON_AVG, 18 * JSON_AVG);
