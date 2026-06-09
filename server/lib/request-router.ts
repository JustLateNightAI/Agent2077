/**
 * Deterministic Request Router — v16.73.2
 *
 * Inspired by smallcode's tool-router pattern (idea #A): a zero-LLM, regex-only
 * pre-filter that classifies the latest user request into a route category.
 * Runs BEFORE the smart tool selector so the selector can bias its picks
 * toward what the user actually asked for, and so chat-style turns can avoid
 * paying for any task tools at all.
 *
 * This is a routing HINT, not a planner. The selector still picks the final
 * tool set; the router just tells it which side of the fence we're on.
 *
 * Routes:
 *   respond         — pure chat / question / acknowledgement. No tools needed.
 *   tool_discovery  — "what tools do you have?", "list your tools", etc.
 *   deep_research   — deliberate multi-source research (forced by the Deep
 *                     Research toggle; never inferred from text alone).
 *   research        — find/look up information (web or local knowledge)
 *   web             — explicit URL fetching or web browsing
 *   code_read       — inspect/understand existing code without changes
 *   code_write      — edit/refactor/create files (non-app)
 *   app_build       — build/deploy an app/game/website/tool
 *   shell_run       — run a command (local or remote)
 *   project         — project-mode follow-up (uses project tools)
 *   unknown         — nothing matched; selector falls back to task-type bundle
 *
 * Conservative on purpose: when uncertain, returns "unknown" and lets the
 * existing smart selector do its full work.
 */
import type { TaskType } from "../../shared/schema.js";

export type Route =
  | "respond"
  | "tool_discovery"
  | "deep_research"
  | "research"
  | "web"
  | "code_read"
  | "code_write"
  | "app_build"
  | "shell_run"
  | "project"
  | "unknown";

export interface RouteDecision {
  route: Route;
  confidence: number;          // 0..1
  reasons: string[];           // which rules fired
  /** Tool categories the selector should bias toward (advisory). */
  preferCategories: string[];
  /** Specific tool names that should be present if registered (e.g. tool_list). */
  forceInclude: string[];
}

// ── Rule signals ────────────────────────────────────────────────────────────
// Each rule has a route and a regex. Negative regexes prevent obvious false hits.
// Order is informational — scoring picks the winner.

interface Rule {
  route: Route;
  weight: number;
  pattern: RegExp;
  reason: string;
}

