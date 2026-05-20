/**
 * Orchestrator — Selects the best model + endpoint for a given task
 * 
 * Key behaviors:
 * - Uses the orchestrator model for task classification (when keyword confidence is low)
 * - Uses the orchestrator model for planning (via task-planner.ts)
 * - Routes execution to the best worker model based on task type
 * - Follow-up messages in a conversation inherit the previous task type
 */
import type { TaskType, Model, Endpoint } from "../../shared/schema.js";
import { modelStore, endpointStore, settingsStore } from "../storage.js";
import { classifyByKeywords, buildClassificationPrompt } from "./classifier.js";
import { chatCompletion, loadModel, isModelLoaded, getLoadedModels, unloadModel, isLocalProvider } from "./llm-client.js";

interface RoutingDecision {
  model: Model;
  endpoint: Endpoint;
  taskType: TaskType;
  confidence: number;
  reason: string;
}

/**
 * Parse model tags from taskAssignment field.
 * Supports:
 *   - JSON array: '["coding","research"]'
 *   - Legacy single string: 'coding'
 *   - null/empty: []
 */
function getModelTags(model: Model): string[] {
  if (!model.taskAssignment) return [];
  const raw = model.taskAssignment.trim();
  if (raw.startsWith("[")) {
    try { return JSON.parse(raw) as string[]; } catch { return [raw]; }
  }
  return [raw];
}

// Model ID patterns for auto-detection of capabilities
const MODEL_CAPABILITY_PATTERNS: Record<Exclude<TaskType, "general">, { pattern: RegExp; score: number }[]> = {
  coding: [
    { pattern: /qwen.*coder|coder|starcoder|codellama|deepseek.*code|code.*llama|wizardcoder|phind/i, score: 60 },
    { pattern: /devops|copilot/i, score: 40 },
  ],
  research: [
    { pattern: /mistral|mixtral|solar|yi|command|orca/i, score: 20 },
  ],
  creative: [
    { pattern: /creative|writing|story|novelist|mythomax|midnight/i, score: 40 },
    { pattern: /llama.*chat|vicuna|openhermes/i, score: 15 },
  ],
  math: [
    { pattern: /math|reason|r1|qwq|deepseek.*r|phi.*reason|nemotron.*reason/i, score: 40 },
    { pattern: /wizard.*math|metamath|llemma/i, score: 60 },
  ],
};

/**
 * Score a model for a given task type
 */
function scoreModel(model: Model, taskType: TaskType): { score: number; reason: string } {
  let score = 0;
  const reasons: string[] = [];

  // Explicit task assignment — highest priority (now supports multi-tag)
  const tags = getModelTags(model);
  if (tags.length > 0) {
    if (tags.includes(taskType)) {
      score += 100;
      reasons.push(`tagged for ${taskType} (+100)`);
    } else {
      score -= 20; // Penalize models tagged for other tasks
      reasons.push(`tagged for ${tags.join(",")} (-20)`);
    }
  }

  // Model ID pattern matching
  if (taskType !== "general") {
    const patterns = MODEL_CAPABILITY_PATTERNS[taskType] || [];
    for (const { pattern, score: patternScore } of patterns) {
      if (pattern.test(model.modelId)) {
        score += patternScore;
        reasons.push(`model name match (+${patternScore})`);
        break; // Only count best pattern match
      }
    }
  }

  // Notes matching
  if (model.notes) {
    const notesLower = model.notes.toLowerCase();
    if (notesLower.includes(taskType)) {
      score += 10;
      reasons.push(`notes mention ${taskType} (+10)`);
    }
  }

  // Prefer models that support tool calling for coding/research
  if (model.supportsToolCalling && (taskType === "coding" || taskType === "research")) {
    score += 5;
    reasons.push(`supports tool calling (+5)`);
  }

  // General tasks: slight preference for no explicit assignment (generalist models)
  if (taskType === "general" && tags.length === 0) {
    score += 10;
    reasons.push(`generalist model (+10)`);
  }

  return { score, reason: reasons.join(", ") || "baseline" };
}

/**
 * Select the best model for a sub-agent task.
 * Prefers models tagged isSubAgent=true; falls back to normal selectModel if none tagged.
 */
