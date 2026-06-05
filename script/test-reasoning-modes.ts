/**
 * Reasoning / Thinking modes smoke tests (v16.74.5):
 *  - schema: reasoningProfilesSchema accepts valid presets and rejects garbage
 *  - schema: resolveReasoningProfile id/label/default/legacy/off resolution
 *  - llm-client: applyReasoning request shaping per strategy/provider
 *      · openai_effort  → reasoning_effort (OpenAI) / reasoning.effort (OpenRouter)
 *                         / thinking budget (LM Studio local)
 *      · anthropic_budget → thinking block / reasoning.max_tokens on OpenRouter
 *      · prompt_prefix  → instruction injected into the system message
 *      · custom_json    → only allowlisted keys merged; unknown keys dropped
 *      · null profile   → legacy thinkingEnabled behaviour preserved exactly
 *
 * Run with: npx tsx script/test-reasoning-modes.ts
 */
import {
  reasoningProfilesSchema,
  resolveReasoningProfile,
  parseReasoningProfiles,
  type ReasoningProfile,
} from "../shared/schema.js";
import { applyReasoning } from "../server/lib/llm-client.js";
import type { ChatMessage } from "../server/lib/llm-client.js";
import type { Endpoint, Model } from "../shared/schema.js";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${label}${detail ? " — " + detail : ""}`);
  if (!ok) { failures++; process.exitCode = 1; }
}

// Minimal endpoint/model fixtures. applyReasoning only reads url/providerType
// (endpoint) and modelId (model), so these stubs are sufficient.
const openrouterEp = { url: "https://openrouter.ai/api/v1", providerType: "openrouter" } as unknown as Endpoint;
const openaiEp = { url: "https://api.example.com/v1", providerType: "openai_compatible" } as unknown as Endpoint;
const localEp = { url: "http://localhost:1234/v1", providerType: "lmstudio" } as unknown as Endpoint;
const model = { modelId: "gpt-5", thinkingEnabled: false } as unknown as Model;

// ── Schema validation ──────────────────────────────────────────────────────
{
  const valid: ReasoningProfile[] = [
    { id: "a", label: "OpenAI High", strategy: "openai_effort", level: "high" },
    { id: "b", label: "Budget 8k", strategy: "anthropic_budget", budgetTokens: 8000, isDefault: true },
    { id: "c", label: "Be terse", strategy: "prompt_prefix", promptPrefix: "Think step by step." },
    { id: "d", label: "Off", strategy: "off" },
  ];
  check("schema: valid profile array accepted", reasoningProfilesSchema.safeParse(valid).success);

  check("schema: rejects unknown strategy",
    !reasoningProfilesSchema.safeParse([{ id: "x", label: "X", strategy: "bogus" }]).success);
  check("schema: rejects missing id",
    !reasoningProfilesSchema.safeParse([{ label: "X", strategy: "auto" }]).success);
  check("schema: rejects negative budget",
    !reasoningProfilesSchema.safeParse([{ id: "x", label: "X", strategy: "anthropic_budget", budgetTokens: -5 }]).success);

  // parseReasoningProfiles tolerates garbage and round-trips JSON.
  check("parse: null → []", parseReasoningProfiles(null).length === 0);
  check("parse: garbage → []", parseReasoningProfiles("{not json").length === 0);
  check("parse: valid JSON round-trips", parseReasoningProfiles(JSON.stringify(valid)).length === 4);
}

// ── resolveReasoningProfile ────────────────────────────────────────────────
{
  const profiles: ReasoningProfile[] = [
    { id: "p1", label: "OpenAI High", strategy: "openai_effort", level: "high" },
    { id: "p2", label: "Budget", strategy: "anthropic_budget", budgetTokens: 8000, isDefault: true },
  ];
  const m = { reasoningProfiles: JSON.stringify(profiles), thinkingEnabled: false };

  check("resolve: by id", resolveReasoningProfile(m, "p1")?.id === "p1");
  check("resolve: by label fallback (id miss)",
    resolveReasoningProfile(m, "nonexistent-id", "Budget")?.id === "p2");
  check("resolve: __off__ special id", resolveReasoningProfile(m, "__off__")?.strategy === "off");
  check("resolve: default when nothing chosen", resolveReasoningProfile(m)?.id === "p2");

  // Legacy: thinkingEnabled with no profiles synthesizes a high-effort profile.
  const legacy = { reasoningProfiles: null, thinkingEnabled: true };
  const lp = resolveReasoningProfile(legacy);
  check("resolve: legacy thinkingEnabled → synthesized high effort",
    lp?.id === "__legacy__" && lp?.strategy === "openai_effort" && lp?.level === "high");

  check("resolve: no profiles, no legacy → null",
    resolveReasoningProfile({ reasoningProfiles: null, thinkingEnabled: false }) === null);
}

// ── applyReasoning: openai_effort across providers ─────────────────────────
{
  const p: ReasoningProfile = { id: "x", label: "High", strategy: "openai_effort", level: "high" };

  const bOR: any = {};
  applyReasoning(bOR, [], openrouterEp, model, p);
  check("openai_effort/OpenRouter → reasoning.effort=high", bOR.reasoning?.effort === "high");

  const bOAI: any = {};
  applyReasoning(bOAI, [], openaiEp, model, p);
  check("openai_effort/OpenAI → reasoning_effort=high", bOAI.reasoning_effort === "high");

  const bLocal: any = {};
  applyReasoning(bLocal, [], localEp, model, p);
  check("openai_effort/local → thinking budget 12000",
    bLocal.thinking?.type === "enabled" && bLocal.thinking?.budget_tokens === 12000);

  const pLow: ReasoningProfile = { id: "y", label: "Low", strategy: "openai_effort", level: "low" };
  const bLow: any = {};
  applyReasoning(bLow, [], localEp, model, pLow);
  check("openai_effort/local low → thinking budget 2000", bLow.thinking?.budget_tokens === 2000);
}

// ── applyReasoning: anthropic_budget ───────────────────────────────────────
{
  const p: ReasoningProfile = { id: "x", label: "B", strategy: "anthropic_budget", budgetTokens: 5000 };

  const bOAI: any = {};
  applyReasoning(bOAI, [], openaiEp, model, p);
  check("anthropic_budget/OpenAI → thinking block 5000",
    bOAI.thinking?.type === "enabled" && bOAI.thinking?.budget_tokens === 5000);

  const bOR: any = {};
  applyReasoning(bOR, [], openrouterEp, model, p);
  check("anthropic_budget/OpenRouter → reasoning.max_tokens 5000", bOR.reasoning?.max_tokens === 5000);

  const pNoBudget: ReasoningProfile = { id: "z", label: "B", strategy: "anthropic_budget" };
  const bDef: any = {};
  applyReasoning(bDef, [], openaiEp, model, pNoBudget);
  check("anthropic_budget: defaults to 8000 when unset", bDef.thinking?.budget_tokens === 8000);
}

// ── applyReasoning: prompt_prefix ──────────────────────────────────────────
{
  const p: ReasoningProfile = { id: "x", label: "P", strategy: "prompt_prefix", promptPrefix: "Reason carefully." };

  const msgsWithSys: ChatMessage[] = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "hi" },
  ];
  applyReasoning({}, msgsWithSys, openaiEp, model, p);
  check("prompt_prefix: prepends to existing system message",
    msgsWithSys[0].content?.startsWith("Reason carefully.") === true &&
    msgsWithSys[0].content?.includes("You are helpful.") === true);

  const msgsNoSys: ChatMessage[] = [{ role: "user", content: "hi" }];
  applyReasoning({}, msgsNoSys, openaiEp, model, p);
  check("prompt_prefix: inserts new system message when none exists",
    msgsNoSys[0].role === "system" && msgsNoSys[0].content === "Reason carefully.");
}

// ── applyReasoning: custom_json allowlist ──────────────────────────────────
{
  const p: ReasoningProfile = {
    id: "x", label: "C", strategy: "custom_json",
    customBody: {
      reasoning_effort: "medium",          // allowlisted top-level
      extra_body: { foo: 1 },              // allowlisted, merged into extra_body
      model: "evil-override",              // NOT allowlisted → dropped
      messages: [{ role: "user" }],        // NOT allowlisted → dropped
    },
  };
  const b: any = { model: "gpt-5", messages: ["original"] };
  applyReasoning(b, [], openaiEp, model, p);
  check("custom_json: allowlisted key merged", b.reasoning_effort === "medium");
  check("custom_json: extra_body merged", b.extra_body?.foo === 1);
  check("custom_json: core 'model' NOT clobbered", b.model === "gpt-5");
  check("custom_json: core 'messages' NOT clobbered", Array.isArray(b.messages) && b.messages[0] === "original");
}

// ── applyReasoning: null profile preserves legacy behaviour ────────────────
{
  // OpenRouter, thinkingEnabled on → reasoning.effort high
  const orModel = { modelId: "anthropic/claude", thinkingEnabled: true } as unknown as Model;
  const bOR: any = {};
  applyReasoning(bOR, [], openrouterEp, orModel, null);
  check("legacy null/OR: thinkingEnabled → reasoning.effort=high", bOR.reasoning?.effort === "high");

  // OpenAI-compat, non-minimax, thinking OFF → disables via chat_template_kwargs
  const offModel = { modelId: "qwen3", thinkingEnabled: false } as unknown as Model;
  const bOff: any = {};
  applyReasoning(bOff, [], openaiEp, offModel, null);
  check("legacy null/OpenAI off: disables enable_thinking",
    bOff.extra_body?.chat_template_kwargs?.enable_thinking === false);

  // Local, thinkingEnabled on → thinking budget 8000
  const bLocal: any = {};
  applyReasoning(bLocal, [], localEp, offModel, null);
  check("legacy null/local off: no thinking block added", bLocal.thinking === undefined);
}

// ── applyReasoning: off / auto strategies ──────────────────────────────────
{
  const bAuto: any = {};
  applyReasoning(bAuto, [], openaiEp, model, { id: "x", label: "A", strategy: "auto" });
  check("auto: sends nothing extra",
    bAuto.reasoning === undefined && bAuto.reasoning_effort === undefined && bAuto.thinking === undefined);

  const bOff: any = {};
  applyReasoning(bOff, [], openaiEp, model, { id: "x", label: "O", strategy: "off" });
  check("off/OpenAI: disables enable_thinking",
    bOff.extra_body?.chat_template_kwargs?.enable_thinking === false);
}

if (failures > 0) {
  console.error(`\n${failures} TEST(S) FAILED`);
  process.exit(1);
}
console.log("\nAll reasoning-mode smoke tests passed.");