const RULES: Rule[] = [
  // ── tool_discovery ────────────────────────────────────────────────────
  { route: "tool_discovery", weight: 100, reason: "asks 'what tools'",
    pattern: /\b(what|which|list).{0,40}(tools|tool\s+(can|do|are)|capabilit(?:ies|y))\b/i },
  { route: "tool_discovery", weight: 80, reason: "tool_list / tool_search verbatim",
    pattern: /\b(tool_list|tool_search)\b/i },
  { route: "tool_discovery", weight: 60, reason: "asks how to do X",
    pattern: /\b(do you have a (?:tool|way) (?:to|for)|is there a tool that|can you (?:list|show) (?:me )?(?:your )?tools)\b/i },

  // ── respond (pure chat / Q&A) ─────────────────────────────────────────
  { route: "respond", weight: 70, reason: "greeting only",
    pattern: /^(hi|hello|hey|sup|yo|good\s+(morning|afternoon|evening|night)|howdy)\b[\s.,!?]*$/i },
  { route: "respond", weight: 60, reason: "thanks / acknowledgement",
    pattern: /^(thanks|thank\s+you|thx|ty|ok|okay|sure|cool|nice|got\s+it|sounds\s+good|alright)\b[\s.,!?]*$/i },
  { route: "respond", weight: 35, reason: "asks model knowledge ('what is X?')",
    pattern: /^(what\s+(is|are|does|do)|explain|tell\s+me\s+about|why\s+(is|does|do)|how\s+(does|do))\b/i },

  // ── research / web ─────────────────────────────────────────────────────
  { route: "web", weight: 80, reason: "explicit URL",
    pattern: /\bhttps?:\/\/\S+/i },
  { route: "web", weight: 70, reason: "explicit fetch verb",
    pattern: /\b(fetch|download|scrape|crawl|open\s+url|visit\s+(the\s+)?(url|site|page))\b/i },
  { route: "research", weight: 60, reason: "search/lookup verb",
    pattern: /\b(search\s+(the\s+web|online|google)|google\s+for|look\s+(it\s+)?up|find\s+(?:out|the\s+latest|news|articles|info)\s+about)\b/i },
  { route: "research", weight: 45, reason: "research verb",
    pattern: /\b(research|investigate|compare|review|evaluate)\b/i },

  // ── code read / write / app build ─────────────────────────────────────
  { route: "code_read", weight: 60, reason: "read/inspect code",
    pattern: /\b(read|show\s+me|look\s+at|inspect|review|find)\s+(the\s+)?(file|files|code|function|class|module|symbol|source|contents?)\b/i },
  { route: "code_read", weight: 55, reason: "show me a *.ext file",
    pattern: /\b(show|read|cat|open|view)\s+(me\s+)?(the\s+)?(contents?\s+of\s+)?[\w./-]+\.(ts|tsx|js|jsx|py|rs|go|java|cs|cpp|c|h|sh|md|json|yaml|yml|toml|sql|html|css)\b/i },
  { route: "code_read", weight: 50, reason: "explain / what does X do",
    pattern: /\b(explain|what\s+does)\b.+\b(do|mean|return|call|function|class|file)\b/i },
  { route: "code_read", weight: 50, reason: "search/grep code",
    pattern: /\b(search|grep|find)\s+(for\s+)?\b(in\s+(?:the\s+)?(?:repo|code|codebase|project)|throughout|across)\b/i },

  { route: "code_write", weight: 70, reason: "fix/refactor/edit code",
    pattern: /\b(fix|refactor|edit|modify|update|change|rewrite|rename|replace)\b.{0,30}\b(file|function|class|bug|test|method|code|module)\b/i },
  { route: "code_write", weight: 60, reason: "add code / write tests",
    pattern: /\b(add|write|implement|create|generate)\s+(a\s+|the\s+)?(function|method|class|test|tests|module|file|interface|endpoint|component)\b/i },
  { route: "code_write", weight: 40, reason: "implement X",
    pattern: /\bimplement\b/i },

  { route: "app_build", weight: 80, reason: "build/deploy app / game / website",
    pattern: /\b(build|create|make|deploy|launch|set\s*up)\b.{0,40}\b(app|application|web\s*app|webapp|game|website|web\s*site|dashboard|tool|service)\b/i },
  { route: "app_build", weight: 60, reason: "deploy verb",
    pattern: /\bdeploy_app\b|\b(deploy|launch)\s+(a|the|my|this)\s+(app|game|website|service)\b/i },

  // ── shell ──────────────────────────────────────────────────────────────
  { route: "shell_run", weight: 80, reason: "explicit shell verb",
    pattern: /\b(run|execute|exec)\s+(this\s+|the\s+)?(command|cmd|shell|bash|script)\b/i },
  { route: "shell_run", weight: 70, reason: "ssh / remote",
    pattern: /\b(ssh|remote\s+into|on\s+the\s+server|on\s+the\s+dgx|on\s+dgx[12]|sparks?)\b/i },
  { route: "shell_run", weight: 55, reason: "pipe-y command line",
    pattern: /(?:^|\s)`[^`]{2,80}`/i },
  { route: "shell_run", weight: 45, reason: "command verbs",
    pattern: /\b(install|systemctl|docker|apt|pip|npm|yarn|curl|wget|tail|grep|chmod|chown)\s+\S+/i },

  // ── project follow-up ──────────────────────────────────────────────────
  // We can't see customPrompt from here — project bias is applied at call site.
];

const PROJECT_CONTEXT_RX = /PROJECT CONTEXT/;

const ROUTE_PREFERRED_CATEGORIES: Record<Route, string[]> = {
  respond:        [],
  tool_discovery: ["system"],
  deep_research:  ["search", "file"],
  research:       ["search"],
  web:            ["search"],
  code_read:      ["file", "code"],
  code_write:     ["file", "code"],
  app_build:      ["file", "code", "docker", "system"],
  shell_run:      ["system", "code"],
  project:        ["file", "code", "system"],
  unknown:        [],
};

const ROUTE_FORCE_INCLUDE: Record<Route, string[]> = {
  respond:        [],
  tool_discovery: ["tool_list", "tool_search"],
  deep_research:  ["web_search", "fetch_url", "browse_url", "browse_search", "browse_extract"],
  research:       [],
  web:            ["fetch_url"],
  code_read:      [],
  code_write:     [],
  app_build:      [],
  shell_run:      [],
  project:        [],
  unknown:        [],
};

// ── Casual / non-actionable chat detection (v16.75) ─────────────────────────
// The deterministic router below only emits `respond` for a narrow set of exact
// greetings/acknowledgements. Real casual chat is broader ("how's it going?",
// "lol that's wild", "I was just thinking about X"), and brand-new chats often
// open with small talk. On those turns the router returns `unknown`, the
// selector loads a full task bundle, and (with tool_choice:auto) small models
// eagerly fire floor/task tools the user never asked for.
//
// `isCasualChat` is the positive signal: the message reads as conversation.
// `hasActionableSignal` is the safety guard: if ANY action/task cue is present
// we do NOT treat the turn as casual, so tools stay enabled. This keeps the
// gate conservative — we only suppress tools when we're confident nothing was
// asked of the agent.

// Verbs/nouns that imply the user wants the agent to DO something with tools.
// Deliberately broad; a single hit disqualifies "casual".
const ACTIONABLE_SIGNAL_RX = new RegExp(
  [
    // imperative action verbs
    "\\b(create|make|build|write|edit|modify|update|change|fix|debug|refactor|implement|generate|add|remove|delete|rename|move|deploy|launch|install|run|execute|exec|start|stop|restart|search|find|look\\s*up|fetch|download|scrape|browse|open|read|show|list|inspect|analy[sz]e|compare|review|investigate|research|summari[sz]e|render|draw|paint|upscale|commit|push|pull|clone|test|check)\\b",
    // file / path / code references
    "\\b(file|files|folder|directory|repo|repository|codebase|project|function|class|module|component|endpoint|api|script|command|terminal|shell|server|database|table|query)\\b",
    "[\\w./-]+\\.(ts|tsx|js|jsx|py|rs|go|java|cs|cpp|c|h|sh|md|json|yaml|yml|toml|sql|html|css)\\b",
    // urls, backtick commands, code-fence
    "https?://\\S+",
    "`[^`]{2,}`",
    "```",
    // app/game/deploy nouns
    "\\b(app|application|webapp|web\\s*app|website|web\\s*site|game|dashboard|tool|service)\\b",
    // question forms that usually need a lookup/tool ("can you find", "do we have")
    "\\b(can\\s+you\\s+(find|search|look|fetch|run|build|make|create|fix|check|open|read|show)|do\\s+(we|i)\\s+have)\\b",
  ].join("|"),
  "i",
);

