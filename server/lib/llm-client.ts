/**
 * LLM Client — Model-agnostic interface to LM Studio & cloud endpoints
 * Supports OpenAI-compatible tool calling + prompted fallback
 * Cloud / OpenAI-compatible providers use the same /v1/chat/completions
 * endpoint with Bearer token auth.
 */
import { Endpoint, Model, type ReasoningProfile } from "../../shared/schema.js";
import { analyticsStore, settingsStore } from "../storage.js";
import { recordInspectorRequest } from "./inspector.js";

// ── OpenRouter balance floor cache ────────────────────────────────────────────
// When a floor is configured we ALWAYS fetch live — stale cache is what
// causes overspend (e.g. 60s window lets requests slip past the floor).
// When no floor is set we cache for 60s for the UI badge display only.
const orBalanceCache = new Map<number, { balance: number; fetchedAt: number }>();
const OR_BALANCE_CACHE_TTL_MS = 60_000;

/**
 * Fetches the current OpenRouter credit balance for an endpoint.
 * Returns null if the endpoint has no API key or fetch fails.
 */
export async function fetchOpenRouterBalance(endpoint: Endpoint): Promise<number | null> {
  if (!endpoint.apiKey) return null;
  // Hard 5-second timeout — if the credits API hangs we must not block LLM requests
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
    console.warn("[BalanceCheck] OpenRouter credits API timed out after 5s — skipping floor check");
  }, 5000);
  try {
    const r = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${endpoint.apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const data = await r.json();
    const { total_credits = 0, total_usage = 0 } = data.data ?? {};
    return total_credits - total_usage;
  } catch {
    clearTimeout(timer);
    return null; // timeout, network error, or abort — don't block the request
  }
}

/** Bust the cached balance for an endpoint — call after each completed request. */
export function invalidateOpenRouterBalanceCache(endpointId: number): void {
  orBalanceCache.delete(endpointId);
}

/**
 * Returns cached balance if fresh, otherwise fetches and caches.
 * When hasFloor=true the cache is always bypassed so we never use
 * a stale value that could allow spending past the floor.
 */
async function getCachedBalance(endpoint: Endpoint, hasFloor: boolean): Promise<number | null> {
  if (!hasFloor) {
    // No floor — use cached value for UI badge (60s TTL)
    const cached = orBalanceCache.get(endpoint.id);
    if (cached && (Date.now() - cached.fetchedAt) < OR_BALANCE_CACHE_TTL_MS) {
      return cached.balance;
    }
  }
  // Floor is set — always fetch live to prevent overspend
  const balance = await fetchOpenRouterBalance(endpoint);
  if (balance !== null) {
    orBalanceCache.set(endpoint.id, { balance, fetchedAt: Date.now() });
  }
  return balance;
}

/**
 * Checks whether the balance floor setting blocks use of this endpoint.
 * Always fetches a live balance when a floor is configured.
 * Returns an error string if blocked, null if OK to proceed.
 */
export async function checkOpenRouterBalanceFloor(endpoint: Endpoint): Promise<string | null> {
  if (!isOpenRouterEndpoint(endpoint)) return null;
  const floorSetting = settingsStore.get(`openrouter.balanceFloor.${endpoint.id}`);
  if (!floorSetting || !floorSetting.trim()) return null; // no floor set
  const floor = parseFloat(floorSetting);
  if (isNaN(floor) || floor <= 0) return null;

  const balance = await getCachedBalance(endpoint, true); // always live when floor is set
  if (balance === null) return null; // network error — don't block, log and continue

  if (balance < floor) {
    return `__OPENROUTER_BALANCE_FLOOR__:${balance.toFixed(4)}:${floor.toFixed(4)}`;
  }
  return null;
}

// ── Provider-type normalisation (v16.73.3) ──────────────────────────────────
// Canonical values: lmstudio | openrouter | openai_compatible.
// Older databases may have stored legacy provider keys — keep treating them
// as the generic OpenAI-compatible bucket so existing rows keep working without
// a migration. Also accept "openai-compatible" (hyphen) as a synonym.
export function normalizeProviderType(raw?: string | null): "lmstudio" | "openrouter" | "openai_compatible" {
  const t = (raw || "lmstudio").toLowerCase();
  if (t === "lmstudio" || t === "local") return "lmstudio";
  if (t === "openrouter") return "openrouter";
  // Legacy provider keys / openai-compatible / openai_compatible / anything
  // else → generic.
  return "openai_compatible";
}

// ── Optional free-tier rate limiter for known OpenAI-compatible hosts ───────
// URL-driven only: if a user points the generic OpenAI-compatible provider at a
// known low-RPM free-tier host, the guard kicks in. For other OpenAI-compatible
// hosts (Together, Fireworks, Groq, OpenAI, etc.) it stays out of the way; the
// provider's own 429 handling takes over.
const freeTierRequestTimestamps: Map<string, number[]> = new Map();
const freeTierLastRequestTime: Map<string, number> = new Map();
const FREE_TIER_RPM_LIMIT = 35;        // conservative free-tier default
const FREE_TIER_MIN_SPACING_MS = 1715; // 60000ms / 35
const FREE_TIER_WINDOW_MS = 60_000;

function isRateLimitedFreeTier(endpoint: { url: string; providerType?: string | null }): boolean {
  const url = endpoint.url || "";
  return (
    url.includes("integrate.api.nvidia.com") ||
    url.includes("api.nvcf.nvidia.com")
  );
}

export function isOpenRouterEndpoint(endpoint: { url: string; providerType?: string | null }): boolean {
  return (
    normalizeProviderType(endpoint.providerType) === "openrouter" ||
    (endpoint.url || "").includes("openrouter.ai")
  );
}

/** Thrown when OpenRouter rejects due to insufficient credits (402). */
export class OpenRouterCreditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenRouterCreditError";
  }
}

