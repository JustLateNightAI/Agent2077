import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card } from "@/components/ui/card";
// CodeMirror 6
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { closeBrackets, autocompletion, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { rust } from "@codemirror/lang-rust";
import { cpp } from "@codemirror/lang-cpp";
import { oneDark } from "@codemirror/theme-one-dark";
/**
 * Pixel-based drag handle. onDragStart is called with the mouse position when
 * dragging begins; onDrag is called with the total delta from start during drag.
 * The parent tracks initialSize + delta to get pixel-perfect resizing.
 */
function DragHandle({
  direction,
  onDragStart,
  onDrag,
}: {
  direction: "horizontal" | "vertical";
  onDragStart: () => void;
  onDrag: (delta: number) => void;
}) {
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    onDragStart();
    const startPos = direction === "horizontal" ? e.clientX : e.clientY;

    const handleMouseMove = (ev: MouseEvent) => {
      const currentPos = direction === "horizontal" ? ev.clientX : ev.clientY;
      onDrag(currentPos - startPos);
    };

    const handleMouseUp = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div
      onMouseDown={handleMouseDown}
      className={`shrink-0 bg-border hover:bg-primary/40 transition-colors ${
        direction === "horizontal"
          ? "w-[3px] cursor-col-resize hover:w-[4px]"
          : "h-[3px] cursor-row-resize hover:h-[4px]"
      }`}
      data-testid={`drag-handle-${direction}`}
    />
  );
}
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuTrigger, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Code, Play, Square, Download, Upload, Plus, File, Folder,
  FolderUp,
  FolderOpen, ChevronRight, ChevronDown, X, Save, MoreVertical,
  Terminal, Trash2, Edit2, ArrowLeft, Loader2, Bot, Send, User,
  Copy, Check, Wrench, Activity, ListChecks,
  CircleDot, CheckCircle2, Circle,
  FileCode, FileText, FileJson, FileCog, Package,
  GitBranch, GitCommit, GitPullRequest, AlertCircle, Diff, ImagePlus, ArrowDown,
  Lightbulb,
} from "lucide-react";

// ────────────── Types ──────────────

interface Project {
  id: number;
  name: string;
  description?: string;
  path: string;
  language?: string;
  updatedAt: string;
  conversationId?: number;
}

interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
}

interface OpenTab {
  path: string;
  modified: boolean;
}

// ────────────── Helpers ──────────────

function getFileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return <FileCode className="w-4 h-4 text-blue-400" />;
    case "js":
    case "jsx":
      return <FileCode className="w-4 h-4 text-yellow-400" />;
    case "py":
      return <FileCode className="w-4 h-4 text-green-400" />;
    case "rs":
      return <FileCode className="w-4 h-4 text-orange-400" />;
    case "go":
      return <FileCode className="w-4 h-4 text-cyan-400" />;
    case "json":
      return <FileJson className="w-4 h-4 text-yellow-300" />;
    case "md":
      return <FileText className="w-4 h-4 text-muted-foreground" />;
    case "toml":
    case "yaml":
    case "yml":
    case "ini":
    case "cfg":
      return <FileCog className="w-4 h-4 text-muted-foreground" />;
    default:
      return <File className="w-4 h-4 text-muted-foreground" />;
  }
}

function formatDate(dateStr: string) {
  try {
    return new Date(dateStr).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return dateStr;
  }
}

// ────────────── Language detection ──────────────

function getLanguageExtension(fileName: string) {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
      return javascript({ typescript: true, jsx: ext === "tsx" });
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return javascript({ jsx: ext === "jsx" });
    case "py":
      return python();
    case "css":
    case "scss":
    case "less":
      return css();
    case "html":
    case "htm":
      return html();
    case "json":
    case "jsonc":
      return json();
    case "md":
    case "mdx":
      return markdown();
    case "rs":
      return rust();
    case "cpp":
    case "cc":
    case "cxx":
    case "c":
    case "h":
    case "hpp":
      return cpp();
    default:
      return null;
  }
}

// ────────────── Code Editor (CodeMirror 6) ──────────────

function CodeEditor({
  content,
  onChange,
  onSave,
  fileName,
}: {
  content: string;
  onChange: (v: string) => void;
  onSave: () => void;
  fileName: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<EditorView | null>(null);

  // Keep callbacks in refs so the CM listener always sees the latest version
  // without needing to recreate the editor every render.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { onSaveRef.current = onSave; }, [onSave]);

  // Recreate the editor whenever the file changes (new language, fresh doc).
  // Content sync for in-file edits is handled by the updateListener below.
  useEffect(() => {
    if (!containerRef.current) return;

    // Destroy previous instance
    if (editorRef.current) {
      editorRef.current.destroy();
      editorRef.current = null;
    }

    const theme = document.documentElement.getAttribute("data-theme") ?? "cyberpunk";

    // v16.39: each theme gets its own code editor style
    let themeExt;
    if (theme === "professional") {
      // Clean light editor — Inter for code, indigo accent, no glow
      themeExt = [
        EditorView.theme({
          "&": { backgroundColor: "#FAFAFA", color: "#171717" },
          ".cm-content": { fontFamily: "'JetBrains Mono','Fira Code',monospace", fontSize: "12px" },
          ".cm-gutters": { backgroundColor: "#F0F0F0", color: "#737373", border: "none", borderRight: "1px solid #E5E5E5" },
          ".cm-activeLine": { backgroundColor: "rgba(99,102,241,0.05)" },
          ".cm-activeLineGutter": { backgroundColor: "rgba(99,102,241,0.08)" },
          ".cm-cursor": { borderLeftColor: "#6366F1" },
          ".cm-selectionBackground": { backgroundColor: "rgba(99,102,241,0.15) !important" },
          ".cm-lineNumbers": { color: "#A3A3A3" },
        }),
        syntaxHighlighting(defaultHighlightStyle),
      ];
    } else if (theme === "lofi") {
      // Warm paper editor — cream background, terracotta accent, soft feel
      themeExt = [
        EditorView.theme({
          "&": { backgroundColor: "#F2EDE4", color: "#3A2E22" },
          ".cm-content": { fontFamily: "'JetBrains Mono','Fira Code',monospace", fontSize: "12.5px", lineHeight: "1.7" },
          ".cm-gutters": { backgroundColor: "#EDE7DC", color: "#9A8878", border: "none", borderRight: "1px solid #D8CFC4" },
          ".cm-activeLine": { backgroundColor: "rgba(212,98,42,0.05)" },
          ".cm-activeLineGutter": { backgroundColor: "rgba(212,98,42,0.08)" },
          ".cm-cursor": { borderLeftColor: "#D4622A", borderLeftWidth: "2px" },
          ".cm-selectionBackground": { backgroundColor: "rgba(212,98,42,0.12) !important" },
          ".cm-lineNumbers": { color: "#B09880" },
        }),
        syntaxHighlighting(defaultHighlightStyle),
      ];
    } else if (theme === "clean") {
      // Clean Pro — soft off-white editor, calm teal accent, no glow
      themeExt = [
        EditorView.theme({
          "&": { backgroundColor: "#FFFFFF", color: "#1d2329" },
          ".cm-content": { fontFamily: "'JetBrains Mono','Fira Code',monospace", fontSize: "12.5px", lineHeight: "1.6" },
          ".cm-gutters": { backgroundColor: "#F7F7F6", color: "#737d85", border: "none", borderRight: "1px solid #e4e2df" },
          ".cm-activeLine": { backgroundColor: "rgba(42,157,143,0.05)" },
          ".cm-activeLineGutter": { backgroundColor: "rgba(42,157,143,0.08)" },
          ".cm-cursor": { borderLeftColor: "#2a9d8f" },
          ".cm-selectionBackground": { backgroundColor: "rgba(42,157,143,0.14) !important" },
          ".cm-lineNumbers": { color: "#9aa3aa" },
        }),
        syntaxHighlighting(defaultHighlightStyle),
      ];
    } else {
      // Cyberpunk — oneDark with transparent bg to let the dark theme show through
      themeExt = [
        oneDark,
        EditorView.theme({
          "&": { backgroundColor: "transparent" },
          ".cm-content": { fontFamily: "'JetBrains Mono','Fira Code',monospace", fontSize: "12px" },
          ".cm-gutters": { backgroundColor: "transparent", border: "none" },
        }),
      ];
    }

    const langExt = getLanguageExtension(fileName);

    const extensions = [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      bracketMatching(),
      closeBrackets(),
      indentOnInput(),
      autocompletion(),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...completionKeymap,
        indentWithTab,
        // Ctrl+S / Cmd+S → save
        { key: "Mod-s", run: () => { onSaveRef.current(); return true; } },
      ]),
      ...themeExt,
      ...(langExt ? [langExt] : []),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString());
        }
      }),
    ];

    const state = EditorState.create({ doc: content, extensions });
    const view = new EditorView({ state, parent: containerRef.current });
    editorRef.current = view;

    return () => {
      view.destroy();
      editorRef.current = null;
    };
  // Re-create when the file changes — content handled via dispatch below
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileName]);

  // Sync external content into the existing editor (e.g. initial load after
  // the effect already ran with an empty string, or undo from outside).
  useEffect(() => {
    const view = editorRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== content) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: content },
        // Don't push into undo history for external syncs
        annotations: [],
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  return (
    <div
      ref={containerRef}
      className="h-full overflow-auto"
      data-testid="code-editor"
    />
  );
}

// ────────────── File Tree ──────────────

