import { useState, useRef, useEffect, useCallback, useMemo, memo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAgentName } from "@/lib/useAgentName";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Send, Square, Copy, Check, Bot, User, Wrench,
  Search, Code, Sparkles, Brain, MessageSquare, Loader2,
  GitBranch,
  Diff, X, ImagePlus, ArrowDown, FileText, Download,
  RotateCcw, Trash2, Lightbulb
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ActivityRail } from "@/components/ActivityRail";

interface Message {
  id: number;
  role: string;
  content: string;
  modelId?: string;
  taskType?: string;
  toolCalls?: string;
  confidence?: "high" | "medium" | "low" | "green" | "yellow" | "red";
  createdAt: string;
  images?: string;
}

interface DiffPreviewData {
  editId: number;
  filePath: string;
  description?: string;
  original: string;
  proposed: string;
}

interface PlanStep {
  step: number;
  title: string;
  status: "pending" | "running" | "completed";
}

interface StreamEvent {
  type: string;
  [key: string]: any;
}

const TASK_ICONS: Record<string, any> = {
  coding: Code,
  research: Search,
  creative: Sparkles,
  math: Brain,
  general: MessageSquare,
  planner: Brain,
};

const TASK_COLORS: Record<string, string> = {
  coding: "text-green-400",
  research: "text-blue-400",
  creative: "text-purple-400",
  math: "text-orange-400",
  general: "text-muted-foreground",
  planner: "text-amber-400",
};

const WELCOME_PROMPTS = [
  { icon: Code, label: "Build me a web app", prompt: "Build me a simple todo web application with a clean UI" },
  { icon: Search, label: "Research a topic", prompt: "Research the latest developments in local AI model deployment" },
  { icon: Sparkles, label: "Creative writing", prompt: "Write a cyberpunk short story about an AI that gains consciousness" },
  { icon: Brain, label: "Solve a problem", prompt: "Explain the traveling salesman problem and implement a solution" },
];