async function applyFreeTierThrottle(endpointUrl: string): Promise<void> {
  // 1) Minimum spacing between requests to prevent burst exhausting the
  // fixed-window quota.
  const last = freeTierLastRequestTime.get(endpointUrl) ?? 0;
  const sinceLast = Date.now() - last;
  if (sinceLast < FREE_TIER_MIN_SPACING_MS) {
    const spaceWait = FREE_TIER_MIN_SPACING_MS - sinceLast;
    console.log(`[LLM Client] free-tier spacing: waiting ${Math.round(spaceWait)}ms`);
    await new Promise(r => setTimeout(r, spaceWait));
  }

  // 2) Rolling-window RPM check
  const now = Date.now();
  const windowStart = now - FREE_TIER_WINDOW_MS;
  const timestamps = (freeTierRequestTimestamps.get(endpointUrl) ?? []).filter(t => t > windowStart);
  freeTierRequestTimestamps.set(endpointUrl, timestamps);

  if (timestamps.length >= FREE_TIER_RPM_LIMIT) {
    const oldest = timestamps[0];
    const waitMs = oldest + FREE_TIER_WINDOW_MS - now + 500;
    if (waitMs > 0) {
      console.log(`[LLM Client] free-tier throttle: ${timestamps.length}/${FREE_TIER_RPM_LIMIT} RPM — waiting ${Math.round(waitMs)}ms`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  // Record this request
  const ts = Date.now();
  timestamps.push(ts);
  freeTierRequestTimestamps.set(endpointUrl, timestamps);
  freeTierLastRequestTime.set(endpointUrl, ts);
}

/** Jittered exponential backoff delay in milliseconds. */
function jitteredBackoff(attempt: number, baseMs = 3000, maxMs = 60000): number {
  const delay = Math.min(baseMs * Math.pow(2, attempt - 1), maxMs);
  return delay + Math.random() * 0.5 * delay;
}

/** Build headers for a given endpoint — adds Bearer auth for cloud providers */
/**
 * Normalize an endpoint base URL by stripping any trailing /v1 segment.
 * Prevents double-path bugs for providers like OpenRouter whose stored URL
 * already ends in /api/v1 — we always append /v1/... ourselves.
 */
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/v1\/?$/, "");
}

function buildHeaders(endpoint: Endpoint): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (endpoint.apiKey) {
    headers["Authorization"] = `Bearer ${endpoint.apiKey}`;
  }
  return headers;
}

/** Check if an endpoint is a local provider (LM Studio) vs cloud / OpenAI-compatible. */
export function isLocalProvider(endpoint: Endpoint): boolean {
  return normalizeProviderType(endpoint.providerType) === "lmstudio";
}

/**
 * Returns true if the model is a MiniMax M2 variant.
 * MiniMax uses --reasoning-parser minimax_m2 at the vLLM level — it does NOT
 * use chat_template_kwargs to control thinking. Sending that param causes errors.
 */
function isMiniMaxModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return id.includes("minimax") || id.includes("minimax-m2") || id.includes("m2.7");
}

// ── Reasoning / thinking request shaping (v16.74.5) ─────────────────────────
// Allowlist of top-level keys a `custom_json` profile may set on the request
// body. Keeps hand-edited JSON from clobbering core fields (model/messages/etc.)
// or injecting anything dangerous. `reasoning`, `thinking` and `extra_body` are
// the common reasoning carriers across OpenAI/Anthropic/OpenRouter/vLLM.
const CUSTOM_JSON_ALLOWLIST = new Set([
  "reasoning", "reasoning_effort", "thinking", "extra_body",
  "thinkingConfig", "chat_template_kwargs", "verbosity", "reasoning_format",
]);

/**
 * Inject a prompt-prefix instruction into the message list.
 * Appends to the first system message if present, otherwise prepends a new one.
 * Mutates `messages` in place (a shallow copy of the original array is fine —
 * agent-loop passes a fresh array each call).
 */
function injectPromptPrefix(messages: ChatMessage[], prefix: string): void {
  if (!prefix.trim()) return;
  const sys = messages.find(m => m.role === "system");
  if (sys) {
    sys.content = `${prefix.trim()}\n\n${sys.content ?? ""}`;
  } else {
    messages.unshift({ role: "system", content: prefix.trim() });
  }
}

/**
 * Shape the request body for a resolved reasoning profile.
 *
 * When `profile` is null we preserve the legacy behaviour: honour the per-model
 * `thinkingEnabled` boolean exactly as before, so existing setups are unchanged.
 *
 * Strategy → request shaping:
 *  - off                  → explicitly disable where the provider supports it
 *  - auto                 → send nothing extra (provider/model decides)
 *  - openai_effort        → reasoning_effort (OpenAI) / reasoning.effort (OpenRouter)
 *  - anthropic_budget     → thinking { type:'enabled', budget_tokens }
 *  - gemini_budget        → extra_body.thinkingConfig.thinkingBudget (best-effort)
 *  - openrouter_extra_body→ merge customBody into reasoning {} (OpenRouter only)
 *  - prompt_prefix        → inject instruction into the prompt (provider-agnostic)
 *  - custom_json          → merge allowlisted top-level keys into the body
 *
 * Provider-unsupported strategies are no-ops rather than errors, so a profile
 * authored for one provider never crashes a request on another.
 */