function FileTreeNode({
  node,
  expandedPaths,
  toggleExpand,
  onSelectFile,
  activeFile,
  onNewFile,
  onNewFolder,
  onDeleteFile,
  onRenameFile,
  depth,
}: {
  node: FileNode;
  expandedPaths: Set<string>;
  toggleExpand: (path: string) => void;
  onSelectFile: (path: string) => void;
  activeFile: string | null;
  onNewFile: (parentPath: string) => void;
  onNewFolder: (parentPath: string) => void;
  onDeleteFile: (path: string) => void;
  onRenameFile: (path: string) => void;
  depth: number;
}) {
  const isExpanded = expandedPaths.has(node.path);
  const isActive = activeFile === node.path;
  const paddingLeft = depth * 12 + 4;

  if (node.type === "directory") {
    return (
      <div data-testid={`tree-dir-${node.path}`}>
        <div
          className="flex items-center gap-1 py-0.5 pr-2 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/10 cursor-pointer group"
          style={{ paddingLeft }}
          onClick={() => toggleExpand(node.path)}
        >
          {isExpanded ? (
            <ChevronDown className="w-3 h-3 shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 shrink-0" />
          )}
          {isExpanded ? (
            <FolderOpen className="w-3.5 h-3.5 shrink-0 text-primary/60" />
          ) : (
            <Folder className="w-3.5 h-3.5 shrink-0 text-primary/60" />
          )}
          <span className="truncate flex-1">{node.name}</span>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-4 w-4 p-0 opacity-0 group-hover:opacity-100 shrink-0"
                onClick={(e) => e.stopPropagation()}
                data-testid={`tree-dir-menu-${node.path}`}
              >
                <MoreVertical className="w-3 h-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="start" className="w-36">
              <DropdownMenuItem
                onClick={(e) => { e.stopPropagation(); onNewFile(node.path); }}
                data-testid={`tree-new-file-${node.path}`}
              >
                <Plus className="w-3 h-3 mr-2" /> New File
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={(e) => { e.stopPropagation(); onNewFolder(node.path); }}
                data-testid={`tree-new-folder-${node.path}`}
              >
                <Folder className="w-3 h-3 mr-2" /> New Folder
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={(e) => { e.stopPropagation(); onDeleteFile(node.path); }}
                data-testid={`tree-delete-${node.path}`}
              >
                <Trash2 className="w-3 h-3 mr-2" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {isExpanded && node.children && (
          <div>
            {node.children.map((child) => (
              <FileTreeNode
                key={child.path}
                node={child}
                expandedPaths={expandedPaths}
                toggleExpand={toggleExpand}
                onSelectFile={onSelectFile}
                activeFile={activeFile}
                onNewFile={onNewFile}
                onNewFolder={onNewFolder}
                onDeleteFile={onDeleteFile}
                onRenameFile={onRenameFile}
                depth={depth + 1}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // File node
  return (
    <div
      className={`flex items-center gap-1.5 py-0.5 pr-2 rounded text-xs cursor-pointer group transition-colors ${
        isActive
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-accent/10 hover:text-foreground"
      }`}
      style={{ paddingLeft }}
      onClick={() => onSelectFile(node.path)}
      data-testid={`tree-file-${node.path}`}
    >
      {getFileIcon(node.name)}
      <span className="truncate flex-1">{node.name}</span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-4 w-4 p-0 opacity-0 group-hover:opacity-100 shrink-0"
            onClick={(e) => e.stopPropagation()}
            data-testid={`tree-file-menu-${node.path}`}
          >
            <MoreVertical className="w-3 h-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="w-32">
          <DropdownMenuItem
            onClick={(e) => { e.stopPropagation(); onRenameFile(node.path); }}
            data-testid={`file-rename-${node.path}`}
          >
            <Edit2 className="w-3 h-3 mr-2" /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={(e) => { e.stopPropagation(); onDeleteFile(node.path); }}
            data-testid={`file-delete-${node.path}`}
          >
            <Trash2 className="w-3 h-3 mr-2" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ────────────── Git Panel ──────────────

interface GitStatus {
  branch: string;
  changes: number;
  status: string;
}

function GitPanel({ projectId }: { projectId: number }) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);

  const { data: gitStatus, isLoading, refetch } = useQuery<GitStatus>({
    queryKey: [`/api/projects/${projectId}/git-status`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/projects/${projectId}/git-status`);
      return res.json();
    },
    retry: false,
    enabled: !!projectId,
  });

  const initMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/projects/${projectId}/git-init`),
    onSuccess: () => { refetch(); toast({ title: "Git initialized" }); },
    onError: () => toast({ title: "Git init failed", variant: "destructive" }),
  });

  const commitMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/projects/${projectId}/git-commit`, { message: "Auto-commit from Agent2077" }),
    onSuccess: () => { refetch(); toast({ title: "Committed all changes" }); },
    onError: () => toast({ title: "Commit failed", variant: "destructive" }),
  });

  const logMutation = useMutation({
    mutationFn: () => apiRequest("GET", `/api/projects/${projectId}/git-log`),
    onSuccess: async (res) => {
      const data = await res.json();
      toast({ title: `Last commit: ${data.last || "none"}` });
    },
    onError: () => toast({ title: "Could not fetch log", variant: "destructive" }),
  });

  const [diffOutput, setDiffOutput] = useState<string | null>(null);
  const diffMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("GET", `/api/projects/${projectId}/git/diff`);
      return res.json();
    },
    onSuccess: (data) => setDiffOutput(data.output || "(no uncommitted changes)"),
    onError: () => toast({ title: "git diff failed", variant: "destructive" }),
  });

  return (
    <div className="border-t border-zinc-800" data-testid="git-panel">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50 transition-colors"
        onClick={() => setExpanded(v => !v)}
        data-testid="button-toggle-git"
      >
        <GitBranch className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
        <span className="flex-1 text-left font-mono">
          {gitStatus?.branch ? (
            <span className="text-cyan-400">{gitStatus.branch}</span>
          ) : (
            <span className="text-zinc-500">git</span>
          )}
        </span>
        {gitStatus?.changes !== undefined && gitStatus.changes > 0 && (
          <span className="text-[10px] text-yellow-500 font-mono">{gitStatus.changes} changes</span>
        )}
        {expanded ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2 bg-zinc-950/40">
          {isLoading ? (
            <div className="flex justify-center py-2"><Loader2 className="w-4 h-4 animate-spin text-zinc-500" /></div>
          ) : gitStatus ? (
            <>
              <div className="text-[10px] text-zinc-500 font-mono py-1">
                {gitStatus.status || "Clean working directory"}
              </div>
              {gitStatus.changes > 0 && (
                <div className="flex items-center gap-1.5 text-[10px] text-yellow-500">
                  <AlertCircle className="w-3 h-3 shrink-0" />
                  {gitStatus.changes} uncommitted change{gitStatus.changes !== 1 ? "s" : ""}
                </div>
              )}
            </>
          ) : (
            <p className="text-[10px] text-zinc-600 py-1">Not a git repository</p>
          )}
          <div className="flex items-center gap-1 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[10px] border-zinc-700 text-zinc-400 hover:text-zinc-100"
              onClick={() => initMutation.mutate()}
              disabled={initMutation.isPending}
              data-testid="button-git-init"
            >
              {initMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Init Git"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[10px] border-zinc-700 text-zinc-400 hover:text-zinc-100"
              onClick={() => commitMutation.mutate()}
              disabled={commitMutation.isPending || !gitStatus?.changes}
              data-testid="button-git-commit"
            >
              {commitMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <><GitCommit className="w-3 h-3 mr-1" />Commit All</>}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[10px] border-zinc-700 text-zinc-400 hover:text-zinc-100"
              onClick={() => logMutation.mutate()}
              disabled={logMutation.isPending}
              data-testid="button-git-log"
            >
              View Log
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[10px] border-zinc-700 text-zinc-400 hover:text-zinc-100"
              onClick={() => { setDiffOutput(null); diffMutation.mutate(); }}
              disabled={diffMutation.isPending}
              data-testid="button-git-diff"
            >
              {diffMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <><Diff className="w-3 h-3 mr-1" />Diff</>}
            </Button>
          </div>
          {diffOutput !== null && (
            <div className="mt-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[9px] text-zinc-500 font-mono">git diff HEAD</span>
                <button onClick={() => setDiffOutput(null)} className="text-[9px] text-zinc-600 hover:text-zinc-400">✕</button>
              </div>
              <pre className="text-[9px] font-mono bg-zinc-900/60 border border-zinc-800 rounded p-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-zinc-300">{diffOutput}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ────────────── WebSocket Terminal Panel ──────────────

function TerminalPanel({ projectId, projectPath }: { projectId: number; projectPath?: string }) {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState<Array<{ type: string; content: string }>>([]);
  const [connected, setConnected] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!projectId) return;
    let ws: WebSocket | null = null;
    let cancelled = false;

    (async () => {
      try {
        // Reuse existing session if we have one stored (survives tab switches)
        const storageKey = `terminal_session_${projectId}`;
        const savedWsUrl = sessionStorage.getItem(storageKey);

        let wsUrlToUse: string;

        if (savedWsUrl) {
          // Try to reconnect to the existing session
          wsUrlToUse = savedWsUrl;
        } else {
          // Create a new terminal session
          const res = await fetch(`/api/projects/${projectId}/terminal/sessions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
          });
          if (!res.ok || cancelled) return;
          const session = await res.json();
          if (cancelled) return;
          wsUrlToUse = `ws://${window.location.host}${session.wsUrl}`;
          sessionStorage.setItem(storageKey, wsUrlToUse);
        }

        ws = new WebSocket(wsUrlToUse);
        wsRef.current = ws;

        ws.onopen = () => {
          if (cancelled) return;
          setConnected(true);
          setOutput([{ type: "info", content: `Connected to terminal — ${projectPath || "workspace"}` }]);
        };

        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === "output") {
              setOutput(prev => [...prev, { type: "stdout", content: msg.data }]);
            }
          } catch {
            setOutput(prev => [...prev, { type: "stdout", content: ev.data }]);
          }
        };

        ws.onclose = () => {
          if (cancelled) return;
          setConnected(false);
          // Clear stored session — it's gone, next mount will create a new one
          sessionStorage.removeItem(`terminal_session_${projectId}`);
          setOutput(prev => [...prev, { type: "info", content: "Terminal disconnected" }]);
        };

        ws.onerror = (err) => {
          // Connection failed (saved session may have expired) — clear and let user retry
          sessionStorage.removeItem(`terminal_session_${projectId}`);
        };

        ws.onerror = () => {
          if (cancelled) return;
          setOutput(prev => [...prev, { type: "stderr", content: "Terminal connection error" }]);
          setConnected(false);
        };
      } catch (err) {
        if (!cancelled) {
          setOutput(prev => [...prev, { type: "stderr", content: "Failed to create terminal session" }]);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (ws) ws.close();
      wsRef.current = null;
    };
  }, [projectId, projectPath]);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output.length]);

  const sendCommand = () => {
    if (!input.trim()) return;
    const cmd = input.trim();
    setInput("");
    setOutput(prev => [...prev, { type: "cmd", content: `$ ${cmd}` }]);

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "input", data: cmd + "\n" }));
    } else {
      // HTTP fallback
      fetch(`/api/projects/${projectId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ command: cmd }),
      }).then(async res => {
        const reader = res.body?.getReader();
        if (!reader) return;
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === "stdout" || event.type === "stderr") {
                setOutput(prev => [...prev, { type: event.type, content: event.content }]);
              } else if (event.type === "exit") {
                setOutput(prev => [...prev, { type: "info", content: `Exited (${event.code})` }]);
              }
            } catch {}
          }
        }
      }).catch(err => setOutput(prev => [...prev, { type: "stderr", content: err.message }]));
    }
  };

  const getOutputColor = (type: string) => {
    switch (type) {
      case "stderr": return "text-red-400";
      case "cmd": return "text-primary";
      case "info": return "text-zinc-500";
      default: return "text-green-400";
    }
  };

  return (
    <div className="flex flex-col h-full bg-black font-mono text-xs">
      {/* Connection indicator */}
      <div className="flex items-center gap-1.5 px-2 py-0.5 bg-zinc-950 border-b border-zinc-800">
        <div className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`} />
        <span className="text-[10px] text-zinc-500">{connected ? "ws connected" : "http mode"}</span>
      </div>
      {/* Output area */}
      <div
        ref={outputRef}
        className="flex-1 overflow-y-auto p-2 space-y-0.5 cursor-text"
        onClick={() => inputRef.current?.focus()}
        data-testid="terminal-output"
      >
        {output.length === 0 && (
          <div className="text-zinc-600">Terminal ready. Type a command below.</div>
        )}
        {output.map((line, i) => (
          <div key={i} className={`whitespace-pre-wrap break-all leading-5 ${getOutputColor(line.type)}`}>
            {line.content}
          </div>
        ))}
      </div>
      {/* Input */}
      <div className="border-t border-zinc-800 flex items-center gap-1 px-2 py-1 bg-zinc-950">
        <span className="text-green-500 shrink-0">$</span>
        <input
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") sendCommand(); }}
          placeholder="Enter command..."
          className="flex-1 bg-transparent outline-none text-green-400 placeholder-zinc-600 text-xs"
          data-testid="terminal-input"
        />
      </div>
    </div>
  );
}

