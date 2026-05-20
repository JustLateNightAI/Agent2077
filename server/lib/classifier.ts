/**
 * Task Classifier — Hybrid keyword + LLM classification
 * 
 * Now with conversation-context awareness:
 * - Follow-up messages inherit the task type from the conversation
 * - "pick up where you left off" in a coding conversation stays as coding
 */
import type { TaskType } from "../../shared/schema.js";
import { messageStore } from "../storage.js";

// ── Short-circuit patterns ─────────────────────────────────────────
const GENERAL_OVERRIDES: RegExp[] = [
  /^(hi|hey|hello|yo|sup|hiya|howdy)[!.?,]*$/i,
  /^(thanks|thank you|thx|ty|cheers|np|no prob)[!.?,]*$/i,
  /^(ok|okay|sure|alright|got it|understood|great|nice)[!.?,]*$/i,
  /^(yes|no|yeah|nah|yep|nope)[!.?,]*$/i,
  /^(bye|goodbye|cya|see you)[!.?,]*$/i,
  /^(lol|lmao|haha|hehe)[!.?,]*$/i,
];

const AGENT_DIRECTED_QUESTION = /\b(you|your|yourself|ur|u)\b/i;

// ── Follow-up / continuation patterns ─────────────────────────────
// These indicate the user is referring to an ongoing task, not starting a new one
const CONTINUATION_PATTERNS: RegExp[] = [
  /\b(pick\s+up|continue|resume|finish|complete|keep\s+going|carry\s+on|go\s+on|proceed)\b/i,
  /\b(where\s+you\s+left\s+off|from\s+where|left\s+off|got\s+stuck|stopped|failed|didn.?t\s+finish|didn.?t\s+complete)\b/i,
  /\b(try\s+again|retry|redo|do\s+it\s+again|one\s+more\s+time|another\s+attempt)\b/i,
  /\b(what\s+happened|why\s+did\s+you\s+stop|what\s+went\s+wrong|the\s+error|that\s+error)\b/i,
  /\b(step\s+\d|the\s+next\s+step|remaining\s+steps|the\s+rest)\b/i,
  /\b(still\s+need|not\s+done|not\s+finished|incomplete|unfinished)\b/i,
];