export function applyReasoning(
  body: any,
  messages: ChatMessage[],
  endpoint: Endpoint,
  model: Model,
  profile: ReasoningProfile | null,
): void {
  const isOR = isOpenRouterEndpoint(endpoint);
  const isLocal = isLocalProvider(endpoint);
  const isMiniMax = isMiniMaxModel(model.modelId);

  // ── Legacy fallback: no profile selected/configured ──────────────────────
  if (!profile) {
    const thinkingOn = !!(model as any).thinkingEnabled;
    if (isOR) {
      if (thinkingOn) body.reasoning = { effort: "high" };
    } else if (isLocal) {
      if (thinkingOn) body.thinking = { type: "enabled", budget_tokens: 8000 };
    } else {
      if (!isMiniMax && !thinkingOn) {
        body.extra_body = { ...(body.extra_body ?? {}), chat_template_kwargs: { enable_thinking: false } };
      }
    }
    return;
  }

  const level = profile.level ?? "high";

  switch (profile.strategy) {
    case "off": {
      // Explicitly disable thinking where the provider exposes a switch.
      if (!isOR && !isLocal && !isMiniMax) {
        body.extra_body = { ...(body.extra_body ?? {}), chat_template_kwargs: { enable_thinking: false } };
      }
      // OpenRouter / LM Studio default OFF when no reasoning param is sent — nothing to do.
      break;
    }
    case "auto":
      // Provider/model decides — send nothing extra.
      break;
    case "openai_effort": {
      if (isOR) {
        body.reasoning = { ...(body.reasoning ?? {}), effort: level };
      } else if (isLocal) {
        // LM Studio honours a thinking block; map effort → a budget heuristic.
        const budget = level === "low" ? 2000 : level === "medium" ? 6000 : 12000;
        body.thinking = { type: "enabled", budget_tokens: budget };
      } else {
        // OpenAI-compatible (o-series, gpt-5, vLLM shims that accept it).
        body.reasoning_effort = level;
      }
      break;
    }
    case "anthropic_budget": {
      const budget = profile.budgetTokens && profile.budgetTokens > 0 ? profile.budgetTokens : 8000;
      if (isOR) {
        // OpenRouter normalises Anthropic thinking via reasoning.max_tokens.
        body.reasoning = { ...(body.reasoning ?? {}), max_tokens: budget };
      } else {
        // Anthropic-native style and LM Studio both accept a thinking block.
        body.thinking = { type: "enabled", budget_tokens: budget };
      }
      break;
    }
    case "gemini_budget": {
      // Gemini's OpenAI-compat path accepts thinkingConfig under extra_body on
      // some gateways; where unsupported this is a harmless no-op extra field.
      const budget = profile.budgetTokens && profile.budgetTokens > 0 ? profile.budgetTokens : 8000;
      body.extra_body = {
        ...(body.extra_body ?? {}),
        thinkingConfig: { thinkingBudget: budget },
      };
      break;
    }
    case "openrouter_extra_body": {
      // Only meaningful on OpenRouter — merge user's reasoning blob.
      if (isOR && profile.customBody && typeof profile.customBody === "object") {
        body.reasoning = { ...(body.reasoning ?? {}), ...profile.customBody };
      }
      break;
    }
    case "prompt_prefix": {
      if (profile.promptPrefix) injectPromptPrefix(messages, profile.promptPrefix);
      break;
    }
    case "custom_json": {
      const blob = profile.customBody;
      if (blob && typeof blob === "object") {
        for (const [k, v] of Object.entries(blob)) {
          if (!CUSTOM_JSON_ALLOWLIST.has(k)) continue;
          if (k === "extra_body" && typeof v === "object" && v) {
            body.extra_body = { ...(body.extra_body ?? {}), ...(v as object) };
          } else {
            body[k] = v;
          }
        }
      }
      break;
    }
  }
}

/**
 * Strip <think>...</think> blocks from streamed content.
 * Some models (MiniMax M2.7, DeepSeek-R1, etc.) emit reasoning tokens inline
 * in the content field rather than a separate reasoning_content field.
 * We strip them so the UI only shows the final answer.
 * Handles partial (mid-stream) blocks by tracking state.
 */
class ThinkTagStripper {
  private inThinkBlock = false;
  private tagBuffer = ""; // accumulates partial tag chars