// ── Image Lightbox Component ──────────────────────────────────────
function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [meta, setMeta] = useState<any>(null);

  useEffect(() => {
    const match = src.match(/path=([^&]+)/);
    if (match) {
      const filePath = decodeURIComponent(match[1]);
      const filename = filePath.split("/").pop() || "";
      fetch(`/api/images?search=${encodeURIComponent(filename)}`)
        .then(r => r.json())
        .then(images => {
          const found = images.find((img: any) => img.filePath === filePath) || images[0];
          if (found) setMeta(found);
        })
        .catch(() => {});
    }
  }, [src]);

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    const a = document.createElement("a");
    a.href = src;
    a.download = alt || "image.png";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4 cursor-pointer overflow-auto"
      onClick={onClose}
    >
      <div className="absolute top-4 right-4 flex items-center gap-2 z-10">
        <button
          className="text-white/70 hover:text-white bg-white/10 hover:bg-white/20 rounded-full p-2 transition-colors"
          onClick={handleDownload}
          title="Download image"
        >
          <Download className="w-6 h-6" />
        </button>
        <button
          className="text-white/70 hover:text-white bg-white/10 hover:bg-white/20 rounded-full p-2 transition-colors"
          onClick={onClose}
          title="Close"
        >
          <X className="w-6 h-6" />
        </button>
      </div>
      <div className="flex flex-col items-center gap-4 max-w-[90vw]" onClick={(e) => e.stopPropagation()}>
        <img
          src={src}
          alt={alt}
          className="max-w-full max-h-[70vh] object-contain rounded-lg"
        />
        {meta && (
          <div className="bg-black/70 border border-white/10 rounded-lg p-4 w-full max-w-2xl text-sm text-white/80 space-y-1">
            {meta.prompt && (
              <div><span className="text-white/50">Prompt:</span> <span className="text-white">{meta.prompt}</span></div>
            )}
            {meta.negativePrompt && (
              <div><span className="text-white/50">Negative:</span> {meta.negativePrompt}</div>
            )}
            <div className="flex flex-wrap gap-x-6 gap-y-1 pt-1">
              {meta.model && <div><span className="text-white/50">Model:</span> {meta.model}</div>}
              {meta.generationType && <div><span className="text-white/50">Type:</span> {meta.generationType}</div>}
              {meta.width && meta.height && <div><span className="text-white/50">Size:</span> {meta.width}×{meta.height}</div>}
              {meta.steps && <div><span className="text-white/50">Steps:</span> {meta.steps}</div>}
              {meta.cfg && <div><span className="text-white/50">CFG:</span> {meta.cfg}</div>}
              {meta.sampler && <div><span className="text-white/50">Sampler:</span> {meta.sampler}</div>}
              {meta.scheduler && <div><span className="text-white/50">Scheduler:</span> {meta.scheduler}</div>}
              {meta.seed != null && <div><span className="text-white/50">Seed:</span> {meta.seed}</div>}
              {meta.durationMs && <div><span className="text-white/50">Time:</span> {(meta.durationMs / 1000).toFixed(1)}s</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Context Usage Gauge (v16.74) ───────────────────────────────────────────
// Small badge showing how much of the model's context window the current turn's
// prompt consumes, e.g. "Context: 18.4k / 32k (56%)". Color bands:
//   green <60 · yellow 60–80 · orange 80–90 · red >=90
// Hides itself when metadata is unavailable or the window is unknown.
interface ContextUsageData {
  estimatedPromptTokens: number;
  contextWindowTokens: number;
  contextUsedPercent: number;
  source: string;
  detail?: string;
}

function formatTokens(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
  }
  return String(n);
}

function ContextGauge({ usage }: { usage: ContextUsageData }) {
  if (!usage || !usage.contextWindowTokens || usage.contextWindowTokens <= 0) return null;

  const pct = usage.contextUsedPercent;
  const band =
    pct >= 90 ? { text: "text-red-400", border: "border-red-500/40", bar: "bg-red-500" } :
    pct >= 80 ? { text: "text-orange-400", border: "border-orange-500/40", bar: "bg-orange-500" } :
    pct >= 60 ? { text: "text-yellow-400", border: "border-yellow-500/40", bar: "bg-yellow-500" } :
                { text: "text-green-400", border: "border-green-500/40", bar: "bg-green-500" };

  const label = `Context: ${formatTokens(usage.estimatedPromptTokens)} / ${formatTokens(usage.contextWindowTokens)} (${Math.round(pct)}%)`;
  const sourceLabel = usage.source === "fallback"
    ? "estimated (window unknown — using conservative fallback)"
    : `window source: ${usage.source}${usage.detail ? ` (${usage.detail})` : ""}`;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            data-testid="context-gauge"
            className={`text-[10px] shrink-0 gap-1.5 ${band.border} ${band.text}`}
          >
            <span className="inline-block w-12 h-1.5 rounded-full bg-muted/40 overflow-hidden align-middle">
              <span
                className={`block h-full ${band.bar}`}
                style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
              />
            </span>
            {label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          <div>{usage.estimatedPromptTokens.toLocaleString()} est. prompt tokens</div>
          <div>{usage.contextWindowTokens.toLocaleString()} token context window</div>
          <div className="text-muted-foreground mt-1">{sourceLabel}</div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ── Inline image path detection for ComfyUI-generated images ──────────────
// Matches absolute paths like /home/.../agent2077-images/filename.png
const IMAGE_PATH_REGEX = /(\/(?:home|root)\/[^\s]*\/agent2077-images\/[^\s]+\.(?:png|jpg|jpeg|webp|gif))/gi;

function imagePathToUrl(filePath: string): string {
  return `/api/images/file?path=${encodeURIComponent(filePath)}`;
}

/** Extract and render only inline images from message content (text is handled by ReactMarkdown) */
function MessageContentWithImages({
  content,
  onImageClick,
}: {
  content: string;
  onImageClick?: (src: string, alt: string) => void;
}) {
  const parts = content.split(IMAGE_PATH_REGEX);
  if (parts.length === 1) return null; // No image paths found

  // Only render <img> tags — text is rendered separately by ReactMarkdown
  const images = parts.filter((part) => {
    IMAGE_PATH_REGEX.lastIndex = 0;
    return IMAGE_PATH_REGEX.test(part);
  });

  if (images.length === 0) return null;

  return (
    <div className="space-y-2">
      {images.map((imgPath, i) => {
        IMAGE_PATH_REGEX.lastIndex = 0;
        const url = imagePathToUrl(imgPath);
        const filename = imgPath.split("/").pop() || "image.png";
        return (
          <div key={i} className="my-2">
            <img
              src={url}
              alt={filename}
              className="max-w-sm max-h-80 rounded-lg border border-border/40 cursor-pointer hover:opacity-90 transition-opacity shadow-lg"
              onClick={() => onImageClick?.(url, filename)}
              loading="lazy"
              data-testid={`inline-image-${i}`}
            />
          </div>
        );
      })}
    </div>
  );
}

// ── Confirmation Banner ───────────────────────────────────────────
function ConfirmBanner({
  confirm,
  onRespond,
}: {
  confirm: { id: string; tool: string; args?: Record<string, any>; reason: string; resolve: (approved: boolean) => void } | null;
  onRespond: (approved: boolean) => void;
}) {
  if (!confirm) return null;
  const displayName = confirm.args?.name || confirm.args?.path || confirm.tool;
  return (
    <div
      className="border-t border-yellow-500/40 bg-yellow-950/40 backdrop-blur-sm px-4 py-3 flex items-start gap-3"
      data-testid="confirm-banner"
    >
      <div className="mt-0.5 shrink-0 w-5 h-5 rounded-full bg-yellow-500/20 border border-yellow-500/50 flex items-center justify-center">
        <span className="text-yellow-400 text-[10px] font-bold leading-none">!</span>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-yellow-300 leading-snug">
          Agent requests permission: <span className="font-mono text-yellow-200">{confirm.tool}</span>
          {displayName ? <span className="text-yellow-400/80"> → {displayName}</span> : null}
        </p>
        <p className="text-[11px] text-yellow-200/70 mt-0.5 leading-snug line-clamp-2">{confirm.reason}</p>
      </div>
      <div className="flex gap-2 shrink-0 ml-2">
        <button
          onClick={() => onRespond(false)}
          className="px-3 py-1.5 text-xs font-medium rounded border border-red-500/40 text-red-400 hover:bg-red-500/10 transition-colors"
          data-testid="confirm-deny"
        >
          Deny
        </button>
        <button
          onClick={() => onRespond(true)}
          className="px-3 py-1.5 text-xs font-medium rounded bg-yellow-500/20 border border-yellow-500/40 text-yellow-200 hover:bg-yellow-500/30 transition-colors"
          data-testid="confirm-approve"
        >
          Approve
        </button>
      </div>
    </div>
  );
}

// ── Skill Proposal Banner ────────────────────────────────────────────
function SkillProposalBanner({
  proposal,
  onRespond,
}: {
  proposal: { id: number; name: string; description: string; taskType: string; toolsUsed: string[] } | null;
  onRespond: (approved: boolean) => void;
}) {
  if (!proposal) return null;
  return (
    <div
      className="border-t border-violet-500/40 bg-violet-950/40 backdrop-blur-sm px-4 py-3 flex items-start gap-3"
      data-testid="skill-proposal-banner"
    >
      <div className="mt-0.5 shrink-0 w-5 h-5 rounded-full bg-violet-500/20 border border-violet-500/50 flex items-center justify-center">
        <span className="text-violet-300 text-[10px] font-bold leading-none">★</span>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-violet-200 leading-snug">
          New skill proposed: <span className="font-mono text-violet-100">{proposal.name}</span>
        </p>
        <p className="text-[11px] text-violet-300/70 mt-0.5 leading-snug">{proposal.description}</p>
        {proposal.toolsUsed?.length > 0 && (
          <p className="text-[10px] text-violet-400/60 mt-0.5">
            Tools: {proposal.toolsUsed.join(", ")}
          </p>
        )}
      </div>
      <div className="flex gap-2 shrink-0 ml-2">
        <button
          onClick={() => onRespond(false)}
          className="px-3 py-1.5 text-xs font-medium rounded border border-red-500/40 text-red-400 hover:bg-red-500/10 transition-colors"
          data-testid="skill-proposal-reject"
        >
          Reject
        </button>
        <button
          onClick={() => onRespond(true)}
          className="px-3 py-1.5 text-xs font-medium rounded bg-violet-500/20 border border-violet-500/40 text-violet-200 hover:bg-violet-500/30 transition-colors"
          data-testid="skill-proposal-approve"
        >
          Save Skill
        </button>
      </div>
    </div>
  );
}

export default function ChatPage({ conversationId }: { conversationId?: string }) {
  const [, navigate] = useLocation();
  const agentName = useAgentName();
  // inputRef doubles as textareaRef — uncontrolled input so keystrokes don't re-render ChatPage
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [inputEmpty, setInputEmpty] = useState(true); // only for send button disabled — avoids re-render on every keystroke
  const [streaming, setStreaming] = useState(false);
  const [pausedCredit, setPausedCredit] = useState<{ provider: string; resumeMessage: string; reason?: string; currentBalance?: string | null; floorBalance?: string | null } | null>(null);
  const [streamContent, setStreamContent] = useState("");
  const [steps, setSteps] = useState<any[]>([]);
  const [planSteps, setPlanSteps] = useState<PlanStep[]>([]);
  const [routingInfo, setRoutingInfo] = useState<any>(null);
  const [contextUsage, setContextUsage] = useState<{
    estimatedPromptTokens: number;
    contextWindowTokens: number;
    contextUsedPercent: number;
    source: string;
    detail?: string;
  } | null>(null);
  const [pendingUserMessage, setPendingUserMessage] = useState<string | null>(null);
  const [iterationCount, setIterationCount] = useState(0);
  const [toolCallCount, setToolCallCount] = useState(0);
  const [statusLog, setStatusLog] = useState<Array<{ message: string; detail?: string; timestamp: number }>>([]);
  const [nudgeInput, setNudgeInput] = useState("");
  const [nudgeSent, setNudgeSent] = useState(false);
  const [currentConvId, setCurrentConvId] = useState<number | null>(
    conversationId ? parseInt(conversationId) : null
  );
  const [activeSubAgents, setActiveSubAgents] = useState<Map<number, { title: string; color: string; status: string }>>(new Map());
  const [pendingSkill, setPendingSkill] = useState<{
    id: number; name: string; description: string; taskType: string; toolsUsed: string[];
  } | null>(null);

  const [pendingConfirm, setPendingConfirm] = useState<{
    id: string;
    tool: string;
    args?: Record<string, any>;
    reason: string;
    resolve: (approved: boolean) => void;
  } | null>(null);
  const [diffPreviews, setDiffPreviews] = useState<DiffPreviewData[]>([]);
  const [activeDiff, setActiveDiff] = useState<DiffPreviewData | null>(null);
  const [attachedImages, setAttachedImages] = useState<File[]>([]);
  const [pendingImages, setPendingImages] = useState<Array<{name: string, base64: string, mimeType: string}>>([]);
  const [attachedFiles, setAttachedFiles] = useState<Array<{name: string, content: string, mimeType: string}>>([]);
  const [lightboxImage, setLightboxImage] = useState<{ src: string; alt: string } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [deepResearch, setDeepResearch] = useState(false); // Deep Research toggle (one-shot: resets after send)
  // v16.74.5: selected reasoning/thinking mode for this chat input. Persistent
  // until changed (unlike Deep Research). Empty = Off/default. Stores the chosen
  // profile id; resolved server-side against the routed model.
  const [reasoningModeId, setReasoningModeId] = useState<string>("");
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [showJumpToPresent, setShowJumpToPresent] = useState(false);
  const { toast } = useToast();
  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef<string>("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = inputRef; // alias — same ref, used for auto-resize
  const imageInputRef = useRef<HTMLInputElement>(null);

  const convId = conversationId ? parseInt(conversationId) : currentConvId;

  const { data: messages = [], refetch } = useQuery<Message[]>({
    queryKey: ["/api/conversations", convId, "messages"],
    queryFn: async () => {
      if (!convId) return [];
      const res = await apiRequest("GET", `/api/conversations/${convId}/messages`);
      return res.json();
    },
    enabled: !!convId,
  });

  // v16.74.5: enabled models — used to build the reasoning-mode lightbulb list.
  const { data: allModels = [] } = useQuery<any[]>({
    queryKey: ["/api/models"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/models`);
      return res.json();
    },
  });

  // Deduplicated reasoning modes across enabled models (by label). Auto-routing
  // means we don't know the exact model up front, so the server matches the
  // chosen mode by id, then label, on the routed model.
  const reasoningModes = useMemo(() => {
    const seen = new Map<string, { id: string; label: string }>();
    for (const m of allModels) {
      if (!m?.isEnabled || !m?.reasoningProfiles) continue;
      let profiles: any[] = [];
      try { profiles = JSON.parse(m.reasoningProfiles); } catch { continue; }
      for (const p of profiles) {
        if (p?.id && p?.label && !seen.has(p.label)) {
          seen.set(p.label, { id: p.id, label: p.label });
        }
      }
    }
    return Array.from(seen.values());
  }, [allModels]);

  const activeReasoningLabel = reasoningModes.find(r => r.id === reasoningModeId)?.label;

  // Sync conversationId prop changes (component stays mounted across nav)
  useEffect(() => {
    if (conversationId) {
      const newId = parseInt(conversationId);
      if (newId !== currentConvId) {
        setCurrentConvId(newId);
        // Only reset streaming state if we're not currently streaming to this conversation
        if (!streaming) {
          setStreamContent("");
          setSteps([]);
          setPlanSteps([]);
          setRoutingInfo(null);
          setPendingUserMessage(null);
          setStatusLog([]);
        }
      }
    } else if (currentConvId !== null && !streaming) {
      // Navigated to new chat (no ID) — reset only if not streaming
      setCurrentConvId(null);
      setStreamContent("");
      setSteps([]);
      setPlanSteps([]);
      setRoutingInfo(null);
      setPendingUserMessage(null);
      setStatusLog([]);
    }
  }, [conversationId]);

  // Track scroll position
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const nearBottom = distanceFromBottom < 150;
    setIsNearBottom(nearBottom);
    setShowJumpToPresent(!nearBottom && (streaming || messages.length > 5));
  }, [streaming, messages.length]);

  // Only auto-scroll when near bottom
  useEffect(() => {
    const el = messagesEndRef.current;
    if (isNearBottom && el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, streamContent, isNearBottom]);

  const jumpToPresent = () => {
    const el = messagesEndRef.current;
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ behavior: "smooth" });
    setShowJumpToPresent(false);
  };

  // Subscribe to live stream if this conversation is active on another tab
  useEffect(() => {
    if (!convId || streaming) return; // Already streaming from this tab

    let aborted = false;
    let eventSource: EventSource | null = null;

    // Check if conversation is active, and if so subscribe
    fetch(`/api/conversations/${convId}/active`, { credentials: "include" })
      .then(r => r.json())
      .then(data => {
        if (aborted || !data.active) return;

        // Subscribe to live stream
        setStreaming(true);
        let content = "";
        eventSource = new EventSource(`/api/conversations/${convId}/stream`, { withCredentials: true });

        eventSource.onmessage = (ev) => {
          try {
            const event = JSON.parse(ev.data);
            switch (event.type) {
              case "content":
                content += event.content;
                setStreamContent(content);
                break;
              case "status":
                setStatusLog(prev => {
                  const entry = { message: event.message, detail: event.detail, timestamp: event.timestamp || Date.now() };
                  const next = [...prev, entry];
                  return next.length > 20 ? next.slice(-20) : next;
                });
                break;
              case "step":
                setSteps(prev => [...prev, event]);
                break;
              case "routing":
                setRoutingInfo(event);
                break;
              case "context_usage":
                setContextUsage({
                  estimatedPromptTokens: event.estimatedPromptTokens,
                  contextWindowTokens: event.contextWindowTokens,
                  contextUsedPercent: event.contextUsedPercent,
                  source: event.source,
                  detail: event.detail,
                });
                break;
              case "plan":
                if (event.steps && Array.isArray(event.steps)) {
                  setPlanSteps(event.steps.map((s: any) => ({
                    step: s.step,
                    title: s.title,
                    status: "pending" as const,
                  })));
                }
                break;
              case "subtask_progress": {
                const AGENT_COLORS = ["bg-blue-500", "bg-green-500", "bg-purple-500", "bg-orange-500", "bg-red-500"];
                setActiveSubAgents(prev => {
                  const next = new Map(prev);
                  if (event.status === "running") {
                    const colorIdx = (event.specIndex ?? 0) % AGENT_COLORS.length;
                    next.set(event.subtaskId, { title: event.title, color: AGENT_COLORS[colorIdx], status: "running" });
                  } else {
                    next.delete(event.subtaskId);
                  }
                  return next;
                });
                break;
              }
              case "confirmation_needed": {
                // Show a pinned confirmation banner above the input area.
                // The banner's Approve/Deny buttons call resolve() which fires the fetch.
                // Cannot use await here — onmessage is synchronous.
                const confirmId = event.id;
                setPendingConfirm({
                  id: confirmId,
                  tool: event.tool,
                  args: event.args,
                  reason: event.reason,
                  resolve: (approved: boolean) => {
                    fetch("/api/chat/confirm", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      credentials: "include",
                      body: JSON.stringify({ confirmId, approved }),
                    }).catch(() => {});
                    if (!approved) {
                      content += "\n\n*Operation declined by user.*";
                      setStreamContent(content);
                    }
                  },
                });
                break;
              }
              case "error":
                content += `\n\n**Error:** ${event.content}`;
                setStreamContent(content);
                break;
              case "done":
                setIterationCount(event.iterations || 0);
                setToolCallCount(event.toolCallCount || 0);
                setPlanSteps(prev => prev.map(s => ({ ...s, status: "completed" as const })));
                // Fall through to cleanup
              case "stream_end":
                setStreaming(false);
                setActiveSubAgents(new Map());
                eventSource?.close();
                eventSource = null;
                refetch();
                queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
                break;
            }
          } catch { }
        };

        eventSource.onerror = () => {
          setStreaming(false);
          eventSource?.close();
          eventSource = null;
          refetch();
        };
      })
      .catch(() => { });

    return () => {
      aborted = true;
      if (eventSource) {
        eventSource.close();
        setStreaming(false);
      }
    };
  }, [convId]); // Only re-run when conversation changes

  // Track tool calls from steps to update plan progress
  useEffect(() => {
    if (steps.length === 0 || planSteps.length === 0) return;
    const lastStep = steps[steps.length - 1];

    // When tool calls complete, try to advance plan step status
    if (lastStep?.status === "completed" || lastStep?.status === "running") {
      setPlanSteps(prev => {
        const updated = [...prev];
        // Find first pending step and mark it running, mark previous ones completed
        let foundRunning = false;
        for (let i = 0; i < updated.length; i++) {
          if (updated[i].status === "pending" && !foundRunning) {
            updated[i] = { ...updated[i], status: "running" };
            foundRunning = true;
            // Mark all previous as completed
            for (let j = 0; j < i; j++) {
              if (updated[j].status === "running") {
                updated[j] = { ...updated[j], status: "completed" };
              }
            }
            break;
          }
        }
        return updated;
      });
    }
  }, [steps.length]);

  const handleSend = useCallback(async (overrideMessage?: string) => {
    const msg = overrideMessage || inputRef.current?.value.trim() || "";
    if (!msg || streaming) return;
    // Deep Research is one-shot: snapshot the toggle for this send, then reset.
    const useDeepResearch = deepResearch;
    if (deepResearch) setDeepResearch(false);
    if (inputRef.current) { inputRef.current.value = ""; }
    setInputEmpty(true);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    setStreaming(true);
    setStreamContent("");
    setSteps([]);
    setPlanSteps([]);
    setRoutingInfo(null);
    setPendingUserMessage(msg);
    setIterationCount(0);
    setToolCallCount(0);
    setStatusLog([]);
    setActiveSubAgents(new Map());

    // requestId comes from the server via "request_id" event — reset until we receive it
    requestIdRef.current = "";

    // Convert attached images to base64
    const imageData: Array<{name: string, base64: string, mimeType: string}> = [];
    for (const file of attachedImages) {
      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve) => {
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      });
      imageData.push({ name: file.name, base64, mimeType: file.type });
    }
    setPendingImages(imageData);
    setAttachedImages([]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          conversationId: convId,
          message: msg,
          deepResearch: useDeepResearch || undefined,
          reasoningModeId: reasoningModeId || undefined,
          reasoningModeLabel: activeReasoningLabel || undefined,
          images: imageData.length > 0 ? imageData : undefined,
          attachments: attachedFiles.length > 0 ? attachedFiles : undefined,
        }),
        signal: controller.signal,
      });

      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event: StreamEvent = JSON.parse(line.slice(6));

            switch (event.type) {
              case "request_id":
                // Server sends its requestId so stop button can target it
                requestIdRef.current = event.requestId;
                break;
              case "conversation":
                setCurrentConvId(event.id);
                navigate(`/chat/${event.id}`, { replace: true });
                queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
                break;
              case "user_message":
                // Real user message is now saved in DB — fetch it immediately
                // so it appears in the chat while the agent is still responding,
                // then clear the optimistic bubble.
                refetch().then(() => {
                  setPendingUserMessage(null);
                  setPendingImages([]);
                });
                break;
              case "routing":
                setRoutingInfo(event);
                break;
              case "context_usage":
                setContextUsage({
                  estimatedPromptTokens: event.estimatedPromptTokens,
                  contextWindowTokens: event.contextWindowTokens,
                  contextUsedPercent: event.contextUsedPercent,
                  source: event.source,
                  detail: event.detail,
                });
                break;
              case "content":
                content += event.content;
                setStreamContent(content);
                break;
              case "step":
                setSteps(prev => [...prev, event]);
                break;
              case "plan":
                // Received execution plan from the agent
                if (event.steps && Array.isArray(event.steps)) {
                  setPlanSteps(event.steps.map((s: any) => ({
                    step: s.step,
                    title: s.title,
                    status: "pending" as const,
                  })));
                }
                break;
              case "skill_proposal": {
                const sk = event.skill;
                setSteps(prev => [...prev, {
                  type: "step",
                  label: `Skill proposed: ${sk?.name}`,
                  detail: sk?.description,
                  status: "completed",
                }]);
                // Only show approval banner if not auto-approved and we have an id
                if (!sk?.autoApprove && sk?.id) {
                  setPendingSkill({
                    id: sk.id,
                    name: sk.name,
                    description: sk.description,
                    taskType: sk.taskType,
                    toolsUsed: sk.toolsUsed || [],
                  });
                }
                break;
              }
              case "status":
                setStatusLog(prev => {
                  const entry = { message: event.message, detail: event.detail, timestamp: event.timestamp || Date.now() };
                  // Keep last 20 entries to avoid unbounded growth
                  const next = [...prev, entry];
                  return next.length > 20 ? next.slice(-20) : next;
                });
                break;
              case "system_notice":
                // Mid-run nudge acknowledgment (or other system notes) — surface
                // it in the activity log so the injected context is visible.
                setStatusLog(prev => {
                  const entry = { message: event.content || "Note", timestamp: Date.now() };
                  const next = [...prev, entry];
                  return next.length > 20 ? next.slice(-20) : next;
                });
                break;
              case "subtask_progress": {
                const AGENT_COLORS = ["bg-blue-500", "bg-green-500", "bg-purple-500", "bg-orange-500", "bg-red-500"];
                setActiveSubAgents(prev => {
                  const next = new Map(prev);
                  if (event.status === "running") {
                    const colorIdx = (event.specIndex ?? 0) % AGENT_COLORS.length;
                    next.set(event.subtaskId, { title: event.title, color: AGENT_COLORS[colorIdx], status: "running" });
                  } else {
                    next.delete(event.subtaskId);
                  }
                  return next;
                });
                break;
              }
              case "paused_credit": {
                const isFloor = event.reason === "balance_floor";
                const curBal = event.currentBalance != null ? `$${Number(event.currentBalance).toFixed(2)}` : null;
                const floorBal = event.floorBalance != null ? `$${Number(event.floorBalance).toFixed(2)}` : null;

                setPausedCredit({
                  provider: event.provider || "openrouter",
                  resumeMessage: event.resumeMessage || "Please continue from where you left off.",
                  reason: event.reason || "exhausted",
                  currentBalance: curBal,
                  floorBalance: floorBal,
                });
                setStreaming(false);

                // Fire a toast so the user can't miss it regardless of scroll position
                if (isFloor) {
                  toast({
                    title: "⚠️ OpenRouter balance floor reached",
                    description: curBal && floorBal
                      ? `Balance ${curBal} is below your floor of ${floorBal}. Switch to a local model or adjust the floor in Settings → API Endpoints.`
                      : "Balance is below your configured floor. Task paused.",
                    variant: "destructive",
                    duration: 10000,
                  });
                } else {
                  toast({
                    title: "⚠️ OpenRouter balance empty",
                    description: "Top up at openrouter.ai/credits then click Resume.",
                    variant: "destructive",
                    duration: 10000,
                  });
                }
                break;
              }
              case "confirmation_needed": {
                // Fix 1: confirmation_needed was missing from the main fetch stream path.
                // It only existed in the EventSource reconnect path, so the banner
                // never appeared during a live send — only visible after page reload.
                const confirmId = event.id;
                setPendingConfirm({
                  id: confirmId,
                  tool: event.tool,
                  args: event.args,
                  reason: event.reason,
                  resolve: (approved: boolean) => {
                    fetch("/api/chat/confirm", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      credentials: "include",
                      body: JSON.stringify({ confirmId, approved }),
                    }).catch(() => {});
                    if (!approved) {
                      content += "\n\n*Operation declined by user.*";
                      setStreamContent(content);
                    }
                  },
                });
                break;
              }
              case "error":
                content += `\n\n**Error:** ${event.content}`;
                setStreamContent(content);
                break;
              case "diff_preview":
                if (event.editId && event.filePath) {
                  const dp: DiffPreviewData = {
                    editId: event.editId,
                    filePath: event.filePath,
                    description: event.description,
                    original: event.original || "",
                    proposed: event.proposed || "",
                  };
                  setDiffPreviews(prev => [...prev, dp]);
                  setActiveDiff(dp);
                }
                break;
              case "done":
                setIterationCount(event.iterations || 0);
                setToolCallCount(event.toolCallCount || 0);
                // Mark all plan steps as completed when done
                setPlanSteps(prev => prev.map(s => ({ ...s, status: "completed" as const })));
                break;
            }
          } catch { }
        }
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        setStreamContent(prev => prev + `\n\n**Error:** ${err.message}`);
      }
    } finally {
      setStreaming(false);
      setPendingUserMessage(null);
      setPendingImages([]);
      setAttachedFiles([]);
      setActiveSubAgents(new Map());
      abortRef.current = null;
      // Note: do NOT clear pausedCredit here — it must persist so the Resume button stays visible
      refetch();
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
    }
  }, [streaming, convId, navigate, refetch, attachedImages, attachedFiles, deepResearch, reasoningModeId, activeReasoningLabel]);

  // Stable callbacks for MessageBubble — defined once so memo() comparator doesn't see new refs every render
  const handleBranch = useCallback((newConvId: number) => {
    queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
    navigate(`/chat/${newConvId}`);
  }, [navigate]);

  const handleDelete = useCallback((_id: number) => {
    refetch();
  }, [refetch]);

  const handleResend = useCallback((_id: number, content: string) => {
    refetch().then(() => handleSend(content));
  }, [refetch, handleSend]);

  const handleImageClick = useCallback((src: string, alt: string) => {
    setLightboxImage({ src, alt });
  }, []);

  const handleStop = () => {
    // Send server-side cancel first (before aborting the connection)
    if (requestIdRef.current) {
      fetch("/api/chat/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ requestId: requestIdRef.current }),
      }).catch(() => {});
    }
    // Then abort the SSE connection (triggers res.on("close") on server as backup)
    abortRef.current?.abort();
    setStatusLog(prev => [...prev, { message: "Stopped", timestamp: Date.now() }]);
  };

  const handleNudge = useCallback(async () => {
    const msg = nudgeInput.trim();
    if (!msg || !streaming || !convId) return;
    setNudgeInput("");
    setNudgeSent(true);
    try {
      await fetch(`/api/conversations/${convId}/inject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ message: msg }),
      });
    } catch { /* ignore — agent may have just finished */ }
    setTimeout(() => setNudgeSent(false), 3000);
  }, [nudgeInput, streaming, convId]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    // Shift+Enter naturally creates a new line in textarea
  }, [handleSend]);

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter(item => item.type.startsWith("image/"));

    // Fix 1: Large paste → auto-convert to .txt attachment
    // Threshold is user-configurable in Settings → Input → Large Paste Threshold
    const pasteThreshold = parseInt(
      (window as any).__AGENT2077_SETTINGS__?.["input.largePasteThreshold"] ?? "5000"
    );
    const pastedText = e.clipboardData.getData("text");
    if (imageItems.length === 0 && pastedText.length > pasteThreshold) {
      e.preventDefault();
      const filename = `paste-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.txt`;
      setAttachedFiles(prev => [
        ...prev,
        { name: filename, content: pastedText, mimeType: "text/plain" },
      ]);
      // Leave a short note in the input box so the user sees what happened
      if (inputRef.current && !inputRef.current.value) {
        inputRef.current.value = `[See attached ${filename}]`;
        setInputEmpty(false);
      }
      return;
    }

    if (imageItems.length === 0) return; // Let normal text paste through
    e.preventDefault();
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (file) {
        const named = new File([file], `screenshot-${Date.now()}.png`, { type: file.type });
        setAttachedImages(prev => [...prev, named]);
      }
    }
  };

  const showWelcome = !convId && messages.length === 0 && !streaming && !pendingUserMessage;

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    for (const file of files) {
      if (file.type.startsWith("image/")) {
        setAttachedImages(prev => [...prev, file]);
      } else {
        try {
          const text = await file.text();
          setAttachedFiles(prev => [...prev, { name: file.name, content: text.slice(0, 50000), mimeType: file.type || "text/plain" }]);
        } catch {
          // Binary file — skip
        }
      }
    }
  };

  const handleConfirmResponse = (approved: boolean) => {
    if (pendingConfirm) {
      pendingConfirm.resolve(approved);
      setPendingConfirm(null);
    }
  };

  const handleSkillProposalResponse = async (approved: boolean) => {
    if (!pendingSkill) return;
    const id = pendingSkill.id;
    setPendingSkill(null);
    try {
      await apiRequest("POST", `/api/skills/${id}/${approved ? "approve" : "reject"}`);
    } catch {
      // non-critical — skill stays in DB, user can manage via Skills page
    }
  };

  return (
    <div
      className="flex flex-col h-full relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-40 bg-primary/10 border-2 border-dashed border-primary/50 rounded-lg flex items-center justify-center pointer-events-none">
          <div className="text-primary font-medium text-sm">Drop files here</div>
        </div>
      )}
      {/* Top bar: tool steps + routing info + context usage gauge */}
      {(steps.length > 0 || routingInfo || contextUsage) && (
        <div className="border-b border-border bg-card/50 px-4 py-2 flex items-center gap-2 overflow-x-auto">
          {steps.slice(-5).map((step, i) => (
            <Badge
              key={i}
              variant="outline"
              className={`text-[10px] shrink-0 ${
                step.status === "completed" ? "border-green-500/30 text-green-400" :
                step.status === "failed" ? "border-red-500/30 text-red-400" :
                "border-primary/30 text-primary animate-pulse-glow"
              }`}
            >
              <Wrench className="w-3 h-3 mr-1" />
              {step.label}
            </Badge>
          ))}
          <div className="flex items-center gap-2 ml-auto shrink-0">
            {contextUsage && <ContextGauge usage={contextUsage} />}
            {routingInfo && (
              <Badge variant="outline" className="text-[10px] shrink-0">
                {routingInfo.model?.split("/").pop()} · {routingInfo.taskType}
              </Badge>
            )}
          </div>
        </div>
      )}

      {/* Messages area */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 p-4 overflow-y-auto"
      >
        {showWelcome ? (
          <div className="flex flex-col items-center justify-center h-full max-w-xl mx-auto space-y-8" data-testid="welcome-screen">
            <div className="text-center space-y-2">
              <h1 className="text-2xl font-mono font-bold">
                {agentName === "Agent2077" ? (
                <>
                  <span className="text-primary">AGENT</span>
                  <span className="text-accent">2077</span>
                </>
              ) : (
                <span className="text-primary">{agentName.toUpperCase()}</span>
              )}
              </h1>
              <p className="text-sm text-muted-foreground">What can I help you with?</p>
            </div>
            <div className="grid grid-cols-2 gap-3 w-full">
              {WELCOME_PROMPTS.map(wp => (
                <Card
                  key={wp.label}
                  className="p-3 cursor-pointer hover:border-primary/30 transition-colors group"
                  onClick={() => handleSend(wp.prompt)}
                  data-testid={`prompt-${wp.label.toLowerCase().replace(/\s+/g, "-")}`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <wp.icon className="w-4 h-4 text-primary group-hover:text-primary" />
                    <span className="text-xs font-medium">{wp.label}</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">{wp.prompt}</p>
                </Card>
              ))}
            </div>
          </div>
        ) : (
          <div className="w-full max-w-4xl xl:max-w-5xl mx-auto space-y-4 pb-4">
            {messages.map(msg => (
              <MessageBubble
                key={msg.id}
                message={msg}
                convId={convId}
                onBranch={handleBranch}
                onDelete={handleDelete}
                onResend={handleResend}
                onImageClick={handleImageClick}
              />
            ))}
            {pendingUserMessage && (
              <MessageBubble
                message={{ id: -2, role: "user", content: pendingUserMessage, createdAt: new Date().toISOString() }}
                pendingImages={pendingImages}
                onImageClick={handleImageClick}
              />
            )}

            {/* Activity rail — Odysseus-inspired live timeline of what the agent
                is doing while not directly replying. Stays condensed after the
                turn finishes so completed work doesn't dominate the transcript. */}
            {(streaming || statusLog.length > 0 || planSteps.length > 0) && (
              <ActivityRail
                statusLog={statusLog}
                steps={steps}
                planSteps={planSteps}
                streaming={streaming}
              />
            )}

            {streaming && (
              <MessageBubble
                message={{
                  id: -1,
                  role: "assistant",
                  content: streamContent || "",
                  modelId: routingInfo?.model?.split("/").pop(),
                  taskType: routingInfo?.taskType,
                  createdAt: new Date().toISOString(),
                }}
                isStreaming
                currentStatus={statusLog.length > 0 ? statusLog[statusLog.length - 1] : undefined}
                onImageClick={handleImageClick}
              />
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
        {showJumpToPresent && (
          <div className="sticky bottom-2 flex justify-center pointer-events-none">
            <button
              onClick={jumpToPresent}
              className="pointer-events-auto px-3 py-1.5 rounded-full bg-primary/90 text-primary-foreground text-xs font-medium shadow-lg hover:bg-primary transition-colors flex items-center gap-1.5"
            >
              <ArrowDown className="w-3 h-3" />
              Jump to present
            </button>
          </div>
        )}
      </div>

      {/* Sub-agent overlay */}
      <SubAgentOverlay agents={activeSubAgents} />

      {/* Diff Preview Dialog */}
      <ChatDiffPreviewDialog diff={activeDiff} onClose={() => setActiveDiff(null)} />

      {/* Image Lightbox */}
      {lightboxImage && (
        <ImageLightbox
          src={lightboxImage.src}
          alt={lightboxImage.alt}
          onClose={() => setLightboxImage(null)}
        />
      )}

      {/* Skill proposal banner — appears when agent proposes saving a new skill */}
      <SkillProposalBanner proposal={pendingSkill} onRespond={handleSkillProposalResponse} />

      {/* Confirmation banner — pinned above input, outside scroll container */}
      <ConfirmBanner confirm={pendingConfirm} onRespond={handleConfirmResponse} />

      {/* v16.40: OpenRouter credit exhaustion — Resume banner */}
      {pausedCredit && (() => {
        const isFloor = pausedCredit.reason === "balance_floor";
        return (
          <div className="border-t border-yellow-500/30 bg-yellow-500/10 px-4 py-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs text-yellow-200">
              <span className="text-yellow-400">⚠️</span>
              {isFloor ? (
                <span>
                  <strong>OpenRouter balance floor reached.</strong>{" "}
                  {pausedCredit.currentBalance && pausedCredit.floorBalance
                    ? <>Balance {pausedCredit.currentBalance} is below your floor of {pausedCredit.floorBalance}. </>
                    : <>Balance is below your configured floor. </>}
                  Switch to a local model or adjust the floor in{" "}
                  <strong>Settings → API Endpoints</strong>, then click Resume.
                </span>
              ) : (
                <span>
                  <strong>OpenRouter balance empty.</strong> Top up at{" "}
                  <a href="https://openrouter.ai/credits" target="_blank" rel="noopener" className="underline text-yellow-300 hover:text-yellow-100">openrouter.ai/credits</a>,
                  then click Resume to continue from where the agent stopped.
                </span>
              )}
            </div>
            <button
              className="shrink-0 text-xs font-medium px-3 py-1.5 rounded bg-yellow-500 hover:bg-yellow-400 text-black transition-colors"
              onClick={() => {
                setPausedCredit(null);
                handleSend(pausedCredit.resumeMessage);
              }}
            >
              Resume
            </button>
          </div>
        );
      })()}

      {/* Input area */}
      <div className="border-t border-border p-4">
        <div className="w-full max-w-4xl xl:max-w-5xl mx-auto">
          {/* File attachments */}
          {attachedFiles.length > 0 && (
            <div className="flex gap-2 px-2 py-1 mb-1 flex-wrap">
              {attachedFiles.map((file, i) => (
                <div key={i} className="flex items-center gap-1.5 bg-muted/50 rounded px-2 py-1 text-xs">
                  <FileText className="w-3 h-3 text-muted-foreground" />
                  <span className="text-muted-foreground max-w-[150px] truncate">{file.name}</span>
                  <button
                    onClick={() => setAttachedFiles(prev => prev.filter((_, j) => j !== i))}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* Image previews */}
          {attachedImages.length > 0 && (
            <div className="flex gap-2 px-1 py-1 mb-2 overflow-x-auto">
              {attachedImages.map((file, i) => (
                <div key={i} className="relative shrink-0">
                  <img
                    src={URL.createObjectURL(file)}
                    className="w-16 h-16 rounded-md object-cover border border-border"
                    alt={file.name}
                  />
                  <button
                    onClick={() => setAttachedImages(prev => prev.filter((_, j) => j !== i))}
                    className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center text-[10px] leading-none"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* Mid-run nudge bar — visible only while the agent is working.
              Adds context to the running agent instead of starting a new turn. */}
          {streaming && (
            <div className="flex gap-2 items-center mb-2 px-2 py-1.5 bg-yellow-500/10 border border-yellow-500/20 rounded-md" data-testid="nudge-bar">
              <span className="text-xs text-yellow-500/80 shrink-0 font-medium">Nudge running agent:</span>
              <input
                type="text"
                value={nudgeInput}
                onChange={(e) => setNudgeInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleNudge(); } }}
                placeholder="Add context mid-task without interrupting…"
                className="flex-1 bg-transparent border-none outline-none text-xs text-yellow-100 placeholder:text-yellow-500/40"
                data-testid="nudge-input"
              />
              {nudgeSent ? (
                <span className="text-xs text-yellow-400 shrink-0">✓ sent</span>
              ) : (
                <button
                  onClick={handleNudge}
                  disabled={!nudgeInput.trim()}
                  className="text-xs text-yellow-400 hover:text-yellow-200 disabled:opacity-30 shrink-0 font-medium transition-colors"
                  data-testid="nudge-send"
                >
                  Add context
                </button>
              )}
            </div>
          )}
          {deepResearch && (
            <div className="flex items-center gap-1.5 px-2 py-1 mb-1 text-xs text-primary" data-testid="deep-research-banner">
              <Search className="w-3 h-3" />
              <span>Deep Research is ON — your next message will run a deliberate, multi-source research workflow.</span>
            </div>
          )}
          <div className="flex items-end gap-2">
            {/* Hidden image file input */}
            <input
              type="file"
              ref={imageInputRef}
              className="hidden"
              accept="image/*"
              multiple
              onChange={(e) => {
                if (e.target.files) {
                  setAttachedImages(prev => [...prev, ...Array.from(e.target.files!)]);
                }
                e.target.value = "";
              }}
              data-testid="chat-image-file-input"
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0"
              onClick={() => imageInputRef.current?.click()}
              disabled={streaming}
              title="Attach images"
              data-testid="chat-image-upload"
            >
              <ImagePlus className="w-4 h-4" />
            </Button>
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant={deepResearch ? "default" : "ghost"}
                    size="icon"
                    className={`h-9 w-9 shrink-0 ${deepResearch ? "ring-2 ring-primary/60" : ""}`}
                    onClick={() => setDeepResearch(v => !v)}
                    disabled={streaming}
                    aria-pressed={deepResearch}
                    aria-label="Deep Research"
                    data-testid="toggle-deep-research"
                  >
                    <Search className="w-4 h-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Deep Research{deepResearch ? " — ON (next message)" : ""}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {/* v16.74.5: reasoning-mode lightbulb. Lists thinking modes configured
                on enabled models; selection persists until changed. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant={reasoningModeId ? "default" : "ghost"}
                  size="icon"
                  className={`h-9 w-9 shrink-0 ${reasoningModeId ? "ring-2 ring-yellow-500/60 text-yellow-300" : ""}`}
                  disabled={streaming}
                  aria-label="Reasoning mode"
                  title={activeReasoningLabel ? `Reasoning: ${activeReasoningLabel}` : "Reasoning mode"}
                  data-testid="toggle-reasoning-mode"
                >
                  <Lightbulb className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel className="text-xs">Reasoning mode</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => setReasoningModeId("")}
                  className="text-xs"
                  data-testid="reasoning-mode-off"
                >
                  <span className={reasoningModeId === "" ? "font-medium text-yellow-400" : ""}>Off / default</span>
                </DropdownMenuItem>
                {reasoningModes.length === 0 && (
                  <DropdownMenuItem disabled className="text-[10px] text-muted-foreground">
                    No modes — add them in Settings → Models
                  </DropdownMenuItem>
                )}
                {reasoningModes.map(rm => (
                  <DropdownMenuItem
                    key={rm.id}
                    onClick={() => setReasoningModeId(rm.id)}
                    className="text-xs"
                    data-testid={`reasoning-mode-${rm.id}`}
                  >
                    <span className={reasoningModeId === rm.id ? "font-medium text-yellow-400" : ""}>{rm.label}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Textarea
              ref={inputRef}
              onChange={e => {
                // Uncontrolled: only update inputEmpty for send button, not full state re-render
                setInputEmpty(e.target.value.trim() === "");
                // Auto-resize
                const el = e.target;
                el.style.height = "auto";
                el.style.height = Math.min(el.scrollHeight, 200) + "px";
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={`Message ${agentName}...`}
              className="resize-none min-h-[40px] max-h-[200px] text-sm overflow-y-auto flex-1"
              rows={1}
              disabled={streaming}
              data-testid="input-chat"
            />
            {streaming ? (
              <Button variant="destructive" size="sm" onClick={handleStop} data-testid="button-stop" className="shrink-0">
                <Square className="w-4 h-4" />
              </Button>
            ) : (
              <Button size="sm" onClick={() => handleSend()} disabled={inputEmpty && attachedImages.length === 0} data-testid="button-send" className="shrink-0">
                <Send className="w-4 h-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-Agent Overlay Component ─────────────────────────────────
function SubAgentOverlay({ agents }: { agents: Map<number, { title: string; color: string; status: string }> }) {
  if (agents.size === 0) return null;
  return (
    <div className="fixed bottom-20 right-4 flex flex-col-reverse gap-3 z-50" data-testid="sub-agent-overlay">
      {Array.from(agents.entries()).map(([id, agent]) => (
        <div key={id} className="flex items-end gap-2 animate-in slide-in-from-right-5 duration-300" data-testid={`sub-agent-${id}`}>
          {/* Thought bubble */}
          <div className="relative bg-card border border-border rounded-lg px-3 py-1.5 max-w-52 shadow-lg">
            <p className="text-[11px] text-foreground leading-snug">{agent.title}</p>
            {/* Tail */}
            <div className="absolute -right-1.5 bottom-2 w-3 h-3 bg-card border-r border-b border-border rotate-[-45deg]" />
          </div>
          {/* Agent avatar */}
          <div className={`w-8 h-8 rounded-full ${agent.color} flex items-center justify-center text-white text-sm shadow-lg ring-2 ring-background shrink-0`}>
            <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5">
              <circle cx="12" cy="8" r="4" fill="currentColor" />
              <path d="M4 20c0-4.4 3.6-8 8-8s8 3.6 8 8" fill="currentColor" opacity="0.7" />
            </svg>
          </div>
        </div>
      ))}
    </div>
  );
}


// ── Confidence Badge ─────────────────────────────────────────────
function ConfidenceBadge({ confidence }: { confidence: string }) {
  const normalized = confidence === "high" || confidence === "green" ? "high"
    : confidence === "medium" || confidence === "yellow" ? "medium"
    : "low";
  
  if (normalized === "high") return (
    <div className="flex items-center gap-1 mt-1" data-testid="confidence-high">
      <div className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
      <span className="text-[10px] text-green-400">High confidence</span>
    </div>
  );
  if (normalized === "medium") return (
    <div className="flex items-center gap-1 mt-1" data-testid="confidence-medium">
      <div className="w-1.5 h-1.5 rounded-full bg-yellow-500 shrink-0" />
      <span className="text-[10px] text-yellow-400">Medium confidence</span>
    </div>
  );
  return (
    <div className="flex items-center gap-1 mt-1" data-testid="confidence-low">
      <div className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
      <span className="text-[10px] text-red-400">Low confidence</span>
    </div>
  );
}

// ── Chat Diff Preview Dialog ──────────────────────────────────────
function ChatDiffPreviewDialog({
  diff,
  onClose,
}: {
  diff: DiffPreviewData | null;
  onClose: () => void;
}) {
  const { toast } = useToast();

  const approveMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/edits/${id}/approve`),
    onSuccess: () => { toast({ title: "Edit approved" }); onClose(); },
    onError: () => toast({ title: "Approve failed", variant: "destructive" }),
  });

  const rejectMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/edits/${id}/reject`),
    onSuccess: () => { toast({ title: "Edit rejected" }); onClose(); },
    onError: () => toast({ title: "Reject failed", variant: "destructive" }),
  });

  if (!diff) return null;

  const origLines = diff.original.split("\n");
  const propLines = diff.proposed.split("\n");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" data-testid="diff-preview-modal">
      <div className="bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl w-full max-w-4xl mx-4 flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
          <Diff className="w-4 h-4 text-primary" />
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-mono text-primary">Diff Preview</h3>
            <p className="text-[11px] text-zinc-400 font-mono truncate">{diff.filePath}</p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        {diff.description && (
          <div className="px-4 py-2 text-xs text-zinc-400 border-b border-zinc-800">{diff.description}</div>
        )}
        {/* Side-by-side diff */}
        <div className="flex gap-0 flex-1 overflow-hidden text-xs font-mono">
          <div className="flex-1 overflow-auto bg-red-950/10">
            <div className="sticky top-0 px-3 py-1 bg-red-900/30 text-red-400 text-[10px] border-b border-red-900/20">Original</div>
            <div className="p-3 space-y-0">
              {origLines.map((line, i) => (
                <div key={i} className="text-red-300/70 whitespace-pre leading-5">{line || " "}</div>
              ))}
            </div>
          </div>
          <div className="w-px bg-zinc-800 shrink-0" />
          <div className="flex-1 overflow-auto bg-green-950/10">
            <div className="sticky top-0 px-3 py-1 bg-green-900/30 text-green-400 text-[10px] border-b border-green-900/20">Proposed</div>
            <div className="p-3 space-y-0">
              {propLines.map((line, i) => (
                <div key={i} className="text-green-300/70 whitespace-pre leading-5">{line || " "}</div>
              ))}
            </div>
          </div>
        </div>
        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-800">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            Close
          </button>
          <button
            onClick={() => rejectMutation.mutate(diff.editId)}
            disabled={rejectMutation.isPending || approveMutation.isPending}
            className="px-3 py-1.5 text-xs bg-red-600/20 border border-red-600/40 text-red-400 hover:bg-red-600/30 rounded transition-colors disabled:opacity-50"
            data-testid="button-reject-diff"
          >
            {rejectMutation.isPending ? "Rejecting..." : "Reject"}
          </button>
          <button
            onClick={() => approveMutation.mutate(diff.editId)}
            disabled={approveMutation.isPending || rejectMutation.isPending}
            className="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-700 text-white rounded transition-colors disabled:opacity-50"
            data-testid="button-approve-diff"
          >
            {approveMutation.isPending ? "Approving..." : "Approve"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Message Bubble Component ────────────────────────────────────────
const MessageBubble = memo(function MessageBubble({
  message,
  isStreaming,
  convId,
  onBranch,
  onDelete,
  onResend,
  currentStatus,
  pendingImages,
  onImageClick,
}: {
  message: Message;
  isStreaming?: boolean;
  convId?: number | null;
  onBranch?: (newConvId: number) => void;
  onDelete?: (id: number) => void;
  onResend?: (id: number, content: string) => void;
  currentStatus?: { message: string; detail?: string };
  pendingImages?: Array<{name: string, base64: string, mimeType: string}>;
  onImageClick?: (src: string, alt: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [branching, setBranching] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [resending, setResending] = useState(false);
  const isUser = message.role === "user";

  // Parse stored images from DB messages or use pending images for in-flight message
  const storedImages: Array<{name: string, base64: string, mimeType: string}> =
    message.images ? (() => { try { return JSON.parse(message.images!); } catch { return []; } })() : [];
  const displayImages = isUser && message.id === -2 && pendingImages ? pendingImages : storedImages;

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleBranch = async () => {
    if (!convId || !onBranch || branching || message.id < 0) return;
    setBranching(true);
    try {
      const res = await apiRequest("POST", `/api/conversations/${convId}/branch`, { messageId: message.id });
      const newConv = await res.json();
      onBranch(newConv.id);
    } catch (err) {
      console.error("[Branch] Failed:", err);
    } finally {
      setBranching(false);
    }
  };

  const canBranch = (message.role === "user" || message.role === "assistant") && message.id > 0 && !!convId && !!onBranch;
  const canDelete = message.id > 0 && !!onDelete;
  const canResend = message.role === "user" && message.id > 0 && !!onResend;

  const handleDelete = async () => {
    if (!onDelete || deleting || message.id < 0) return;
    setDeleting(true);
    try {
      await apiRequest("DELETE", `/api/messages/${message.id}`);
      onDelete(message.id);
    } catch (err) {
      console.error("[Delete] Failed:", err);
    } finally {
      setDeleting(false);
    }
  };

  const handleResend = async () => {
    if (!onResend || resending || message.id < 0) return;
    setResending(true);
    try {
      const res = await apiRequest("POST", `/api/messages/${message.id}/resend`);
      const data = await res.json();
      onResend(message.id, data.content);
    } catch (err) {
      console.error("[Resend] Failed:", err);
    } finally {
      setResending(false);
    }
  };

  const TaskIcon = message.taskType ? TASK_ICONS[message.taskType] || MessageSquare : null;

  return (
    <div className={`flex gap-3 group/msg ${isUser ? "justify-end" : ""}`} data-testid={`message-${message.id}`}>
      {!isUser && (
        <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-1">
          <Bot className="w-4 h-4 text-primary" />
        </div>
      )}

      <div className={`flex-1 min-w-0 overflow-hidden ${isUser ? "max-w-[85%] text-right" : "max-w-full"}`}>
        {/* Metadata */}
        {!isUser && message.modelId && (
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-mono text-muted-foreground">
              {message.modelId.split("/").pop()}
            </span>
            {TaskIcon && (
              <Badge variant="outline" className={`text-[10px] h-4 ${TASK_COLORS[message.taskType || "general"]}`}>
                {message.taskType}
              </Badge>
            )}
          </div>
        )}

        <div className={`rounded-lg max-w-full min-w-0 ${
          isUser
            ? "inline-block text-sm px-3 py-2 bg-primary text-primary-foreground ml-auto"
            : "block text-[15px] leading-relaxed px-5 py-4 bg-card border border-border"
        }`}>
          {isUser ? (
            <>
              {displayImages.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-2">
                  {displayImages.map((img, i) => (
                    <img
                      key={i}
                      src={img.base64}
                      className="max-w-xs rounded-md border border-border/40 cursor-pointer hover:opacity-80 transition-opacity"
                      alt={img.name}
                      onClick={() => onImageClick?.(img.base64, img.name)}
                    />
                  ))}
                </div>
              )}
              <p className="whitespace-pre-wrap">{message.content}</p>
            </>
          ) : (
            <div className="markdown-content">
              {message.content ? (
                <>
                  {/* Inline ComfyUI images */}
                  <MessageContentWithImages content={message.content} onImageClick={onImageClick} />
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeHighlight]}
                    components={{
                      pre: ({ children }) => (
                        <div className="relative group my-2">
                          <pre className="bg-muted/50 rounded p-3 text-xs overflow-x-auto max-w-full whitespace-pre-wrap break-words">{children}</pre>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="absolute top-1 right-1 h-6 w-6 p-0 opacity-0 group-hover:opacity-100"
                            onClick={() => {
                              const code = (children as any)?.props?.children;
                              if (code) navigator.clipboard.writeText(String(code));
                            }}
                          >
                            <Copy className="w-3 h-3" />
                          </Button>
                        </div>
                      ),
                    }}
                  >
                    {message.content.replace(IMAGE_PATH_REGEX, "").trim()}
                  </ReactMarkdown>
                </>
              ) : isStreaming ? (
                <div className="flex items-center gap-1.5 py-1">
                  <Loader2 className="w-3 h-3 animate-spin text-primary" />
                  <span className="text-xs text-muted-foreground">
                    {currentStatus?.message || "Thinking..."}
                  </span>
                  {currentStatus?.detail && (
                    <span className="text-[10px] text-muted-foreground/60">
                      {currentStatus.detail}
                    </span>
                  )}
                </div>
              ) : null}
              {isStreaming && message.content && <span className="inline-block w-2 h-4 bg-primary animate-pulse ml-0.5" />}
            </div>
          )}
        </div>

        {/* Confidence badge */}
        {!isUser && message.confidence && (
          <ConfidenceBadge confidence={message.confidence} />
        )}

        {/* Actions */}
        {!isStreaming && (
          <div className={`flex items-center gap-1 mt-1 ${
            isUser ? "justify-end" : ""
          } opacity-0 group-hover/msg:opacity-100 transition-opacity`}>
            {!isUser && (
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-5 px-1" onClick={handleCopy}>
                      {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom"><p className="text-xs">Copy</p></TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {canBranch && (
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 px-1"
                      onClick={handleBranch}
                      disabled={branching}
                      data-testid={`branch-${message.id}`}
                    >
                      {branching
                        ? <Loader2 className="w-3 h-3 animate-spin" />
                        : <GitBranch className="w-3 h-3" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom"><p className="text-xs">Branch from here</p></TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {canResend && (
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 px-1 text-primary/70 hover:text-primary"
                      onClick={handleResend}
                      disabled={resending}
                      data-testid={`resend-${message.id}`}
                    >
                      {resending
                        ? <Loader2 className="w-3 h-3 animate-spin" />
                        : <RotateCcw className="w-3 h-3" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom"><p className="text-xs">Resend — clears responses after this</p></TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {canDelete && (
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 px-1 text-destructive/60 hover:text-destructive"
                      onClick={handleDelete}
                      disabled={deleting}
                      data-testid={`delete-msg-${message.id}`}
                    >
                      {deleting
                        ? <Loader2 className="w-3 h-3 animate-spin" />
                        : <Trash2 className="w-3 h-3" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom"><p className="text-xs">Delete message</p></TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        )}
      </div>

      {isUser && (
        <div className="w-7 h-7 rounded-full bg-accent/10 flex items-center justify-center shrink-0 mt-1">
          <User className="w-4 h-4 text-accent" />
        </div>
      )}
    </div>
  );
}, (prev, next) => {
  // Only re-render if something meaningful actually changed
  return (
    prev.message.id === next.message.id &&
    prev.message.content === next.message.content &&
    prev.message.role === next.message.role &&
    prev.isStreaming === next.isStreaming &&
    prev.convId === next.convId &&
    prev.currentStatus?.message === next.currentStatus?.message &&
    prev.pendingImages === next.pendingImages
    // onBranch/onDelete/onResend/onImageClick intentionally excluded —
    // they are stable useCallback refs from the parent
  );
});
