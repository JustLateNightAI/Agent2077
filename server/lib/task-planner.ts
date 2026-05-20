/**
 * Task Planner — Generates actionable step-by-step plans for complex tasks
 * 
 * The planner determines if a user request needs multi-step execution,
 * and if so, produces a concrete plan that the agent loop will follow.
 * 
 * Key design decisions:
 * - Any request that involves BUILDING, CREATING, DEPLOYING, or MULTI-STEP
 *   work gets a plan — even short requests like "build a drawing app"
 * - Plans are injected into the agent loop's system prompt so the model
 *   follows them step by step
 * - The plan includes a verification step at the end
 */
import type { Endpoint, Model, TaskType } from "../../shared/schema.js";
import { chatCompletion, type ChatMessage } from "./llm-client.js";
import { classifyByKeywords } from "./classifier.js";
import { messageStore, settingsStore, modelStore, endpointStore } from "../storage.js";

/**
 * Resolve the best endpoint+model to use for planning.
 * Priority: model tagged "planner" > orchestrator endpoint model > undefined.
 */
function resolvePlannerModel(
  orchestratorEndpoint: Endpoint | undefined,
  orchestratorModel: Model | undefined
): { endpoint: Endpoint | undefined; model: Model | undefined } {
  // Find a model explicitly tagged "planner"
  const allModels = modelStore.getEnabled();
  const plannerModel = allModels.find(m => {
    if (!m.taskAssignment) return false;
    const raw = m.taskAssignment.trim();
    try {
      const tags: string[] = raw.startsWith("[") ? JSON.parse(raw) : [raw];
      return tags.includes("planner");
    } catch { return false; }
  });

  if (plannerModel) {
    const endpoints = endpointStore.getAll();
    const ep = endpoints.find(e => e.id === plannerModel.endpointId);
    if (ep) {
      console.log(`[TaskPlanner] Using planner-tagged model: ${plannerModel.modelId}`);
      return { endpoint: ep, model: plannerModel };
    }
  }

  // Fall back to orchestrator
  return { endpoint: orchestratorEndpoint, model: orchestratorModel };
}

export interface PlanStep {
  step: number;
  title: string;
  description: string;
  tools: string[]; // which tools this step likely needs
  parallel?: boolean; // true if this step can run independently
}

export interface TaskPlan {
  needsPlan: boolean;
  needsClarification?: boolean; // true if the request is too vague and the agent should ask the user for details first
  clarificationQuestion?: string; // the question to ask the user
  steps: PlanStep[];
  reasoning: string;
  estimatedTools: number;
  parallelGroups?: number[][]; // Groups of step indices that can run simultaneously
}

/**
 * Keywords/phrases that indicate a task needs multi-step planning.
 * These are intentionally broad — it's better to plan and not need it
 * than to skip planning for a complex task.
 */
const ACTION_VERBS = /\b(build|create|make|develop|implement|write|code|design|set\s*up|deploy|generate|construct|put\s+together|add|install|configure|fix|debug|refactor|update|modify|change|improve|upgrade|convert|migrate|integrate|connect|automate)\b/i;

const COMPLEX_OBJECTS = /\b(app|application|website|web\s*site|web\s*app|game|tool|program|software|page|dashboard|api|server|service|database|script|bot|extension|plugin|widget|component|system|platform|ui|interface|editor|viewer|player|manager|tracker|monitor|calculator|converter|generator|simulator|emulator)\b/i;

const MULTI_STEP_SIGNALS = /\b(and|then|also|with|including|plus|that\s+(can|has|does|shows|lets|allows)|which|where|step|first|second|finally|after|before|both|multiple|several|along\s+with)\b/i;

const RESEARCH_SIGNALS = /\b(research|analyze|compare|evaluate|investigate|study|review|assess|examine|find\s+(out|information|data)|look\s+(up|into)|search\s+for)\b/i;

// Follow-up / continuation patterns that indicate the user wants to resume prior work
const CONTINUATION_PATTERNS = /\b(pick\s+up|continue|resume|finish|complete|keep\s+going|carry\s+on|go\s+on|proceed|try\s+(it\s+)?again|retry|redo|do\s+it\s+again|where\s+you\s+left\s+off|left\s+off)\b/i;