  process(chunk: string): string {
    let out = "";
    let i = 0;
    while (i < chunk.length) {
      if (this.inThinkBlock) {
        // Look for closing </think>
        const closeIdx = chunk.indexOf("</think>", i);
        if (closeIdx !== -1) {
          this.inThinkBlock = false;
          i = closeIdx + 8; // skip past </think>
        } else {
          break; // rest of chunk is inside think block — discard
        }
      } else {
        // Look for opening <think>
        const openIdx = chunk.indexOf("<think>", i);
        if (openIdx !== -1) {
          out += chunk.slice(i, openIdx);
          this.inThinkBlock = true;
          i = openIdx + 7; // skip past <think>
        } else {
          out += chunk.slice(i);
          break;
        }
      }
    }
    return out;
  }
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface LLMResponse {
  content: string | null;
  toolCalls: ToolCall[];
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  finishReason: string;
  modelUsed: string;
}

export interface StreamChunk {
  type: "content" | "thinking" | "tool_call" | "done" | "error";
  content?: string;
  toolCall?: Partial<ToolCall>;
  tokensIn?: number;
  tokensOut?: number;
  finishReason?: string;
}

// Rough chars-per-token used to estimate token counts when a provider omits the
// `usage` object (common for LM Studio / llama.cpp / Ollama streaming). Mirrors
// agent-loop's CHARS_PER_TOKEN so analytics estimates stay consistent with the
// context gauge.
const EST_CHARS_PER_TOKEN = 4;

/** Estimate prompt tokens from request messages + tool schemas (char/4 heuristic). */
function estimateMessagesTokens(messages: ChatMessage[], tools?: ToolDefinition[]): number {
  let chars = 0;
  for (const msg of messages) {
    chars += (msg.content || "").length;
    if ((msg as any).tool_calls) chars += JSON.stringify((msg as any).tool_calls).length;
  }
  if (tools?.length) chars += JSON.stringify(tools).length;
  return Math.max(1, Math.ceil(chars / EST_CHARS_PER_TOKEN));
}

// Track active AbortControllers per request so we can cancel from outside
const activeRequests = new Map<string, AbortController>();

export function cancelRequest(requestId: string) {
  const controller = activeRequests.get(requestId);
  if (controller) {
    controller.abort();
    activeRequests.delete(requestId);
  }
}

/**
 * Send a chat completion request to an LM Studio endpoint
 */
export async function chatCompletion(
  endpoint: Endpoint,
  model: Model,
  messages: ChatMessage[],
  options: {
    tools?: ToolDefinition[];
    temperature?: number;
    topP?: number;
    maxTokens?: number; // Only sent if explicitly set — otherwise LM Studio decides
    stream?: false;
    requestId?: string;
    conversationId?: number; // Recorded into analytics metadata for per-conversation token usage
    taskType?: string;       // Recorded into analytics for task-type distribution
    reasoning?: ReasoningProfile | null; // v16.74.5: resolved per-request thinking profile
  } = {}
): Promise<LLMResponse> {
  // ── OpenRouter balance floor pre-flight check ─────────────────────────────
  const floorErr = await checkOpenRouterBalanceFloor(endpoint);
  if (floorErr) {
    return { role: "assistant", content: floorErr, toolCalls: [], error: true };
  }

  const controller = new AbortController();
  if (options.requestId) {
    activeRequests.set(options.requestId, controller);
  }

  const startTime = Date.now();

  const body: any = {
    model: model.modelId,
    messages,
    temperature: options.temperature ?? 0.7,
    stream: false,
  };

  if (options.topP !== undefined) {
    body.top_p = options.topP;
  }

  // Only cap tokens if explicitly requested — let LM Studio decide by default
  if (options.maxTokens) {
    body.max_tokens = options.maxTokens;
  }

  // Add tools if model supports them and tools are provided.
  // v16.73: last-resort MiniMax cap — even with smart selection on, never send
  // more than 18 tools to MiniMax (parser spirals into infinite reasoning).
  if (options.tools?.length && model.supportsToolCalling) {
    let outTools = options.tools;
    if (isMiniMaxModel(model.modelId) && outTools.length > 18) {
      console.warn(`[LLM Client] MiniMax cap: trimming tools ${outTools.length} → 18`);
      outTools = outTools.slice(0, 18);
    }
    body.tools = outTools;
    body.tool_choice = "auto";
  }

  // Thinking / extended reasoning mode — shaped by the resolved profile (or the
  // legacy thinkingEnabled flag when no profile is supplied). See applyReasoning.
  applyReasoning(body, messages, endpoint, model, options.reasoning ?? null);

  const MAX_ATTEMPTS = 8;
  let lastErr: any;

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // 5-minute hard timeout per attempt — prevents hung cloud requests from
        // blocking the subtask (and the main loop) indefinitely.
        if (isRateLimitedFreeTier(endpoint)) await applyFreeTierThrottle(endpoint.url);
        const timeoutSignal = AbortSignal.timeout(300_000);
        const res = await fetch(`${normalizeBaseUrl(endpoint.url)}/v1/chat/completions`, {
          method: "POST",
          headers: buildHeaders(endpoint),
          body: JSON.stringify(body),
          signal: AbortSignal.any([controller.signal, timeoutSignal]),
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => "Unknown error");
          // Retry on transient server errors — respect Retry-After header for 429s
          if ([429, 500, 503].includes(res.status) && attempt < MAX_ATTEMPTS) {
            let waitMs = jitteredBackoff(attempt);
            if (res.status === 429) {
              const retryAfter = res.headers.get("retry-after") || res.headers.get("x-ratelimit-reset-requests");
              if (retryAfter) {
                const seconds = parseFloat(retryAfter);
                if (!isNaN(seconds)) waitMs = Math.max(waitMs, seconds * 1000 + 500);
              }
            }
            console.warn(`[LLM Client] chatCompletion attempt ${attempt}/${MAX_ATTEMPTS} failed (${res.status}) — retrying in ${Math.round(waitMs)}ms`);
            await new Promise(r => setTimeout(r, waitMs));
            continue;
          }
          // v16.40: detect OpenRouter credit exhaustion — throw typed error so agent-loop can pause & checkpoint
          if (res.status === 402 || (isOpenRouterEndpoint(endpoint) && errText.includes("insufficient"))) {
            throw new OpenRouterCreditError(`OpenRouter credit exhausted: ${errText.slice(0, 200)}`);
          }
          throw new Error(`LLM request failed (${res.status}): ${errText}`);
        }

        const data = await res.json();
        const choice = data.choices?.[0];
        const durationMs = Date.now() - startTime;

        const result: LLMResponse = {
          content: choice?.message?.content ?? null,
          toolCalls: choice?.message?.tool_calls ?? [],
          tokensIn: data.usage?.prompt_tokens ?? 0,
          tokensOut: data.usage?.completion_tokens ?? 0,
          durationMs,
          finishReason: choice?.finish_reason ?? "stop",
          modelUsed: model.modelId,
        };

        // Record analytics
        analyticsStore.record({
          eventType: "chat",
          modelId: model.modelId,
          endpointId: endpoint.id,
          taskType: options.taskType,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          durationMs,
          success: true,
          metadata: options.conversationId != null
            ? JSON.stringify({ conversationId: options.conversationId })
            : undefined,
        });

        // Bust balance cache after each completed request
        if (isOpenRouterEndpoint(endpoint)) {
          invalidateOpenRouterBalanceCache(endpoint.id);
        }

        return result;
      } catch (err: any) {
        if (err.name === "AbortError") {
          throw new Error("Request was cancelled");
        }
        // TimeoutError = our 5-min hard timeout fired — treat as a retryable error
        if (err.name === "TimeoutError") {
          console.warn(`[LLM Client] chatCompletion attempt ${attempt}/${MAX_ATTEMPTS} timed out after 5 minutes`);
          if (attempt < MAX_ATTEMPTS) {
            lastErr = err;
            continue; // retry immediately — provider was just slow/hung
          }
          throw new Error("LLM request timed out after 5 minutes (all attempts exhausted)");
        }
        // Retry on network errors
        if (attempt < MAX_ATTEMPTS) {
          const waitMs = jitteredBackoff(attempt);
          console.warn(`[LLM Client] chatCompletion attempt ${attempt}/${MAX_ATTEMPTS} network error — retrying in ${Math.round(waitMs)}ms:`, err.message);
          lastErr = err;
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new Error("chatCompletion: all retry attempts exhausted");
  } finally {
    if (options.requestId) activeRequests.delete(options.requestId);
  }
}

/**
 * Stream a chat completion — yields chunks as they arrive
 */
export async function* chatCompletionStream(
  endpoint: Endpoint,
  model: Model,
  messages: ChatMessage[],
  options: {
    tools?: ToolDefinition[];
    temperature?: number;
    topP?: number;
    maxTokens?: number; // Only sent if explicitly set — otherwise LM Studio decides
    requestId?: string;
    signal?: AbortSignal; // Optional external abort signal (e.g. loop-level controller)
    conversationId?: number; // Recorded into analytics metadata for per-conversation token usage
    taskType?: string;       // Recorded into analytics for task-type distribution
    reasoning?: ReasoningProfile | null; // v16.74.5: resolved per-request thinking profile
  } = {}
): AsyncGenerator<StreamChunk> {
  // If an external abort signal is already fired, don't even start
  if (options.signal?.aborted) {
    yield { type: "content", content: "Request cancelled" };
    return;
  }

  // ── OpenRouter balance floor pre-flight check ─────────────────────────────
  const floorErr = await checkOpenRouterBalanceFloor(endpoint);
  if (floorErr) {
    yield { type: "error", content: floorErr };
    return;
  }

  // Use a linked AbortController so either cancelRequest() OR the loop-level
  // signal can abort the fetch — whichever fires first.
  const controller = new AbortController();
  if (options.signal) {
    // Propagate external abort into this controller
    options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  if (options.requestId) {
    activeRequests.set(options.requestId, controller);
  }

  const startTime = Date.now();

  // ── Analytics state (function-scoped so it survives early consumer break) ──
  // Many local OpenAI-compatible servers (LM Studio, llama.cpp, Ollama's OpenAI
  // shim) do NOT emit a `usage` object in streaming responses. Without a fallback
  // we'd record tokensIn=tokensOut=0 — and, worse, the previous implementation
  // placed analyticsStore.record() AFTER the final `yield {type:"done"}`, so when
  // the agent loop breaks out of its `for await` on "done" the generator is
  // .return()'d and that code never ran. The net effect: zero analytics rows for
  // any streamed chat. We now record from inside the generator (before yielding
  // "done") via an idempotent helper, guaranteeing a row regardless of how the
  // consumer exits.
  let usageReported = false;
  let estCompletionChars = 0; // accumulated visible content length for fallback estimate
  let analyticsRecorded = false;
  const estPromptTokens = estimateMessagesTokens(messages, options.tools);
  const recordChatAnalytics = (tokensIn: number, tokensOut: number, success: boolean) => {
    if (analyticsRecorded) return;
    analyticsRecorded = true;
    // Fall back to char/4 estimates when the provider omitted usage tokens.
    const finalIn = tokensIn > 0 ? tokensIn : estPromptTokens;
    const finalOut = tokensOut > 0 ? tokensOut : Math.max(1, Math.ceil(estCompletionChars / EST_CHARS_PER_TOKEN));
    try {
      analyticsStore.record({
        eventType: "chat",
        modelId: model.modelId,
        endpointId: endpoint.id,
        taskType: options.taskType,
        tokensIn: finalIn,
        tokensOut: finalOut,
        durationMs: Date.now() - startTime,
        success,
        metadata: JSON.stringify({
          ...(options.conversationId != null ? { conversationId: options.conversationId } : {}),
          provider: endpoint.providerType ?? undefined,
          endpoint: endpoint.name || endpoint.url,
          estimated: !usageReported, // true when token counts are char/4 estimates
          streamed: true,
        }),
      });
    } catch (e: any) {
      console.warn(`[LLM Client] failed to record chat analytics:`, e?.message);
    }
  };

  const streamBody: any = {
    model: model.modelId,
    messages,
    temperature: options.temperature ?? 0.7,
    stream: true,
  };

  if (options.topP !== undefined) {
    streamBody.top_p = options.topP;
  }

  // Only cap tokens if explicitly requested — let LM Studio decide by default
  if (options.maxTokens) {
    streamBody.max_tokens = options.maxTokens;
  }

  if (options.tools?.length && model.supportsToolCalling) {
    let outTools = options.tools;
    // v16.73: last-resort MiniMax cap — see chatCompletion above for rationale.
    if (isMiniMaxModel(model.modelId) && outTools.length > 18) {
      console.warn(`[LLM Client] MiniMax cap (stream): trimming tools ${outTools.length} → 18`);
      outTools = outTools.slice(0, 18);
    }
    streamBody.tools = outTools;
    streamBody.tool_choice = "auto";
  }

  // Thinking / extended reasoning mode — shaped by the resolved profile (or the
  // legacy thinkingEnabled flag when no profile is supplied). See applyReasoning.
  applyReasoning(streamBody, messages, endpoint, model, options.reasoning ?? null);

  const MAX_STREAM_ATTEMPTS = 8;

  // Record to LLM Inspector (only on first attempt to avoid duplicate entries)
  recordInspectorRequest({
    requestId: options.requestId,
    model: model.modelId,
    endpoint: endpoint.name || endpoint.url,
    temperature: streamBody.temperature,
    topP: streamBody.top_p,
    stream: true,
    tools: streamBody.tools,
    messages: streamBody.messages,
  });

  for (let streamAttempt = 1; streamAttempt <= MAX_STREAM_ATTEMPTS; streamAttempt++) {
  try {
    if (isRateLimitedFreeTier(endpoint)) await applyFreeTierThrottle(endpoint.url);
    const res = await fetch(`${normalizeBaseUrl(endpoint.url)}/v1/chat/completions`, {
      method: "POST",
      headers: buildHeaders(endpoint),
      body: JSON.stringify(streamBody),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      // Retry on transient server errors — respect Retry-After header for 429s
      if ([429, 500, 503].includes(res.status) && streamAttempt < MAX_STREAM_ATTEMPTS) {
        let waitMs = jitteredBackoff(streamAttempt);
        if (res.status === 429) {
          const retryAfter = res.headers.get("retry-after") || res.headers.get("x-ratelimit-reset-requests");
          if (retryAfter) {
            const seconds = parseFloat(retryAfter);
            if (!isNaN(seconds)) waitMs = Math.max(waitMs, seconds * 1000 + 500);
          }
        }
        const bodySnippet = errText.slice(0, 200).replace(/\n/g, " ");
        console.warn(`[LLM Client] chatCompletionStream attempt ${streamAttempt}/${MAX_STREAM_ATTEMPTS} failed (${res.status}) — retrying in ${Math.round(waitMs)}ms | body: ${bodySnippet}`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      // v16.40: detect OpenRouter credit exhaustion in stream path
      if (res.status === 402 || (isOpenRouterEndpoint(endpoint) && errText.includes("insufficient"))) {
        yield { type: "error", content: `__OPENROUTER_CREDIT_EXHAUSTED__: ${errText.slice(0, 200)}` };
        return;
      }
      recordChatAnalytics(0, 0, false);
      yield { type: "error", content: `LLM error (${res.status}): ${errText}` };
      return;
    }

    const reader = res.body?.getReader();
    if (!reader) { recordChatAnalytics(0, 0, false); yield { type: "error", content: "No response body" }; return; }

    const decoder = new TextDecoder();
    let buffer = "";
    let tokensIn = 0, tokensOut = 0;
    let accumulatedToolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
    let doneEmitted = false;
    // Strip <think>...</think> reasoning blocks from streamed content.
    // MiniMax M2.7 and some other models emit reasoning tokens inline in the
    // content field — we strip them so the UI only shows the final answer.
    const thinkStripper = new ThinkTagStripper();

    // No streaming watchdog — LM Studio and the OS TCP stack handle timeouts.
    // Previous watchdog implementations caused more harm than good:
    // - Async generator yields pause execution but setTimeout keeps ticking
    // - HTTP 200 headers count as "data" before actual tokens arrive
    // - Timer leaked across requests causing premature aborts
    // The user can always cancel via the stop button (cancelRequest).

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") {
          if (trimmed === "data: [DONE]") {
            // Emit accumulated tool calls
            for (const [, tc] of accumulatedToolCalls) {
              yield {
                type: "tool_call",
                toolCall: {
                  id: tc.id,
                  type: "function",
                  function: { name: tc.name, arguments: tc.arguments },
                },
              };
            }
            doneEmitted = true;
            recordChatAnalytics(tokensIn, tokensOut, true);
            yield { type: "done", tokensIn, tokensOut, finishReason: "stop" };
          }
          continue;
        }
        if (!trimmed.startsWith("data: ")) continue;

        try {
          const data = JSON.parse(trimmed.slice(6));
          const delta = data.choices?.[0]?.delta;
          const finishReason = data.choices?.[0]?.finish_reason;

          if (data.usage) {
            if (data.usage.prompt_tokens || data.usage.completion_tokens) usageReported = true;
            tokensIn = data.usage.prompt_tokens || tokensIn;
            tokensOut = data.usage.completion_tokens || tokensOut;
          }

          // vLLM reasoning parsers (minimax_m2, deepseek_r1, etc.) split the
          // response into two separate delta fields:
          //   delta.reasoning  — thinking tokens (everything before </think>)
          //   delta.content    — the actual response (everything after </think>)
          // We must read both. Reasoning chunks are yielded as type:"thinking"
          // so the UI shows the thinking indicator while the model reasons.
          // Content chunks are the real answer and go through the ThinkTagStripper
          // as a safety net in case any model leaks <think> tags into content.
          const reasoningChunk: string | undefined =
            (delta as any)?.reasoning ||
            (delta as any)?.reasoning_content ||
            undefined;
          if (reasoningChunk) {
            yield { type: "thinking", content: reasoningChunk };
          }

          if (delta?.content) {
            const stripped = thinkStripper.process(delta.content);
            if (stripped) {
              estCompletionChars += stripped.length;
              yield { type: "content", content: stripped };
            }
          }

          // Accumulate streaming tool calls
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!accumulatedToolCalls.has(idx)) {
                accumulatedToolCalls.set(idx, { id: tc.id || `call_${idx}`, name: "", arguments: "" });
              }
              const acc = accumulatedToolCalls.get(idx)!;
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name = tc.function.name; // Replace, not append — names arrive complete
              if (tc.function?.arguments) {
                acc.arguments += tc.function.arguments;
                estCompletionChars += tc.function.arguments.length; // count tool args toward completion estimate
              }
            }
          }

          if (finishReason) {
            if (finishReason === "tool_calls") {
              for (const [, tc] of accumulatedToolCalls) {
                yield {
                  type: "tool_call",
                  toolCall: {
                    id: tc.id,
                    type: "function",
                    function: { name: tc.name, arguments: tc.arguments },
                  },
                };
              }
            }
            if (finishReason === "length") {
              console.warn(`[LLM Client] Response truncated (finish_reason=length) — model hit output token limit`);
            }
            doneEmitted = true;
            recordChatAnalytics(tokensIn, tokensOut, true);
            yield { type: "done", tokensIn, tokensOut, finishReason };
          }
        } catch { /* ignore malformed chunks */ }
      }
    }

    // If the stream ended without [DONE] or finish_reason (e.g. upstream timeout,
    // connection drop, silent truncation), emit a synthetic done so the agent loop
    // doesn't hang waiting for an event that never arrives.
    if (!doneEmitted) {
      console.warn(`[LLM Client] Stream ended without [DONE] token — emitting synthetic done (possible API timeout or connection drop)`);
      // Flush any accumulated tool calls
      for (const [, tc] of accumulatedToolCalls) {
        if (tc.name) {
          yield {
            type: "tool_call",
            toolCall: {
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: tc.arguments },
            },
          };
        }
      }
      recordChatAnalytics(tokensIn, tokensOut, true);
      yield { type: "done", tokensIn, tokensOut, finishReason: "stream_drop" };
    }