export function selectSubAgentModel(taskType: TaskType): RoutingDecision | null {
  const enabledModels = modelStore.getEnabled();
  const endpoints = endpointStore.getAll();

  // Find models explicitly tagged as sub-agent workers
  const subAgentModels = enabledModels.filter((m: any) => m.isSubAgent);

  if (subAgentModels.length > 0) {
    // Score among sub-agent models for the task type
    const scored = subAgentModels.map((model: any) => {
      const endpoint = endpoints.find((e: any) => e.id === model.endpointId)!;
      const { score, reason } = scoreModel(model, taskType);
      return { model, endpoint, score, reason };
    }).filter((s: any) => s.endpoint).sort((a: any, b: any) => b.score - a.score);

    if (scored.length > 0) {
      const best = scored[0];
      console.log(`[Orchestrator] Sub-agent task: ${taskType} → ${best.model.modelId} (sub-agent, score: ${best.score}, ${best.reason})`);
      return {
        model: best.model,
        endpoint: best.endpoint,
        taskType,
        confidence: best.score >= 60 ? 0.9 : 0.7,
        reason: `sub-agent: ${best.reason}`,
      };
    }
  }

  // No sub-agent models configured — fall back to normal routing
  console.log(`[Orchestrator] No sub-agent models configured — falling back to normal routing for task: ${taskType}`);
  return selectModel(taskType);
}

/**
 * Select the best model for a task type
 */