// Patterns that suggest the previous task is incomplete and user is asking about it
const INCOMPLETE_REFERENCE = /\b(uh|um|did\s+you|have\s+you|is\s+it|are\s+you|you\s+didn.?t|not\s+done|not\s+finished|incomplete|didn.?t\s+work|still\s+need|what\s+happened|you\s+stopped)\b/i;

/**
 * Determine if a request needs a plan, and generate one.
 * 
 * This intentionally has a LOW threshold for triggering — we want plans
 * for anything that involves tool use beyond a simple Q&A.
 * 
 * Now accepts conversationId to detect follow-ups that should resume
 * a previous complex task (and thus need a plan).
 */
export async function planTask(
  message: string,
  orchestratorEndpoint: Endpoint | undefined,
  orchestratorModel: Model | undefined,
  conversationId?: number
): Promise<TaskPlan> {
  // Use planner-tagged model if available, otherwise fall back to orchestrator
  const { endpoint: plannerEndpoint, model: plannerModel } = resolvePlannerModel(orchestratorEndpoint, orchestratorModel);
  orchestratorEndpoint = plannerEndpoint;
  orchestratorModel = plannerModel;

  const lowerMsg = message.toLowerCase();
  
  // Quick check: is this just a simple question/greeting?
  const isSimpleQuestion = /^(what|who|when|where|why|how|is|are|was|were|do|does|did|can|could|would|should|will|shall|tell\s+me|explain)\s/i.test(message.trim());
  const isGreeting = /^(hi|hello|hey|sup|yo|good\s+(morning|afternoon|evening)|thanks|thank\s+you|ok|okay|sure|yes|no|bye|goodbye)\b/i.test(message.trim());
  const wordCount = message.split(/\s+/).length;
  
  // Simple greetings and very short questions — no plan needed
  if (isGreeting && wordCount < 8) {
    return { needsPlan: false, steps: [], reasoning: "Greeting — no plan needed", estimatedTools: 0 };
  }

  // Check if this is a follow-up that refers to an incomplete previous task
  // e.g. "try it again", "uh, did you do it?", "pick up where you left off"
  if (conversationId && (CONTINUATION_PATTERNS.test(message) || INCOMPLETE_REFERENCE.test(message))) {
    const prevContext = getPreviousTaskContext(conversationId);
    if (prevContext) {
      console.log(`[TaskPlanner] Follow-up detected — rebuilding plan from previous ${prevContext.taskType} task`);
      // Rebuild a plan based on what the previous task was doing
      return await generatePlan(
        prevContext.originalMessage || message,
        orchestratorEndpoint,
        orchestratorModel,
        `continuation_of_${prevContext.taskType}`
      );
    }
  }
  
  // Check if this involves building/creating something
  const hasActionVerb = ACTION_VERBS.test(message);
  const hasComplexObject = COMPLEX_OBJECTS.test(message);
  const hasMultiStepSignal = MULTI_STEP_SIGNALS.test(message);
  const hasResearchSignal = RESEARCH_SIGNALS.test(message);
  
  // Clarification check: if the request is vague (short, action + complex object, but few specifics),
  // ask the user for more detail before diving in.
  const clarifyEnabled = settingsStore.get("agent.askClarification") !== "false";
  if (clarifyEnabled && hasActionVerb && hasComplexObject && wordCount < 20 && !hasMultiStepSignal) {
    // Short request like "code me a drawing program" — check if we should clarify
    const clarification = await checkNeedsClarification(message, orchestratorEndpoint, orchestratorModel, conversationId);
    if (clarification) {
      return clarification;
    }
  }

  // If it has an action verb + complex object, it ALWAYS gets a plan
  // "build a drawing app" — short but definitely needs a plan
  if (hasActionVerb && hasComplexObject) {
    return await generatePlan(message, orchestratorEndpoint, orchestratorModel, "action_verb + complex_object");
  }
  
  // If it has multi-step signals with either action or research
  if (hasMultiStepSignal && (hasActionVerb || hasResearchSignal)) {
    return await generatePlan(message, orchestratorEndpoint, orchestratorModel, "multi_step + action/research");
  }
  
  // Research tasks that are non-trivial
  if (hasResearchSignal && wordCount > 10) {
    return await generatePlan(message, orchestratorEndpoint, orchestratorModel, "research_task");
  }
  
  // Long messages (>30 words) with action verbs likely need planning
  if (hasActionVerb && wordCount > 30) {
    return await generatePlan(message, orchestratorEndpoint, orchestratorModel, "long_action_request");
  }
  
  // Simple question — no plan
  if (isSimpleQuestion && wordCount < 25 && !hasActionVerb) {
    return { needsPlan: false, steps: [], reasoning: "Simple question — direct answer", estimatedTools: 0 };
  }
  
  // For anything else moderately complex, try LLM classification if available
  if (wordCount > 15 && orchestratorEndpoint && orchestratorModel) {
    return await generatePlan(message, orchestratorEndpoint, orchestratorModel, "llm_classification");
  }
  
  return { needsPlan: false, steps: [], reasoning: "Simple request — no decomposition needed", estimatedTools: 0 };
}

