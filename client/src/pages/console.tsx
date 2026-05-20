import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { getAgentName } from "@/lib/useAgentName";
import {
  Terminal, Trash2, ArrowDown, Pause, Play, Search, X,
  Microscope, ChevronDown, ChevronRight, Zap,
} from "lucide-react";

// ─── Console types ────────────────────────────────────────────────────────────

interface LogEntry {
  id: number;
  timestamp: string;
  level: "log" | "warn" | "error" | "info" | "debug";
  message: string;
  source?: string;
}

const LEVEL_STYLES: Record<string, { badge: string; text: string }> = {
  log:   { badge: "bg-muted text-muted-foreground",    text: "text-foreground" },
  info:  { badge: "bg-blue-500/20 text-blue-400",      text: "text-blue-300" },
  warn:  { badge: "bg-yellow-500/20 text-yellow-400",  text: "text-yellow-300" },
  error: { badge: "bg-red-500/20 text-red-400",        text: "text-red-300" },
  debug: { badge: "bg-purple-500/20 text-purple-400",  text: "text-purple-300" },
};

const SOURCE_COLORS: Record<string, string> = {
  "Orchestrator": "text-cyan-400",
  "Agent2077":    "text-primary",
  "Docker":       "text-blue-400",
  "Chat":         "text-green-400",
  "Tools":        "text-yellow-400",
  "Auth":         "text-orange-400",
  "DB":           "text-purple-400",
  "Init":         "text-muted-foreground",
};

function getSourceColor(source: string): string {
  const agentName = getAgentName();
  if (source === agentName || source === "Agent2077") return "text-primary";
  return SOURCE_COLORS[source] || "text-muted-foreground";
}

// ─── Inspector types ──────────────────────────────────────────────────────────

interface InspectorEntry {
  id: number;
  timestamp: string;
  requestId?: string;
  model: string;
  endpoint: string;
  temperature: number;
  topP?: number;
  stream: boolean;
  tools?: any[];
  messages: any[];
}

// ─── Inspector: single request card ──────────────────────────────────────────