    // Safety net: if for any reason we reached here without recording (e.g. the
    // stream ended cleanly but emitted neither [DONE] nor finish_reason and
    // doneEmitted was somehow set elsewhere), record now. Idempotent.
    recordChatAnalytics(tokensIn, tokensOut, true);
    // Bust balance cache after each completed request so the next
    // floor check always sees the actual post-request balance.
    if (isOpenRouterEndpoint(endpoint)) {
      invalidateOpenRouterBalanceCache(endpoint.id);
    }
    // Successful stream — return (don't retry)
    return;
  } catch (err: any) {
    if (err.name === "AbortError") {
      yield { type: "error", content: "Request cancelled" };
      return;
    }
    // Retry on network errors
    if (streamAttempt < MAX_STREAM_ATTEMPTS) {
      const waitMs = jitteredBackoff(streamAttempt);
      console.warn(`[LLM Client] chatCompletionStream attempt ${streamAttempt}/${MAX_STREAM_ATTEMPTS} network error — retrying in ${Math.round(waitMs)}ms:`, err.message);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    recordChatAnalytics(0, 0, false);
    yield { type: "error", content: err.message };
    return;
  } finally {
    if (options.requestId) activeRequests.delete(options.requestId);
  }
  } // end for streamAttempt
}

// ── Model Loading ───────────────────────────────────────────────────────────