export function selectModel(taskType: TaskType): RoutingDecision | null {
  const enabledModels = modelStore.getEnabled();
  const endpoints = endpointStore.getAll();

  // Exclude models tagged as sub-agent only — they should never be selected for primary routing
  const workerModels = enabledModels.filter((m: any) => !m.isSubAgent);

  if (workerModels.length === 0) {
    if (enabledModels.length === 0) return null;
    const model = enabledModels[0];
    const endpoint = endpoints.find(e => e.id === model.endpointId);
    if (!endpoint) return null;
    return { model, endpoint, taskType, confidence: 0.3, reason: "only model available" };
  }

  // Score all worker models
  const scored = workerModels.map(model => {
    const endpoint = endpoints.find(e => e.id === model.endpointId)!;
    const { score, reason } = scoreModel(model, taskType);
    return { model, endpoint, score, reason };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  console.log(`[Orchestrator] Task: ${taskType} → ${best.model.modelId} (score: ${best.score}, ${best.reason})`);

  return {
    model: best.model,
    endpoint: best.endpoint,
    taskType,
    confidence: best.score >= 60 ? 0.9 : best.score >= 20 ? 0.7 : 0.5,
    reason: best.reason,
  };
}

/**
 * Check if two context lengths are "close enough" to skip reloading.
 * LM Studio may round context lengths to multiples of 256/512,
 * so an exact match isn't always possible. We use a 5% tolerance.
 */
function contextCloseEnough(loaded: number, preferred: number): boolean {
  const tolerance = Math.max(preferred * 0.05, 512);
  return Math.abs(loaded - preferred) <= tolerance;
}

/**
 * Ensure a model is loaded in LM Studio with the preferred context length.
 *
 * Logic:
 * 1. If model has no preferredContextLength set, skip (LM Studio manages its own loading)
 * 2. Clamp preferred to the model's own maxContextLength (not a global cap)
 * 3. If the EXACT model is already loaded with matching or close-enough context → skip
 * 4. If the exact model is loaded but with wrong context → unload IT, then reload
 * 5. If a DIFFERENT model is loaded on this endpoint → unload it to free VRAM
 * 6. Load model with the preferred context
 * 7. Update stored loadedContextLength on success
 */
export async function ensureModelLoaded(
  model: Model,
  endpoint: Endpoint
): Promise<void> {
  // Cloud providers don't need model loading/unloading — models are always available
  if (!isLocalProvider(endpoint)) return;

  let preferred = model.preferredContextLength;

  // No preferred context set — let LM Studio manage loading naturally.
  if (!preferred || preferred <= 0) {
    return;
  }

  // Clamp to this model's maxContextLength if known — no global cap.
  // The user knows their hardware and sets the context they want.
  if (model.maxContextLength && preferred > model.maxContextLength) {
    console.log(`[Orchestrator] Clamping preferred context from ${preferred} to model max ${model.maxContextLength}`);
    preferred = model.maxContextLength;
  }

  // Check current state — avoid unnecessary load calls
  const status = await isModelLoaded(endpoint, model.modelId);
  let didUnload = false; // Track if we explicitly unloaded — if so, load MUST succeed

  if (status.loaded && status.currentContextLength) {
    if (status.currentContextLength === preferred || contextCloseEnough(status.currentContextLength, preferred)) {
      console.log(`[Orchestrator] Model ${model.modelId} already loaded with ctx=${status.currentContextLength} (preferred=${preferred}), close enough — skipping`);
      return;
    }
    // Same model loaded but with wrong context — unload it first
    console.log(`[Orchestrator] Model ${model.modelId} loaded with ctx=${status.currentContextLength}, need ctx=${preferred} — unloading to reload`);
    try {
      await unloadModel(endpoint, model.modelId);
      didUnload = true;
    } catch (err: any) {
      console.warn(`[Orchestrator] Failed to unload ${model.modelId}:`, err.message);
    }
  } else if (status.loaded) {
    // Loaded but we don't know context length — assume it needs reloading
    console.log(`[Orchestrator] Model ${model.modelId} loaded but context unknown — unloading to reload with ctx=${preferred}`);
    try {
      await unloadModel(endpoint, model.modelId);
      didUnload = true;
    } catch (err: any) {
      console.warn(`[Orchestrator] Failed to unload ${model.modelId}:`, err.message);
    }
  } else {
    // Model not loaded. Check if OTHER models are loaded on this endpoint
    // and unload them to free VRAM.
    console.log(`[Orchestrator] Model ${model.modelId} not loaded — loading with ctx=${preferred}`);
    didUnload = true; // No model is loaded — we need the load to succeed
    try {
      const loadedModels = await getLoadedModels(endpoint);
      for (const loadedId of loadedModels) {
        console.log(`[Orchestrator] Unloading ${loadedId} to free VRAM for ${model.modelId}`);
        await unloadModel(endpoint, loadedId);
      }
    } catch (err: any) {
      console.warn(`[Orchestrator] Failed to check/unload models:`, err.message);
    }
  }

  const result = await loadModel(endpoint, model.modelId, {
    contextLength: preferred,
    flashAttention: true,
  });

  if (result.success) {
    // Update the stored loadedContextLength so agent-loop uses it correctly
    if (result.loadedContextLength) {
      modelStore.update(model.id, { loadedContextLength: result.loadedContextLength });
    }
  } else if (didUnload) {
    // We explicitly unloaded the model (or no model was loaded) — there's nothing to chat with.
    // Throw an error so the chat route can show a proper error message instead of crashing the API.
    const errMsg = `Model ${model.modelId} failed to load with ctx=${preferred}: ${result.error}. ` +
      `No model is available on endpoint "${endpoint.name}" — the previous model was unloaded to make room.`;
    console.error(`[Orchestrator] ${errMsg}`);
    throw new Error(errMsg);
  } else {
    // Load failed but we didn't unload anything — the original model may still be available.
    // Log and let the chat attempt proceed (LM Studio may auto-load on demand).
    console.warn(`[Orchestrator] Model load failed for ${model.modelId}: ${result.error}. Will attempt chat with whatever is loaded.`);
  }
}

/**
 * Classify a message and select the best model — full pipeline
 * Now accepts conversationId for context-aware classification
 */
export async function routeMessage(
  message: string,
  useAutoRouting: boolean,
  conversationId?: number
): Promise<RoutingDecision | null> {
  if (!useAutoRouting) {
    const { taskType, confidence } = classifyByKeywords(message, conversationId);
    return selectModel(taskType);
  }

  // Hybrid classification: keywords first (with conversation context), LLM if uncertain
  const keyword = classifyByKeywords(message, conversationId);
  let finalTaskType = keyword.taskType;
  console.log(`[Orchestrator] Keyword classification: ${keyword.taskType} (confidence: ${keyword.confidence.toFixed(2)})`);

  if (keyword.confidence < 0.6) {
    // Try LLM classification for ambiguous messages
    const orchestratorEndpoint = endpointStore.getOrchestrator();
    if (orchestratorEndpoint) {
      const orchModels = modelStore.getByEndpoint(orchestratorEndpoint.id).filter(m => m.isEnabled);
      if (orchModels.length > 0) {
        try {
          const prompt = buildClassificationPrompt(message);
          const result = await chatCompletion(orchestratorEndpoint, orchModels[0], [
            { role: "user", content: prompt },
          ], { temperature: 0.1, maxTokens: 20 });

          const llmCategory = (result.content || "").trim().toLowerCase()
            .replace(/[^a-z]/g, "") as TaskType;

          if (["coding", "research", "creative", "math", "general"].includes(llmCategory)) {
            finalTaskType = llmCategory;
            console.log(`[Orchestrator] LLM reclassified: ${keyword.taskType} → ${llmCategory}`);
          }
        } catch (err: any) {
          console.warn(`[Orchestrator] LLM classification failed, using keywords:`, err.message);
        }
      }
    }
  }

  return selectModel(finalTaskType);
}