/**
 * Look at the conversation history to find the original task that the user
 * is referring to when they say "try again" or "did you do it?"
 */
function getPreviousTaskContext(conversationId: number): { taskType: string; originalMessage: string } | null {
  try {
    const messages = messageStore.getByConversation(conversationId);
    // Walk backwards looking for a user message that triggered a complex task
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      // Find the last user message that looks like it triggered work (has action verb + complex object)
      if (msg.role === 'user' && msg.content) {
        const hasAction = ACTION_VERBS.test(msg.content);
        const hasComplex = COMPLEX_OBJECTS.test(msg.content);
        if (hasAction && hasComplex) {
          // Find the corresponding assistant message to get task type
          const nextAssistant = messages.slice(i + 1).find(m => m.role === 'assistant');
          return {
            taskType: (nextAssistant as any)?.taskType || 'coding',
            originalMessage: msg.content,
          };
        }
      }
    }
  } catch {
    // Storage might not be ready
  }
  return null;
}

/**
 * Check if a request is too vague and needs clarification from the user.
 * Only called for short requests (< 20 words) that trigger the action+complex pattern.
 * Returns a TaskPlan with needsClarification=true if clarification is needed, or null to proceed.
 *
 * This is SKIPPED if the conversation already has user messages (i.e., the user already
 * provided clarification in a follow-up), so the agent doesn't keep asking.
 */
async function checkNeedsClarification(
  message: string,
  endpoint: Endpoint | undefined,
  model: Model | undefined,
  conversationId?: number
): Promise<TaskPlan | null> {
  // If this is a follow-up in an existing conversation, don't ask for clarification again
  if (conversationId) {
    try {
      const history = messageStore.getByConversation(conversationId);
      // If there are already 2+ user messages, the user has already been through a Q&A
      const userMsgCount = history.filter(m => m.role === "user").length;
      if (userMsgCount >= 2) {
        return null; // User already clarified, proceed with planning
      }
    } catch {}
  }

  // If no orchestrator, use a heuristic: short requests without detail words are vague
  if (!endpoint || !model) {
    const wordCount = message.split(/\s+/).length;
    const hasDetails = /\b(with|including|that has|features?|tools?|like|such as|support|able to|capable of|should|must|need|want it to|buttons?|canvas|layers?|colors?|palette|menu|sidebar|toolbar)\b/i.test(message);
    if (wordCount < 12 && !hasDetails) {
      return {
        needsPlan: false,
        needsClarification: true,
        clarificationQuestion: `I'd like to build that for you! Before I start, could you tell me more about what you have in mind? For example:\n\n- What features or tools should it have?\n- Any specific style or look you're going for?\n- Any reference apps you'd like it to be similar to?\n\nOr if you'd prefer, I can just build it with a sensible default set of features and you can tell me what to change.`,
        steps: [],
        reasoning: "Request is vague — asking for clarification (heuristic)",
        estimatedTools: 0,
      };
    }
    return null;
  }

  // Use the orchestrator LLM to determine if clarification is needed
  try {
    const prompt = `You are an AI assistant deciding whether a user's request is specific enough to start working on, or if you should ask for more details first.

User request: "${message}"

Determine if the request is:
1. SPECIFIC ENOUGH — The user gave enough detail (features, requirements, constraints) to start building immediately. Proceed without asking.
2. TOO VAGUE — The user gave a broad request without specifying what they want. You should ask a SHORT, helpful clarifying question.

Examples of VAGUE requests:
- "build me an app" (what kind?)
- "code a drawing program" (what tools? what features? desktop or web?)
- "make a game" (what type? what mechanics?)
- "create a website" (for what? what content?)

Examples of SPECIFIC requests:
- "build a to-do app with drag and drop, due dates, and categories"
- "code a drawing program with a canvas, brush tool, eraser, and color picker"
- "make a snake game with arrow key controls"
- "create a portfolio website with an about section, projects grid, and contact form"

Respond with ONLY valid JSON:
{"needsClarification": true/false, "question": "Your helpful question here (only if needsClarification is true)"}`;

    const response = await chatCompletion(endpoint, model, [
      { role: "user", content: prompt },
    ], { temperature: 0.2, maxTokens: 500 });

    const text = (response.content || "").trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.needsClarification && parsed.question) {
        console.log(`[TaskPlanner] Clarification needed for: "${message.slice(0, 60)}"`);
        return {
          needsPlan: false,
          needsClarification: true,
          clarificationQuestion: parsed.question,
          steps: [],
          reasoning: "Request is vague — asking for clarification (LLM)",
          estimatedTools: 0,
        };
      }
    }
  } catch (err: any) {
    console.warn("[TaskPlanner] Clarification check failed:", err.message);
  }

  return null; // Proceed with normal planning
}

