/**
 * Self-Development Chat Page — 3-panel layout for Agent2077 self-development mode.
 * LEFT:   Dev session status (build, test, server info)
 * CENTER: Chat interface connected to /api/self-dev/chat via SSE
 * RIGHT:  File viewer for browsing dev workspace files
 */
import { useState, useRef, useEffect, useCallback, Component, type ErrorInfo, type ReactNode } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAgentName } from "@/lib/useAgentName";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ActivityRail } from "@/components/ActivityRail";
import { useChatStream } from "@/hooks/use-chat-stream";
import { MarkdownMessage } from "@/components/chat-markdown";
import { ChatMessageBubble } from "@/components/ChatMessageBubble";
import type { ChatStreamEvent } from "@shared/chat-events";

// ── Pixel-based drag handle (same pattern as workspace.tsx) ──────────────────
function DragHandle({ onDragStart, onDrag }: { onDragStart: () => void; onDrag: (delta: number) => void }) {
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    onDragStart();
    const startX = e.clientX;
    const handleMouseMove = (ev: MouseEvent) => onDrag(ev.clientX - startX);
    const handleMouseUp = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };
  return (
    <div
      onMouseDown={handleMouseDown}
      className="shrink-0 w-[3px] bg-border hover:bg-primary/40 cursor-col-resize transition-colors"
    />
  );
}
import {
  Bot, User, Send, Square, Copy, Check, Loader2,
  Play, RefreshCw, Plus, PlusCircle, ExternalLink, ImagePlus, X,
  FolderOpen, FileText, Server, CheckCircle2,
  XCircle, Clock, Terminal, Code2, Wrench,
  ChevronRight, ChevronDown, Activity, Download, Shield,
  Rocket, RotateCcw, Trash2, AlertTriangle, History, CheckCircle,
} from "lucide-react";

// ── Error Boundary ──────────────────────────────────────────────────

class DevErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[SelfDev] UI crash:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-full flex flex-col items-center justify-center bg-background p-8">
          <div className="max-w-lg text-center space-y-4">
            <XCircle className="w-12 h-12 text-red-400 mx-auto" />
            <h2 className="text-lg font-semibold text-foreground">Self-Dev UI Crashed</h2>
            <p className="text-sm text-muted-foreground">
              Something went wrong rendering this page. This can happen when a self-dev code change
              causes an error in the dev server.
            </p>
            <pre className="text-xs text-red-400/80 bg-red-900/10 border border-red-500/20 rounded p-3 overflow-x-auto whitespace-pre-wrap text-left max-h-32">
              {this.state.error?.message || "Unknown error"}
            </pre>
            <Button
              variant="outline"
              className="border-primary/30 hover:border-primary/60"
              onClick={() => this.setState({ hasError: false, error: null })}
            >
              <RefreshCw className="w-4 h-4 mr-2" /> Try Again
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface DevStatus {
  devNumber: number | null;
  devDir: string | null;
  stableDir: string;
  serverStatus: string;
  serverPort: number;
  localUrl: string;
  networkUrl: string | null;
  lastBuild: { success: boolean; output: string; timestamp: string } | null;
  lastTests: { passed: number; failed: number; total: number; details: string; timestamp: string } | null;
  logLines: string[];
  statusEvents?: Array<{ message: string; detail?: string; timestamp: number }>;
}

interface Message {
  id: number;
  role: string;
  content: string;
  images?: string;
  createdAt: string;
}