export interface LoadModelOptions {
  contextLength?: number;    // from preferredContextLength setting
  flashAttention?: boolean;  // default true for performance
}

export interface LoadModelResult {
  success: boolean;
  modelId: string;
  loadedContextLength?: number;
  error?: string;
}

/**
 * Load (or hot-swap) a model in LM Studio via POST /api/v1/models/load.
 *
 * If the model is already loaded with the correct context length, this is a fast no-op
 * in LM Studio (returns immediately). If a different model is loaded, LM Studio unloads
 * it first then loads the requested one.
 *
 * Timeout is very generous (600s / 10 min) — loading large models with massive
 * context windows (e.g., nemotron 1M context on DGX Sparks) can take 5+ minutes
 * as the KV cache is allocated across VRAM.
 */

export async function loadModel(
  endpoint: Endpoint,
  modelId: string,
  options: LoadModelOptions = {}
): Promise<LoadModelResult> {
  // Cloud providers don't need model loading — models are always available
  if (!isLocalProvider(endpoint)) {
    console.log(`[LLM Client] Skipping model load for cloud provider ${endpoint.name} (${endpoint.providerType})`);
    return { success: true, modelId };
  }

  const { contextLength, flashAttention = true } = options;
  const startTime = Date.now();

  // Only send parameters that LM Studio's load API actually accepts:
  // model, context_length, eval_batch_size, flash_attention, num_experts,
  // offload_kv_cache_to_gpu, echo_load_config
  const body: Record<string, any> = {
    model: modelId,
    flash_attention: flashAttention,
    echo_load_config: true,  // LM Studio returns the final config it actually used
  };

  if (contextLength && contextLength > 0) {
    body.context_length = contextLength;
  }

  console.log(`[LLM Client] Loading model ${modelId} on ${endpoint.url} (ctx=${contextLength || 'default'}, flash=${flashAttention})`);

  try {
    const res = await fetch(`${normalizeBaseUrl(endpoint.url)}/api/v1/models/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(600000), // 10 minutes — massive context models (1M+) need time to allocate KV cache
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      console.error(`[LLM Client] Failed to load model ${modelId}: ${res.status} ${errText}`);
      return { success: false, modelId, error: `Load failed (${res.status}): ${errText}` };
    }

    const data = await res.json();
    const durationMs = Date.now() - startTime;
    const actualCtx = data?.config?.context_length || data?.context_length || contextLength;

    console.log(`[LLM Client] Model ${modelId} loaded in ${(durationMs / 1000).toFixed(1)}s (context=${actualCtx || '?'})`);

    return {
      success: true,
      modelId,
      loadedContextLength: actualCtx,
    };
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      console.error(`[LLM Client] Model load timed out after ${(durationMs / 1000).toFixed(1)}s for ${modelId}`);
      return { success: false, modelId, error: `Load timed out after ${Math.round(durationMs / 1000)}s` };
    }
    console.error(`[LLM Client] Model load error for ${modelId}:`, err.message);
    return { success: false, modelId, error: err.message };
  }
}

/**
 * Check if a specific model is currently loaded on an endpoint.
 * Uses v0 API for state info; falls back to v1 /models listing.
 */
export async function isModelLoaded(
  endpoint: Endpoint,
  modelId: string
): Promise<{ loaded: boolean; currentContextLength?: number }> {
  // Cloud providers — models are always "loaded"
  if (!isLocalProvider(endpoint)) {
    return { loaded: true };
  }

  try {
    const res = await fetch(`${normalizeBaseUrl(endpoint.url)}/api/v0/models`, { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json();
      const models = Array.isArray(data) ? data : (data.data || []);
      const match = models.find((m: any) => (m.id || m.path) === modelId);
      if (match && match.state === "loaded") {
        return { loaded: true, currentContextLength: match.loaded_context_length };
      }
      return { loaded: false };
    }
  } catch { /* fall through */ }

  // Fallback: v1 /models only lists loaded models
  try {
    const res = await fetch(`${normalizeBaseUrl(endpoint.url)}/v1/models`, { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json();
      const models = data.data || [];
      const match = models.find((m: any) => m.id === modelId);
      return { loaded: !!match };
    }
  } catch { /* ignore */ }

  return { loaded: false };
}

export interface SyncedModel {
  id: string;
  type: string;
  supportsVision?: boolean;
  quantization?: string;
  maxContextLength?: number;    // max_context_length from LM Studio v0 API
  loadedContextLength?: number; // loaded_context_length from v0 API (only if model is loaded)
  state?: string;               // "loaded" | "not-loaded"
}

function modelSupportsVision(modelId: string): boolean {
  const visionKeywords = [
    "vision", "vl", "visual", "pixtral", "llava", "bakllava",
    "moondream", "cogvlm", "qwen-vl", "qwen2-vl", "internvl",
    "minicpm-v", "phi-3-vision", "phi-4-multimodal",
    "gemma-4", // gemma 4 is multimodal
    "gemini", "gpt-4o", "gpt-4-turbo", "gpt-4-vision",
    "claude-3", "claude-opus", "claude-sonnet", "claude-haiku",
    "mistral-pixtral", "llama-3.2-11b-vision", "llama-3.2-90b-vision",
    "free:multimodal", "multimodal",
  ];
  const id = modelId.toLowerCase();
  return visionKeywords.some(kw => id.includes(kw));
}

/**
 * Sync models from an LM Studio endpoint.
 * Prefers v0 API (richer metadata including context lengths), falls back to v1.
 */
export async function syncModels(endpoint: Endpoint): Promise<SyncedModel[]> {
  try {
    // Cloud providers — use /v1/models with auth headers
    if (!isLocalProvider(endpoint)) {
      console.log(`[LLM Client] Syncing models from cloud provider ${endpoint.name} (${endpoint.providerType})`);
      const res = await fetch(`${normalizeBaseUrl(endpoint.url)}/v1/models`, {
        headers: buildHeaders(endpoint),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`Failed to fetch models: ${res.status}`);
      const data = await res.json();
      const models = (data.data || []).map((m: any) => ({
        id: m.id,
        type: m.type || "llm",
        supportsVision: modelSupportsVision(m.id),
      }));
      console.log(`[LLM Client] Found ${models.length} models on ${endpoint.name}`);
      return models;
    }

    // Local (LM Studio) — prefer v0 API for richer metadata
    // 30s timeout — large models (200B) can take 30-120s to load in LM Studio
    const res = await fetch(`${normalizeBaseUrl(endpoint.url)}/api/v0/models`, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) {
      // Try /v1/models as fallback (no context length info available)
      const res2 = await fetch(`${normalizeBaseUrl(endpoint.url)}/v1/models`, { signal: AbortSignal.timeout(30000) });
      if (!res2.ok) throw new Error(`Failed to fetch models: ${res2.status}`);
      const data2 = await res2.json();
      return (data2.data || []).map((m: any) => ({
        id: m.id,
        type: m.type || "llm",
        supportsVision: modelSupportsVision(m.id),
      }));
    }
    const data = await res.json();
    const rawModels = Array.isArray(data) ? data : (data.data || []);

    return rawModels.map((m: any) => {
      const synced: SyncedModel = {
        id: m.id || m.path,
        type: m.type || "llm",
      };
      synced.supportsVision = modelSupportsVision(synced.id);
      if (m.quantization) synced.quantization = m.quantization;
      if (m.max_context_length) synced.maxContextLength = m.max_context_length;
      if (m.loaded_context_length) synced.loadedContextLength = m.loaded_context_length;
      if (m.state) synced.state = m.state;

      if (synced.maxContextLength || synced.loadedContextLength) {
        console.log(`[LLM Client] Model ${synced.id}: maxCtx=${synced.maxContextLength || '?'}, loadedCtx=${synced.loadedContextLength || '?'}, state=${synced.state || '?'}`);
      }
      return synced;
    });
  } catch (err: any) {
    console.error(`[LLM Client] Failed to sync models from ${endpoint.url}:`, err.message);
    return [];
  }
}

/**
 * Get list of currently loaded model IDs from an endpoint
 */
export async function getLoadedModels(endpoint: Endpoint): Promise<string[]> {
  const url = `${normalizeBaseUrl(endpoint.url)}/v1/models`;
  try {
    const res = await fetch(url, {
      headers: buildHeaders(endpoint),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || []).map((m: any) => m.id as string);
  } catch {
    return [];
  }
}

/**
 * Unload a model from an LM Studio endpoint via POST /api/v1/models/unload
 */
export async function unloadModel(endpoint: Endpoint, modelId: string): Promise<void> {
  // Cloud providers don't support model unloading
  if (!isLocalProvider(endpoint)) return;

  const url = `${normalizeBaseUrl(endpoint.url)}/api/v1/models/unload`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instance_id: modelId }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[LLM] Failed to unload ${modelId}: ${res.status} ${text}`);
    } else {
      console.log(`[LLM] Unloaded model ${modelId} from ${endpoint.name}`);
    }
  } catch (err: any) {
    console.warn(`[LLM] Error unloading ${modelId}:`, err.message);
  }
}

/**
 * Check if an endpoint is reachable
 */
export async function pingEndpoint(endpoint: Endpoint | string): Promise<boolean> {
  try {
    const url = typeof endpoint === "string" ? endpoint : endpoint.url;
    const headers: Record<string, string> = {};
    if (typeof endpoint !== "string" && endpoint.apiKey) {
      headers["Authorization"] = `Bearer ${endpoint.apiKey}`;
    }
    // 15s timeout — large models loading in LM Studio can take 30-120s, 3s was too aggressive
    const res = await fetch(`${url}/v1/models`, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