/**
 * Generate a concrete, actionable plan using the LLM
 */
async function generatePlan(
  message: string,
  endpoint: Endpoint | undefined,
  model: Model | undefined,
  triggerReason: string
): Promise<TaskPlan> {
  // If no orchestrator available, generate a heuristic plan
  if (!endpoint || !model) {
    return addParallelHints(heuristicPlan(message, triggerReason), message);
  }

  try {
    const prompt = `You are a task planning assistant. Create a step-by-step execution plan for this request.

User request: "${message}"

Create 3-8 concrete steps. Each step should be a specific action the agent can execute using tools.
The LAST step must ALWAYS be verification — checking the work is correct.

Available tools the agent has:
- web_search: Search the web for information
- execute_code: Run code in a Docker container  
- write_file: Write files to the workspace
- read_file: Read files from the workspace
- deploy_app: Deploy a web app to the App Store (builds Docker container, starts it for testing)
- stop_app: Stop a running app after verification
- save_memory: Save information for future recall
- search_memory: Search past memories

For app-building tasks, the plan MUST include:
1. Planning the architecture/structure
2. Writing ALL the code files
3. Deploying with deploy_app
4. Verifying the app works
5. Stopping with stop_app

If multiple steps are INDEPENDENT and can run simultaneously (e.g., separate research tasks, writing unrelated files), mark them with "parallel": true and group them in "parallelGroups" — an array of arrays of step indices (0-based). Example: [[1, 2, 3]] means steps at indices 1, 2, 3 run in parallel.

Tasks that require outputs from previous steps should NOT be marked parallel.

Respond with ONLY valid JSON in this exact format:
{
  "needsPlan": true,
  "steps": [
    {"step": 1, "title": "Brief title", "description": "What to do in detail", "tools": ["tool1", "tool2"], "parallel": false},
    ...
  ],
  "reasoning": "Why this plan makes sense",
  "estimatedTools": <number of total tool calls expected>,
  "parallelGroups": [] 
}`;

    const response = await chatCompletion(endpoint, model, [
      { role: "user", content: prompt },
    ], { temperature: 0.3, maxTokens: 2000 });

    const text = (response.content || "").trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      
      // Validate the plan has steps
      if (parsed.steps && parsed.steps.length > 0) {
        return {
          needsPlan: true,
          steps: parsed.steps.map((s: any, i: number) => ({
            step: s.step || i + 1,
            title: s.title || `Step ${i + 1}`,
            description: s.description || "",
            tools: s.tools || [],
            parallel: s.parallel || false,
          })),
          reasoning: parsed.reasoning || triggerReason,
          estimatedTools: parsed.estimatedTools || parsed.steps.length * 2,
          parallelGroups: parsed.parallelGroups || [],
        };
      }
    }
  } catch (err: any) {
    console.warn("[TaskPlanner] LLM planning failed, using heuristic:", err.message);
  }

  // Fallback to heuristic plan
  return addParallelHints(heuristicPlan(message, triggerReason), message);
}

/**
 * Generate a heuristic plan when LLM is unavailable
 */