function InspectorCard({ entry }: { entry: InspectorEntry }) {
  const [open, setOpen] = useState(false);
  const [sysOpen, setSysOpen] = useState(false);
  const [msgsOpen, setMsgsOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);

  const systemMsg = entry.messages.find(m => m.role === "system");
  const chatMsgs = entry.messages.filter(m => m.role !== "system");

  const formatTime = (ts: string) => {
    try {
      return new Date(ts).toLocaleTimeString("en-US", {
        hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
    } catch { return ""; }
  };

  const roleColor = (role: string) => {
    switch (role) {
      case "user":      return "text-green-400";
      case "assistant": return "text-cyan-400";
      case "tool":      return "text-yellow-400";
      case "system":    return "text-purple-400";
      default:          return "text-muted-foreground";
    }
  };

  const renderContent = (content: any): string => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map(c => {
        if (c.type === "text") return c.text;
        if (c.type === "tool_use") return `[tool_use: ${c.name}]`;
        if (c.type === "tool_result") return `[tool_result: ${JSON.stringify(c.content).slice(0, 120)}]`;
        return JSON.stringify(c).slice(0, 120);
      }).join("\n");
    }
    return JSON.stringify(content).slice(0, 200);
  };

  return (
    <div className="border border-border/50 rounded mb-2 overflow-hidden text-[11px] font-mono">
      {/* Card header — click to expand */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted/40 transition-colors text-left"
      >
        <span className="text-muted-foreground">{formatTime(entry.timestamp)}</span>
        <span className="text-primary font-bold">#{entry.id}</span>
        <span className="text-cyan-400 truncate max-w-[200px]">{entry.model}</span>
        <span className="text-muted-foreground text-[10px] truncate max-w-[160px]">{entry.endpoint}</span>
        <span className="ml-auto flex items-center gap-2 shrink-0">
          <span className="text-yellow-400">T={entry.temperature}</span>
          {entry.topP != null && <span className="text-orange-400">P={entry.topP}</span>}
          <Badge variant="outline" className="text-[9px] py-0 px-1 text-muted-foreground">
            {entry.messages.length} msg{entry.messages.length !== 1 ? "s" : ""}
          </Badge>
          {entry.tools && entry.tools.length > 0 && (
            <Badge variant="outline" className="text-[9px] py-0 px-1 text-yellow-400 border-yellow-400/30">
              {entry.tools.length} tool{entry.tools.length !== 1 ? "s" : ""}
            </Badge>
          )}
          {open ? <ChevronDown className="w-3 h-3 text-muted-foreground" /> : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
        </span>
      </button>

      {/* Expanded detail */}
      {open && (
        <div className="border-t border-border/40 bg-muted/10">

          {/* System prompt section */}
          {systemMsg && (
            <div className="border-b border-border/30">
              <button
                onClick={() => setSysOpen(o => !o)}
                className="w-full flex items-center gap-2 px-3 py-1 hover:bg-muted/30 text-left"
              >
                <span className="text-purple-400 font-bold text-[10px]">SYSTEM PROMPT</span>
                <span className="text-muted-foreground text-[10px] ml-auto">
                  {String(renderContent(systemMsg.content)).length} chars
                </span>
                {sysOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              </button>
              {sysOpen && (
                <pre className="px-3 py-2 text-[10px] text-purple-200 whitespace-pre-wrap break-all max-h-60 overflow-auto bg-purple-950/20">
                  {renderContent(systemMsg.content)}
                </pre>
              )}
            </div>
          )}

          {/* Messages section */}
          {chatMsgs.length > 0 && (
            <div className="border-b border-border/30">
              <button
                onClick={() => setMsgsOpen(o => !o)}
                className="w-full flex items-center gap-2 px-3 py-1 hover:bg-muted/30 text-left"
              >
                <span className="text-cyan-400 font-bold text-[10px]">MESSAGES</span>
                <span className="text-muted-foreground text-[10px]">({chatMsgs.length})</span>
                {msgsOpen ? <ChevronDown className="w-3 h-3 ml-auto" /> : <ChevronRight className="w-3 h-3 ml-auto" />}
              </button>
              {msgsOpen && (
                <div className="px-3 py-2 space-y-2 max-h-72 overflow-auto">
                  {chatMsgs.map((msg, i) => (
                    <div key={i} className="border border-border/30 rounded p-2 bg-background/40">
                      <div className={`text-[10px] font-bold mb-1 ${roleColor(msg.role)}`}>
                        {msg.role.toUpperCase()}
                        {msg.name && <span className="text-muted-foreground ml-1">({msg.name})</span>}
                      </div>
                      <pre className="text-[10px] text-foreground/80 whitespace-pre-wrap break-all">
                        {renderContent(msg.content)}
                      </pre>
                      {msg.tool_calls && msg.tool_calls.length > 0 && (
                        <div className="mt-1 space-y-1">
                          {msg.tool_calls.map((tc: any, ti: number) => (
                            <div key={ti} className="text-[10px] text-yellow-400 border border-yellow-400/20 rounded px-2 py-1">
                              <span className="font-bold">tool_call:</span> {tc.function?.name}
                              <pre className="text-[9px] text-yellow-200/70 whitespace-pre-wrap mt-0.5">
                                {tc.function?.arguments?.slice(0, 300)}
                              </pre>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Tools section */}
          {entry.tools && entry.tools.length > 0 && (
            <div>
              <button
                onClick={() => setToolsOpen(o => !o)}
                className="w-full flex items-center gap-2 px-3 py-1 hover:bg-muted/30 text-left"
              >
                <span className="text-yellow-400 font-bold text-[10px]">TOOLS AVAILABLE</span>
                <span className="text-muted-foreground text-[10px]">({entry.tools.length})</span>
                {toolsOpen ? <ChevronDown className="w-3 h-3 ml-auto" /> : <ChevronRight className="w-3 h-3 ml-auto" />}
              </button>
              {toolsOpen && (
                <div className="px-3 py-2 max-h-48 overflow-auto space-y-1">
                  {entry.tools.map((tool: any, i: number) => (
                    <div key={i} className="flex items-start gap-2 text-[10px]">
                      <span className="text-yellow-300 font-bold shrink-0">
                        {tool.function?.name ?? tool.name ?? "?"}
                      </span>
                      <span className="text-muted-foreground truncate">
                        {tool.function?.description ?? tool.description ?? ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Inspector panel ──────────────────────────────────────────────────────────

function InspectorPanel() {
  const [entries, setEntries] = useState<InspectorEntry[]>([]);
  const [open, setOpen] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // SSE stream
  useEffect(() => {
    const es = new EventSource("/api/inspector/stream", { withCredentials: true });
    es.onmessage = (event) => {
      try {
        const entry: InspectorEntry = JSON.parse(event.data);
        setEntries(prev => {
          // Deduplicate by id
          if (prev.some(e => e.id === entry.id)) return prev;
          const next = [...prev, entry];
          if (next.length > 100) next.splice(0, next.length - 100);
          return next;
        });
      } catch { /* ignore */ }
    };
    return () => es.close();
  }, []);

  // Auto-scroll inspector list
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  return (
    <div className="border-t border-border flex flex-col" style={{ minHeight: "180px", maxHeight: "480px" }}>
      {/* Inspector header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-muted/20 shrink-0">
        <Microscope className="w-3.5 h-3.5 text-cyan-400" />
        <span className="text-[11px] font-mono font-bold text-cyan-400">LLM INSPECTOR</span>
        <Badge variant="outline" className="text-[9px] py-0 px-1 text-muted-foreground">
          {entries.length} request{entries.length !== 1 ? "s" : ""}
        </Badge>
        {entries.length > 0 && (
          <span className="flex items-center gap-1 text-[10px] text-green-400">
            <Zap className="w-2.5 h-2.5" />
            live
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px]"
            onClick={() => setAutoScroll(a => !a)}
            title="Toggle auto-scroll"
          >
            <ArrowDown className={`w-3 h-3 ${autoScroll ? "text-primary" : "text-muted-foreground"}`} />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px]"
            onClick={() => setEntries([])}
            title="Clear inspector"
          >
            <Trash2 className="w-3 h-3 text-muted-foreground" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2"
            onClick={() => setOpen(o => !o)}
            title={open ? "Collapse inspector" : "Expand inspector"}
          >
            {open
              ? <ChevronDown className="w-3 h-3 text-muted-foreground" />
              : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
          </Button>
        </div>
      </div>

      {/* Inspector body */}
      {open && (
        <div
          ref={scrollRef}
          className="flex-1 overflow-auto p-3 min-h-0"
          style={{ minHeight: "120px" }}
        >
          {entries.length === 0 ? (
            <div className="flex items-center justify-center h-20 text-muted-foreground text-[11px] font-mono">
              Waiting for LLM requests...
            </div>
          ) : (
            <div>
              {entries.map(entry => (
                <InspectorCard key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Console page ────────────────────────────────────────────────────────

export default function ConsolePage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState<Set<string>>(new Set(["log", "info", "warn", "error", "debug"]));
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);
  const logsRef = useRef<LogEntry[]>([]);
  const queueRef = useRef<LogEntry[]>([]);

  // Keep refs in sync
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { logsRef.current = logs; }, [logs]);

  // Connect to SSE stream
  useEffect(() => {
    const evtSource = new EventSource("/api/console/stream", { withCredentials: true });

    evtSource.onmessage = (event) => {
      try {
        const entry: LogEntry = JSON.parse(event.data);
        if (pausedRef.current) {
          queueRef.current.push(entry);
        } else {
          setLogs(prev => {
            if (prev.length > 0 && prev[prev.length - 1].id >= entry.id) return prev;
            const next = [...prev, entry];
            if (next.length > 2000) next.splice(0, next.length - 2000);
            return next;
          });
        }
      } catch { /* ignore */ }
    };

    evtSource.onerror = () => {
      // Reconnect is automatic with EventSource
    };

    return () => evtSource.close();
  }, []);

  // Resume: flush queued logs
  useEffect(() => {
    if (!paused && queueRef.current.length > 0) {
      setLogs(prev => {
        const merged = [...prev, ...queueRef.current];
        queueRef.current = [];
        if (merged.length > 2000) merged.splice(0, merged.length - 2000);
        return merged;
      });
    }
  }, [paused]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleClear = () => {
    setLogs([]);
    queueRef.current = [];
  };

  const toggleLevel = (level: string) => {
    setLevelFilter(prev => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  const filteredLogs = logs.filter(entry => {
    if (!levelFilter.has(entry.level)) return false;
    if (filter) {
      const q = filter.toLowerCase();
      return entry.message.toLowerCase().includes(q) ||
        (entry.source?.toLowerCase().includes(q) ?? false);
    }
    return true;
  });

  const formatTime = (ts: string) => {
    try {
      return new Date(ts).toLocaleTimeString("en-US", {
        hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
    } catch { return ""; }
  };

  return (
    <div className="h-full flex flex-col bg-background" data-testid="console-page">
      {/* ── Console header ── */}
      <div className="border-b border-border px-4 py-3 flex items-center gap-3 shrink-0">
        <Terminal className="w-4 h-4 text-primary" />
        <div className="flex-1">
          <h1 className="text-sm font-mono font-bold text-primary">CONSOLE</h1>
          <p className="text-[10px] text-muted-foreground">
            Backend logs — {logs.length} entries
            {paused && <span className="text-yellow-400 ml-1">(paused, {queueRef.current.length} queued)</span>}
          </p>
        </div>

        {/* Level filters */}
        <div className="flex items-center gap-1">
          {["log", "info", "warn", "error"].map(level => (
            <Badge
              key={level}
              variant="outline"
              className={`text-[9px] cursor-pointer transition-opacity ${
                levelFilter.has(level) ? LEVEL_STYLES[level].badge : "opacity-30"
              }`}
              onClick={() => toggleLevel(level)}
              data-testid={`filter-${level}`}
            >
              {level.toUpperCase()}
            </Badge>
          ))}
        </div>

        {/* Search */}
        <div className="relative w-44">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
          <Input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter..."
            className="h-7 text-xs pl-7 pr-7"
            data-testid="input-filter"
          />
          {filter && (
            <Button
              variant="ghost"
              size="sm"
              className="absolute right-0 top-0 h-7 w-7 p-0"
              onClick={() => setFilter("")}
            >
              <X className="w-3 h-3" />
            </Button>
          )}
        </div>

        {/* Actions */}
        <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => setPaused(!paused)} data-testid="button-pause">
          {paused ? <Play className="w-3 h-3 mr-1" /> : <Pause className="w-3 h-3 mr-1" />}
          <span className="text-[10px]">{paused ? "Resume" : "Pause"}</span>
        </Button>
        <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => setAutoScroll(!autoScroll)} data-testid="button-autoscroll">
          <ArrowDown className={`w-3 h-3 mr-1 ${autoScroll ? "text-primary" : ""}`} />
          <span className="text-[10px]">Auto</span>
        </Button>
        <Button size="sm" variant="outline" className="h-7 px-2" onClick={handleClear} data-testid="button-clear">
          <Trash2 className="w-3 h-3 mr-1" />
          <span className="text-[10px]">Clear</span>
        </Button>
      </div>

      {/* ── Log entries ── */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto font-mono text-xs min-h-0"
        data-testid="log-container"
      >
        <table className="w-full">
          <tbody>
            {filteredLogs.map(entry => {
              const style = LEVEL_STYLES[entry.level] || LEVEL_STYLES.log;
              const sourceColor = entry.source ? getSourceColor(entry.source) : "";
              return (
                <tr
                  key={entry.id}
                  className="hover:bg-muted/30 border-b border-border/30"
                  data-testid={`log-${entry.id}`}
                >
                  <td className="px-2 py-0.5 text-[10px] text-muted-foreground whitespace-nowrap align-top w-16">
                    {formatTime(entry.timestamp)}
                  </td>
                  <td className="px-1 py-0.5 align-top w-12">
                    <span className={`text-[9px] font-bold uppercase ${style.text}`}>
                      {entry.level === "log" ? "LOG" : entry.level.toUpperCase()}
                    </span>
                  </td>
                  {entry.source && (
                    <td className={`px-1 py-0.5 text-[10px] whitespace-nowrap align-top w-24 ${sourceColor}`}>
                      [{entry.source}]
                    </td>
                  )}
                  <td
                    className={`px-2 py-0.5 ${style.text} break-all`}
                    colSpan={entry.source ? 1 : 2}
                  >
                    {entry.message}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {filteredLogs.length === 0 && (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-xs">
            {logs.length === 0 ? "Waiting for log output..." : "No logs match the current filter"}
          </div>
        )}
      </div>

      {/* ── LLM Inspector panel (below log area) ── */}
      <InspectorPanel />
    </div>
  );
}
