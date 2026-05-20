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
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

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
  Play, RefreshCw, PlusCircle, ImagePlus, X,
  FolderOpen, FileText, Server, CheckCircle2,
  XCircle, Clock, Terminal, Code2, Wrench,
  ChevronRight, ChevronDown, Activity, Download, Shield,
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

interface StreamEvent {
  type: string;
  [key: string]: any;
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

// ── Inline image path detection for ComfyUI-generated images ───────────────
const IMAGE_PATH_REGEX = /(\/(?:home|root)\/[^\s]*\/agent2077-images\/[^\s]+\.(?:png|jpg|jpeg|webp|gif))/gi;

function imagePathToUrl(filePath: string): string {
  return `/api/images/file?path=${encodeURIComponent(filePath)}`;
}

function MessageContentWithImages({
  content,
  onImageClick,
}: {
  content: string;
  onImageClick?: (src: string, alt: string) => void;
}) {
  const parts = content.split(IMAGE_PATH_REGEX);
  if (parts.length === 1) return null;

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
              className="max-w-xs max-h-64 rounded-lg border border-border/40 cursor-pointer hover:opacity-90 transition-opacity shadow-lg"
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

// ── Markdown renderer (shared with main chat) ─────────────────────────────────

function MarkdownMessage({ content, onImageClick }: { content: string; onImageClick?: (src: string, alt: string) => void }) {
  return (
    <>
      <MessageContentWithImages content={content} onImageClick={onImageClick} />
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        className="prose prose-invert prose-sm max-w-none text-foreground break-words"
        components={{
          code({ node, className, children, ...props }: any) {
            const inline = !className;
            if (inline) {
              return (
                <code
                  className="bg-muted/60 px-1 py-0.5 rounded text-xs font-mono text-primary"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              <code className={`${className ?? ""} text-xs`} {...props}>
                {children}
              </code>
            );
          },
          pre({ children }: any) {
            return (
              <pre className="bg-black/50 border border-border/40 rounded-md p-3 overflow-x-auto text-xs my-2">
                {children}
              </pre>
            );
          },
        }}
      >
        {content.replace(IMAGE_PATH_REGEX, "").trim()}
      </ReactMarkdown>
    </>
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

          {/* Server status */}
          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Dev Server</p>
            <div className="flex items-center gap-2">
              <StatusDot ok={serverRunning} />
              <span className="font-mono text-xs">
                {serverRunning ? `Running :${status?.serverPort}` : "Stopped"}
              </span>
            </div>
            <div className="flex gap-1.5 mt-1.5">
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
      </ScrollArea>
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
  const [streaming, setStreaming] = useState(false);
  const [streamContent, setStreamContent] = useState("");
  const [pendingUserMessage, setPendingUserMessage] = useState<string | null>(null);
  const [steps, setSteps] = useState<any[]>([]);
  const [statusLog, setStatusLog] = useState<Array<{ message: string; detail?: string; timestamp: number }>>([]);
  const [attachedImages, setAttachedImages] = useState<File[]>([]);
  const [pendingImages, setPendingImages] = useState<Array<{ name: string; base64: string; mimeType: string }>>([]);
  const [lightboxImage, setLightboxImage] = useState<{ src: string; alt: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef<string>("");
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
                else if (ev.type === "status") { setStatusLog(p => [...p, ev]); }
                else if (ev.type === "step") { setSteps(p => [...p, ev]); }
                else if (ev.type === "active") { /* already streaming */ }
                else if (ev.type === "done" || ev.type === "error" || ev.type === "stream_end") {
                  if (ev.type === "error") setStreamContent(p => p + `\n\n[Error: ${ev.content}]`);
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
    setStatusLog([{ type: "status", content: "Resuming after reset decision..." }]);
    // Re-subscribe to SSE broadcast so we receive the new agent turn
    // The server will send a request_id event followed by the usual stream
    const selfDevConvId = String(convData?.id ?? "");
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
            else if (ev.type === "status") setStatusLog(p => [...p, ev]);
            else if (ev.type === "step") setSteps(p => [...p, ev]);
            else if (ev.type === "done" || ev.type === "error") {
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
    if (requestIdRef.current) {
      apiRequest("POST", "/api/chat/stop", { requestId: requestIdRef.current });
    }
    abortRef.current?.abort();
    setStreaming(false);
  };

  const handleSend = useCallback(async (overrideMessage?: string) => {
    const msg = overrideMessage ?? input.trim();
    if (!msg || streaming) return;

    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setStreaming(true);
    setStreamContent("");
    setSteps([]);
    setStatusLog([]);
    setPendingUserMessage(msg);
    requestIdRef.current = "";

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

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/self-dev/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          message: msg,
          images: imageData.length > 0 ? imageData : undefined,
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
                requestIdRef.current = event.requestId;
                break;
              case "content":
                content += event.content;
                setStreamContent(content);
                break;
              case "status": {
                const entry = { message: event.message || event.label || "", detail: event.detail, timestamp: event.timestamp || Date.now() };
                setStatusLog(prev => {
                  const next = [...prev, entry];
                  return next.length > 20 ? next.slice(-20) : next;
                });
                break;
              }
              case "step":
                setSteps((prev) => [...prev, event]);
                break;
              case "error":
                content += `\n\n**Error:** ${event.content}`;
                setStreamContent(content);
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
              case "done":
                setActiveSubAgents(new Map());
                setStatusLog([]);
                break;
            }
          } catch {}
        }
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        setStreamContent((prev) => prev + `\n\n**Error:** ${err.message}`);
      }
    } finally {
      setStreaming(false);
      setPendingUserMessage(null);
      setPendingImages([]);
      abortRef.current = null;
      refetch();
      queryClient.invalidateQueries({ queryKey: ["/api/self-dev/conversation"] });
    }
  }, [input, streaming, attachedImages, refetch]);

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
          <MessageBubble key={msg.id} message={msg} onImageClick={(src, alt) => setLightboxImage({ src, alt })} />
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
              <p className="text-sm text-foreground/90 whitespace-pre-wrap">{pendingUserMessage}</p>
            </div>
            <div className="w-6 h-6 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center shrink-0 mt-0.5">
              <User className="w-3 h-3 text-primary" />
            </div>
          </div>
        )}

        {/* Streaming assistant response */}
        {(streaming || statusLog.length > 0) && (streamContent || steps.length > 0 || statusLog.length > 0) && (
          <div className="flex gap-2.5">
            <div className="w-6 h-6 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center shrink-0 mt-0.5">
              <Bot className="w-3 h-3 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              {statusLog.length > 0 && (
                <ActivityFeed entries={statusLog} />
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

// ── Message Bubble ────────────────────────────────────────────────────────────

function MessageBubble({ message, onImageClick }: { message: Message; onImageClick?: (src: string, alt: string) => void }) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === "user";

  const copy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  let parsedImages: Array<{ name: string; base64: string; mimeType: string }> = [];
  if (message.images) {
    try {
      parsedImages = JSON.parse(message.images);
    } catch {}
  }

  return (
    <div className={`flex gap-2.5 group ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      {/* Avatar */}
      <div
        className={`w-6 h-6 rounded-full border flex items-center justify-center shrink-0 mt-0.5 ${
          isUser
            ? "bg-primary/20 border-primary/30"
            : "bg-cyan-500/10 border-cyan-500/20"
        }`}
      >
        {isUser ? (
          <User className="w-3 h-3 text-primary" />
        ) : (
          <Bot className="w-3 h-3 text-cyan-400" />
        )}
      </div>

      {/* Content */}
      <div className={`flex-1 min-w-0 ${isUser ? "items-end" : "items-start"} flex flex-col`}>
        {parsedImages.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {parsedImages.map((img, i) => (
              <img
                key={i}
                src={img.base64}
                alt={img.name}
                className="w-24 h-24 object-cover rounded-lg border border-border/30"
              />
            ))}
          </div>
        )}
        <div
          className={`relative max-w-[90%] rounded-xl px-3 py-2 ${
            isUser
              ? "bg-primary/10 border border-primary/20 rounded-tr-sm"
              : "bg-muted/30 border border-border/30 rounded-tl-sm"
          }`}
        >
          {isUser ? (
            <p className="text-sm text-foreground/90 whitespace-pre-wrap">{message.content}</p>
          ) : (
            <MarkdownMessage content={message.content} onImageClick={onImageClick} />
          )}
          <button
            className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={copy}
          >
            {copied ? (
              <Check className="w-3 h-3 text-green-400" />
            ) : (
              <Copy className="w-3 h-3 text-muted-foreground hover:text-foreground" />
            )}
          </button>
        </div>
        <span className="text-[9px] text-muted-foreground/50 mt-0.5 px-1 font-mono">
          {new Date(message.createdAt).toLocaleTimeString()}
        </span>
      </div>
    </div>
  );
}

// ── Activity Feed Component (mirrors chat.tsx) ─────────────────────────────
function ActivityFeed({ entries }: { entries: Array<{ message: string; detail?: string; timestamp: number }> }) {
  const feedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [entries.length]);
  const visible = entries.slice(-8);
  return (
    <div className="bg-card/80 border border-border rounded-lg p-3 mb-2">
      <div className="flex items-center gap-2 mb-2">
        <Activity className="w-4 h-4 text-primary animate-pulse" />
        <span className="text-xs font-medium text-foreground">Working</span>
      </div>
      <div ref={feedRef} className="space-y-1 max-h-32 overflow-y-auto">
        {visible.map((entry, i) => {
          const isLatest = i === visible.length - 1;
          return (
            <div
              key={`${entry.timestamp}-${i}`}
              className={`flex items-center gap-2 text-[11px] transition-opacity duration-300 ${
                isLatest ? "text-foreground" : "text-muted-foreground/60"
              }`}
            >
              {isLatest ? (
                <Loader2 className="w-3 h-3 animate-spin text-primary shrink-0" />
              ) : (
                <CheckCircle2 className="w-3 h-3 text-green-400/60 shrink-0" />
              )}
              <span className={isLatest ? "font-medium" : ""}>{entry.message}</span>
              {entry.detail && (
                <span className="text-[10px] text-muted-foreground/50 truncate">
                  {entry.detail}
                </span>
              )}
            </div>
          );
        })}
      </div>
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