// Conversational openers / small talk. These are POSITIVE casual cues but on
// their own are not sufficient — we still require absence of actionable signal.
const CASUAL_CHAT_RX = new RegExp(
  [
    "^(hi|hey|hello|yo|sup|hiya|howdy|good\\s+(morning|afternoon|evening|night))\\b",
    "^(thanks|thank\\s+you|thx|ty|cheers|np|no\\s+prob(?:lem)?)\\b",
    "^(ok|okay|sure|alright|got\\s+it|understood|great|nice|cool|awesome|perfect|sounds\\s+good)\\b",
    "^(yes|no|yeah|nah|yep|nope|maybe|idk|i\\s+dunno)\\b",
    "^(bye|goodbye|cya|see\\s+you|later|gtg)\\b",
    "^(lol|lmao|rofl|haha+|hehe+|nice\\s+one)\\b",
    "\\bhow\\s+(are|r)\\s+(you|u|ya)\\b",
    "\\bhow.?s\\s+(it\\s+going|your\\s+day|life)\\b",
    "\\bwhat.?s\\s+up\\b",
    "\\bhow\\s+(have\\s+you\\s+been|you\\s+doing)\\b",
    "\\b(who\\s+are\\s+you|what\\s+can\\s+you\\s+do|what\\s+are\\s+you|tell\\s+me\\s+about\\s+yourself)\\b",
    "\\bjust\\s+(saying|chatting|wanted\\s+to\\s+say|thinking)\\b",
    "\\bnice\\s+to\\s+meet\\s+you\\b",
  ].join("|"),
  "i",
);

/**
 * True when the message contains any cue that the user wants an action / tool.
 * Exported for tests and for the tool-choice gate.
 */
export function hasActionableSignal(message: string | undefined): boolean {
  const msg = (message || "").trim();
  if (!msg) return false;
  return ACTIONABLE_SIGNAL_RX.test(msg);
}

/**
 * True when the latest user message reads as casual conversation / small talk
 * with NO actionable intent. Conservative: any actionable signal vetoes it.
 *
 * Used to decide `tool_choice: "none"` for the turn so the agent replies
 * normally instead of eagerly invoking tools. Tools are still attached, so a
 * genuine follow-up action on a later turn works normally.
 */