// ────────────── Diff Preview Dialog ──────────────

interface DiffPreview {
  editId: number;
  filePath: string;
  description?: string;
  original: string;
  proposed: string;
}

function DiffPreviewDialog({
  diff,
  onClose,
}: {
  diff: DiffPreview | null;
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
  const maxLines = Math.max(origLines.length, propLines.length);

  return (
    <Dialog open={!!diff} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-w-4xl w-full" data-testid="diff-preview-dialog">
        <DialogHeader>
          <DialogTitle className="text-sm font-mono text-primary flex items-center gap-2">
            <Diff className="w-4 h-4" />
            Diff Preview
          </DialogTitle>
          <div className="text-xs text-zinc-400 font-mono">{diff.filePath}</div>
          {diff.description && (
            <div className="text-xs text-zinc-300 mt-1">{diff.description}</div>
          )}
        </DialogHeader>
        <div className="flex gap-1 h-72 overflow-hidden border border-zinc-800 rounded-md text-xs font-mono">
          {/* Original */}
          <div className="flex-1 overflow-auto bg-red-950/20">
            <div className="px-2 py-1 bg-red-900/30 text-red-400 text-[10px] sticky top-0 border-b border-red-900/30">Original</div>
            <div className="p-2 space-y-0">
              {origLines.map((line, i) => (
                <div key={i} className="text-red-300/80 whitespace-pre leading-5">{line || " "}</div>
              ))}
            </div>
          </div>
          {/* Proposed */}
          <div className="flex-1 overflow-auto bg-green-950/20">
            <div className="px-2 py-1 bg-green-900/30 text-green-400 text-[10px] sticky top-0 border-b border-green-900/30">Proposed</div>
            <div className="p-2 space-y-0">
              {propLines.map((line, i) => (
                <div key={i} className="text-green-300/80 whitespace-pre leading-5">{line || " "}</div>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
          >
            Close
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => rejectMutation.mutate(diff.editId)}
            disabled={rejectMutation.isPending || approveMutation.isPending}
            data-testid="button-reject-diff"
          >
            {rejectMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Reject"}
          </Button>
          <Button
            size="sm"
            className="bg-green-600 hover:bg-green-700 text-white"
            onClick={() => approveMutation.mutate(diff.editId)}
            disabled={approveMutation.isPending || rejectMutation.isPending}
            data-testid="button-approve-diff"
          >
            {approveMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Approve"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ────────────── Workspace Chat (full-featured, mirrors main chat) ──────────────

interface WsMessage {
  id: number;
  role: string;
  content: string;
  modelId?: string;
  taskType?: string;
  createdAt: string;
  images?: string;
}

interface WsPlanStep {
  step: number;
  title: string;
  status: "pending" | "running" | "completed";
}

// ── Image Lightbox ─────────────────────────────────────────────
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

function WorkspaceChat({
  project,
  activeFile,
  onFilesChanged,
  onStreamingChange,
}: {
  project: Project;
  activeFile: string | null;
  onFilesChanged: () => void;
  onStreamingChange?: (streaming: boolean) => void;
}) {
  const conversationId = project.conversationId ?? null;
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamContent, setStreamContent] = useState("");
  const [steps, setSteps] = useState<any[]>([]);
  const [planSteps, setPlanSteps] = useState<WsPlanStep[]>([]);
  const [routingInfo, setRoutingInfo] = useState<any>(null);
  const [pendingUserMessage, setPendingUserMessage] = useState<string | null>(null);
  const [statusLog, setStatusLog] = useState<Array<{ message: string; detail?: string; timestamp: number }>>([]);
  const [nudgeInput, setNudgeInput] = useState("");
  const [nudgeSent, setNudgeSent] = useState(false);
  const [currentConvId, setCurrentConvId] = useState<number | null>(conversationId);
  const [attachedImages, setAttachedImages] = useState<File[]>([]);
  const [pendingImages, setPendingImages] = useState<Array<{name: string, base64: string, mimeType: string}>>([]);
  const [attachedFiles, setAttachedFiles] = useState<Array<{name: string, content: string, mimeType: string}>>([]);
  const [lightboxImage, setLightboxImage] = useState<{ src: string; alt: string } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [showJumpToPresent, setShowJumpToPresent] = useState(false);
  // v16.74.5: per-input reasoning mode (persistent until changed). See chat.tsx.
  const [reasoningModeId, setReasoningModeId] = useState<string>("");
  const { data: allModels = [] } = useQuery<any[]>({
    queryKey: ["/api/models"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/models`);
      return res.json();
    },
  });
  const reasoningModes = useMemo(() => {
    const seen = new Map<string, { id: string; label: string }>();
    for (const m of allModels) {
      if (!m?.isEnabled || !m?.reasoningProfiles) continue;
      let profiles: any[] = [];
      try { profiles = JSON.parse(m.reasoningProfiles); } catch { continue; }
      for (const p of profiles) {
        if (p?.id && p?.label && !seen.has(p.label)) seen.set(p.label, { id: p.id, label: p.label });
      }
    }
    return Array.from(seen.values());
  }, [allModels]);
  const activeReasoningLabel = reasoningModes.find(r => r.id === reasoningModeId)?.label;
  // Confirmation banner + diff preview state (must live in this component — used in SSE handler)
  const [pendingConfirm, setPendingConfirm] = useState<{
    id: string;
    tool: string;
    args?: Record<string, any>;
    reason: string;
    resolve: (approved: boolean) => void;
  } | null>(null);
  const [diffPreviews, setDiffPreviews] = useState<DiffPreview[]>([]);
  const [activeDiff, setActiveDiff] = useState<DiffPreview | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef<string>("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter(item => item.type.startsWith("image/"));
    if (imageItems.length === 0) return; // let normal text paste through
    e.preventDefault();
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (file) {
        const named = new globalThis.File([file], `screenshot-${Date.now()}.png`, { type: file.type });
        setAttachedImages(prev => [...prev, named]);
      }
    }
  };

  const convId = currentConvId;

  const { data: messages = [], refetch } = useQuery<WsMessage[]>({
    queryKey: ["/api/conversations", convId, "messages"],
    queryFn: async () => {
      if (!convId) return [];
      const res = await apiRequest("GET", `/api/conversations/${convId}/messages`);
      return res.json();
    },
    enabled: !!convId,
  });

  // Sync when project changes
  useEffect(() => {
    const newId = project.conversationId ?? null;
    if (newId !== currentConvId) {
      setCurrentConvId(newId);
      setStreamContent("");
      setSteps([]);
      setPlanSteps([]);
      setRoutingInfo(null);
      setPendingUserMessage(null);
      setStatusLog([]);
    }
  }, [project.id]);

  // Notify parent of streaming state changes
  useEffect(() => {
    onStreamingChange?.(streaming);
  }, [streaming, onStreamingChange]);

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

  // Check if there's an active response when we mount (e.g., after page reload)
  useEffect(() => {
    if (!convId) return;

    let cancelled = false;

    (async () => {
      try {
        const res = await apiRequest("GET", `/api/conversations/${convId}/active`);
        const data = await res.json();
        if (cancelled) return;

        if (data.active) {
          // The agent is still responding — connect to the live stream
          setStreaming(true);
          setStatusLog([{ message: "Reconnecting to active response...", timestamp: Date.now() }]);

          const eventSource = new EventSource(`/api/conversations/${convId}/stream`);

          eventSource.onmessage = (event) => {
            try {
              const data = JSON.parse(event.data);
              switch (data.type) {
                case "content":
                  setStreamContent(prev => prev + data.content);
                  break;
                case "step":
                  setSteps(prev => [...prev, data]);
                  break;
                case "status":
                  setStatusLog(prev => {
                    const entry = { message: data.message, detail: data.detail, timestamp: data.timestamp || Date.now() };
                    const next = [...prev, entry];
                    return next.length > 20 ? next.slice(-20) : next;
                  });
                  break;
                case "system_notice":
                  setStatusLog(prev => {
                    const entry = { message: data.content || "Note", timestamp: Date.now() };
                    const next = [...prev, entry];
                    return next.length > 20 ? next.slice(-20) : next;
                  });
                  break;
                case "files_changed":
                  onFilesChanged();
                  break;
                case "confirmation_needed": {
                  const confirmId2 = data.id;
                  setPendingConfirm({
                    id: confirmId2,
                    tool: data.tool,
                    args: data.args,
                    reason: data.reason,
                    resolve: (approved: boolean) => {
                      fetch("/api/chat/confirm", {
                        method: "POST", headers: { "Content-Type": "application/json" },
                        credentials: "include", body: JSON.stringify({ confirmId: confirmId2, approved }),
                      }).catch(() => {});
                      if (!approved) setStreamContent(prev => prev + "\n\n*Operation declined.*");
                    },
                  });
                  break;
                }
                case "error":
                  setStreamContent(prev => prev + `\n\n**Error:** ${data.content}`);
                  break;
                case "done":
                case "stream_end":
                  setStreaming(false);
                  setPendingUserMessage(null);
                  refetch();
                  onFilesChanged();
                  eventSource.close();
                  break;
              }
            } catch {}
          };

          eventSource.onerror = () => {
            setStreaming(false);
            refetch();
            eventSource.close();
          };
        }
      } catch {}
    })();

    return () => { cancelled = true; };
  }, [convId]);

  // Track tool calls → advance plan step status
  useEffect(() => {
    if (steps.length === 0 || planSteps.length === 0) return;
    const lastStep = steps[steps.length - 1];
    if (lastStep?.status === "completed" || lastStep?.status === "running") {
      setPlanSteps(prev => {
        const updated = [...prev];
        let foundRunning = false;
        for (let i = 0; i < updated.length; i++) {
          if (updated[i].status === "pending" && !foundRunning) {
            updated[i] = { ...updated[i], status: "running" };
            foundRunning = true;
            for (let j = 0; j < i; j++) {
              if (updated[j].status === "running") updated[j] = { ...updated[j], status: "completed" };
            }
            break;
          }
        }
        return updated;
      });
    }
  }, [steps.length]);

  const handleSend = useCallback(async (overrideMessage?: string) => {
    const msg = overrideMessage || input.trim();
    if (!msg || streaming) return;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setStreaming(true);
    setStreamContent("");
    setSteps([]);
    setPlanSteps([]);
    setRoutingInfo(null);
    setPendingUserMessage(msg);
    setStatusLog([]);
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
      // Build project-scoped system prompt — MUST reference project tools, not workspace tools
      const systemPrompt =
        `## CRITICAL — PROJECT CONTEXT\n` +
        `You are working inside the project "${project.name}" (projectId: ${project.id}).\n` +
        `The project is located at: ${project.path}\n\n` +
        `## MANDATORY TOOL USAGE\n` +
        `You MUST use these project-specific tools (with projectId: ${project.id}):\n` +
        `- write_project_file(projectId: ${project.id}, filePath: "relative/path", content: "...") — to create or write files\n` +
        `- read_project_file(projectId: ${project.id}, filePath: "relative/path") — to read files\n` +
        `- edit_project_file(projectId: ${project.id}, filePath: "relative/path", oldText: "...", newText: "...") — to edit files\n` +
        `- list_project_files(projectId: ${project.id}) — to list project files\n` +
        `- run_project_command(projectId: ${project.id}, command: "...") — to run shell commands in the project directory\n\n` +
        `## FORBIDDEN — DO NOT USE THESE\n` +
        `- Do NOT use write_file or read_file (those write to the wrong directory)\n` +
        `- Do NOT use deploy_app (that deploys to the App Store, not the project)\n` +
        `- Do NOT use shell_command or execute_code\n` +
        `- File paths in write_project_file/read_project_file should be RELATIVE to the project root (e.g. "index.html", "src/app.js"), NOT absolute paths.\n` +
        (activeFile ? `\nThe user currently has this file open: ${activeFile}` : "");

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          conversationId: convId,
          message: msg,
          systemPrompt,
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
            const event = JSON.parse(line.slice(6));
            switch (event.type) {
              case "request_id":
                requestIdRef.current = event.requestId;
                break;
              case "conversation":
                setCurrentConvId(event.id);
                break;
              case "routing":
                setRoutingInfo(event);
                break;
              case "content":
                content += event.content;
                setStreamContent(content);
                break;
              case "step":
                setSteps(prev => [...prev, event]);
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
              case "status":
                setStatusLog(prev => {
                  const entry = { message: event.message, detail: event.detail, timestamp: event.timestamp || Date.now() };
                  const next = [...prev, entry];
                  return next.length > 20 ? next.slice(-20) : next;
                });
                break;
              case "system_notice":
                setStatusLog(prev => {
                  const entry = { message: event.content || "Note", timestamp: Date.now() };
                  const next = [...prev, entry];
                  return next.length > 20 ? next.slice(-20) : next;
                });
                break;
              case "confirmation_needed": {
                // Use the ConfirmBanner (same pattern as chat.tsx — no window.confirm)
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
                    if (!approved) { content += "\n\n*Operation declined.*"; setStreamContent(content); }
                  },
                });
                break;
              }
              case "diff_preview": {
                if (event.editId && event.filePath) {
                  const newDiff: DiffPreview = {
                    editId: event.editId,
                    filePath: event.filePath,
                    description: event.description,
                    original: event.original || "",
                    proposed: event.proposed || "",
                  };
                  setDiffPreviews(prev => [...prev, newDiff]);
                  setActiveDiff(newDiff);
                }
                break;
              }
              case "error":
                content += `\n\n**Error:** ${event.content}`;
                setStreamContent(content);
                break;
              case "files_changed":
                onFilesChanged();
                break;
              case "done":
                setPlanSteps(prev => prev.map(s => ({ ...s, status: "completed" as const })));
                // Refresh file tree in case agent created files
                onFilesChanged();
                break;
            }
          } catch {}
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
      abortRef.current = null;
      refetch();
    }
  }, [input, streaming, convId, project, activeFile, refetch, onFilesChanged, attachedImages, attachedFiles, reasoningModeId, activeReasoningLabel]);

  const handleStop = () => {
    if (requestIdRef.current) {
      fetch("/api/chat/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ requestId: requestIdRef.current }),
      }).catch(() => {});
    }
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

  // Filter to displayable messages (user + assistant only)
  const displayMessages = messages.filter(m => m.role === "user" || m.role === "assistant");

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

  return (
    <div
      className="flex flex-col h-full relative"
      data-testid="workspace-chat"
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
      {/* Header with routing info */}
      <div className="px-3 py-2 border-b border-border flex items-center gap-2 shrink-0">
        <Bot className="w-4 h-4 text-primary" />
        <span className="text-xs font-medium text-foreground">AI Assistant</span>
        {routingInfo && (
          <Badge variant="outline" className="text-[10px] ml-auto">
            {routingInfo.model?.split("/").pop()}
          </Badge>
        )}
      </div>

      {/* Tool steps bar */}
      {steps.length > 0 && (
        <div className="border-b border-border bg-card/50 px-2 py-1 flex items-center gap-1.5 overflow-x-auto shrink-0">
          {steps.slice(-4).map((step, i) => (
            <Badge
              key={i}
              variant="outline"
              className={`text-[9px] shrink-0 ${
                step.status === "completed" ? "border-green-500/30 text-green-400" :
                step.status === "failed" ? "border-red-500/30 text-red-400" :
                "border-primary/30 text-primary animate-pulse"
              }`}
            >
              <Wrench className="w-2.5 h-2.5 mr-0.5" />
              {step.label}
            </Badge>
          ))}
        </div>
      )}

      {/* Messages area */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 px-3 py-2 overflow-y-auto"
      >
        <div className="space-y-3">
          {displayMessages.map(msg => (
            <WsChatBubble
              key={msg.id}
              message={msg}
              onImageClick={(src, alt) => setLightboxImage({ src, alt })}
            />
          ))}

          {pendingUserMessage && (
            <WsChatBubble
              message={{ id: -2, role: "user", content: pendingUserMessage, createdAt: new Date().toISOString() }}
              pendingImages={pendingImages}
              onImageClick={(src, alt) => setLightboxImage({ src, alt })}
            />
          )}

          {/* Plan progress */}
          {streaming && planSteps.length > 0 && (
            <div className="bg-card/80 border border-border rounded-lg p-2 text-[10px]" data-testid="ws-plan-progress">
              <div className="flex items-center gap-1.5 mb-1.5">
                <ListChecks className="w-3.5 h-3.5 text-primary" />
                <span className="font-medium">Plan</span>
                <span className="text-muted-foreground ml-auto">
                  {planSteps.filter(s => s.status === "completed").length}/{planSteps.length}
                </span>
              </div>
              {planSteps.map((step, i) => {
                const StepIcon = step.status === "completed" ? CheckCircle2 : step.status === "running" ? CircleDot : Circle;
                const color = step.status === "completed" ? "text-green-400" : step.status === "running" ? "text-primary animate-pulse" : "text-muted-foreground/50";
                return (
                  <div key={i} className="flex items-center gap-1.5 py-0.5">
                    <StepIcon className={`w-3 h-3 shrink-0 ${color}`} />
                    <span className={step.status === "completed" ? "text-muted-foreground line-through" : step.status === "running" ? "font-medium" : "text-muted-foreground/70"}>
                      {step.title}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Activity feed */}
          {streaming && statusLog.length > 0 && (
            <div className="bg-card/80 border border-border rounded-lg p-2 text-[10px]" data-testid="ws-activity-feed">
              <div className="flex items-center gap-1.5 mb-1.5">
                <Activity className="w-3.5 h-3.5 text-primary animate-pulse" />
                <span className="font-medium">Working</span>
              </div>
              {statusLog.slice(-5).map((entry, i, arr) => {
                const isLatest = i === arr.length - 1;
                return (
                  <div key={`${entry.timestamp}-${i}`} className={`flex items-center gap-1.5 py-0.5 ${isLatest ? "text-foreground" : "text-muted-foreground/60"}`}>
                    {isLatest ? <Loader2 className="w-2.5 h-2.5 animate-spin text-primary shrink-0" /> : <CheckCircle2 className="w-2.5 h-2.5 text-green-400/60 shrink-0" />}
                    <span className={isLatest ? "font-medium" : ""}>{entry.message}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Streaming assistant message */}
          {streaming && (
            <WsChatBubble
              message={{ id: -1, role: "assistant", content: streamContent || "", createdAt: new Date().toISOString() }}
              isStreaming
              currentStatus={statusLog.length > 0 ? statusLog[statusLog.length - 1] : undefined}
              onImageClick={(src, alt) => setLightboxImage({ src, alt })}
            />
          )}
          <div ref={messagesEndRef} />
        </div>
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

      {/* Image Lightbox */}
      {lightboxImage && (
        <ImageLightbox
          src={lightboxImage.src}
          alt={lightboxImage.alt}
          onClose={() => setLightboxImage(null)}
        />
      )}

      {/* Input area */}
      <div className="p-2 border-t border-border shrink-0">
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
          <div className="flex gap-2 px-1 py-1 mb-1 overflow-x-auto">
            {attachedImages.map((file, i) => (
              <div key={i} className="relative shrink-0">
                <img
                  src={URL.createObjectURL(file)}
                  className="w-14 h-14 rounded-md object-cover border border-border"
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
        {/* Mid-run nudge bar — add context to the running project agent without
            interrupting it or starting a new turn. Project context is preserved
            because the nudge targets this project's conversation/run. */}
        {streaming && (
          <div className="flex gap-2 items-center mb-2 px-2 py-1.5 bg-yellow-500/10 border border-yellow-500/20 rounded-md" data-testid="ws-nudge-bar">
            <span className="text-xs text-yellow-500/80 shrink-0 font-medium">Nudge running agent:</span>
            <input
              type="text"
              value={nudgeInput}
              onChange={(e) => setNudgeInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleNudge(); } }}
              placeholder="Add context mid-task without interrupting…"
              className="flex-1 bg-transparent border-none outline-none text-xs text-yellow-100 placeholder:text-yellow-500/40"
              data-testid="ws-nudge-input"
            />
            {nudgeSent ? (
              <span className="text-xs text-yellow-400 shrink-0">✓ sent</span>
            ) : (
              <button
                onClick={handleNudge}
                disabled={!nudgeInput.trim()}
                className="text-xs text-yellow-400 hover:text-yellow-200 disabled:opacity-30 shrink-0 font-medium transition-colors"
                data-testid="ws-nudge-send"
              >
                Add context
              </button>
            )}
          </div>
        )}
        <div className="flex items-end gap-1">
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
            data-testid="ws-image-file-input"
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={() => imageInputRef.current?.click()}
            disabled={streaming}
            title="Attach images"
            data-testid="ws-chat-image-upload"
          >
            <ImagePlus className="w-4 h-4" />
          </Button>
          {/* v16.74.5: reasoning-mode lightbulb (shares /api/chat with main chat). */}
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
                data-testid="ws-toggle-reasoning-mode"
              >
                <Lightbulb className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel className="text-xs">Reasoning mode</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setReasoningModeId("")} className="text-xs">
                <span className={reasoningModeId === "" ? "font-medium text-yellow-400" : ""}>Off / default</span>
              </DropdownMenuItem>
              {reasoningModes.length === 0 && (
                <DropdownMenuItem disabled className="text-[10px] text-muted-foreground">
                  No modes — add them in Settings → Models
                </DropdownMenuItem>
              )}
              {reasoningModes.map(rm => (
                <DropdownMenuItem key={rm.id} onClick={() => setReasoningModeId(rm.id)} className="text-xs" data-testid={`ws-reasoning-mode-${rm.id}`}>
                  <span className={reasoningModeId === rm.id ? "font-medium text-yellow-400" : ""}>{rm.label}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={e => {
              setInput(e.target.value);
              const el = e.target;
              el.style.height = "auto";
              el.style.height = Math.min(el.scrollHeight, 120) + "px";
            }}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            onPaste={handlePaste}
            placeholder={`Message about ${project.name}...`}
            className="resize-none min-h-[36px] max-h-[120px] text-xs overflow-y-auto flex-1"
            rows={1}
            disabled={streaming}
            data-testid="workspace-chat-input"
          />
          {streaming ? (
            <Button variant="destructive" size="icon" className="h-9 w-9 shrink-0" onClick={handleStop} data-testid="workspace-chat-stop">
              <Square className="w-3.5 h-3.5" />
            </Button>
          ) : (
            <Button size="icon" variant="ghost" className="h-9 w-9 shrink-0" onClick={() => handleSend()} disabled={!input.trim() && attachedImages.length === 0} data-testid="workspace-chat-send">
              <Send className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Workspace chat message bubble ────────────────────────────────────
function WsChatBubble({
  message,
  isStreaming,
  currentStatus,
  pendingImages,
  onImageClick,
}: {
  message: WsMessage;
  isStreaming?: boolean;
  currentStatus?: { message: string; detail?: string };
  pendingImages?: Array<{name: string, base64: string, mimeType: string}>;
  onImageClick?: (src: string, alt: string) => void;
}) {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);

  // Parse stored images from message (DB-stored messages have images as JSON string)
  const storedImages: Array<{name: string, base64: string, mimeType: string}> =
    message.images ? (() => { try { return JSON.parse(message.images!); } catch { return []; } })() : [];
  const displayImages = isUser && message.id === -2 && pendingImages ? pendingImages : storedImages;

  return (
    <div className={`flex gap-2 ${isUser ? "justify-end" : ""}`}>
      {!isUser && (
        <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
          <Bot className="w-3.5 h-3.5 text-primary" />
        </div>
      )}
      <div className={`flex-1 max-w-[90%] ${isUser ? "text-right" : ""}`}>
        <div className={`inline-block text-xs rounded-lg px-2.5 py-1.5 ${
          isUser
            ? "bg-primary text-primary-foreground ml-auto"
            : "bg-card border border-border"
        }`}>
          {isUser ? (
            <>
              {displayImages.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-1">
                  {displayImages.map((img, i) => (
                    <img
                      key={i}
                      src={img.base64}
                      className="max-w-[120px] rounded border border-border/40 cursor-pointer hover:opacity-80 transition-opacity"
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
                  <MessageContentWithImages content={message.content} onImageClick={onImageClick} />
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}
                    components={{
                      pre: ({ children }) => (
                        <div className="relative group my-1">
                          <pre className="bg-muted/50 rounded p-2 text-[11px] overflow-x-auto max-w-full whitespace-pre-wrap break-words">{children}</pre>
                          <Button variant="ghost" size="sm"
                            className="absolute top-0.5 right-0.5 h-5 w-5 p-0 opacity-0 group-hover:opacity-100"
                            onClick={() => {
                              const code = (children as any)?.props?.children;
                              if (code) navigator.clipboard.writeText(String(code));
                            }}>
                            <Copy className="w-2.5 h-2.5" />
                          </Button>
                        </div>
                      ),
                    }}>
                    {message.content.replace(IMAGE_PATH_REGEX, "").trim()}
                  </ReactMarkdown>
                </>
              ) : isStreaming ? (
                <div className="flex items-center gap-1.5 py-0.5">
                  <Loader2 className="w-3 h-3 animate-spin text-primary" />
                  <span className="text-[10px] text-muted-foreground">
                    {currentStatus?.message || "Thinking..."}
                  </span>
                </div>
              ) : null}
              {isStreaming && message.content && <span className="inline-block w-1.5 h-3 bg-primary animate-pulse ml-0.5" />}
            </div>
          )}
        </div>
        {/* Copy button on hover */}
        {!isStreaming && !isUser && message.content && (
          <div className="opacity-0 hover:opacity-100 transition-opacity mt-0.5">
            <Button variant="ghost" size="sm" className="h-4 px-1" onClick={() => {
              navigator.clipboard.writeText(message.content);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}>
              {copied ? <Check className="w-2.5 h-2.5 text-green-400" /> : <Copy className="w-2.5 h-2.5" />}
            </Button>
          </div>
        )}
      </div>
      {isUser && (
        <div className="w-6 h-6 rounded-full bg-accent/10 flex items-center justify-center shrink-0 mt-0.5">
          <User className="w-3.5 h-3.5 text-accent" />
        </div>
      )}
    </div>
  );
}

// ────────────── Project List ──────────────

function ProjectList({
  projects,
  onSelectProject,
  onCreateProject,
  onDeleteProject,
  searchValue,
  onSearchChange,
}: {
  projects: Project[];
  onSelectProject: (id: number) => void;
  onCreateProject: () => void;
  onDeleteProject: (id: number) => void;
  searchValue: string;
  onSearchChange: (v: string) => void;
}) {
  return (
    <div className="flex-1 overflow-auto p-6" data-testid="project-list">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold font-mono">
              <span className="text-primary">CODING</span>{" "}
              <span className="text-foreground">WORKSPACE</span>
            </h1>
            <p className="text-xs text-muted-foreground mt-1">
              Build and run projects with AI assistance
            </p>
          </div>
          <Button onClick={onCreateProject} data-testid="button-new-project">
            <Plus className="w-4 h-4 mr-2" />
            New Project
          </Button>
        </div>

        {/* Search input */}
        <div className="mb-4">
          <Input
            placeholder="Search projects..."
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
            className="max-w-sm bg-zinc-900 border-zinc-800 text-zinc-100 placeholder:text-zinc-500"
            data-testid="project-search"
          />
        </div>

        {projects.length === 0 && !searchValue ? (
          <div className="text-center py-20">
            <Code className="w-12 h-12 text-muted-foreground/20 mx-auto mb-4" />
            <p className="text-muted-foreground text-sm mb-4">No projects yet</p>
            <Button variant="outline" onClick={onCreateProject} data-testid="button-create-first-project">
              <Plus className="w-4 h-4 mr-2" />
              Create your first project
            </Button>
          </div>
        ) : projects.length === 0 && searchValue ? (
          <div className="text-center py-20">
            <p className="text-muted-foreground text-sm">No projects match "{searchValue}"</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map((project) => (
              <Card
                key={project.id}
                className="p-4 cursor-pointer hover:border-primary/50 transition-colors bg-card/50 hover:bg-card group/proj"
                onClick={() => onSelectProject(project.id)}
                data-testid={`project-card-${project.id}`}
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Code className="w-4 h-4 text-primary shrink-0" />
                    <span className="font-medium text-sm truncate">{project.name}</span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {project.language && (
                      <Badge variant="secondary" className="text-[10px]">
                        {project.language}
                      </Badge>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 opacity-0 group-hover/proj:opacity-100 hover:text-destructive transition-opacity"
                      onClick={(e) => { e.stopPropagation(); onDeleteProject(project.id); }}
                      data-testid={`button-delete-project-${project.id}`}
                      title="Delete project"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
                {project.description && (
                  <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
                    {project.description}
                  </p>
                )}
                <p className="text-[10px] text-muted-foreground/50">
                  Updated {formatDate(project.updatedAt)}
                </p>
              </Card>
            ))}

            {/* New project card */}
            <Card
              className="p-4 cursor-pointer border-dashed hover:border-primary/50 transition-colors flex items-center justify-center gap-2 text-muted-foreground hover:text-foreground"
              onClick={onCreateProject}
              data-testid="new-project-card"
            >
              <Plus className="w-5 h-5" />
              <span className="text-sm">New Project</span>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

// ────────────── Main WorkspacePage ──────────────

// ── Workspace Confirmation Banner ────────────────────────────────────────────
function WorkspaceConfirmBanner({
  confirm,
  onRespond,
}: {
  confirm: { id: string; tool: string; args?: Record<string, any>; reason: string; resolve: (approved: boolean) => void } | null;
  onRespond: (approved: boolean) => void;
}) {
  if (!confirm) return null;
  const displayName = confirm.args?.name || confirm.args?.path || confirm.tool;
  return (
    <div className="border-b border-yellow-500/40 bg-yellow-950/40 backdrop-blur-sm px-4 py-2 flex items-center gap-3 z-50">
      <span className="text-yellow-400 text-[11px] font-bold shrink-0">!</span>
      <div className="flex-1 min-w-0">
        <span className="text-xs font-semibold text-yellow-300">
          Agent requests: <span className="font-mono">{confirm.tool}</span>
          {displayName ? <span className="text-yellow-400/80"> → {displayName}</span> : null}
        </span>
        <span className="text-[10px] text-yellow-200/60 ml-2 line-clamp-1">{confirm.reason}</span>
      </div>
      <div className="flex gap-2 shrink-0">
        <button onClick={() => onRespond(false)} className="px-2 py-1 text-[10px] font-medium rounded border border-red-500/40 text-red-400 hover:bg-red-500/10 transition-colors">Deny</button>
        <button onClick={() => onRespond(true)} className="px-2 py-1 text-[10px] font-medium rounded bg-yellow-500/20 border border-yellow-500/40 text-yellow-200 hover:bg-yellow-500/30 transition-colors">Approve</button>
      </div>
    </div>
  );
}

export default function WorkspacePage() {
  const { toast } = useToast();
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [projectToDelete, setProjectToDelete] = useState<number | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [fileContents, setFileContents] = useState<Record<string, string>>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [terminalVisible, setTerminalVisible] = useState(true);


  // Resizable panel pixel sizes (defaults match original v11.4 layout)
  const [fileTreeWidth, setFileTreeWidth] = useState(200);
  const [chatWidth, setChatWidth] = useState(320);
  const [terminalHeight, setTerminalHeight] = useState(200);
  // Refs to snapshot size at drag start
  const dragStartRef = useRef({ fileTreeWidth: 200, chatWidth: 320, terminalHeight: 200 });
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false);
  const [showNewFileDialog, setShowNewFileDialog] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");
  const [newFileParent, setNewFileParent] = useState("");
  const [newFileIsFolder, setNewFileIsFolder] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDesc, setNewProjectDesc] = useState("");
  const [newProjectLang, setNewProjectLang] = useState("");

  // Auto-save debounce ref
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Projects list query
  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
    refetchInterval: 30000,
  });

  // Active project query
  const { data: activeProject } = useQuery<Project>({
    queryKey: [`/api/projects/${activeProjectId}`],
    enabled: activeProjectId !== null,
  });

  // File tree query
  const { data: fileTree, refetch: refetchTree } = useQuery<FileNode[]>({
    queryKey: [`/api/projects/${activeProjectId}/files`],
    enabled: activeProjectId !== null,
    refetchInterval: isStreaming ? 3000 : false,
  });

  // Create project mutation
  const createProjectMutation = useMutation({
    mutationFn: (data: { name: string; description?: string; language?: string }) =>
      apiRequest("POST", "/api/projects", data).then((r) => r.json()),
    onSuccess: (project: Project) => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      setShowNewProjectDialog(false);
      setNewProjectName("");
      setNewProjectDesc("");
      setNewProjectLang("");
      setActiveProjectId(project.id);
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Failed to create project", description: err.message });
    },
  });

  // Delete project mutation
  const deleteProjectMutation = useMutation({
    mutationFn: (id: number) =>
      apiRequest("DELETE", `/api/projects/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      if (activeProjectId !== null) {
        setActiveProjectId(null);
      }
      toast({ title: "Project deleted" });
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Failed to delete project", description: err.message });
    },
  });

  // Filtered projects for search
  const filteredProjects = (projects as Project[]).filter(p =>
    p.name.toLowerCase().includes(projectSearch.toLowerCase())
  );

  // Write file mutation
  const writeFileMutation = useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      apiRequest("PUT", `/api/projects/${activeProjectId}/file`, { path, content }),
    onSuccess: (_, vars) => {
      // Mark as saved (remove modified flag)
      setOpenTabs((prev) =>
        prev.map((t) => (t.path === vars.path ? { ...t, modified: false } : t))
      );
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Failed to save file", description: err.message });
    },
  });

  // Create file mutation
  const createFileMutation = useMutation({
    mutationFn: ({ path }: { path: string }) =>
      apiRequest("POST", `/api/projects/${activeProjectId}/file`, { path, content: "" }),
    onSuccess: () => {
      refetchTree();
      setShowNewFileDialog(false);
      setNewFilePath("");
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Failed to create file", description: err.message });
    },
  });

  // Create folder mutation
  const createFolderMutation = useMutation({
    mutationFn: ({ path }: { path: string }) =>
      apiRequest("POST", `/api/projects/${activeProjectId}/folder`, { path }),
    onSuccess: () => {
      refetchTree();
      setShowNewFileDialog(false);
      setNewFilePath("");
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Failed to create folder", description: err.message });
    },
  });

  // Delete file mutation
  const deleteFileMutation = useMutation({
    mutationFn: ({ path }: { path: string }) =>
      apiRequest("DELETE", `/api/projects/${activeProjectId}/file?path=${encodeURIComponent(path)}`),
    onSuccess: (_, vars) => {
      refetchTree();
      // Close tab if open
      setOpenTabs((prev) => prev.filter((t) => t.path !== vars.path));
      if (activeFile === vars.path) {
        setActiveFile(null);
      }
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Failed to delete file", description: err.message });
    },
  });

  // Load file content
  const loadFile = useCallback(
    async (path: string) => {
      if (fileContents[path] !== undefined) {
        setActiveFile(path);
        // Open tab if not already open
        setOpenTabs((prev) =>
          prev.find((t) => t.path === path)
            ? prev
            : [...prev, { path, modified: false }]
        );
        return;
      }
      try {
        const res = await apiRequest(
          "GET",
          `/api/projects/${activeProjectId}/file?path=${encodeURIComponent(path)}`
        );
        const data = await res.json();
        setFileContents((prev) => ({ ...prev, [path]: data.content ?? "" }));
        setActiveFile(path);
        setOpenTabs((prev) =>
          prev.find((t) => t.path === path)
            ? prev
            : [...prev, { path, modified: false }]
        );
      } catch {}
    },
    [activeProjectId, fileContents]
  );

  // Handle file content changes (with debounced auto-save)
  const handleFileChange = useCallback(
    (path: string, content: string) => {
      setFileContents((prev) => ({ ...prev, [path]: content }));
      setOpenTabs((prev) =>
        prev.map((t) => (t.path === path ? { ...t, modified: true } : t))
      );

      // Debounced auto-save
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        writeFileMutation.mutate({ path, content });
      }, 1000);
    },
    [writeFileMutation]
  );

  const handleSave = useCallback(() => {
    if (!activeFile) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    writeFileMutation.mutate({ path: activeFile, content: fileContents[activeFile] ?? "" });
  }, [activeFile, fileContents, writeFileMutation]);

  const toggleExpand = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleNewFile = (parentPath: string) => {
    setNewFileParent(parentPath);
    setNewFileIsFolder(false);
    setNewFilePath("");
    setShowNewFileDialog(true);
  };

  const handleNewFolder = (parentPath: string) => {
    setNewFileParent(parentPath);
    setNewFileIsFolder(true);
    setNewFilePath("");
    setShowNewFileDialog(true);
  };

  const handleDeleteFile = (path: string) => {
    deleteFileMutation.mutate({ path });
  };

  const handleRenameFile = async (filePath: string) => {
    const currentName = filePath.split("/").pop() ?? "";
    const newName = window.prompt("Rename to:", currentName);
    if (!newName || newName === currentName) return;
    const parentPath = filePath.split("/").slice(0, -1).join("/");
    const newPath = parentPath ? `${parentPath}/${newName}` : newName;
    try {
      await apiRequest("POST", `/api/projects/${activeProjectId}/rename`, {
        oldPath: filePath,
        newPath,
      });
      refetchTree();
      // Update tabs and active file references
      setOpenTabs((prev) =>
        prev.map((t) => t.path === filePath ? { ...t, path: newPath } : t)
      );
      if (activeFile === filePath) setActiveFile(newPath);
      if (fileContents[filePath] !== undefined) {
        setFileContents((prev) => {
          const next = { ...prev };
          next[newPath] = next[filePath];
          delete next[filePath];
          return next;
        });
      }
    } catch (err: any) {
      toast({ variant: "destructive", title: "Rename failed", description: err.message });
    }
  };

  const handleConfirmNewFile = () => {
    if (!newFilePath.trim()) return;
    const fullPath = newFileParent
      ? `${newFileParent}/${newFilePath.trim()}`
      : newFilePath.trim();
    if (newFileIsFolder) {
      createFolderMutation.mutate({ path: fullPath });
    } else {
      createFileMutation.mutate({ path: fullPath });
    }
  };

  const closeTab = (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenTabs((prev) => prev.filter((t) => t.path !== path));
    if (activeFile === path) {
      const remaining = openTabs.filter((t) => t.path !== path);
      setActiveFile(remaining.length > 0 ? remaining[remaining.length - 1].path : null);
    }
  };

  const handleDownload = () => {
    window.open(`/api/projects/${activeProjectId}/download`, "_blank");
  };

  const handleUploadFiles = async (fileList: FileList, relativePaths?: string[]) => {
    if (!activeProjectId || fileList.length === 0) return;
    const formData = new FormData();
    for (let i = 0; i < fileList.length; i++) {
      formData.append("files", fileList[i]);
    }
    // Upload to the currently expanded folder, or project root
    const expandedDirs = Array.from(expandedPaths);
    const targetDir = expandedDirs.length > 0 ? expandedDirs[expandedDirs.length - 1] : "";
    if (targetDir) formData.append("directory", targetDir);
    // Send relative paths for folder uploads (preserves subdirectory structure)
    if (relativePaths && relativePaths.length > 0) {
      formData.append("relativePaths", JSON.stringify(relativePaths));
    }

    try {
      const res = await fetch(`/api/projects/${activeProjectId}/upload`, {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      const data = await res.json();
      if (data.success) {
        toast({ title: `Uploaded ${data.uploaded.length} file(s)` });
        queryClient.invalidateQueries({ queryKey: [`/api/projects/${activeProjectId}/files`] });
      } else {
        toast({ variant: "destructive", title: "Upload failed", description: data.error });
      }
    } catch (err: any) {
      toast({ variant: "destructive", title: "Upload failed", description: err.message });
    }
    // Reset file input
    if (uploadInputRef.current) uploadInputRef.current.value = "";
  };

  const handleFolderUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const files = e.target.files;
    // Collect relative paths from webkitRelativePath (available when webkitdirectory is set)
    const relativePaths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      relativePaths.push((files[i] as any).webkitRelativePath || files[i].name);
    }
    await handleUploadFiles(files, relativePaths);
    if (folderInputRef.current) folderInputRef.current.value = "";
    toast({ title: `Uploaded ${files.length} file(s) from folder` });
  };

  const importToAppMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", `/api/projects/${activeProjectId}/import-to-app`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/apps"] });
      toast({ title: "Imported to App Store", description: "Project has been added to your App Store." });
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Import failed", description: err.message });
    },
  });

  if (!activeProjectId) {
    return (
      <div className="flex flex-col h-full">
        <ProjectList
          projects={filteredProjects}
          onSelectProject={setActiveProjectId}
          onCreateProject={() => setShowNewProjectDialog(true)}
          onDeleteProject={setProjectToDelete}
          searchValue={projectSearch}
          onSearchChange={setProjectSearch}
        />

        {/* Delete project confirmation dialog */}
        <Dialog open={projectToDelete !== null} onOpenChange={(open) => !open && setProjectToDelete(null)}>
          <DialogContent data-testid="delete-project-dialog">
            <DialogHeader>
              <DialogTitle>Delete Project</DialogTitle>
              <DialogDescription>
                Are you sure you want to delete "{(projects as Project[]).find(p => p.id === projectToDelete)?.name}"?
                This will remove the project from the workspace but won't delete any files on disk.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setProjectToDelete(null)} data-testid="delete-project-cancel">
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={deleteProjectMutation.isPending}
                onClick={() => {
                  if (projectToDelete !== null) deleteProjectMutation.mutate(projectToDelete);
                  setProjectToDelete(null);
                }}
                data-testid="delete-project-confirm"
              >
                {deleteProjectMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* New project dialog */}
        <Dialog open={showNewProjectDialog} onOpenChange={setShowNewProjectDialog}>
          <DialogContent data-testid="new-project-dialog">
            <DialogHeader>
              <DialogTitle>New Project</DialogTitle>
              <DialogDescription>
                Create a new coding project with AI assistance.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  Project Name *
                </label>
                <Input
                  autoFocus
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="my-awesome-project"
                  onKeyDown={(e) => { if (e.key === "Enter") createProjectMutation.mutate({ name: newProjectName, description: newProjectDesc || undefined, language: newProjectLang || undefined }); }}
                  data-testid="new-project-name"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  Description (optional)
                </label>
                <Input
                  value={newProjectDesc}
                  onChange={(e) => setNewProjectDesc(e.target.value)}
                  placeholder="A short description"
                  data-testid="new-project-desc"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  Language (optional)
                </label>
                <Input
                  value={newProjectLang}
                  onChange={(e) => setNewProjectLang(e.target.value)}
                  placeholder="TypeScript, Python, Go..."
                  data-testid="new-project-lang"
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowNewProjectDialog(false)}
                data-testid="new-project-cancel"
              >
                Cancel
              </Button>
              <Button
                disabled={!newProjectName.trim() || createProjectMutation.isPending}
                onClick={() =>
                  createProjectMutation.mutate({
                    name: newProjectName,
                    description: newProjectDesc || undefined,
                    language: newProjectLang || undefined,
                  })
                }
                data-testid="new-project-confirm"
              >
                {createProjectMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                ) : (
                  <Plus className="w-4 h-4 mr-2" />
                )}
                Create Project
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // ── Full workspace layout with resizable panels ──
  return (
    <div className="flex flex-col h-full overflow-hidden" data-testid="workspace-layout">
      {/* Project Header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-card/50 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => setActiveProjectId(null)}
          data-testid="button-back-to-projects"
        >
          <ArrowLeft className="w-4 h-4" />
        </Button>

        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Code className="w-4 h-4 text-primary shrink-0" />
          <span className="font-mono font-bold text-sm text-foreground truncate">
            {activeProject?.name ?? "Loading..."}
          </span>
          {activeProject?.language && (
            <Badge variant="secondary" className="text-[10px] shrink-0">
              {activeProject.language}
            </Badge>
          )}
          {activeFile && (
            <span className="text-[10px] text-muted-foreground/60 truncate">
              / {activeFile}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={handleDownload}
            data-testid="button-download-project"
          >
            <Download className="w-3.5 h-3.5" />
            Download
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => importToAppMutation.mutate()}
            disabled={importToAppMutation.isPending}
            data-testid="button-import-to-app"
          >
            <Package className="w-3.5 h-3.5" />
            Import to App
          </Button>
        </div>
      </div>

      {/* Main 3-panel layout: [File Tree] | [Editor + Terminal] | [Chat] — pixel-based resizable */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: File Tree */}
        <div
          className="shrink-0 flex flex-col border-r border-border bg-card/30 overflow-hidden"
          style={{ width: fileTreeWidth }}
        >
          <div className="flex items-center justify-between px-2 py-1.5 border-b border-border/50">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">
              Explorer
            </span>
            <div className="flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0"
                onClick={() => handleNewFile("")}
                data-testid="button-new-file-root"
                title="New file"
              >
                <Plus className="w-3 h-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0"
                onClick={() => handleNewFolder("")}
                data-testid="button-new-folder-root"
                title="New folder"
              >
                <FolderOpen className="w-3 h-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0"
                onClick={() => uploadInputRef.current?.click()}
                data-testid="button-upload-file"
                title="Upload files"
              >
                <Upload className="w-3 h-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0"
                onClick={() => folderInputRef.current?.click()}
                data-testid="button-upload-folder"
                title="Upload folder"
              >
                <FolderUp className="w-3 h-3" />
              </Button>
            </div>
          </div>

          <ScrollArea className="flex-1">
            <div className="py-1" data-testid="file-tree">
              {!fileTree || fileTree.length === 0 ? (
                <div className="px-3 py-4 text-[10px] text-muted-foreground/50 text-center">
                  No files yet
                </div>
              ) : (
                fileTree.map((node) => (
                  <FileTreeNode
                    key={node.path}
                    node={node}
                    expandedPaths={expandedPaths}
                    toggleExpand={toggleExpand}
                    onSelectFile={loadFile}
                    activeFile={activeFile}
                    onNewFile={handleNewFile}
                    onNewFolder={handleNewFolder}
                    onDeleteFile={handleDeleteFile}
                    onRenameFile={handleRenameFile}
                    depth={0}
                  />
                ))
              )}
            </div>
          </ScrollArea>

          {/* Git Panel */}
          {activeProjectId !== null && <GitPanel projectId={activeProjectId} />}
        </div>

        {/* Drag handle: file tree ↔ editor */}
        <DragHandle
          direction="horizontal"
          onDragStart={() => { dragStartRef.current.fileTreeWidth = fileTreeWidth; }}
          onDrag={(delta) => setFileTreeWidth(Math.max(120, Math.min(500, dragStartRef.current.fileTreeWidth + delta)))}
        />

        {/* Center: Editor + Terminal */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
              {/* Tab bar */}
              {openTabs.length > 0 && (
                <div
                  className="flex items-center border-b border-border bg-card/50 overflow-x-auto shrink-0"
                  data-testid="tab-bar"
                >
                  {openTabs.map((tab) => {
                    const fileName = tab.path.split("/").pop() ?? tab.path;
                    const isActiveTab = activeFile === tab.path;
                    return (
                      <div
                        key={tab.path}
                        className={`group flex items-center gap-1.5 px-3 py-1.5 border-r border-border text-xs cursor-pointer shrink-0 ${
                          isActiveTab
                            ? "bg-background text-foreground border-b-2 border-b-primary"
                            : "text-muted-foreground hover:text-foreground hover:bg-accent/5"
                        }`}
                        onClick={() => setActiveFile(tab.path)}
                        data-testid={`tab-${tab.path}`}
                      >
                        {getFileIcon(fileName)}
                        <span className="max-w-[120px] truncate">{fileName}</span>
                        {tab.modified && (
                          <span
                            className="w-1.5 h-1.5 rounded-full bg-primary shrink-0"
                            title="Unsaved changes"
                            data-testid={`tab-modified-${tab.path}`}
                          />
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-4 w-4 p-0 opacity-0 group-hover:opacity-100 hover:bg-destructive/20"
                          onClick={(e) => closeTab(tab.path, e)}
                          data-testid={`tab-close-${tab.path}`}
                        >
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
                    );
                  })}
                  {/* Save button — always visible in tab bar */}
                  <div className="ml-auto flex items-center gap-1 px-2 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className={`h-6 px-2 text-xs gap-1 ${
                        openTabs.find(t => t.path === activeFile)?.modified
                          ? "text-primary hover:text-primary hover:bg-primary/10"
                          : "text-muted-foreground/50"
                      }`}
                      onClick={handleSave}
                      disabled={!activeFile || !openTabs.find(t => t.path === activeFile)?.modified}
                      title="Save (Ctrl+S)"
                      data-testid="button-save-file"
                    >
                      <Save className="w-3.5 h-3.5" />
                      Save
                    </Button>
                  </div>
                </div>
              )}

              {/* Editor content */}
              <div className="flex-1 overflow-hidden relative h-full">
                {activeFile && fileContents[activeFile] !== undefined ? (
                  <div className="absolute inset-0 overflow-auto bg-background">
                    <CodeEditor
                      content={fileContents[activeFile]}
                      onChange={(v) => handleFileChange(activeFile, v)}
                      onSave={handleSave}
                      fileName={activeFile}
                    />
                  </div>
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="text-center">
                      <FileCode className="w-12 h-12 text-muted-foreground/20 mx-auto mb-3" />
                      <p className="text-sm text-muted-foreground/50">
                        Select a file to edit
                      </p>
                    </div>
                  </div>
                )}
              </div>
          {/* Drag handle: editor ↔ terminal (only when terminal is visible) */}
          {terminalVisible && (
            <DragHandle
              direction="vertical"
              onDragStart={() => { dragStartRef.current.terminalHeight = terminalHeight; }}
              onDrag={(delta) => setTerminalHeight(Math.max(80, Math.min(600, dragStartRef.current.terminalHeight - delta)))}
            />
          )}

          {/* Terminal */}
          <div
            className="shrink-0"
            style={{ height: terminalVisible ? terminalHeight : 32 }}
            data-testid="terminal-panel"
          >
            <div className="flex items-center gap-2 px-3 h-8 border-b border-border/50 bg-card/30">
              <Terminal className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs text-muted-foreground font-mono">Terminal</span>
              <div className="ml-auto">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 p-0"
                  onClick={() => setTerminalVisible((v) => !v)}
                  data-testid="button-toggle-terminal"
                >
                  {terminalVisible ? (
                    <ChevronDown className="w-3 h-3" />
                  ) : (
                    <ChevronRight className="w-3 h-3" />
                  )}
                </Button>
              </div>
            </div>
            {terminalVisible && (
              <div className="h-[calc(100%-2rem)]">
                <TerminalPanel projectId={activeProjectId} projectPath={activeProject?.path} />
              </div>
            )}
          </div>
        </div>


        {/* Drag handle: editor ↔ chat */}
        <DragHandle
          direction="horizontal"
          onDragStart={() => { dragStartRef.current.chatWidth = chatWidth; }}
          onDrag={(delta) => setChatWidth(Math.max(200, Math.min(600, dragStartRef.current.chatWidth - delta)))}
        />

        {/* Right: Workspace Chat */}
        <div
          className="shrink-0 flex flex-col border-l border-border overflow-hidden"
          style={{ width: chatWidth }}
          data-testid="workspace-chat-panel"
        >
          {activeProject ? (
            <WorkspaceChat
              project={activeProject}
              activeFile={activeFile}
              onFilesChanged={() => {
                queryClient.invalidateQueries({ queryKey: [`/api/projects/${activeProjectId}/files`] });
              }}
              onStreamingChange={setIsStreaming}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
              Loading project...
            </div>
          )}
        </div>
      </div>



      {/* Hidden file upload input */}
      <input
        ref={uploadInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            handleUploadFiles(e.target.files);
          }
        }}
        data-testid="upload-file-input"
      />

      {/* Hidden folder upload input */}
      <input
        ref={folderInputRef}
        type="file"
        // @ts-ignore — webkitdirectory is a valid browser attribute
        webkitdirectory=""
        multiple
        className="hidden"
        onChange={handleFolderUpload}
        data-testid="upload-folder-input"
      />

      {/* New file/folder dialog */}
      <Dialog open={showNewFileDialog} onOpenChange={setShowNewFileDialog}>
        <DialogContent data-testid="new-file-dialog">
          <DialogHeader>
            <DialogTitle>
              {newFileIsFolder ? "New Folder" : "New File"}
            </DialogTitle>
            <DialogDescription>
              {newFileParent
                ? `Create inside ${newFileParent}`
                : "Create at project root"}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={newFilePath}
            onChange={(e) => setNewFilePath(e.target.value)}
            placeholder={newFileIsFolder ? "folder-name" : "filename.ts"}
            onKeyDown={(e) => { if (e.key === "Enter") handleConfirmNewFile(); }}
            data-testid="new-file-input"
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowNewFileDialog(false)}
              data-testid="new-file-cancel"
            >
              Cancel
            </Button>
            <Button
              disabled={!newFilePath.trim()}
              onClick={handleConfirmNewFile}
              data-testid="new-file-confirm"
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