function heuristicPlan(message: string, triggerReason: string): TaskPlan {
  const hasApp = COMPLEX_OBJECTS.test(message);
  const hasSearch = RESEARCH_SIGNALS.test(message);
  
  if (hasApp && ACTION_VERBS.test(message)) {
    // App building plan
    return {
      needsPlan: true,
      steps: [
        { step: 1, title: "Plan the application", description: "Determine the architecture, features, and file structure needed", tools: [] },
        { step: 2, title: "Write the code", description: "Create all necessary files: HTML, CSS, JavaScript, and any other required files", tools: ["write_file"] },
        { step: 3, title: "Deploy to App Store", description: "Use deploy_app to build a Docker container and start the app for testing", tools: ["deploy_app"] },
        { step: 4, title: "Verify the app works", description: "Check that the app is running correctly and all features work as expected", tools: ["execute_code"] },
        { step: 5, title: "Stop the app", description: "Call stop_app so it appears in the App Store as stopped, ready for the user to launch", tools: ["stop_app"] },
      ],
      reasoning: `Heuristic app-building plan (triggered by: ${triggerReason})`,
      estimatedTools: 8,
    };
  }

  if (hasSearch) {
    // Research plan
    return {
      needsPlan: true,
      steps: [
        { step: 1, title: "Search for information", description: "Use web search to find relevant data and sources", tools: ["web_search"] },
        { step: 2, title: "Analyze findings", description: "Process and organize the search results", tools: [] },
        { step: 3, title: "Compile response", description: "Write a comprehensive answer based on the research", tools: [] },
      ],
      reasoning: `Heuristic research plan (triggered by: ${triggerReason})`,
      estimatedTools: 3,
    };
  }

  // Generic multi-step plan
  return {
    needsPlan: true,
    steps: [
      { step: 1, title: "Analyze the request", description: "Break down what needs to be done", tools: [] },
      { step: 2, title: "Execute the task", description: "Use the appropriate tools to complete the work", tools: [] },
      { step: 3, title: "Verify the result", description: "Check that everything is correct and complete", tools: [] },
    ],
    reasoning: `Generic plan (triggered by: ${triggerReason})`,
    estimatedTools: 4,
  };
}

// Detect parallel intent from heuristic patterns
const PARALLEL_SIGNALS = /\bin\s+parallel\b|\bsimultaneously\b|\bat\s+the\s+same\s+time\b|\bconcurrently\b/i;

/**
 * Check if message implies parallel execution and add parallelGroups to a heuristic plan
 */
function addParallelHints(plan: TaskPlan, message: string): TaskPlan {
  // If message explicitly says "in parallel" and there are multiple research/search steps,
  // group the middle steps (excluding first setup and last verification) as parallel
  if (PARALLEL_SIGNALS.test(message) && plan.steps.length >= 3) {
    const middleIndices = plan.steps
      .map((_, i) => i)
      .filter(i => i > 0 && i < plan.steps.length - 1);
    if (middleIndices.length >= 2) {
      return {
        ...plan,
        steps: plan.steps.map((s, i) => ({
          ...s,
          parallel: middleIndices.includes(i),
        })),
        parallelGroups: [middleIndices],
      };
    }
  }
  return plan;
}

/**
 * Format a plan as text for injection into the system prompt
 */
export function formatPlanForPrompt(plan: TaskPlan): string {
  if (!plan.needsPlan || plan.steps.length === 0) return "";

  const hasParallel = plan.parallelGroups && plan.parallelGroups.length > 0;
  const parallelIndices = new Set((plan.parallelGroups || []).flat());

  const lines = [
    "## YOUR EXECUTION PLAN",
    hasParallel
      ? "Follow these steps. Steps marked PARALLEL can be delegated to sub-agents concurrently using the sub_agent tool. After each step, state what you did and move to the next."
      : "Follow these steps IN ORDER. Do NOT skip steps. After each step, state what you did and move to the next.",
    ""
  ];

  for (const step of plan.steps) {
    const toolHint = step.tools.length > 0 ? ` [Tools: ${step.tools.join(", ")}]` : "";
    const parallelTag = parallelIndices.has(step.step - 1) ? " [PARALLEL]" : "";
    lines.push(`### Step ${step.step}: ${step.title}${toolHint}${parallelTag}`);
    lines.push(step.description);
    lines.push("");
  }

  lines.push("### IMPORTANT");
  lines.push("- Execute EVERY step. Do not stop after just one or two steps.");
  lines.push("- Use the appropriate tools for each step — do not just describe what you would do.");
  lines.push("- After the LAST step, provide a summary of what was accomplished.");
  lines.push("- If any step fails, explain the error and try to fix it before moving on.");

  return lines.join("\n");
}