export function isCasualChat(message: string | undefined): boolean {
  const msg = (message || "").trim();
  if (!msg) return true; // empty / brand-new chat opener: nothing was asked
  if (hasActionableSignal(msg)) return false;
  // A short message with no actionable signal is very likely chit-chat.
  // (≤ 6 words, e.g. "what do you think?", "anyway, that's funny")
  const wordCount = msg.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 6) return true;
  return CASUAL_CHAT_RX.test(msg);
}

/**
 * Decide the OpenAI `tool_choice` for THIS turn.
 *  - "none"  → tools attached but the model may not call them (casual chat).
 *  - "auto"  → model decides (default for anything actionable).
 *
 * Project mode and the deep-research toggle always keep "auto" — those are
 * explicit task contexts where the user opted into tool use.
 */
export function decideToolChoice(
  message: string | undefined,
  ctx?: { customPrompt?: string; deepResearch?: boolean },
): "auto" | "none" {
  if (ctx?.deepResearch) return "auto";
  if (ctx?.customPrompt && PROJECT_CONTEXT_RX.test(ctx.customPrompt)) return "auto";
  return isCasualChat(message) ? "none" : "auto";
}

/**
 * Classify the latest user message + optional context.
 */
export function routeRequest(
  message: string | undefined,
  ctx?: { customPrompt?: string; taskType?: TaskType; hasPlan?: boolean; deepResearch?: boolean }
): RouteDecision {
  // ── Deep Research toggle is a hard override ───────────────────────────
  // The user explicitly asked for deliberate research via the chat-box
  // toggle. This is never inferred from text — it comes only from the flag —
  // so it short-circuits all regex scoring and forces the deep_research route.
  if (ctx?.deepResearch) {
    return {
      route: "deep_research",
      confidence: 1,
      reasons: ["deep research toggle ON"],
      preferCategories: ROUTE_PREFERRED_CATEGORIES.deep_research,
      forceInclude: ROUTE_FORCE_INCLUDE.deep_research,
    };
  }

  const msg = (message || "").trim();
  if (!msg) {
    return {
      route: "respond",
      confidence: 0.5,
      reasons: ["empty message"],
      preferCategories: [],
      forceInclude: [],
    };
  }

  // Project mode is a hard override — when active, treat as project follow-up
  // unless the message is clearly about something else (tool_discovery wins,
  // pure-chat respond wins).
  const inProject = !!ctx?.customPrompt && PROJECT_CONTEXT_RX.test(ctx.customPrompt);

  const scores = new Map<Route, number>();
  const reasons: string[] = [];

  for (const rule of RULES) {
    if (rule.pattern.test(msg)) {
      scores.set(rule.route, (scores.get(rule.route) ?? 0) + rule.weight);
      reasons.push(`${rule.route}+${rule.weight}: ${rule.reason}`);
    }
  }

  if (inProject) {
    // PROJECT CONTEXT acts as a strong bias: project follow-ups should route
    // to the project surface unless the message is explicitly tool-discovery,
    // respond, or web/research. We don't want code_write/code_read/app_build
    // beating project mode, because in project mode all writes go through
    // project-scoped tools.
    scores.set("project", (scores.get("project") ?? 0) + 100);
    reasons.push("project+100: PROJECT CONTEXT active");
  }

  // Take the top route. If two are within 10 points of each other, prefer
  // the more specific one (tool_discovery > respond > others > unknown).
  let best: Route = "unknown";
  let bestScore = 0;
  const PRIORITY_TIEBREAK: Route[] = [
    "tool_discovery", "deep_research", "app_build", "shell_run", "web", "research",
    "code_write", "code_read", "project", "respond",
  ];
  for (const route of PRIORITY_TIEBREAK) {
    const s = scores.get(route) ?? 0;
    if (s > bestScore) { best = route; bestScore = s; }
  }
  if (bestScore === 0) {
    return {
      route: "unknown",
      confidence: 0,
      reasons: ["no rule matched"],
      preferCategories: [],
      forceInclude: [],
    };
  }

  // Reasonable confidence curve: 0.4 at score 30, 0.8 at score 80, capped 0.95.
  const confidence = Math.min(0.95, 0.3 + bestScore / 150);

  return {
    route: best,
    confidence,
    reasons,
    preferCategories: ROUTE_PREFERRED_CATEGORIES[best] || [],
    forceInclude: ROUTE_FORCE_INCLUDE[best] || [],
  };
}