// ── Status Badge ──────────────────────────────────────────────────────────────

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${ok ? "bg-green-400" : "bg-red-400"} mr-1.5`}
    />
  );
}

// ── Image Lightbox ──────────────────────────────────────────────────────────

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
              {meta.seed != null && <div><span className="text-white/50">Seed:</span> {meta.seed}</div>}
              {meta.durationMs && <div><span className="text-white/50">Time:</span> {(meta.durationMs / 1000).toFixed(1)}s</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Status Panel (left) ───────────────────────────────────────────────────────

function StatusPanel({ status, onRefresh }: { status: DevStatus | null; onRefresh: () => void }) {
  const { toast } = useToast();
  const [showLogs, setShowLogs] = useState(false);

  const postAction = useMutation({
    mutationFn: async (action: string) => {
      const res = await apiRequest("POST", `/api/self-dev/${action}`);
      return res.json();
    },
    onSuccess: (data, action) => {
      toast({ title: `${action} completed`, description: data.message || "Done" });
      onRefresh();
    },
    onError: (err: any, action) => {
      toast({ title: `${action} failed`, description: err.message, variant: "destructive" });
    },
  });

  const serverRunning = status?.serverStatus === "running";

  return (
    <div className="flex flex-col h-full min-w-0 bg-background/50 border-r border-border/40">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/40 bg-black/30">
        <span className="font-mono text-xs text-primary font-semibold uppercase tracking-wider truncate">
          Dev Session
        </span>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onRefresh}>
          <RefreshCw className="w-3 h-3" />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-3 space-y-4 min-w-0">
          {/* Session info */}
          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Session</p>
            <div className="font-mono text-xs space-y-0.5">
              <div className="flex items-center gap-1.5 text-foreground/80">
                <Code2 className="w-3 h-3 text-primary" />
                <span>
                  {status?.devNumber != null
                    ? `dev-${String(status.devNumber).padStart(3, "0")}`
                    : "Not initialized"}
                </span>
              </div>
              {status?.devDir && (
                <div className="text-muted-foreground truncate pl-4" title={status.devDir}>
                  {status.devDir}
                </div>
              )}
            </div>
          </div>

          {/* Dev Server */}
          <div className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Dev Server</p>

            {/* Status + controls row */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <StatusDot ok={serverRunning} />
                <span className="font-mono text-xs">
                  {serverRunning ? `Running :${status?.serverPort}` : "Stopped"}
                </span>
              </div>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[10px] px-2 border-green-500/30 hover:border-green-500/60 hover:bg-green-500/10"
                  onClick={() => postAction.mutate("start-server")}
                  disabled={postAction.isPending}
                >
                  <Play className="w-2.5 h-2.5 mr-1" /> Start
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[10px] px-2 border-red-500/30 hover:border-red-500/60 hover:bg-red-500/10"
                  onClick={() => postAction.mutate("stop-server")}
                  disabled={postAction.isPending}
                >
                  <Square className="w-2.5 h-2.5 mr-1" /> Stop
                </Button>
              </div>
            </div>

            {/* Preview URLs — always shown, dimmed when server is stopped */}
            <div className={`space-y-1 rounded-md border p-2 transition-colors ${
              serverRunning
                ? "border-primary/30 bg-primary/5"
                : "border-border/20 bg-black/20 opacity-50"
            }`}>
              <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
                Preview URLs
              </p>

              {/* Local URL */}
              <div className="flex items-center justify-between gap-1 min-w-0">
                <div className="flex items-center gap-1 min-w-0">
                  <span className="text-[9px] text-muted-foreground shrink-0">Local</span>
                  <span className="font-mono text-[10px] text-foreground/80 truncate">
                    {status?.localUrl ?? `http://localhost:${status?.serverPort ?? 5050}`}
                  </span>
                </div>
                <a
                  href={status?.localUrl ?? `http://localhost:${status?.serverPort ?? 5050}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0"
                >
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-5 text-[9px] px-1.5 border-border/30 hover:border-primary/50 hover:bg-primary/10"
                  >
                    <ExternalLink className="w-2.5 h-2.5" />
                  </Button>
                </a>
              </div>

              {/* Network URL */}
              {status?.networkUrl && (
                <div className="flex items-center justify-between gap-1 min-w-0">
                  <div className="flex items-center gap-1 min-w-0">
                    <span className="text-[9px] text-muted-foreground shrink-0">LAN</span>
                    <span className="font-mono text-[10px] text-primary truncate">
                      {status.networkUrl}
                    </span>
                  </div>
                  <a
                    href={status.networkUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0"
                  >
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-5 text-[9px] px-1.5 border-primary/30 hover:border-primary/60 hover:bg-primary/10"
                    >
                      <ExternalLink className="w-2.5 h-2.5" />
                    </Button>
                  </a>
                </div>
              )}
            </div>
          </div>

          {/* Last build */}
          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Last Build</p>
            {status?.lastBuild ? (
              <div className="space-y-0.5">
                <div className="flex items-center gap-1.5">
                  {status.lastBuild.success ? (
                    <CheckCircle2 className="w-3 h-3 text-green-400" />
                  ) : (
                    <XCircle className="w-3 h-3 text-red-400" />
                  )}
                  <span className={`font-mono text-xs ${status.lastBuild.success ? "text-green-400" : "text-red-400"}`}>
                    {status.lastBuild.success ? "Success" : "Failed"}
                  </span>
                </div>
                <p className="font-mono text-[10px] text-muted-foreground">
                  {new Date(status.lastBuild.timestamp).toLocaleTimeString()}
                </p>
                {!status.lastBuild.success && (
                  <pre className="text-[9px] text-red-400/80 bg-red-900/10 border border-red-500/20 rounded p-1.5 overflow-x-auto whitespace-pre-wrap mt-1 max-h-24">
                    {status.lastBuild.output.split("\n").slice(-8).join("\n")}
                  </pre>
                )}
              </div>
            ) : (
              <span className="font-mono text-xs text-muted-foreground">None yet</span>
            )}
          </div>

          {/* Last tests */}
          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Last Tests</p>
            {status?.lastTests ? (
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-green-400">
                    {status.lastTests.passed} pass
                  </span>
                  {status.lastTests.failed > 0 && (
                    <span className="font-mono text-xs text-red-400">
                      {status.lastTests.failed} fail
                    </span>
                  )}
                  <span className="font-mono text-xs text-muted-foreground">
                    / {status.lastTests.total}
                  </span>
                </div>
                <p className="font-mono text-[10px] text-muted-foreground">
                  {new Date(status.lastTests.timestamp).toLocaleTimeString()}
                </p>
              </div>
            ) : (
              <span className="font-mono text-xs text-muted-foreground">None yet</span>
            )}
          </div>

          {/* Quick actions */}
          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Quick Actions</p>
            <div className="grid grid-cols-1 gap-1">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[10px] justify-start px-2 border-border/40 hover:border-primary/50 hover:bg-primary/10"
                onClick={() => postAction.mutate("build")}
                disabled={postAction.isPending}
              >
                <Terminal className="w-3 h-3 mr-1.5" /> Build
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[10px] justify-start px-2 border-border/40 hover:border-primary/50 hover:bg-primary/10"
                onClick={() => postAction.mutate("run-tests")}
                disabled={postAction.isPending}
              >
                <CheckCircle2 className="w-3 h-3 mr-1.5" /> Run Tests
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[10px] justify-start px-2 border-border/40 hover:border-primary/50 hover:bg-primary/10"
                onClick={() => postAction.mutate("init")}
                disabled={postAction.isPending}
              >
                <PlusCircle className="w-3 h-3 mr-1.5" /> Init Session
              </Button>
            </div>
          </div>

          {/* Server logs toggle */}
          {status?.logLines && status.logLines.length > 0 && (
            <div className="space-y-1">
              <button
                className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold hover:text-foreground transition-colors"
                onClick={() => setShowLogs(!showLogs)}
              >
                {showLogs ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                Server Logs
              </button>
              {showLogs && (
                <pre className="text-[9px] text-muted-foreground bg-black/40 border border-border/20 rounded p-2 overflow-x-auto max-h-40 whitespace-pre-wrap">
                  {status.logLines.join("\n")}
                </pre>
              )}
            </div>
          )}
        </div>
        <PromoteRollbackPanel status={status} />
      </ScrollArea>
    </div>
  );
}

// ── Promote & Rollback Panel ────────────────────────────────────────────────
interface ReleaseManifest {
  id: string;
  label: string;
  timestamp: string;
  devNumber: number | null;
  type: string;
}

/** Poll until the server is back up, then reload the page. */
function useRestartPoller() {
  const [restarting, setRestarting] = useState(false);
  const [secondsElapsed, setSecondsElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startPolling = useCallback(() => {
    setRestarting(true);
    setSecondsElapsed(0);

    // Tick counter for display
    elapsedRef.current = setInterval(() => setSecondsElapsed(s => s + 1), 1000);

    // Wait 3 s for the process to actually exit before we start polling
    const start = () => {
      timerRef.current = setInterval(async () => {
        try {
          // Any fast endpoint works — /api/self-dev/status is tiny
          const r = await fetch("/api/self-dev/status", { credentials: "include" });
          if (r.ok || r.status === 401) {
            // Server is back — clear timers and reload
            clearInterval(timerRef.current!);
            clearInterval(elapsedRef.current!);
            window.location.reload();
          }
        } catch {
          /* still down — keep polling */
        }
      }, 2000);
    };
    setTimeout(start, 3000);
  }, []);

  // Clean up on unmount
  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (elapsedRef.current) clearInterval(elapsedRef.current);
  }, []);

  return { restarting, secondsElapsed, startPolling };
}

function PromoteRollbackPanel({ status }: { status: DevStatus | null }) {
  const { toast } = useToast();
  const [showPromoteModal, setShowPromoteModal] = useState(false);
  const [showRollbackModal, setShowRollbackModal] = useState(false);
  const [includeData, setIncludeData] = useState(false);
  const [promoteLog, setPromoteLog] = useState<Array<{ type: string; message: string }>>([]);
  const [promoting, setPromoting] = useState(false);
  const [promoted, setPromoted] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<ReleaseManifest | null>(null);
  const [rollbackLog, setRollbackLog] = useState<Array<{ type: string; message: string }>>([]);
  const [rollingBack, setRollingBack] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const { restarting, secondsElapsed, startPolling } = useRestartPoller();

  const { data: releases = [], refetch: refetchReleases } = useQuery<ReleaseManifest[]>({
    queryKey: ["/api/self-dev/releases"],
    refetchInterval: showRollbackModal ? 5000 : false,
  });

  // Auto-scroll log
  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [promoteLog, rollbackLog]);

  const handlePromote = async () => {
    if (!status?.devNumber) return;
    setPromoting(true);
    setPromoteLog([]);
    setPromoted(false);

    try {
      const res = await fetch("/api/self-dev/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ devNumber: status.devNumber, includeData, includeSettings: includeData }),
        credentials: "include",
      });

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response stream");
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            setPromoteLog(prev => [...prev, event]);
            if (event.type === "success") {
              setPromoted(true);
              startPolling(); // wait for server to come back, then auto-reload
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch (err: any) {
      setPromoteLog(prev => [...prev, { type: "error", message: err.message }]);
    } finally {
      setPromoting(false);
      refetchReleases();
    }
  };

  const handleRollback = async () => {
    if (!rollbackTarget) return;
    setRollingBack(true);
    setRollbackLog([]);

    try {
      const res = await fetch("/api/self-dev/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ releaseId: rollbackTarget.id }),
        credentials: "include",
      });

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response stream");
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            setRollbackLog(prev => [...prev, event]);
            if (event.type === "success") {
              startPolling(); // wait for server to come back, then auto-reload
            }
          } catch { /* skip */ }
        }
      }
    } catch (err: any) {
      setRollbackLog(prev => [...prev, { type: "error", message: err.message }]);
    } finally {
      setRollingBack(false);
      refetchReleases();
    }
  };

  const handleDeleteRelease = async (id: string) => {
    try {
      await apiRequest("DELETE", `/api/self-dev/releases/${id}`);
      refetchReleases();
      toast({ title: "Snapshot deleted" });
    } catch (err: any) {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    }
  };

  const canPromote = !!status?.devNumber;

  return (
    <div className="px-3 pb-4 space-y-2 border-t border-border/40 pt-3 mt-2">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Custom Version</p>

      {/* Deploy button */}
      <Button
        className="w-full h-8 text-xs font-semibold bg-primary/90 hover:bg-primary text-primary-foreground"
        disabled={!canPromote}
        onClick={() => { setShowPromoteModal(true); setPromoteLog([]); setPromoted(false); }}
      >
        <Rocket className="w-3.5 h-3.5 mr-2" />
        Deploy to Production
      </Button>

      {/* Rollback button */}
      <Button
        variant="outline"
        className="w-full h-7 text-[11px] border-border/40 hover:border-yellow-500/60 hover:bg-yellow-500/10 hover:text-yellow-400"
        onClick={() => { setShowRollbackModal(true); setRollbackLog([]); setRollbackTarget(null); }}
      >
        <History className="w-3 h-3 mr-1.5" />
        Version History &amp; Rollback
      </Button>

      {!canPromote && (
        <p className="text-[9px] text-muted-foreground text-center">
          Initialize a dev session to enable deployment.
        </p>
      )}

      {/* ── PROMOTE MODAL ───────────────────────────────── */}
      <Dialog open={showPromoteModal} onOpenChange={open => { if (!promoting) setShowPromoteModal(open); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Rocket className="w-4 h-4 text-primary" />
              Deploy dev-{String(status?.devNumber ?? 0).padStart(3, "0")} to Production
            </DialogTitle>
            <DialogDescription>
              This will replace the running Agent2077 with your custom version, rebuild it, and restart.
              Your current version is automatically snapshotted first so you can roll back instantly.
            </DialogDescription>
          </DialogHeader>

          {!promoting && !promoted && (
            <div className="space-y-4">
              {/* Data options */}
              <div className="rounded-md border border-border/40 bg-muted/20 p-3 space-y-3">
                <p className="text-xs font-semibold text-foreground">Data &amp; Settings</p>

                <div className="flex items-start gap-3">
                  <Checkbox
                    id="include-data"
                    checked={includeData}
                    onCheckedChange={v => setIncludeData(!!v)}
                    className="mt-0.5"
                  />
                  <div>
                    <Label htmlFor="include-data" className="text-xs cursor-pointer">
                      Copy chats &amp; settings from dev session
                    </Label>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      Replaces production data with what you have in the dev session.
                      Leave unchecked to keep your existing chats and settings.
                    </p>
                  </div>
                </div>
              </div>

              {/* Warning */}
              <div className="flex gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3">
                <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
                <p className="text-[11px] text-yellow-300/90">
                  Agent2077 will be unavailable for 1–3 minutes while the build runs and it restarts.
                  A rollback snapshot is created automatically before any changes are made.
                </p>
              </div>
            </div>
          )}

          {/* Progress log */}
          {(promoting || promoteLog.length > 0) && (
            <div className="rounded-md border border-border/30 bg-black/40 p-3 max-h-52 overflow-y-auto space-y-1">
              {promoteLog.map((entry, i) => (
                <div key={i} className={`flex items-start gap-2 text-[11px] font-mono ${
                  entry.type === "error" ? "text-red-400" :
                  entry.type === "success" ? "text-green-400" :
                  "text-muted-foreground"
                }`}>
                  {entry.type === "error" && <XCircle className="w-3 h-3 shrink-0 mt-0.5" />}
                  {entry.type === "success" && <CheckCircle className="w-3 h-3 shrink-0 mt-0.5 text-green-400" />}
                  {entry.type === "progress" && <span className="w-3 shrink-0">›</span>}
                  <span className="whitespace-pre-wrap">{entry.message}</span>
                </div>
              ))}
              {promoting && (
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Working...
                </div>
              )}
              {restarting && (
                <div className="flex items-center gap-2 text-[11px] text-cyan-400">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Waiting for Agent2077 to come back online… ({secondsElapsed}s)
                </div>
              )}
              <div ref={logEndRef} />
            </div>
          )}

          <DialogFooter>
            {!promoting && !promoted && (
              <>
                <Button variant="outline" onClick={() => setShowPromoteModal(false)}>Cancel</Button>
                <Button
                  className="bg-primary hover:bg-primary/90"
                  onClick={handlePromote}
                >
                  <Rocket className="w-3.5 h-3.5 mr-2" /> Deploy Now
                </Button>
              </>
            )}
            {promoting && (
              <Button variant="outline" disabled>
                <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> Deploying...
              </Button>
            )}
            {promoted && restarting && (
              <Button variant="outline" disabled>
                <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                Restarting… {secondsElapsed}s
              </Button>
            )}
            {promoted && !restarting && (
              <Button onClick={() => setShowPromoteModal(false)}>
                <CheckCircle className="w-3.5 h-3.5 mr-2" /> Done — Close
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── ROLLBACK MODAL ─────────────────────────────── */}
      <Dialog open={showRollbackModal} onOpenChange={open => { if (!rollingBack) setShowRollbackModal(open); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="w-4 h-4 text-yellow-400" />
              Version History &amp; Rollback
            </DialogTitle>
            <DialogDescription>
              Select a snapshot to restore. Your current version is always snapshotted before any rollback.
            </DialogDescription>
          </DialogHeader>

          {/* Release list */}
          {!rollingBack && rollbackLog.length === 0 && (
            <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
              {releases.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-4">
                  No snapshots yet. Deploy a custom version to create one automatically.
                </p>
              )}
              {releases.map(rel => (
                <div
                  key={rel.id}
                  className={`rounded-md border p-2.5 cursor-pointer transition-colors ${
                    rollbackTarget?.id === rel.id
                      ? "border-primary/60 bg-primary/10"
                      : "border-border/40 hover:border-border/70 hover:bg-muted/20"
                  }`}
                  onClick={() => setRollbackTarget(rel)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-mono font-medium text-foreground truncate">{rel.label}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {new Date(rel.timestamp).toLocaleString()}
                        {rel.devNumber != null && (
                          <span className="ml-2 text-primary/70">dev-{String(rel.devNumber).padStart(3, "0")}</span>
                        )}
                      </p>
                    </div>
                    <button
                      className="shrink-0 p-1 rounded hover:bg-red-500/20 hover:text-red-400 text-muted-foreground transition-colors"
                      onClick={e => { e.stopPropagation(); handleDeleteRelease(rel.id); }}
                      title="Delete snapshot"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Rollback log */}
          {rollbackLog.length > 0 && (
            <div className="rounded-md border border-border/30 bg-black/40 p-3 max-h-52 overflow-y-auto space-y-1">
              {rollbackLog.map((entry, i) => (
                <div key={i} className={`flex items-start gap-2 text-[11px] font-mono ${
                  entry.type === "error" ? "text-red-400" :
                  entry.type === "success" ? "text-green-400" :
                  "text-muted-foreground"
                }`}>
                  {entry.type === "error" && <XCircle className="w-3 h-3 shrink-0 mt-0.5" />}
                  {entry.type === "success" && <CheckCircle className="w-3 h-3 shrink-0 mt-0.5" />}
                  {entry.type === "progress" && <span className="w-3 shrink-0">›</span>}
                  <span className="whitespace-pre-wrap">{entry.message}</span>
                </div>
              ))}
              {rollingBack && (
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Loader2 className="w-3 h-3 animate-spin" /> Rolling back...
                </div>
              )}
              {restarting && (
                <div className="flex items-center gap-2 text-[11px] text-cyan-400">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Waiting for Agent2077 to come back online… ({secondsElapsed}s)
                </div>
              )}
              <div ref={logEndRef} />
            </div>
          )}

          <DialogFooter>
            {!rollingBack && rollbackLog.length === 0 && (
              <>
                <Button variant="outline" onClick={() => setShowRollbackModal(false)}>Cancel</Button>
                <Button
                  variant="outline"
                  className="border-yellow-500/40 hover:border-yellow-500 hover:bg-yellow-500/10 text-yellow-400"
                  disabled={!rollbackTarget}
                  onClick={handleRollback}
                >
                  <RotateCcw className="w-3.5 h-3.5 mr-2" />
                  Restore Selected
                </Button>
              </>
            )}
            {rollingBack && (
              <Button variant="outline" disabled>
                <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> Restoring...
              </Button>
            )}
            {!rollingBack && rollbackLog.length > 0 && restarting && (
              <Button variant="outline" disabled>
                <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                Restarting… {secondsElapsed}s
              </Button>
            )}
            {!rollingBack && rollbackLog.length > 0 && !restarting && (
              <Button onClick={() => setShowRollbackModal(false)}>Close</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── File Viewer Panel (right) ─────────────────────────────────────────────────

interface DevFileEntry {
  name: string;
  type: "file" | "directory";
}

function FileViewerPanel({ devDir }: { devDir: string | null }) {
  const { toast } = useToast();
  const [browsePath, setBrowsePath] = useState(".");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);

  const { data: fileList = [], refetch: refetchFiles } = useQuery<DevFileEntry[]>({
    queryKey: ["/api/self-dev/files", browsePath],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/self-dev/files?path=${encodeURIComponent(browsePath)}`);
      const data = await res.json();
      // Normalise: server returns {name,type}[] but guard against legacy string[] format
      if (Array.isArray(data) && data.length > 0 && typeof data[0] === "string") {
        return (data as string[]).map((entry: string) => ({
          name: entry.endsWith("/") ? entry.slice(0, -1) : entry,
          type: (entry.endsWith("/") ? "directory" : "file") as "file" | "directory",
        }));
      }
      return data as DevFileEntry[];
    },
    enabled: !!devDir,
    retry: false,
  });

  const loadFile = async (filePath: string) => {
    setLoadingFile(true);
    setSelectedFile(filePath);
    try {
      const res = await apiRequest("GET", `/api/self-dev/file?path=${encodeURIComponent(filePath)}`);
      const data = await res.json();
      setFileContent(data.content ?? null);
    } catch (err: any) {
      toast({ title: "Failed to load file", description: err.message, variant: "destructive" });
      setFileContent(null);
    } finally {
      setLoadingFile(false);
    }
  };

  const [copied, setCopied] = useState(false);
  const copyContent = () => {
    if (!fileContent) return;
    navigator.clipboard.writeText(fileContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex flex-col h-full min-w-0 bg-background/50 border-l border-border/40">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/40 bg-black/30 shrink-0">
        <span className="font-mono text-xs text-primary font-semibold uppercase tracking-wider">
          File Viewer
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => refetchFiles()}
          disabled={!devDir}
        >
          <RefreshCw className="w-3 h-3" />
        </Button>
      </div>

      {!devDir ? (
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-xs text-muted-foreground text-center">
            No dev session active.<br />Initialize one to browse files.
          </p>
        </div>
      ) : (
        <div className="flex flex-col h-full overflow-hidden">
          {/* Path breadcrumb */}
          <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border/20 shrink-0">
            <FolderOpen className="w-3 h-3 text-muted-foreground shrink-0" />
            <span className="font-mono text-[10px] text-muted-foreground truncate">{browsePath}</span>
            {browsePath !== "." && (
              <Button
                variant="ghost"
                size="sm"
                className="h-4 px-1 text-[10px] ml-auto shrink-0"
                onClick={() => {
                  const parent = browsePath.split("/").slice(0, -1).join("/") || ".";
                  setBrowsePath(parent);
                }}
              >
                ↑ Up
              </Button>
            )}
          </div>

          {/* Split: file list + file content */}
          <div className="flex-1 flex flex-col overflow-hidden min-w-0">
            {/* File list */}
            <ScrollArea className="h-48 border-b border-border/20 shrink-0">
              <div className="p-1">
                {fileList.length === 0 ? (
                  <p className="text-[10px] text-muted-foreground px-2 py-1">Empty directory</p>
                ) : (
                  fileList.map((entry) => {
                    const isDir = entry.type === "directory";
                    const name = entry.name;
                    const fullPath = browsePath === "." ? name : `${browsePath}/${name}`;
                    return (
                      <button
                        key={fullPath}
                        className={`w-full flex items-center gap-1.5 px-2 py-1 rounded text-left text-[11px] font-mono hover:bg-white/5 transition-colors ${
                          selectedFile === fullPath
                            ? "bg-primary/10 text-primary"
                            : "text-foreground/70"
                        }`}
                        onClick={() => {
                          if (isDir) {
                            setBrowsePath(fullPath);
                          } else {
                            loadFile(fullPath);
                          }
                        }}
                      >
                        {isDir ? (
                          <FolderOpen className="w-3 h-3 text-yellow-400/70 shrink-0" />
                        ) : (
                          <FileText className="w-3 h-3 text-blue-400/70 shrink-0" />
                        )}
                        <span className="truncate">{name}</span>
                      </button>
                    );
                  })
                )}
              </div>
            </ScrollArea>

            {/* File content */}
            <div className="flex-1 flex flex-col overflow-hidden">
              {selectedFile && (
                <div className="flex items-center justify-between px-2 py-1 border-b border-border/20 bg-black/20 shrink-0">
                  <span className="font-mono text-[10px] text-muted-foreground truncate">{selectedFile}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 shrink-0"
                    onClick={copyContent}
                  >
                    {copied ? <Check className="w-2.5 h-2.5 text-green-400" /> : <Copy className="w-2.5 h-2.5" />}
                  </Button>
                </div>
              )}
              <ScrollArea className="flex-1">
                {loadingFile ? (
                  <div className="flex items-center justify-center p-4">
                    <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                  </div>
                ) : fileContent != null ? (
                  <pre className="p-3 text-[10px] font-mono text-foreground/80 whitespace-pre-wrap break-words">
                    {fileContent}
                  </pre>
                ) : (
                  <div className="flex items-center justify-center p-6">
                    <p className="text-[10px] text-muted-foreground">Select a file to view its contents</p>
                  </div>
                )}
              </ScrollArea>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Chat Panel (center) ───────────────────────────────────────────────────────

function ChatPanel({ statusEvents }: { statusEvents?: Array<{ message: string; detail?: string; timestamp: number }> }) {
  const { toast } = useToast();
  const agentName = useAgentName();
  const [input, setInput] = useState("");
  const [nudgeInput, setNudgeInput] = useState("");
  const [activeSubAgents, setActiveSubAgents] = useState<Map<number, { title: string; color: string; status: string }>>(new Map());
  const [nudgeSent, setNudgeSent] = useState(false);
  const [pendingUserMessage, setPendingUserMessage] = useState<string | null>(null);
  const [attachedImages, setAttachedImages] = useState<File[]>([]);
  const [pendingImages, setPendingImages] = useState<Array<{ name: string; base64: string; mimeType: string }>>([]);
  const [lightboxImage, setLightboxImage] = useState<{ src: string; alt: string } | null>(null);

  // Centralized SSE stream state (messages/ActivityRail/tool events). Self-dev's
  // bespoke mount-reconnect + after-reset paths drive the same state via the
  // exposed setters so there is one source of truth feeding ActivityRail.
  const stream = useChatStream({
    onEvent: (event) => {
      if (event.type === "subtask_progress") {
        const AGENT_COLORS = ["bg-blue-500", "bg-green-500", "bg-purple-500", "bg-orange-500", "bg-red-500"];
        const e = event as Extract<ChatStreamEvent, { type: "subtask_progress" }>;
        setActiveSubAgents(prev => {
          const next = new Map(prev);
          if (e.status === "running") {
            const colorIdx = (e.specIndex ?? 0) % AGENT_COLORS.length;
            next.set(e.subtaskId, { title: e.title ?? "", color: AGENT_COLORS[colorIdx], status: "running" });
          } else {
            next.delete(e.subtaskId);
          }
          return next;
        });
      } else if (event.type === "done" || event.type === "stream_end") {
        setActiveSubAgents(new Map());
      }
    },
  });
  const {
    streaming, streamContent, statusLog, steps, planSteps,
    requestIdRef,
    setStreaming, setStreamContent, setSteps, setPlanSteps, setStatusLog,
  } = stream;
  // Abort controller for the bespoke reconnect/after-reset SSE subscriptions
  // (the hook owns a separate internal controller for the primary send path).
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const { data: convData, refetch } = useQuery<{ messages: Message[]; conversationId: number | null }>({
    queryKey: ["/api/self-dev/conversation"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/self-dev/conversation");
      return res.json();
    },
    retry: 1,
  });

  const messages = convData?.messages ?? [];

  // ── On mount: reconnect to any in-progress stream ─────────────────
  // When the user navigates away and back, the component remounts with empty
  // state. If the agent is still running, the AgentStream has a full replay
  // buffer. We subscribe to /api/conversations/:id/stream on mount and get
  // every event replayed instantly, restoring the full in-progress view.
  useEffect(() => {
    // Wait until we know the conversation ID before subscribing
    if (!convData?.conversationId) return;
    // Don't reconnect if we are already streaming (mid-send)
    if (streaming) return;

    const convId = convData.conversationId;
    const ctrl = new AbortController();

    // Check stream-status first — only subscribe if stream is active or has buffered events
    apiRequest("GET", `/api/conversations/${convId}/stream-status`)
      .then(r => r.json())
      .then((status: { active: boolean; eventCount: number }) => {
        if (!status.active && status.eventCount === 0) return; // nothing to replay
        if (ctrl.signal.aborted) return;

        // Subscribe — the server will replay all buffered events then stream live ones
        abortRef.current = ctrl;
        setStreaming(true);
        setStreamContent("");
        setSteps([]);
        setPlanSteps([]);
        setStatusLog([]);

        fetch(`/api/conversations/${convId}/stream`, {
          credentials: "include",
          signal: ctrl.signal,
        }).then(async (resp) => {
          if (!resp.body) return;
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          let gotContent = false;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const parts = buf.split("\n\n");
            buf = parts.pop() ?? "";
            for (const part of parts) {
              const line = part.replace(/^data: /, "").trim();
              if (!line) continue;
              try {
                const ev = JSON.parse(line);
                if (ev.type === "request_id") { requestIdRef.current = ev.requestId; }
                else if (ev.type === "chunk") { setStreamContent(p => p + (ev.content ?? "")); gotContent = true; }
                else if (ev.type === "status") {
                  setStatusLog(p => [...p, { message: ev.message || ev.content || ev.label || "", detail: ev.detail, timestamp: ev.timestamp || Date.now() }]);
                }
                else if (ev.type === "step") { setSteps(p => [...p, ev]); }
                else if (ev.type === "plan" && Array.isArray(ev.steps)) {
                  setPlanSteps(ev.steps.map((s: any, i: number) => ({ step: s.step ?? i + 1, title: s.title ?? String(s), status: s.status ?? "pending" })));
                }
                else if (ev.type === "active") { /* already streaming */ }
                else if (ev.type === "done" || ev.type === "error" || ev.type === "stream_end") {
                  if (ev.type === "error") setStreamContent(p => p + `\n\n[Error: ${ev.content}]`);
                  setPlanSteps(prev => prev.map(s => ({ ...s, status: "completed" as const })));
                  setStreaming(false);
                  queryClient.invalidateQueries({ queryKey: ["/api/self-dev/conversation"] });
                  refetch();
                  return;
                }
              } catch { /* non-JSON line, skip */ }
            }
          }
          // Stream ended (server closed connection)
          setStreaming(false);
          queryClient.invalidateQueries({ queryKey: ["/api/self-dev/conversation"] });
          refetch();
        }).catch((err) => {
          if (err?.name !== "AbortError") {
            setStreaming(false);
            console.error("[SelfDev] Stream reconnect error:", err);
          }
        });
      })
      .catch(() => { /* stream-status failed — no active stream */ });

    return () => {
      // Only abort the reconnect fetch — don't abort an in-progress send
      if (!streaming) ctrl.abort();
    };
  // Run when we first get the conversation ID, and when the conv ID changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convData?.conversationId]);

  // Poll for pending reset permission requests every 2s
  const { data: resetPermissions = [], refetch: refetchPermissions } = useQuery<Array<{
    id: string; type: "file" | "all"; filePath?: string; status: string; createdAt: number;
  }>>({    queryKey: ["/api/self-dev/reset-permissions"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/self-dev/reset-permissions");
      return res.json();
    },
    refetchInterval: 2000,
    retry: 1,
  });

  // Diff preview state for reset banners: permissionId → { loading, diff, expanded }
  const [resetDiffs, setResetDiffs] = useState<Record<string, { loading: boolean; diff: string | null; expanded: boolean }>>({});

  const fetchResetDiff = async (permId: string, filePath: string) => {
    setResetDiffs(prev => ({ ...prev, [permId]: { loading: true, diff: null, expanded: true } }));
    try {
      const res = await apiRequest("GET", `/api/self-dev/diff?path=${encodeURIComponent(filePath)}`);
      const data = await res.json();
      setResetDiffs(prev => ({ ...prev, [permId]: { loading: false, diff: data.diff || "(no diff)", expanded: true } }));
    } catch {
      setResetDiffs(prev => ({ ...prev, [permId]: { loading: false, diff: "(could not load diff)", expanded: true } }));
    }
  };

  const toggleResetDiff = (permId: string, filePath: string) => {
    const current = resetDiffs[permId];
    if (!current) {
      fetchResetDiff(permId, filePath);
    } else {
      setResetDiffs(prev => ({ ...prev, [permId]: { ...current, expanded: !current.expanded } }));
    }
  };

  /**
   * Shared logic after approve or deny: hide the banner, flip the UI into
   * streaming mode so the user sees the agent resume, then reconnect SSE.
   */
  const afterResetDecision = (id: string) => {
    setResetDiffs(prev => { const n = { ...prev }; delete n[id]; return n; });
    refetchPermissions();
    // Show streaming indicator immediately — agent is now running server-side
    setStreaming(true);
    setStreamContent("");
    setSteps([]);
    setPlanSteps([]);
    setStatusLog([{ message: "Resuming after reset decision...", timestamp: Date.now() }]);
    // Re-subscribe to SSE broadcast so we receive the new agent turn
    // The server will send a request_id event followed by the usual stream
    const selfDevConvId = String(convData?.conversationId ?? "");
    if (!selfDevConvId) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    fetch(`/api/conversations/${selfDevConvId}/stream`, {
      credentials: "include",
      signal: ctrl.signal,
    }).then(async (resp) => {
      if (!resp.body) return;
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.replace(/^data: /, "").trim();
          if (!line) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.type === "request_id") requestIdRef.current = ev.requestId;
            else if (ev.type === "chunk") setStreamContent(p => p + (ev.content ?? ""));
            else if (ev.type === "status") setStatusLog(p => [...p, { message: ev.message || ev.content || ev.label || "", detail: ev.detail, timestamp: ev.timestamp || Date.now() }]);
            else if (ev.type === "step") setSteps(p => [...p, ev]);
            else if (ev.type === "plan" && Array.isArray(ev.steps)) {
              setPlanSteps(ev.steps.map((s: any, i: number) => ({ step: s.step ?? i + 1, title: s.title ?? String(s), status: s.status ?? "pending" })));
            }
            else if (ev.type === "done" || ev.type === "error") {
              setPlanSteps(prev => prev.map(s => ({ ...s, status: "completed" as const })));
              setStreaming(false);
              if (ev.type === "error") setStreamContent(p => p + `\n\n[Error: ${ev.content}]`);
              queryClient.invalidateQueries({ queryKey: ["/api/self-dev/conversation"] });
              refetch();
              break;
            }
          } catch { /* ignore non-JSON */ }
        }
      }
      setStreaming(false);
      queryClient.invalidateQueries({ queryKey: ["/api/self-dev/conversation"] });
      refetch();
    }).catch((err) => {
      if (err?.name !== "AbortError") {
        setStreaming(false);
        console.error("[SelfDev] SSE reconnect error:", err);
      }
    });
  };

  const handleResetApprove = async (id: string) => {
    await apiRequest("POST", `/api/self-dev/reset-permissions/${id}/approve`);
    afterResetDecision(id);
  };

  const handleResetDeny = async (id: string) => {
    await apiRequest("POST", `/api/self-dev/reset-permissions/${id}/deny`);
    afterResetDecision(id);
  };

  // Sync statusLog from server-side buffer when not actively streaming.
  // statusEvents comes from the parent's 2s status poll so any tab sees the feed.
  const prevStatusEventsRef = useRef<number>(0);
  useEffect(() => {
    if (streaming) return;
    if (!statusEvents || statusEvents.length === 0) return;
    if (statusEvents.length !== prevStatusEventsRef.current) {
      prevStatusEventsRef.current = statusEvents.length;
      setStatusLog(statusEvents);
    }
  }, [statusEvents, streaming]);

  useEffect(() => {
    const el = messagesEndRef.current;
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, streamContent]);

  const newSessionMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/self-dev/new-session");
      return res.json();
    },
    onSuccess: () => {
      // Abort any active stream first
      if (requestIdRef.current) {
        apiRequest("POST", "/api/chat/stop", { requestId: requestIdRef.current }).catch(() => {});
      }
      abortRef.current?.abort();
      abortRef.current = null;
      requestIdRef.current = "";
      // Clear all local chat state
      setStreaming(false);
      setStreamContent("");
      setSteps([]);
      setPlanSteps([]);
      setStatusLog([]);
      setInput("");
      setAttachedImages([]);
      // Refresh conversation from server
      queryClient.invalidateQueries({ queryKey: ["/api/self-dev/conversation"] });
      refetch();
      toast({ title: "New session started", description: "Fresh conversation ready." });
    },
  });

  const stopStreaming = () => {
    abortRef.current?.abort();
    stream.stop();
  };

  const handleSend = useCallback(async (overrideMessage?: string) => {
    const typed = overrideMessage ?? input.trim();
    // Allow sending an image with no text (matches the Send button's enabled
    // state). Server requires a non-empty message, so caption attachment-only sends.
    const hasAttachment = attachedImages.length > 0;
    if ((!typed && !hasAttachment) || streaming) return;
    const msg = typed || "(image attached)";

    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    stream.reset();
    setActiveSubAgents(new Map());
    setPendingUserMessage(msg);

    // Convert images to base64
    const imageData: Array<{ name: string; base64: string; mimeType: string }> = [];
    for (const file of attachedImages) {
      const base64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      });
      imageData.push({ name: file.name, base64, mimeType: file.type });
    }
    setPendingImages(imageData);
    setAttachedImages([]);

    await stream.start({
      url: "/api/self-dev/chat",
      body: {
        message: msg,
        images: imageData.length > 0 ? imageData : undefined,
      },
    });

    setPendingUserMessage(null);
    setPendingImages([]);
    refetch();
    queryClient.invalidateQueries({ queryKey: ["/api/self-dev/conversation"] });
  }, [input, streaming, attachedImages, refetch, stream]);

  const handleNudge = useCallback(async () => {
    const msg = nudgeInput.trim();
    if (!msg || !streaming) return;
    setNudgeInput("");
    setNudgeSent(true);
    try {
      await fetch("/api/self-dev/inject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ message: msg }),
      });
    } catch { /* ignore */ }
    setTimeout(() => setNudgeSent(false), 3000);
  }, [nudgeInput, streaming]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter(item => item.type.startsWith("image/"));
    if (imageItems.length === 0) return; // Let text paste through normally
    e.preventDefault();
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (file) {
        const named = new File([file], `screenshot-${Date.now()}.png`, { type: file.type });
        setAttachedImages(prev => [...prev, named]);
      }
    }
  };

  const handleImageAttach = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    setAttachedImages((prev) => [...prev, ...files]);
    e.target.value = "";
  };

  return (
    <div className="flex flex-col h-full">
      {/* Chat header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/40 bg-black/30 shrink-0">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-primary" />
          <span className="font-mono text-xs text-primary font-semibold uppercase tracking-wider">
            Self-Dev Chat
          </span>
          {convData?.conversationId && (
            <Badge variant="outline" className="font-mono text-[10px] h-4 px-1.5">
              #{convData.conversationId}
            </Badge>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-[10px] gap-1 border-primary/30 text-primary hover:bg-primary/10 hover:text-primary"
          onClick={() => newSessionMutation.mutate()}
          disabled={newSessionMutation.isPending}
          title="Start a new self-dev conversation"
        >
          {newSessionMutation.isPending
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : <PlusCircle className="w-3 h-3" />}
          New Session
        </Button>
      </div>

      {/* Reset permission banners — pinned above scroll area so they're always visible */}
      {resetPermissions.length > 0 && (
        <div className="shrink-0 flex flex-col gap-1.5 px-3 pt-2 pb-1">
          {resetPermissions.map((p) => {
            const diffState = resetDiffs[p.id];
            return (
              <div key={p.id} className="rounded-lg border border-yellow-500/40 bg-yellow-950/30 p-3 flex flex-col gap-2">
                <div className="flex items-start gap-2">
                  <Shield className="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-yellow-300">Agent requesting reset permission</p>
                    {p.type === "file" ? (
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <p className="text-xs text-yellow-200/80">
                          Reset file to stable: <span className="font-mono text-yellow-100">{p.filePath}</span>
                        </p>
                        {p.filePath && (
                          <button
                            onClick={() => toggleResetDiff(p.id, p.filePath!)}
                            className="text-xs text-yellow-400/70 hover:text-yellow-300 underline decoration-dotted transition-colors"
                          >
                            {diffState?.expanded ? "hide diff" : "show diff"}
                          </button>
                        )}
                      </div>
                    ) : (
                      <p className="text-xs text-yellow-200/80 mt-0.5">
                        Reset <span className="font-semibold">entire dev workspace</span> to stable — all uncommitted changes will be lost.
                      </p>
                    )}
                    {/* Diff preview for file resets */}
                    {p.type === "file" && diffState?.expanded && (
                      <div className="mt-2 rounded border border-yellow-500/20 bg-black/30 overflow-auto max-h-48">
                        {diffState.loading ? (
                          <p className="text-xs text-yellow-200/50 p-2">Loading diff…</p>
                        ) : (
                          <pre className="text-xs p-2 whitespace-pre-wrap font-mono leading-relaxed">
                            {(diffState.diff || "").split("\n").map((line, i) => (
                              <span
                                key={i}
                                className={
                                  line.startsWith("+") && !line.startsWith("+++") ? "text-green-400" :
                                  line.startsWith("-") && !line.startsWith("---") ? "text-red-400" :
                                  line.startsWith("@@") ? "text-blue-400" :
                                  "text-yellow-200/60"
                                }
                              >{line}{"\n"}</span>
                            ))}
                          </pre>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => handleResetDeny(p.id)}
                    className="text-xs px-3 py-1 rounded border border-red-500/40 text-red-400 hover:bg-red-900/30 transition-colors"
                  >
                    Deny
                  </button>
                  <button
                    onClick={() => handleResetApprove(p.id)}
                    className="text-xs px-3 py-1 rounded border border-green-500/40 text-green-400 hover:bg-green-900/30 transition-colors"
                  >
                    Approve
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {messages.length === 0 && !streaming && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
            <Bot className="w-10 h-10 text-primary/40" />
            <div>
              <p className="text-sm font-semibold text-foreground/60">Self-Development Mode</p>
              <p className="text-xs text-muted-foreground mt-1">
                Chat with {agentName} to develop itself.<br />Use the quick actions on the left to build, test, and deploy.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 justify-center mt-2">
              {[
                "Initialize a new dev session",
                "Show me the current architecture",
                "Build and run tests",
                "What are the known issues?",
              ].map((prompt) => (
                <button
                  key={prompt}
                  className="text-[11px] px-3 py-1.5 rounded border border-border/40 text-muted-foreground hover:border-primary/50 hover:text-primary transition-colors"
                  onClick={() => handleSend(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <ChatMessageBubble key={msg.id} message={msg} onImageClick={(src, alt) => setLightboxImage({ src, alt })} />
        ))}

        {/* Pending user message while streaming */}
        {pendingUserMessage && (
          <div className="flex gap-2.5 justify-end">
            <div className="max-w-[80%] bg-primary/10 border border-primary/20 rounded-xl rounded-tr-sm px-3 py-2">
              {pendingImages.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {pendingImages.map((img, i) => (
                    <img
                      key={i}
                      src={img.base64}
                      alt={img.name}
                      className="w-20 h-20 object-cover rounded border border-border/30"
                    />
                  ))}
                </div>
              )}
              <p className="text-sm text-foreground/90 whitespace-pre-wrap text-left">{pendingUserMessage}</p>
            </div>
            <div className="w-6 h-6 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center shrink-0 mt-0.5">
              <User className="w-3 h-3 text-primary" />
            </div>
          </div>
        )}

        {/* Streaming assistant response */}
        {(streaming || statusLog.length > 0) && (streamContent || steps.length > 0 || statusLog.length > 0 || planSteps.length > 0) && (
          <div className="flex gap-2.5">
            <div className="w-6 h-6 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center shrink-0 mt-0.5">
              <Bot className="w-3 h-3 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              {(statusLog.length > 0 || planSteps.length > 0) && (
                <ActivityRail
                  statusLog={statusLog}
                  steps={steps}
                  planSteps={planSteps}
                  streaming={streaming}
                />
              )}
              {streamContent && (
                <div className="bg-muted/30 border border-border/30 rounded-xl rounded-tl-sm px-3 py-2">
                  <MarkdownMessage content={streamContent} />
                </div>
              )}
              {!streamContent && streaming && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>Thinking...</span>
                </div>
              )}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="shrink-0 border-t border-border/40 bg-black/20 px-4 py-3">
        {/* Attached images preview */}
        {attachedImages.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {attachedImages.map((file, i) => (
              <div key={i} className="relative">
                <img
                  src={URL.createObjectURL(file)}
                  alt={file.name}
                  className="w-14 h-14 object-cover rounded border border-border/40"
                />
                <button
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-red-500 rounded-full flex items-center justify-center hover:bg-red-600 transition-colors"
                  onClick={() => setAttachedImages((prev) => prev.filter((_, idx) => idx !== i))}
                >
                  <X className="w-2.5 h-2.5 text-white" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Active subagent pills */}
        {activeSubAgents.size > 0 && (
          <div className="px-3 py-2 flex flex-wrap gap-1.5 border-b border-border/20">
            {Array.from(activeSubAgents.entries()).map(([id, sub]) => (
              <div key={id} className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-muted/40 border border-border/30 text-xs font-mono">
                <span className={`w-1.5 h-1.5 rounded-full ${sub.color} animate-pulse shrink-0`} />
                <span className="text-muted-foreground truncate max-w-[180px]">{sub.title}</span>
              </div>
            ))}
          </div>
        )}

        {/* Mid-task nudge bar — visible only while agent is running */}
        {streaming && (
          <div className="flex gap-2 items-center mb-2 px-1 py-1.5 bg-yellow-500/10 border border-yellow-500/20 rounded-md">
            <span className="text-xs text-yellow-400/80 shrink-0 font-mono">nudge:</span>
            <input
              type="text"
              value={nudgeInput}
              onChange={(e) => setNudgeInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleNudge(); }}
              placeholder="Send a correction mid-task (e.g. 'use selfdev_read_file instead')"
              className="flex-1 bg-transparent border-none outline-none text-xs font-mono text-yellow-100 placeholder:text-yellow-500/40"
            />
            {nudgeSent ? (
              <span className="text-xs text-yellow-400 shrink-0">✓ sent</span>
            ) : (
              <button
                onClick={handleNudge}
                disabled={!nudgeInput.trim()}
                className="text-xs text-yellow-400 hover:text-yellow-200 disabled:opacity-30 shrink-0 font-mono transition-colors"
              >
                send
              </button>
            )}
          </div>
        )}

        <div className="flex gap-2 items-end">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={`Message ${agentName} self-dev...`}
            className="flex-1 min-h-[40px] max-h-[160px] resize-none bg-background/60 border-border/40 font-mono text-xs placeholder:text-muted-foreground/50 focus-visible:ring-primary/50"
            disabled={streaming}
          />

          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={handleImageAttach}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-9 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => imageInputRef.current?.click()}
            disabled={streaming}
          >
            <ImagePlus className="w-4 h-4" />
          </Button>

          {streaming ? (
            <Button
              size="icon"
              className="h-10 w-10 shrink-0 bg-red-500/20 hover:bg-red-500/40 border border-red-500/30"
              onClick={stopStreaming}
            >
              <Square className="w-4 h-4 text-red-400" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="h-10 w-10 shrink-0 bg-primary/20 hover:bg-primary/40 border border-primary/30"
              onClick={() => handleSend()}
              disabled={!input.trim() && attachedImages.length === 0}
            >
              <Send className="w-4 h-4 text-primary" />
            </Button>
          )}
        </div>
      </div>

      {/* Image lightbox overlay */}
      {lightboxImage && (
        <ImageLightbox
          src={lightboxImage.src}
          alt={lightboxImage.alt}
          onClose={() => setLightboxImage(null)}
        />
      )}
    </div>
  );
}


// ── Main Page Component ───────────────────────────────────────────────────────

function SelfDevPageInner() {
  const agentName = useAgentName();
  // Panel widths in pixels; null means "use flex-1 (fill remaining)"
  const [leftWidth, setLeftWidth] = useState(260);
  const [rightWidth, setRightWidth] = useState(320);
  const dragStartRef = useRef({ left: 260, right: 320 });

  const { data: status, refetch: refetchStatus, isError: statusError } = useQuery<DevStatus>({
    queryKey: ["/api/self-dev/status"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/self-dev/status");
      return res.json();
    },
    refetchInterval: 2000, // Poll status every 2s — reflects agent-triggered server start/stop quickly
    retry: 1,
  });

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Page header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border/40 bg-black/40 shrink-0">
        <Code2 className="w-4 h-4 text-primary" />
        <h1 className="font-mono text-sm font-semibold text-foreground tracking-wide">
          Self-Development
        </h1>
        <Badge
          variant="outline"
          className={`ml-1 font-mono text-[10px] h-4 px-1.5 ${
            status?.devDir
              ? "border-green-500/40 text-green-400"
              : "border-yellow-500/40 text-yellow-500"
          }`}
        >
          {status?.devDir ? `dev-${String(status.devNumber ?? 0).padStart(3, "0")}` : "No session"}
        </Badge>
        {status?.serverStatus === "running" && (
          <Badge
            variant="outline"
            className="font-mono text-[10px] h-4 px-1.5 border-cyan-500/40 text-cyan-400 gap-1"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 inline-block animate-pulse" />
            Server :{status.serverPort}
          </Badge>
        )}
      </div>

      {/* 3-panel layout — pixel-based flex with drag handles (no react-resizable-panels) */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Left: Status panel */}
        <div
          className="flex flex-col overflow-hidden shrink-0"
          style={{ width: leftWidth, minWidth: 180, maxWidth: 380 }}
        >
          <StatusPanel status={status ?? null} onRefresh={() => refetchStatus()} />
        </div>

        <DragHandle
          onDragStart={() => { dragStartRef.current.left = leftWidth; }}
          onDrag={(delta) => setLeftWidth(Math.max(180, Math.min(380, dragStartRef.current.left + delta)))}
        />

        {/* Center: Chat panel — fills remaining space */}
        <div className="flex flex-col flex-1 overflow-hidden min-w-0">
          <ChatPanel statusEvents={status?.statusEvents} />
        </div>

        <DragHandle
          onDragStart={() => { dragStartRef.current.right = rightWidth; }}
          onDrag={(delta) => setRightWidth(Math.max(200, Math.min(500, dragStartRef.current.right - delta)))}
        />

        {/* Right: File viewer panel */}
        <div
          className="flex flex-col overflow-hidden shrink-0"
          style={{ width: rightWidth, minWidth: 200, maxWidth: 500 }}
        >
          <FileViewerPanel devDir={status?.devDir ?? null} />
        </div>
      </div>
    </div>
  );
}

export default function SelfDevPage() {
  return (
    <DevErrorBoundary>
      <SelfDevPageInner />
    </DevErrorBoundary>
  );
}