// ── Task patterns ──────────────────────────────────────────────────
const TASK_PATTERNS: Record<Exclude<TaskType, "general">, RegExp[]> = {
  coding: [
    // Intent verbs followed (eventually) by a software noun
    /\b(write|create|build|make|implement|generate|code|develop|design)\b.{0,40}\b(script|program|function|class|component|api|endpoint|module|app|application|website|web\s*app|server|cli|tool|bot|plugin|extension|game|editor|calculator|timer|dashboard|viewer|program|software)\b/i,
    // "code" used as a verb anywhere
    /\b(code\s+me|code\s+a|code\s+up|code\s+this|code\s+it)\b/i,
    // "lets build/code/make" etc
    /\b(lets|let's|let\s+us|i\s+want\s+(you\s+to|to))\s+(code|build|make|create|write|develop|program)\b/i,
    // Fix/debug/refactor
    /\b(fix|debug|refactor|optimize|review)\s+(this\s+|the\s+|my\s+)?(code|function|bug|error|script|class|program|issue)\b/i,
    // How-to coding
    /\b(how\s+do\s+i|how\s+to)\s+(code|program|implement|write\s+a|build\s+a)\b/i,
    // Language/framework mentions
    /\b(python|javascript|typescript|rust|golang|java|kotlin|swift|ruby|php|c\+\+|c#|bash|shell|sql|html|css|react|vue|angular|node\.?js|express|django|flask|fastapi|next\.?js|svelte|tailwind|graphql|prisma|drizzle)\b/i,
    // Dev tool mentions
    /\b(npm|pip|cargo|docker|git|kubernetes|terraform|ansible|webpack|vite|eslint|prettier)\b/i,
    // CS concepts
    /\b(algorithm|data\s+structure|regex|recursion|async|await|promise|callback|closure|generics|polymorphism|runtime|compile|transpile|lint|deploy|dockerfile|ci\/cd)\b/i,
    // App Store references (for/to/in/on the app store)
    /\b(for|to|in|into|on)\s+(the\s+)?app\s*store\b/i,
    // Quality + software noun ("high quality app", "simple game")
    /\b(web|simple|basic|complex|full|high[\s-]?quality|beautiful|fancy|cool|nice|good|great)\s+(app|game|tool|program|editor|viewer|website|application|dashboard|interface|ui)\b/i,
    // "drawing app", "video editor", "music player" etc — compound software nouns
    /\b(drawing|painting|video|music|audio|photo|image|file|text|note|task|todo|chat|weather|clock|calendar|recipe)\s+(app|application|program|editor|player|viewer|manager|tracker|tool)\b/i,
    // Direct requests: "make it", "build it", "code it" after context suggests coding
    /\b(make|build|code|create|write)\s+it\b/i,
  ],
  research: [
    /\b(research|analyze|analyse|investigate|study|examine|explore)\b/i,
    /\b(what\s+is|what\s+are|who\s+is|who\s+are|what\s+does)\s+\w+/i,
    /\b(how\s+does|how\s+do|why\s+does|why\s+do)\s+(?!you\b|it\b)[a-z]/i,
    /\b(tell\s+me\s+about|summarize|summarise|overview\s+of|summary\s+of)\b/i,
    /\b(history\s+of|origin\s+of|background\s+on|evolution\s+of)\b/i,
    /\b(compare|contrast|difference\s+between|pros\s+and\s+cons|advantages\s+of|disadvantages\s+of|tradeoffs?)\b/i,
    /\b(latest\s+news|recent\s+developments?|what.s\s+happening|news\s+about)\b/i,
    /\b(deep\s+dive|comprehensive\s+(guide|overview|analysis)|look\s+into|find\s+out\s+about|search\s+for|look\s+up)\b/i,
    /\b(explain|describe)\s+(?!yourself|myself|itself)[a-z]/i,
  ],
  creative: [
    /\b(write|generate|create|draft|compose)\s+(me\s+)?(a|an)?\s*(story|poem|essay|article|blog\s+post|fiction|narrative|short\s+story|tale|novel|haiku|sonnet|limerick|song|lyrics|screenplay|script|dialogue|monologue)\b/i,
    /\b(brainstorm|ideate|come\s+up\s+with\s+ideas|generate\s+ideas|think\s+of\s+ideas)\b/i,
    /\b(marketing\s+copy|slogan|tagline|advertisement|ad\s+copy|campaign\s+brief|brand\s+voice|pitch)\b/i,
    /\b(creative\s+writing|short\s+story|world\s+building|character\s+development|plot\s+outline)\b/i,
  ],
  math: [
    /\b(calculate|compute|solve|evaluate|simplify|factor|integrate|differentiate|derive)\b/i,
    /\b(equation|formula|theorem|proof|matrix|determinant|eigenvalue|vector|integral|derivative|limit|series|sequence)\b/i,
    /\b(algebra|geometry|calculus|trigonometry|statistics|probability|linear\s+algebra|number\s+theory|combinatorics|discrete\s+math)\b/i,
    /\b(math|maths|mathematical|arithmetic|numerical)\b/i,
    /\b\d+\s*[\+\-\*\/\^\%]\s*\d+\b/,
    /\b\d+\s*(plus|minus|times|divided\s+by|squared|cubed|to\s+the\s+power)\s*\d*/i,
    /\bwhat\s+(is|are|equals?)\s+[\d\(]/i,
    /\bwhat\s+(is|are)\s+\d/i,
    /\b(mean|median|variance|standard\s+deviation|p\-?value|confidence\s+interval|correlation|regression|hypothesis\s+test)\b/i,
    /\b(mean|median)\s+(and|or|,)\s*mode\b/i,
    /\bmode\s+of\s+(a\s+)?(distribution|dataset|sample|set|list)\b/i,
  ],
};

/**
 * Classify a message, optionally with conversation context.
 * If conversationId is provided and the message looks like a follow-up,
 * we inherit the task type from the most recent assistant message.
 */
export function classifyByKeywords(
  message: string,
  conversationId?: number
): { taskType: TaskType; confidence: number } {
  const trimmed = message.trim();

  // Pass 0: Check if this is a follow-up/continuation in an existing conversation
  if (conversationId) {
    const isContinuation = CONTINUATION_PATTERNS.some(p => p.test(trimmed));
    if (isContinuation) {
      const prevTaskType = getConversationTaskType(conversationId);
      if (prevTaskType && prevTaskType !== "general") {
        console.log(`[Classifier] Continuation detected → inheriting task type: ${prevTaskType}`);
        return { taskType: prevTaskType, confidence: 0.85 };
      }
    }
  }

  // Pass 1: Conversational short-circuit (only for very short standalone greetings)
  for (const pattern of GENERAL_OVERRIDES) {
    if (pattern.test(trimmed)) {
      return { taskType: "general", confidence: 0.95 };
    }
  }

  const scores: Record<TaskType, number> = { coding: 0, research: 0, creative: 0, math: 0, general: 0 };

  for (const [taskType, patterns] of Object.entries(TASK_PATTERNS) as [Exclude<TaskType, "general">, RegExp[]][]) {
    for (const pattern of patterns) {
      if (pattern.test(trimmed)) scores[taskType] += 1;
    }
  }

  // Pass 2: Agent-directed question — only penalize if truly no task signal
  if (AGENT_DIRECTED_QUESTION.test(trimmed)) {
    const totalNonGeneral = scores.coding + scores.research + scores.creative + scores.math;
    if (totalNonGeneral === 0) {
      // No task keywords at all + mentions "you" — check conversation context before defaulting
      if (conversationId) {
        const prevTaskType = getConversationTaskType(conversationId);
        if (prevTaskType && prevTaskType !== "general") {
          console.log(`[Classifier] Agent-directed but has conversation context → ${prevTaskType}`);
          return { taskType: prevTaskType, confidence: 0.70 };
        }
      }
      return { taskType: "general", confidence: 0.75 };
    }
  }

  const entries = (Object.entries(scores) as [TaskType, number][]).sort((a, b) => b[1] - a[1]);
  const [best, second] = entries;

  if (best[1] === 0) {
    // No keyword matches — check conversation context
    if (conversationId) {
      const prevTaskType = getConversationTaskType(conversationId);
      if (prevTaskType && prevTaskType !== "general") {
        console.log(`[Classifier] No keywords but conversation context → ${prevTaskType}`);
        return { taskType: prevTaskType, confidence: 0.60 };
      }
    }
    return { taskType: "general", confidence: 0.3 };
  }

  const ratio = second[1] > 0 ? best[1] / second[1] : Infinity;
  const confidence = ratio >= 2 ? 0.85 : ratio >= 1.5 ? 0.65 : 0.5;

  return { taskType: best[0], confidence };
}

/**
 * Look at the most recent assistant message in a conversation to determine
 * what task type was used. This lets follow-up messages inherit context.
 */
function getConversationTaskType(conversationId: number): TaskType | null {
  try {
    const messages = messageStore.getByConversation(conversationId);
    // Find the most recent assistant message with a task type
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant" && msg.taskType) {
        return msg.taskType as TaskType;
      }
    }
  } catch {
    // Storage might not be ready yet
  }
  return null;
}

/**
 * Build a classification prompt for LLM-based classification
 * Used when keyword confidence is low, or as a second pass
 */
export function buildClassificationPrompt(message: string): string {
  return `Classify this user message into exactly one category. Reply with ONLY the category name, nothing else.

Categories:
- coding: Writing, debugging, or discussing code, programming languages, or software tools
- research: Factual questions, analysis, comparisons, news, explanations of topics
- creative: Creative writing, brainstorming, marketing copy, storytelling
- math: Mathematical calculations, equations, statistics, numerical reasoning
- general: Greetings, casual chat, questions about the agent itself, unclear intent

Message: "${message}"

Category:`;
}
