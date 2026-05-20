import { useState, useEffect } from "react";
import { setTheme } from "../App";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Server, Plus, Trash2, RefreshCw, Wifi, ChevronDown, ChevronRight,
  Pencil, Save, X, CheckCircle2, XCircle, Search, Zap,
  Shield, Brain, User, Palette, Box, Settings2, Loader2, Bot,
  Network, Power, PowerOff, Terminal as TerminalIcon, Link2, Cpu,
  Image as ImageIcon, FolderOpen, Database, MonitorDot,
} from "lucide-react";

type Endpoint = {
  id: number; name: string; url: string; providerType: string; apiKey?: string;
  isOrchestrator: boolean; parallelSlots: number; isEnabled: boolean; lastSeen?: string;
};

type Model = {
  id: number; endpointId: number; modelId: string; type: string;
  maxContextLength?: number; loadedContextLength?: number; preferredContextLength?: number;
  isEnabled: boolean; taskAssignment?: string; supportsToolCalling: boolean; notes?: string;
  temperature?: number | null; topP?: number | null;
};

/** Parse task tags from taskAssignment field (JSON array or legacy string) */
function parseTags(raw?: string | null): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed) as string[]; } catch { return [trimmed]; }
  }
  if (trimmed === "none" || trimmed === "") return [];
  return [trimmed];
}

/** Format token count for display: 131072 → "128k", 8192 → "8k" */
function fmtCtx(tokens: number | undefined | null): string {
  if (!tokens) return "?";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1024) return `${Math.round(tokens / 1024)}k`;
  return `${tokens}`;
}

/**
 * Extract quantization info from an LM Studio model ID.
 * e.g. "lmstudio-community/Nemotron-Super-49B-v1-GGUF/Nemotron-Super-49B-v1-Q4_K_M.gguf" → "Q4_K_M"
 * e.g. "bartowski/gemma-3-27B-it-GGUF/gemma-3-27B-it-Q8_0.gguf" → "Q8_0"
 * Falls back to checking the parent folder name for quant hints.
 */
function extractQuant(modelId: string): string | null {
  // Match common GGUF quantization patterns: Q2_K, Q3_K_S, Q4_0, Q4_K_M, Q5_1, Q6_K, Q8_0, IQ2_XS, etc.
  const quantPattern = /[_-]((?:I?Q[0-9]+(?:_[A-Z0-9]+)*))/i;
  // First check the filename (last path segment)
  const parts = modelId.split("/");
  const filename = parts[parts.length - 1] || modelId;
  const match = filename.match(quantPattern);
  if (match) return match[1].toUpperCase();
  // Also try matching anywhere in the full path
  const fullMatch = modelId.match(quantPattern);
  if (fullMatch) return fullMatch[1].toUpperCase();
  // Check for FP16/BF16/F16/F32 markers
  const fpMatch = modelId.match(/[_-]((?:B?F(?:P)?(?:16|32)))/i);
  if (fpMatch) return fpMatch[1].toUpperCase();
  return null;
}

/** Get a short friendly model name: strip org prefix, GGUF suffix, .gguf extension */
function shortModelName(modelId: string): string {
  const parts = modelId.split("/");
  // Use the last meaningful segment (filename or folder name)
  let name = parts.length >= 2 ? parts[parts.length - 1] : modelId;
  // Strip .gguf extension
  name = name.replace(/\.gguf$/i, "");
  return name;
}

const TASK_TAGS = ["coding", "research", "creative", "math", "general", "planner"] as const;
const TASK_COLORS: Record<string, string> = {
  coding: "text-green-400 border-green-500/30",
  research: "text-blue-400 border-blue-500/30",
  planner: "text-amber-400 border-amber-500/30",
  creative: "text-purple-400 border-purple-500/30",
  math: "text-orange-400 border-orange-500/30",
  general: "text-muted-foreground border-border",
  none: "text-muted-foreground border-border",
};


type McpServer = {
  id: number;
  name: string;
  command: string;
  args?: string;
  env?: string;
  transport: "stdio" | "sse";
  sseUrl?: string;
  status: "connected" | "disconnected" | "error";
  toolCount?: number;
  error?: string;
};

// ── SSH Types ───────────────────────────────────────────────
type SshTarget = {
  id: string;
  name: string;
  host: string;
  user: string;
  password: string;
  port: number;
};

// ── SSH Target Row ───────────────────────────────────────────
function SshTargetRow({ target, onUpdate, onDelete }: {
  target: SshTarget;
  onUpdate: (t: SshTarget) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ ...target });

  function save() {
    onUpdate({ ...form });
    setEditing(false);
  }

  return (
    <div className="border border-border rounded-md overflow-hidden">
      {editing ? (
        <div className="p-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">Name</Label>
              <Input
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. DGX Spark"
                className="h-7 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">Host / IP</Label>
              <Input
                value={form.host}
                onChange={e => setForm(f => ({ ...f, host: e.target.value }))}
                placeholder="192.168.0.20"
                className="h-7 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">Username</Label>
              <Input
                value={form.user}
                onChange={e => setForm(f => ({ ...f, user: e.target.value }))}
                placeholder="ubuntu"
                className="h-7 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">Port</Label>
              <Input
                type="number"
                value={form.port}
                onChange={e => setForm(f => ({ ...f, port: Number(e.target.value) }))}
                className="h-7 text-xs"
                min={1}
                max={65535}
              />
            </div>
            <div className="col-span-2 space-y-1">
              <Label className="text-[10px] text-muted-foreground">Password</Label>
              <Input
                type="password"
                value={form.password}
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                placeholder="SSH password"
                className="h-7 text-xs"
              />
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <Button size="sm" className="h-7 text-xs" onClick={save} disabled={!form.name || !form.host || !form.user}>
              <Save className="w-3 h-3 mr-1" /> Save
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setForm({ ...target }); setEditing(false); }}>
              <X className="w-3 h-3 mr-1" /> Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-3 py-2">
          <MonitorDot className="w-3.5 h-3.5 text-primary shrink-0" />
          <span className="text-xs font-medium truncate">{target.name}</span>
          <span className="text-[10px] text-muted-foreground font-mono truncate flex-1">
            {target.user}@{target.host}:{target.port || 22}
          </span>
          <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setEditing(true)}>
            <Pencil className="w-3 h-3" />
          </Button>
          <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive hover:text-destructive" onClick={onDelete}>
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Section Wrapper ─────────────────────────────────────────
function Section({ title, icon: Icon, children }: { title: string; icon: any; children: React.ReactNode }) {
  return (
    <Card className="mb-4">
      <CardHeader className="pb-3 pt-4 px-4">
        <CardTitle className="text-sm font-mono flex items-center gap-2 text-primary">
          <Icon className="w-4 h-4" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">{children}</CardContent>
    </Card>
  );
}

// ── Endpoint Row ─────────────────────────────────────────────
function EndpointRow({ endpoint, models, onDelete }: { endpoint: Endpoint; models: Model[]; onDelete: () => void }) {
  const [modelSearch, setModelSearch] = useState("");
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: endpoint.name, url: endpoint.url, providerType: endpoint.providerType || "lmstudio", apiKey: endpoint.apiKey || "", isOrchestrator: endpoint.isOrchestrator, parallelSlots: endpoint.parallelSlots });
  const isCloud = form.providerType !== "lmstudio";
  const isOpenRouter = endpoint.providerType === "openrouter";

  const endpointModels = models.filter(m => m.endpointId === endpoint.id);

  // Live balance for OpenRouter endpoints — refetches every 60s
  const { data: balanceData, refetch: refetchBalance, isFetching: balanceFetching } = useQuery<{
    balance: number; total: number; used: number;
  }>({
    queryKey: [`/api/endpoints/${endpoint.id}/openrouter-balance`],
    enabled: isOpenRouter && !!endpoint.apiKey,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  // Balance floor setting (per-endpoint, stored as openrouter.balanceFloor.<id>)
  const balanceFloorKey = `openrouter.balanceFloor.${endpoint.id}`;
  const [balanceFloor, setBalanceFloor] = useState("");
  const settingsData = useQuery<Record<string, string>>({ queryKey: ["/api/settings"] });
  useEffect(() => {
    const val = settingsData.data?.[balanceFloorKey];
    if (val !== undefined) setBalanceFloor(val);
  }, [settingsData.data, balanceFloorKey]);

  const updateMutation = useMutation({
    mutationFn: (data: Partial<Endpoint>) => apiRequest("PATCH", `/api/endpoints/${endpoint.id}`, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/endpoints"] }); setEditing(false); toast({ title: "Endpoint updated" }); },
    onError: () => toast({ title: "Update failed", variant: "destructive" }),
  });

  const syncMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/endpoints/${endpoint.id}/sync`),
    onSuccess: async (res) => {
      const data = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/models"] });
      toast({ title: `Synced — ${data.added} new models` });
    },
    onError: () => toast({ title: "Sync failed", variant: "destructive" }),
  });

  const pingMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/endpoints/${endpoint.id}/ping`),
    onSuccess: async (res) => {
      const data = await res.json();
      toast({ title: data.alive ? "Endpoint is alive" : "Endpoint not responding", variant: data.alive ? "default" : "destructive" });
    },
    onError: () => toast({ title: "Ping failed", variant: "destructive" }),
  });

  return (
    <div className="border border-border rounded-md overflow-hidden" data-testid={`endpoint-row-${endpoint.id}`}>
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/30">
        <button onClick={() => setExpanded(!expanded)} className="text-muted-foreground hover:text-foreground" data-testid={`expand-endpoint-${endpoint.id}`}>
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <Server className="w-3.5 h-3.5 text-primary shrink-0" />
        {editing ? (
          <div className="flex items-center gap-2 flex-1 flex-wrap">
            <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="h-7 text-xs w-32" data-testid={`input-endpoint-name-${endpoint.id}`} />
            <Select value={form.providerType} onValueChange={v => setForm(f => ({ ...f, providerType: v }))}>
              <SelectTrigger className="h-7 text-xs w-36" data-testid={`select-provider-${endpoint.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="lmstudio">LM Studio</SelectItem>
                <SelectItem value="openrouter">OpenRouter</SelectItem>
                <SelectItem value="openai_compatible">OpenAI Compatible</SelectItem>
              </SelectContent>
            </Select>
            <Input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} className="h-7 text-xs flex-1 min-w-48" data-testid={`input-endpoint-url-${endpoint.id}`} />
            {isCloud && (
              <Input value={form.apiKey} onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))} type="password" placeholder="API key" className="h-7 text-xs w-40" data-testid={`input-apikey-${endpoint.id}`} />
            )}
            <div className="flex items-center gap-1">
              <Switch checked={form.isOrchestrator} onCheckedChange={v => setForm(f => ({ ...f, isOrchestrator: v }))} data-testid={`switch-orchestrator-${endpoint.id}`} />
              <span className="text-xs text-muted-foreground">Orchestrator</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground">Slots:</span>
              <Input type="number" value={form.parallelSlots} onChange={e => setForm(f => ({ ...f, parallelSlots: Number(e.target.value) }))} className="h-7 text-xs w-16" min={1} max={16} data-testid={`input-parallel-slots-${endpoint.id}`} />
            </div>
            <Button size="icon" variant="ghost" onClick={() => updateMutation.mutate(form)} disabled={updateMutation.isPending} data-testid={`button-save-endpoint-${endpoint.id}`}>
              {updateMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5 text-primary" />}
            </Button>
            <Button size="icon" variant="ghost" onClick={() => setEditing(false)} data-testid={`button-cancel-endpoint-${endpoint.id}`}>
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className="text-xs font-medium truncate">{endpoint.name}</span>
            <span className="text-[10px] text-muted-foreground font-mono truncate flex-1">{endpoint.url}</span>
            {(endpoint.providerType && endpoint.providerType !== "lmstudio") && (
              <Badge variant="outline" className="text-[10px] border-green-500/40 text-green-400">
                {endpoint.providerType === "openrouter" ? "OpenRouter" : "OpenAI-compatible"}
              </Badge>
            )}
            {endpoint.isOrchestrator && <Badge variant="outline" className="text-[10px] border-primary/40 text-primary">orchestrator</Badge>}
            <Badge variant="outline" className="text-[10px]">{endpoint.parallelSlots} slots</Badge>
            {isOpenRouter && (() => {
              const floor = parseFloat(balanceFloor);
              const bal = balanceData?.balance ?? null;
              const belowFloor = bal !== null && !isNaN(floor) && floor > 0 && bal < floor;
              const aboveFloor = bal !== null && !isNaN(floor) && floor > 0 && bal >= floor;
              return (
                <button
                  onClick={e => { e.stopPropagation(); refetchBalance(); }}
                  className={`flex items-center gap-1 text-[10px] font-mono border rounded px-1.5 py-0.5 transition-colors ${
                    belowFloor
                      ? "text-red-400 border-red-500/40 bg-red-500/10 hover:bg-red-500/20"
                      : aboveFloor
                      ? "text-amber-400 border-amber-500/30 hover:bg-amber-500/10"
                      : "text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/10"
                  }`}
                  title={belowFloor ? `Balance $${bal?.toFixed(2)} is below your floor of $${floor.toFixed(2)} — OpenRouter is blocked` : "OpenRouter balance (click to refresh)"}
                  data-testid={`openrouter-balance-${endpoint.id}`}
                >
                  {balanceFetching ? (
                    <span className="animate-pulse">...</span>
                  ) : bal !== null ? (
                    <span>{belowFloor ? "⚠ " : ""}${bal.toFixed(2)}{!isNaN(floor) && floor > 0 ? ` / $${floor.toFixed(2)} floor` : ""}</span>
                  ) : (
                    <span className="text-muted-foreground">$?</span>
                  )}
                </button>
              );
            })()}
          </div>
        )}
        {!editing && (
          <div className="flex items-center gap-1 shrink-0">
            <Button size="icon" variant="ghost" onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending} data-testid={`button-sync-${endpoint.id}`}>
              <RefreshCw className={`w-3.5 h-3.5 ${syncMutation.isPending ? "animate-spin text-primary" : ""}`} />
            </Button>
            <Button size="icon" variant="ghost" onClick={() => pingMutation.mutate()} disabled={pingMutation.isPending} data-testid={`button-ping-${endpoint.id}`}>
              <Wifi className={`w-3.5 h-3.5 ${pingMutation.isPending ? "animate-pulse text-primary" : ""}`} />
            </Button>
            <Button size="icon" variant="ghost" onClick={() => setEditing(true)} data-testid={`button-edit-endpoint-${endpoint.id}`}>
              <Pencil className="w-3.5 h-3.5" />
            </Button>
            <Button size="icon" variant="ghost" onClick={onDelete} data-testid={`button-delete-endpoint-${endpoint.id}`}>
              <Trash2 className="w-3.5 h-3.5 text-destructive" />
            </Button>
          </div>
        )}
      </div>

      {expanded && (() => {
        const filteredModels = endpointModels.filter(m =>
          !modelSearch || m.modelId.toLowerCase().includes(modelSearch.toLowerCase())
        );
        return (
          <div className="border-t border-border bg-background/50">
            {/* OpenRouter balance floor setting */}
            {isOpenRouter && (
              <div className="px-4 py-3 border-b border-border flex items-center gap-3">
                <div className="flex-1">
                  <Label className="text-[11px] font-medium">Balance Floor</Label>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Stop using OpenRouter when balance drops below this amount. Leave blank to disable.
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-muted-foreground">$</span>
                  <Input
                    type="number"
                    min="0"
                    step="0.5"
                    value={balanceFloor}
                    onChange={e => setBalanceFloor(e.target.value)}
                    placeholder="e.g. 5"
                    className="h-7 text-xs w-20 font-mono"
                    data-testid={`input-balance-floor-${endpoint.id}`}
                  />
                  <Button
                    size="sm"
                    className="h-7 text-xs px-2"
                    onClick={async () => {
                      try {
                        await apiRequest("PATCH", "/api/settings", { [balanceFloorKey]: balanceFloor });
                        queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
                        toast({ title: balanceFloor ? `Balance floor set to $${balanceFloor}` : "Balance floor cleared" });
                      } catch {
                        toast({ title: "Failed to save", variant: "destructive" });
                      }
                    }}
                    data-testid={`button-save-balance-floor-${endpoint.id}`}
                  >
                    Save
                  </Button>
                </div>
              </div>
            )}
            {endpointModels.length > 3 && (
              <div className="px-4 py-2 border-b border-border">
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                  <Input
                    value={modelSearch}
                    onChange={e => setModelSearch(e.target.value)}
                    placeholder="Filter models..."
                    className="h-7 text-xs pl-7"
                    data-testid={`input-model-search-${endpoint.id}`}
                  />
                </div>
              </div>
            )}
            <div className="divide-y divide-border">
              {filteredModels.length === 0 ? (
                <p className="text-xs text-muted-foreground px-6 py-3">
                  {modelSearch ? "No models match filter" : "No models — click Sync to load from endpoint."}
                </p>
              ) : (
                filteredModels.map(model => (
                  <ModelRow key={model.id} model={model} />
                ))
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ── Selected Model Row (for the unified panel) ─────────────────────
function SelectedModelRow({ model, endpointName }: { model: Model; endpointName?: string }) {
  const { toast } = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [notes, setNotes] = useState(model.notes || "");
  const [tags, setTags] = useState<string[]>(parseTags(model.taskAssignment));
  const [supportsTools, setSupportsTools] = useState(model.supportsToolCalling);
  const [isSubAgent, setIsSubAgent] = useState((model as any).isSubAgent ?? false);
  const [thinkingEnabled, setThinkingEnabled] = useState((model as any).thinkingEnabled ?? false);
  const [prefCtx, setPrefCtx] = useState(model.preferredContextLength?.toString() || "");
  const [temperature, setTemperature] = useState(model.temperature?.toString() || "0.65");
  const [topP, setTopP] = useState(model.topP?.toString() || "0.95");

  const updateMutation = useMutation({
    mutationFn: (data: Partial<Model>) => apiRequest("PATCH", `/api/models/${model.id}`, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/models"] }); toast({ title: "Model updated" }); },
    onError: () => toast({ title: "Update failed", variant: "destructive" }),
  });

  const handleDisable = () => {
    updateMutation.mutate({ isEnabled: false });
  };

  // Inline thinking toggle — saves immediately without opening edit dialog
  const handleThinkingToggle = (enabled: boolean) => {
    setThinkingEnabled(enabled);
    updateMutation.mutate({ thinkingEnabled: enabled } as any);
  };

  const toggleTag = (tag: string) => {
    setTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  };

  const handleSave = () => {
    const taskAssignment = tags.length > 0 ? JSON.stringify(tags) : null;
    let preferredContextLength = prefCtx ? parseInt(prefCtx, 10) || null : null;
    if (preferredContextLength && model.maxContextLength && preferredContextLength > model.maxContextLength) {
      preferredContextLength = model.maxContextLength;
    }
    const tempVal = temperature ? parseFloat(temperature) : null;
    const topPVal = topP ? parseFloat(topP) : null;
    updateMutation.mutate({
      notes,
      taskAssignment: taskAssignment as any,
      supportsToolCalling: supportsTools,
      isSubAgent: isSubAgent as any,
      thinkingEnabled: thinkingEnabled as any,
      preferredContextLength: preferredContextLength as any,
      temperature: tempVal as any,
      topP: topPVal as any,
    });
    setEditOpen(false);
  };

  const modelTags = parseTags(model.taskAssignment);

  return (
    <div className="flex items-center gap-2 px-3 py-2" data-testid={`selected-model-${model.id}`}>
      <span className="text-xs font-mono flex-1 truncate" title={model.modelId}>{shortModelName(model.modelId)}</span>
      {extractQuant(model.modelId) && (
        <Badge variant="outline" className="text-[10px] border-violet-500/40 text-violet-400 font-mono shrink-0">{extractQuant(model.modelId)}</Badge>
      )}
      {endpointName && <span className="text-[10px] text-muted-foreground shrink-0">{endpointName}</span>}
      {modelTags.map(tag => (
        <Badge key={tag} variant="outline" className={`text-[10px] ${TASK_COLORS[tag] || ""}`}>{tag}</Badge>
      ))}
      {model.supportsToolCalling && (
        <Badge variant="outline" className="text-[10px] border-primary/30 text-primary">tools</Badge>
      )}
      {(model as any).isSubAgent && (
        <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-400">sub-agent</Badge>
      )}
      {/* Thinking toggle — inline, saves immediately */}
      <button
        onClick={() => handleThinkingToggle(!thinkingEnabled)}
        title={thinkingEnabled ? "Thinking ON — click to disable" : "Thinking OFF — click to enable"}
        className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] transition-colors shrink-0 ${
          thinkingEnabled
            ? "border-yellow-500/60 text-yellow-400 bg-yellow-500/10"
            : "border-border text-muted-foreground hover:border-muted-foreground/50"
        }`}
      >
        <Brain className="w-3 h-3" />
        <span>{thinkingEnabled ? "think" : "think"}</span>
      </button>
      {(model.preferredContextLength || model.loadedContextLength) && (
        <Badge variant="outline" className="text-[10px] border-zinc-500/40 text-zinc-400 font-mono">
          {fmtCtx(model.preferredContextLength || model.loadedContextLength)} ctx
        </Badge>
      )}
      <Button size="icon" variant="ghost" onClick={() => setEditOpen(true)} className="h-6 w-6" data-testid={`button-edit-selected-${model.id}`}>
        <Pencil className="w-3 h-3" />
      </Button>
      <Button size="icon" variant="ghost" onClick={handleDisable} className="h-6 w-6" title="Disable model" data-testid={`button-disable-selected-${model.id}`}>
        <XCircle className="w-3 h-3 text-destructive" />
      </Button>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm font-mono text-primary">Configure Model</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-xs font-mono text-muted-foreground truncate">{model.modelId}</p>
            {endpointName && <p className="text-[10px] text-muted-foreground">Endpoint: {endpointName}</p>}
            {(model.maxContextLength || model.loadedContextLength) && (
              <div className="flex gap-3 text-[11px] text-muted-foreground font-mono bg-muted/50 rounded px-2 py-1.5">
                {model.maxContextLength && <span>Max context: <span className="text-foreground">{fmtCtx(model.maxContextLength)}</span></span>}
                {model.loadedContextLength && <span>Loaded: <span className="text-primary">{fmtCtx(model.loadedContextLength)}</span></span>}
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">Task Tags</Label>
              <p className="text-[10px] text-muted-foreground">Select all that apply</p>
              <div className="flex flex-wrap gap-1.5">
                {TASK_TAGS.map(tag => {
                  const active = tags.includes(tag);
                  return (
                    <button
                      key={tag}
                      onClick={() => toggleTag(tag)}
                      className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                        active
                          ? `${TASK_COLORS[tag] || ""} bg-muted font-medium`
                          : "text-muted-foreground border-border hover:border-muted-foreground/50"
                      }`}
                    >
                      {tag}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Load Context Length</Label>
              <p className="text-[10px] text-muted-foreground">Context window when loading this model (blank = LM Studio default)</p>
              <div className="flex gap-1.5">
                <Input
                  type="number"
                  value={prefCtx}
                  onChange={e => {
                    const val = parseInt(e.target.value, 10);
                    const cap = model.maxContextLength || Infinity;
                    if (val > cap) {
                      setPrefCtx(String(cap));
                    } else {
                      setPrefCtx(e.target.value);
                    }
                  }}
                  placeholder={model.maxContextLength ? `Max: ${fmtCtx(model.maxContextLength)}` : "e.g. 40960"}
                  className="h-8 text-xs font-mono flex-1"
                  min={1024}
                  max={model.maxContextLength || undefined}
                  step={1024}
                />
                {model.maxContextLength && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs px-2 shrink-0"
                    onClick={() => {
                      const capped = model.maxContextLength!;
                      setPrefCtx(String(capped));
                    }}
                  >
                    Max ({fmtCtx(model.maxContextLength)})
                  </Button>
                )}
              </div>

            </div>
            <div className="flex items-center gap-2">
              <Switch checked={supportsTools} onCheckedChange={setSupportsTools} />
              <Label className="text-xs">Supports Tool Calling</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={isSubAgent} onCheckedChange={setIsSubAgent} />
              <div>
                <Label className="text-xs">Sub-agent Model</Label>
                <p className="text-[10px] text-muted-foreground">Route parallel sub-tasks to this model instead of the main model</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={thinkingEnabled} onCheckedChange={setThinkingEnabled} />
              <div>
                <Label className="text-xs">Thinking / Reasoning Mode</Label>
                <p className="text-[10px] text-muted-foreground">Enables extended thinking for models that support it (e.g. QwQ, DeepSeek-R1, Claude 3.7). Sends <code className="font-mono">thinking</code> param to LM Studio or <code className="font-mono">reasoning</code> to OpenRouter.</p>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Inference Parameters</Label>
              <p className="text-[10px] text-muted-foreground">Leave blank to use smart defaults for this model</p>
              <div className="flex gap-2">
                <div className="flex-1 space-y-1">
                  <Label className="text-[10px] text-muted-foreground">Temperature</Label>
                  <Input
                    type="number" value={temperature} onChange={e => setTemperature(e.target.value)}
                    placeholder="0.65" className="h-7 text-xs font-mono"
                    min={0} max={2} step={0.05}
                  />
                </div>
                <div className="flex-1 space-y-1">
                  <Label className="text-[10px] text-muted-foreground">Top P</Label>
                  <Input
                    type="number" value={topP} onChange={e => setTopP(e.target.value)}
                    placeholder="0.95" className="h-7 text-xs font-mono"
                    min={0} max={1} step={0.05}
                  />
                </div>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Notes</Label>
              <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} className="text-xs resize-none" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={handleSave} disabled={updateMutation.isPending}>
              {updateMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Model Row ────────────────────────────────────────────────
function ModelRow({ model }: { model: Model }) {
  const { toast } = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [notes, setNotes] = useState(model.notes || "");
  const [tags, setTags] = useState<string[]>(parseTags(model.taskAssignment));
  const [supportsTools, setSupportsTools] = useState(model.supportsToolCalling);
  const [isSubAgent, setIsSubAgent] = useState((model as any).isSubAgent ?? false);
  const [enabled, setEnabled] = useState(model.isEnabled);
  const [prefCtx, setPrefCtx] = useState(model.preferredContextLength?.toString() || "");
  const [temperature, setTemperature] = useState(model.temperature?.toString() || "0.65");
  const [topP, setTopP] = useState(model.topP?.toString() || "0.95");

  const updateMutation = useMutation({
    mutationFn: (data: Partial<Model>) => apiRequest("PATCH", `/api/models/${model.id}`, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/models"] }); toast({ title: "Model updated" }); },
    onError: () => toast({ title: "Update failed", variant: "destructive" }),
  });

  const handleEnableToggle = (v: boolean) => {
    setEnabled(v);
    updateMutation.mutate({ isEnabled: v });
  };

  const toggleTag = (tag: string) => {
    setTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  };

  const handleSave = () => {
    const taskAssignment = tags.length > 0 ? JSON.stringify(tags) : null;
    let preferredContextLength = prefCtx ? parseInt(prefCtx, 10) || null : null;
    if (preferredContextLength && model.maxContextLength && preferredContextLength > model.maxContextLength) {
      preferredContextLength = model.maxContextLength;
    }
    const tempVal = temperature ? parseFloat(temperature) : null;
    const topPVal = topP ? parseFloat(topP) : null;
    updateMutation.mutate({
      notes,
      taskAssignment: taskAssignment as any,
      supportsToolCalling: supportsTools,
      isSubAgent: isSubAgent as any,
      preferredContextLength: preferredContextLength as any,
      temperature: tempVal as any,
      topP: topPVal as any,
    });
    setEditOpen(false);
  };

  const modelTags = parseTags(model.taskAssignment);
  const showAssignBadge = enabled && modelTags.length === 0;

  return (
    <div className="flex items-center gap-2 px-6 py-2" data-testid={`model-row-${model.id}`}>
      <Switch checked={enabled} onCheckedChange={handleEnableToggle} data-testid={`switch-model-${model.id}`} />
      <span className="text-xs font-mono flex-1 truncate text-muted-foreground" title={model.modelId}>{shortModelName(model.modelId)}</span>
      {extractQuant(model.modelId) && (
        <Badge variant="outline" className="text-[10px] border-violet-500/40 text-violet-400 font-mono shrink-0">{extractQuant(model.modelId)}</Badge>
      )}
      {modelTags.map(tag => (
        <Badge key={tag} variant="outline" className={`text-[10px] ${TASK_COLORS[tag] || ""}`}>
          {tag}
        </Badge>
      ))}
      {showAssignBadge && (
        <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-400" data-testid={`badge-assign-${model.id}`}>
          assign task
        </Badge>
      )}
      {model.supportsToolCalling && (
        <Badge variant="outline" className="text-[10px] border-primary/30 text-primary">tools</Badge>
      )}
      {(model.preferredContextLength || model.loadedContextLength || model.maxContextLength) && (
        <Badge variant="outline" className="text-[10px] border-zinc-500/40 text-zinc-400 font-mono" title={`Preferred: ${fmtCtx(model.preferredContextLength)} | Max: ${fmtCtx(model.maxContextLength)} | Loaded: ${fmtCtx(model.loadedContextLength)}`}>
          {fmtCtx(model.preferredContextLength || model.loadedContextLength || model.maxContextLength)} ctx
        </Badge>
      )}
      <Button size="icon" variant="ghost" onClick={() => setEditOpen(true)} data-testid={`button-edit-model-${model.id}`}>
        <Pencil className="w-3 h-3" />
      </Button>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm font-mono text-primary">Configure Model</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-xs font-mono text-muted-foreground truncate">{model.modelId}</p>
            {(model.maxContextLength || model.loadedContextLength) && (
              <div className="flex gap-3 text-[11px] text-muted-foreground font-mono bg-muted/50 rounded px-2 py-1.5">
                {model.maxContextLength && <span>Max context: <span className="text-foreground">{fmtCtx(model.maxContextLength)}</span></span>}
                {model.loadedContextLength && <span>Loaded: <span className="text-primary">{fmtCtx(model.loadedContextLength)}</span></span>}
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">Task Tags</Label>
              <p className="text-[10px] text-muted-foreground">Select all that apply</p>
              <div className="flex flex-wrap gap-1.5">
                {TASK_TAGS.map(tag => {
                  const active = tags.includes(tag);
                  return (
                    <button
                      key={tag}
                      onClick={() => toggleTag(tag)}
                      className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                        active
                          ? `${TASK_COLORS[tag] || ""} bg-muted font-medium`
                          : "text-muted-foreground border-border hover:border-muted-foreground/50"
                      }`}
                      data-testid={`tag-${tag}-${model.id}`}
                    >
                      {tag}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Load Context Length</Label>
              <p className="text-[10px] text-muted-foreground">Context window when loading this model (blank = LM Studio default)</p>
              <div className="flex gap-1.5">
                <Input
                  type="number"
                  value={prefCtx}
                  onChange={e => {
                    const val = parseInt(e.target.value, 10);
                    const cap = model.maxContextLength || Infinity;
                    if (val > cap) {
                      setPrefCtx(String(cap));
                    } else {
                      setPrefCtx(e.target.value);
                    }
                  }}
                  placeholder={model.maxContextLength ? `Max: ${fmtCtx(model.maxContextLength)}` : "e.g. 40960"}
                  className="h-8 text-xs font-mono flex-1"
                  min={1024}
                  max={model.maxContextLength || undefined}
                  step={1024}
                  data-testid={`input-pref-ctx-${model.id}`}
                />
                {model.maxContextLength && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs px-2 shrink-0"
                    onClick={() => {
                      const capped = model.maxContextLength!;
                      setPrefCtx(String(capped));
                    }}
                    data-testid={`button-max-ctx-${model.id}`}
                  >
                    Max ({fmtCtx(model.maxContextLength)})
                  </Button>
                )}
              </div>

            </div>
            <div className="flex items-center gap-2">
              <Switch checked={supportsTools} onCheckedChange={setSupportsTools} data-testid={`switch-tools-${model.id}`} />
              <Label className="text-xs">Supports Tool Calling</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={isSubAgent} onCheckedChange={setIsSubAgent} data-testid={`switch-subagent-${model.id}`} />
              <div>
                <Label className="text-xs">Sub-agent Model</Label>
                <p className="text-[10px] text-muted-foreground">Route parallel sub-tasks to this model instead of the main model</p>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Inference Parameters</Label>
              <p className="text-[10px] text-muted-foreground">Leave blank to use smart defaults for this model</p>
              <div className="flex gap-2">
                <div className="flex-1 space-y-1">
                  <Label className="text-[10px] text-muted-foreground">Temperature</Label>
                  <Input
                    type="number" value={temperature} onChange={e => setTemperature(e.target.value)}
                    placeholder="0.65" className="h-7 text-xs font-mono"
                    min={0} max={2} step={0.05}
                  />
                </div>
                <div className="flex-1 space-y-1">
                  <Label className="text-[10px] text-muted-foreground">Top P</Label>
                  <Input
                    type="number" value={topP} onChange={e => setTopP(e.target.value)}
                    placeholder="0.95" className="h-7 text-xs font-mono"
                    min={0} max={1} step={0.05}
                  />
                </div>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Notes</Label>
              <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} className="text-xs resize-none" data-testid={`textarea-notes-${model.id}`} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={handleSave} disabled={updateMutation.isPending} data-testid={`button-save-model-${model.id}`}>
              {updateMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}


// ── Theme Section ──────────────────────────────────────────────────

type ThemeOption = {
  value: "cyberpunk" | "professional" | "lofi";
  label: string;
  description: string;
  colors: string[];
};

const THEMES: ThemeOption[] = [
  {
    value: "cyberpunk",
    label: "Cyberpunk 2077",
    description: "Neon cyan & hot pink on deep dark blue-black",
    colors: ["#00e5ff", "#ff4fa3", "#121825"],
  },
  {
    value: "professional",
    label: "Professional",
    description: "Inter font, sharp corners, indigo accent — clean SaaS feel",
    colors: ["#FAFAFA", "#6366F1", "#111111"],
  },
  {
    value: "lofi",
    label: "Lofi",
    description: "Space Grotesk font, warm indigo-violet palette, late-night city vibe",
    colors: ["#0d0b14", "#8f72e0", "#d467a8"],
  },
];

function ThemeSection() {
  const { toast } = useToast();

  // Read active theme synchronously from the injected global so the correct
  // theme is shown immediately without waiting for the query to resolve.
  const initialTheme = (() => {
    const t = (window as any).__AGENT2077_SETTINGS__?.theme;
    if (t === "professional" || t === "lofi") return t as "professional" | "lofi";
    return "cyberpunk" as const;
  })();

  const [activeTheme, setActiveTheme] = useState<"cyberpunk" | "professional" | "lofi">(initialTheme);

  const { data: settings } = useQuery({
    queryKey: ["/api/settings"],
    queryFn: () => apiRequest("GET", "/api/settings").then(r => r.json()),
    staleTime: 30_000,
  });

  useEffect(() => {
    if (settings?.theme === "professional" || settings?.theme === "lofi") {
      setActiveTheme(settings.theme);
    } else if (settings) {
      setActiveTheme("cyberpunk");
    }
  }, [settings]);

  const handleSelect = (theme: "cyberpunk" | "professional" | "lofi") => {
    setActiveTheme(theme);
    setTheme(theme);
    toast({ title: "Theme updated", description: `Switched to ${THEMES.find(t => t.value === theme)?.label}` });
  };

  return (
    <Section title="THEME" icon={Palette}>
      <div className="grid grid-cols-1 gap-2">
        {THEMES.map((t) => {
          const isActive = activeTheme === t.value;
          return (
            <button
              key={t.value}
              onClick={() => handleSelect(t.value)}
              className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors w-full ${
                isActive
                  ? "border-primary/60 bg-primary/10"
                  : "border-border hover:border-primary/30 hover:bg-muted/40"
              }`}
              data-testid={`theme-option-${t.value}`}
            >
              {/* Color swatch */}
              <div className="flex gap-0.5 shrink-0">
                {t.colors.map((c, i) => (
                  <div
                    key={i}
                    className="w-3 h-6 rounded-sm first:rounded-l-md last:rounded-r-md"
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium">{t.label}</p>
                <p className="text-[10px] text-muted-foreground truncate">{t.description}</p>
              </div>
              {isActive && (
                <Badge variant="outline" className="ml-auto shrink-0 text-[10px] border-primary/40 text-primary">
                  Active
                </Badge>
              )}
            </button>
          );
        })}
      </div>
    </Section>
  );
}

// ── MCP Server Management Section ─────────────────────────────────
function McpServerSection() {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServer | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [form, setForm] = useState({
    name: "", command: "", args: "[]", env: "{}", transport: "stdio" as "stdio" | "sse", sseUrl: "",
  });

  const { data: servers = [], isLoading } = useQuery<McpServer[]>({
    queryKey: ["/api/mcp-servers"],
  });

  const openCreate = () => {
    setEditingServer(null);
    setForm({ name: "", command: "", args: "[]", env: "{}", transport: "stdio", sseUrl: "" });
    setDialogOpen(true);
  };

  const openEdit = (s: McpServer) => {
    setEditingServer(s);
    setForm({ name: s.name, command: s.command, args: s.args || "[]", env: s.env || "{}", transport: s.transport, sseUrl: s.sseUrl || "" });
    setDialogOpen(true);
  };

  const createMutation = useMutation({
    mutationFn: (data: typeof form) => apiRequest("POST", "/api/mcp-servers", data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/mcp-servers"] }); setDialogOpen(false); toast({ title: "MCP server created" }); },
    onError: () => toast({ title: "Failed to create MCP server", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: typeof form }) => apiRequest("PATCH", `/api/mcp-servers/${id}`, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/mcp-servers"] }); setDialogOpen(false); toast({ title: "MCP server updated" }); },
    onError: () => toast({ title: "Failed to update MCP server", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/mcp-servers/${id}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/mcp-servers"] }); setDeleteId(null); toast({ title: "MCP server deleted" }); },
    onError: () => toast({ title: "Delete failed", variant: "destructive" }),
  });

  const connectMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/mcp-servers/${id}/connect`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/mcp-servers"] }); toast({ title: "Connected" }); },
    onError: () => toast({ title: "Connection failed", variant: "destructive" }),
  });

  const disconnectMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/mcp-servers/${id}/disconnect`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/mcp-servers"] }); toast({ title: "Disconnected" }); },
    onError: () => toast({ title: "Disconnect failed", variant: "destructive" }),
  });

  const handleSubmit = () => {
    if (editingServer) {
      updateMutation.mutate({ id: editingServer.id, data: form });
    } else {
      createMutation.mutate(form);
    }
  };

  const statusDot = (status: string) => {
    if (status === "connected") return "bg-green-500";
    if (status === "error") return "bg-red-500";
    return "bg-zinc-500";
  };

  const statusLabel = (status: string) => {
    if (status === "connected") return "connected";
    if (status === "error") return "error";
    return "disconnected";
  };

  return (
    <Card className="mb-4">
      <CardHeader className="pb-3 pt-4 px-4">
        <CardTitle className="text-sm font-mono flex items-center gap-2 text-primary">
          <Network className="w-4 h-4" />
          MCP SERVERS
          <button
            onClick={() => setExpanded(!expanded)}
            className="ml-auto text-muted-foreground hover:text-foreground"
            data-testid="button-toggle-mcp"
          >
            {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
        </CardTitle>
      </CardHeader>
      {expanded && (
        <CardContent className="px-4 pb-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-muted-foreground">
              Model Context Protocol servers — expose tools to the agent via stdio or SSE transport.
            </p>
            <Button size="sm" onClick={openCreate} data-testid="button-add-mcp-server">
              <Plus className="w-3.5 h-3.5 mr-1" /> Add Server
            </Button>
          </div>

          {isLoading ? (
            <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
          ) : servers.length === 0 ? (
            <div className="text-center py-6 text-xs text-muted-foreground">
              <Network className="w-8 h-8 mx-auto mb-2 opacity-20" />
              No MCP servers configured
            </div>
          ) : (
            <div className="space-y-2">
              {servers.map(server => (
                <div
                  key={server.id}
                  className="border border-zinc-800 rounded-md px-3 py-2 flex items-center gap-2 bg-zinc-900/50"
                  data-testid={`mcp-server-${server.id}`}
                >
                  <div className={`w-2 h-2 rounded-full shrink-0 ${statusDot(server.status)}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium truncate">{server.name}</span>
                      <Badge variant="outline" className="text-[10px] border-zinc-700 text-zinc-400 shrink-0">
                        {server.transport}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={`text-[10px] shrink-0 ${
                          server.status === "connected"
                            ? "border-green-500/30 text-green-400"
                            : server.status === "error"
                            ? "border-red-500/30 text-red-400"
                            : "border-zinc-600 text-zinc-500"
                        }`}
                      >
                        {statusLabel(server.status)}
                      </Badge>
                      {server.toolCount !== undefined && server.toolCount > 0 && (
                        <Badge variant="outline" className="text-[10px] border-cyan-500/30 text-cyan-400 shrink-0">
                          {server.toolCount} tools
                        </Badge>
                      )}
                    </div>
                    <p className="text-[10px] text-zinc-500 font-mono truncate mt-0.5">
                      {server.transport === "sse" ? server.sseUrl : server.command}
                    </p>
                    {server.error && (
                      <p className="text-[10px] text-red-400 mt-0.5 truncate">{server.error}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {server.status === "connected" ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => disconnectMutation.mutate(server.id)}
                        disabled={disconnectMutation.isPending}
                        title="Disconnect"
                        data-testid={`button-disconnect-mcp-${server.id}`}
                      >
                        <PowerOff className="w-3.5 h-3.5 text-yellow-500" />
                      </Button>
                    ) : (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => connectMutation.mutate(server.id)}
                        disabled={connectMutation.isPending}
                        title="Connect"
                        data-testid={`button-connect-mcp-${server.id}`}
                      >
                        <Power className="w-3.5 h-3.5 text-green-500" />
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => openEdit(server)}
                      data-testid={`button-edit-mcp-${server.id}`}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => setDeleteId(server.id)}
                      data-testid={`button-delete-mcp-${server.id}`}
                    >
                      <Trash2 className="w-3.5 h-3.5 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm font-mono text-primary">
              {editingServer ? "Edit MCP Server" : "Add MCP Server"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label className="text-xs">Name</Label>
              <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="My MCP Server" className="text-xs" data-testid="input-mcp-name" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Transport</Label>
              <Select value={form.transport} onValueChange={v => setForm(f => ({ ...f, transport: v as "stdio" | "sse" }))}>
                <SelectTrigger className="text-xs" data-testid="select-mcp-transport">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stdio">stdio</SelectItem>
                  <SelectItem value="sse">SSE (HTTP)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.transport === "sse" ? (
              <div className="space-y-1">
                <Label className="text-xs">SSE URL</Label>
                <Input value={form.sseUrl} onChange={e => setForm(f => ({ ...f, sseUrl: e.target.value }))}
                  placeholder="http://localhost:8080/sse" className="text-xs font-mono" data-testid="input-mcp-sse-url" />
              </div>
            ) : (
              <>
                <div className="space-y-1">
                  <Label className="text-xs">Command</Label>
                  <Input value={form.command} onChange={e => setForm(f => ({ ...f, command: e.target.value }))}
                    placeholder="npx @modelcontextprotocol/server-filesystem" className="text-xs font-mono" data-testid="input-mcp-command" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Args (JSON array)</Label>
                  <Input value={form.args} onChange={e => setForm(f => ({ ...f, args: e.target.value }))}
                    placeholder='["/path/to/dir"]' className="text-xs font-mono" data-testid="input-mcp-args" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Env vars (JSON object)</Label>
                  <Input value={form.env} onChange={e => setForm(f => ({ ...f, env: e.target.value }))}
                    placeholder='{"API_KEY": "value"}' className="text-xs font-mono" data-testid="input-mcp-env" />
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={handleSubmit}
              disabled={!form.name || (form.transport === "sse" ? !form.sseUrl : !form.command) || createMutation.isPending || updateMutation.isPending}
              data-testid="button-submit-mcp">
              {(createMutation.isPending || updateMutation.isPending) ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : editingServer ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <AlertDialog open={deleteId !== null} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">Delete MCP Server?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">This will remove the server configuration. This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild><Button variant="ghost" size="sm">Cancel</Button></AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button variant="destructive" size="sm" onClick={() => deleteId && deleteMutation.mutate(deleteId)}
                data-testid="button-confirm-delete-mcp">
                Delete
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// ── ComfyUI / Image Generation Section ──────────────────────
function ComfyUISection({
  host, setHost, port, setPort,
  defaultCheckpoint, setDefaultCheckpoint,
  defaultUpscaleModel, setDefaultUpscaleModel,
  autoApprove, setAutoApprove,
  maxConcurrent, setMaxConcurrent,
  testResult, setTestResult,
  testing, setTesting,
  saveSettings,
}: {
  host: string; setHost: (v: string) => void;
  port: string; setPort: (v: string) => void;
  defaultCheckpoint: string; setDefaultCheckpoint: (v: string) => void;
  defaultUpscaleModel: string; setDefaultUpscaleModel: (v: string) => void;
  autoApprove: boolean; setAutoApprove: (v: boolean) => void;
  maxConcurrent: string; setMaxConcurrent: (v: string) => void;
  testResult: null | { connected: boolean; message?: string };
  setTestResult: (v: null | { connected: boolean; message?: string }) => void;
  testing: boolean; setTesting: (v: boolean) => void;
  saveSettings: (extra?: Record<string, string>) => void;
}) {
  const { data: comfyModels } = useQuery<{ checkpoints?: string[]; upscale_models?: string[] }>({
    queryKey: ["/api/comfyui/models"],
    retry: false,
    staleTime: 60_000,
  });

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await apiRequest("GET", "/api/comfyui/status");
      const data = await res.json();
      setTestResult({ connected: data.connected ?? false, message: data.message });
    } catch {
      setTestResult({ connected: false, message: "Request failed" });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card className="mb-4" data-testid="comfyui-section">
      <CardHeader className="pb-3 pt-4 px-4">
        <CardTitle className="text-sm font-mono flex items-center gap-2 text-primary">
          <ImageIcon className="w-4 h-4" />
          COMFYUI / IMAGE GENERATION
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        {/* Host + Port */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">ComfyUI Host</Label>
            <Input
              value={host}
              onChange={e => setHost(e.target.value)}
              onBlur={() => saveSettings({ comfyuiHost: host })}
              placeholder="127.0.0.1"
              className="text-xs font-mono"
              data-testid="input-comfyui-host"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">ComfyUI Port</Label>
            <Input
              type="number"
              value={port}
              onChange={e => setPort(e.target.value)}
              onBlur={() => saveSettings({ comfyuiPort: port })}
              placeholder="8188"
              className="text-xs font-mono"
              data-testid="input-comfyui-port"
            />
          </div>
        </div>

        {/* Test Connection */}
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            className="text-xs h-7 gap-1.5"
            onClick={handleTestConnection}
            disabled={testing}
            data-testid="button-test-comfyui"
          >
            {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wifi className="w-3.5 h-3.5" />}
            Test Connection
          </Button>
          {testResult !== null && (
            <div className={`flex items-center gap-1.5 text-xs font-mono ${
              testResult.connected ? "text-green-400" : "text-red-400"
            }`}>
              {testResult.connected
                ? <CheckCircle2 className="w-3.5 h-3.5" />
                : <XCircle className="w-3.5 h-3.5" />}
              {testResult.connected ? "Connected" : (testResult.message ?? "Offline")}
            </div>
          )}
        </div>

        {/* Default Checkpoint */}
        <div className="space-y-1">
          <Label className="text-xs">Default Checkpoint</Label>
          <Select
            value={defaultCheckpoint || "__none"}
            onValueChange={v => {
              const val = v === "__none" ? "" : v;
              setDefaultCheckpoint(val);
              saveSettings({ comfyuiDefaultCheckpoint: val });
            }}
          >
            <SelectTrigger className="text-xs font-mono" data-testid="select-default-checkpoint">
              <SelectValue placeholder="Select checkpoint..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none" className="text-xs text-muted-foreground">None</SelectItem>
              {(comfyModels?.checkpoints ?? []).map(m => (
                <SelectItem key={m} value={m} className="text-xs font-mono">{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Default Upscale Model */}
        <div className="space-y-1">
          <Label className="text-xs">Default Upscale Model</Label>
          <Select
            value={defaultUpscaleModel || "__none"}
            onValueChange={v => {
              const val = v === "__none" ? "" : v;
              setDefaultUpscaleModel(val);
              saveSettings({ comfyuiDefaultUpscaleModel: val });
            }}
          >
            <SelectTrigger className="text-xs font-mono" data-testid="select-default-upscale">
              <SelectValue placeholder="Select upscale model..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none" className="text-xs text-muted-foreground">None</SelectItem>
              {(comfyModels?.upscale_models ?? []).map(m => (
                <SelectItem key={m} value={m} className="text-xs font-mono">{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Auto-approve */}
        <div className="flex items-center justify-between py-0.5">
          <div>
            <Label className="text-xs">Auto-approve generation</Label>
            <p className="text-[10px] text-muted-foreground mt-0.5">Start generation without confirmation prompt</p>
          </div>
          <Switch
            checked={autoApprove}
            onCheckedChange={v => {
              setAutoApprove(v);
              saveSettings({ comfyuiAutoApprove: String(v) });
            }}
            data-testid="switch-comfyui-auto-approve"
          />
        </div>

        {/* Max concurrent */}
        <div className="space-y-1">
          <Label className="text-xs">Max Concurrent Generations</Label>
          <Input
            type="number"
            value={maxConcurrent}
            onChange={e => setMaxConcurrent(e.target.value)}
            onBlur={() => saveSettings({ comfyuiMaxConcurrent: maxConcurrent })}
            min={1}
            max={8}
            className="text-xs font-mono w-24"
            data-testid="input-comfyui-max-concurrent"
          />
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main Settings Page ───────────────────────────────────────
export default function SettingsPage() {
  const { toast } = useToast();
  const [deleteEndpointId, setDeleteEndpointId] = useState<number | null>(null);
  const [addEndpointOpen, setAddEndpointOpen] = useState(false);
  const [newEndpoint, setNewEndpoint] = useState({ name: "", url: "http://localhost:1234", providerType: "lmstudio", apiKey: "", isOrchestrator: false, parallelSlots: 1 });

  // Settings state
  const [searxngUrl, setSearxngUrl] = useState("");
  const [searxngEnabled, setSearxngEnabled] = useState(false);
  const [autoRouting, setAutoRouting] = useState(false);
  const [autoApproveSkills, setAutoApproveSkills] = useState(false);
  const [appStoreConfirm, setAppStoreConfirm] = useState(true);
  const [largePasteThreshold, setLargePasteThreshold] = useState(5000);
  const [execTimeout, setExecTimeout] = useState(30);
  const [memoryLimit, setMemoryLimit] = useState(512);
  const [cpuLimit, setCpuLimit] = useState(1.0);
  const [contextTokenBudget, setContextTokenBudget] = useState(96000);

  // Agent Personality
  const [agentName, setAgentName] = useState("Agent2077");
  const [maxIterations, setMaxIterations] = useState("90");
  const [maxFailedToolCalls, setMaxFailedToolCalls] = useState("4");
  const [personalityPrompt, setPersonalityPrompt] = useState("");
  const [askClarification, setAskClarification] = useState(true);

  // ComfyUI settings
  const [comfyuiHost, setComfyuiHost] = useState("127.0.0.1");
  const [comfyuiPort, setComfyuiPort] = useState("8188");
  const [comfyuiDefaultCheckpoint, setComfyuiDefaultCheckpoint] = useState("");
  const [comfyuiDefaultUpscaleModel, setComfyuiDefaultUpscaleModel] = useState("");
  const [comfyuiAutoApprove, setComfyuiAutoApprove] = useState(false);
  const [comfyuiMaxConcurrent, setComfyuiMaxConcurrent] = useState("1");
  const [comfyuiTestResult, setComfyuiTestResult] = useState<null | { connected: boolean; message?: string }>(null);
  const [comfyuiTesting, setComfyuiTesting] = useState(false);

  // Kill switch + self-dev
  const [internetKillSwitch, setInternetKillSwitch] = useState(false);
  const [selfDevEnabled, setSelfDevEnabled] = useState(false);
  const [selfDevCodingModel, setSelfDevCodingModel] = useState("");
  const [selfDevOrchModel, setSelfDevOrchModel] = useState("");
  const [selfDevAutoApproveSkills, setSelfDevAutoApproveSkills] = useState(false);

  // Network Security
  const [lanServing, setLanServing] = useState(false);
  const [httpsEnabled, setHttpsEnabled] = useState(false);

  // Storage / Paths
  const [projectsRoot, setProjectsRoot] = useState("");
  const [dbPathInfo, setDbPathInfo] = useState<{ active: string; pending: string } | null>(null);
  const [pendingDbPath, setPendingDbPath] = useState("");
  const [showWorkspaceChatsInSidebar, setShowWorkspaceChatsInSidebar] = useState(false);
  const [dbPathSaving, setDbPathSaving] = useState(false);

  // Account
  const [username, setUsername] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");

  // SSH Targets
  const [sshTargets, setSshTargets] = useState<SshTarget[]>([]);
  const [sshAddOpen, setSshAddOpen] = useState(false);
  const [sshNewTarget, setSshNewTarget] = useState<Omit<SshTarget, "id">>({ name: "", host: "", user: "", password: "", port: 22 });

  const { data: endpoints = [], isLoading: endpointsLoading } = useQuery<Endpoint[]>({ queryKey: ["/api/endpoints"] });
  const { data: models = [] } = useQuery<Model[]>({ queryKey: ["/api/models"] });
  const { data: settingsData } = useQuery<Record<string, string>>({
    queryKey: ["/api/settings"],
  });

  useEffect(() => {
    if (!settingsData) return;
    if (settingsData["searxng.url"]) setSearxngUrl(settingsData["searxng.url"]);
    if (settingsData["searxng.enabled"]) setSearxngEnabled(settingsData["searxng.enabled"] === "true");
    if (settingsData["autoRouting"]) setAutoRouting(settingsData["autoRouting"] === "true");
    if (settingsData["skills.autoApprove"]) setAutoApproveSkills(settingsData["skills.autoApprove"] === "true");
    if (settingsData["agent.appStoreConfirm"] !== undefined) setAppStoreConfirm(settingsData["agent.appStoreConfirm"] !== "false");
    if (settingsData["input.largePasteThreshold"]) setLargePasteThreshold(Number(settingsData["input.largePasteThreshold"]) || 5000);
    if (settingsData["docker.executionTimeout"]) setExecTimeout(Number(settingsData["docker.executionTimeout"]));
    if (settingsData["docker.memoryLimit"]) setMemoryLimit(parseInt(settingsData["docker.memoryLimit"]) || 512);
    if (settingsData["docker.cpuLimit"]) setCpuLimit(Number(settingsData["docker.cpuLimit"]) || 1);
    if (settingsData["contextTokenBudget"]) setContextTokenBudget(Number(settingsData["contextTokenBudget"]) || 96000);
    if (settingsData["agent.name"]) setAgentName(settingsData["agent.name"]);
    if (settingsData["agent.maxIterations"]) setMaxIterations(settingsData["agent.maxIterations"]);
    if (settingsData["agent.maxFailedToolCalls"]) setMaxFailedToolCalls(settingsData["agent.maxFailedToolCalls"]);
    if (settingsData["agent.personalityPrompt"] !== undefined) setPersonalityPrompt(settingsData["agent.personalityPrompt"] || "");
    if (settingsData["agent.askClarification"] !== undefined) setAskClarification(settingsData["agent.askClarification"] !== "false");
    if (settingsData["internetEnabled"] !== undefined) setInternetKillSwitch(settingsData["internetEnabled"] === "false");
    if (settingsData["selfDevEnabled"] !== undefined) setSelfDevEnabled(settingsData["selfDevEnabled"] === "true");
    if (settingsData["selfDevCodingModel"] !== undefined) setSelfDevCodingModel(settingsData["selfDevCodingModel"] || "");
    if (settingsData["selfDevOrchModel"] !== undefined) setSelfDevOrchModel(settingsData["selfDevOrchModel"] || "");
    if (settingsData["selfDevAutoApproveSkills"] !== undefined) setSelfDevAutoApproveSkills(settingsData["selfDevAutoApproveSkills"] === "true");
    if (settingsData["comfyuiHost"]) setComfyuiHost(settingsData["comfyuiHost"]);
    if (settingsData["comfyuiPort"]) setComfyuiPort(settingsData["comfyuiPort"]);
    if (settingsData["comfyuiDefaultCheckpoint"] !== undefined) setComfyuiDefaultCheckpoint(settingsData["comfyuiDefaultCheckpoint"] || "");
    if (settingsData["comfyuiDefaultUpscaleModel"] !== undefined) setComfyuiDefaultUpscaleModel(settingsData["comfyuiDefaultUpscaleModel"] || "");
    if (settingsData["comfyuiAutoApprove"] !== undefined) setComfyuiAutoApprove(settingsData["comfyuiAutoApprove"] === "true");
    if (settingsData["comfyuiMaxConcurrent"]) setComfyuiMaxConcurrent(settingsData["comfyuiMaxConcurrent"]);
    if (settingsData["network.lanServing"] !== undefined) setLanServing(settingsData["network.lanServing"] === "true");
    if (settingsData["network.httpsEnabled"] !== undefined) setHttpsEnabled(settingsData["network.httpsEnabled"] === "true");
    if (settingsData["paths.projectsRoot"] !== undefined) setProjectsRoot(settingsData["paths.projectsRoot"] || "");
    if (settingsData["paths.showWorkspaceChatsInSidebar"] !== undefined) setShowWorkspaceChatsInSidebar(settingsData["paths.showWorkspaceChatsInSidebar"] === "true");
    // SSH targets
    try {
      const raw = settingsData["ssh.targets"];
      if (raw) setSshTargets(JSON.parse(raw));
    } catch { /* ignore */ }
  }, [settingsData]);

  // Fetch DB path info once on mount
  useEffect(() => {
    apiRequest("GET", "/api/settings/db-path")
      .then(r => r.json())
      .then(d => {
        setDbPathInfo(d);
        setPendingDbPath(d.pending || "");
      })
      .catch(() => {});
  }, []);

  const { data: dockerStatus } = useQuery<{ ready: boolean; running: number; total: number }>({ queryKey: ["/api/docker/status"] });

  const createEndpointMutation = useMutation({
    mutationFn: (data: typeof newEndpoint) => apiRequest("POST", "/api/endpoints", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/endpoints"] });
      setAddEndpointOpen(false);
      setNewEndpoint({ name: "", url: "http://localhost:1234", providerType: "lmstudio", apiKey: "", isOrchestrator: false, parallelSlots: 1 });
      toast({ title: "Endpoint created" });
    },
    onError: () => toast({ title: "Failed to create endpoint", variant: "destructive" }),
  });

  const deleteEndpointMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/endpoints/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/endpoints"] });
      setDeleteEndpointId(null);
      toast({ title: "Endpoint deleted" });
    },
    onError: () => toast({ title: "Delete failed", variant: "destructive" }),
  });

  const updateSettingsMutation = useMutation({
    mutationFn: (data: Record<string, string>) => apiRequest("PATCH", "/api/settings", data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/settings"] }); toast({ title: "Settings saved" }); },
    onError: () => toast({ title: "Save failed", variant: "destructive" }),
  });

  const sshPersistMutation = useMutation({
    mutationFn: (updated: SshTarget[]) =>
      apiRequest("PATCH", "/api/settings", { "ssh.targets": JSON.stringify(updated) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/settings"] }); toast({ title: "SSH targets saved" }); },
    onError: () => toast({ title: "Failed to save SSH targets", variant: "destructive" }),
  });

  function sshPersist(updated: SshTarget[]) {
    setSshTargets(updated);
    sshPersistMutation.mutate(updated);
  }

  function sshAddTarget() {
    const uuid = typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const t: SshTarget = { ...sshNewTarget, id: uuid, port: sshNewTarget.port || 22 };
    sshPersist([...sshTargets, t]);
    setSshNewTarget({ name: "", host: "", user: "", password: "", port: 22 });
    setSshAddOpen(false);
  }

  function sshUpdateTarget(updated: SshTarget) {
    sshPersist(sshTargets.map(t => (t.id === updated.id ? updated : t)));
  }

  function sshDeleteTarget(id: string) {
    sshPersist(sshTargets.filter(t => t.id !== id));
  }

  const testSearchMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/search/test", { url: searxngUrl }),
    onSuccess: async (res) => {
      const data = await res.json();
      toast({ title: data.success ? "SearXNG connection OK" : "SearXNG test failed", variant: data.success ? "default" : "destructive" });
    },
    onError: () => toast({ title: "Test failed", variant: "destructive" }),
  });

  const changePasswordMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/auth/change-password", { currentPassword, newPassword }),
    onSuccess: () => { setCurrentPassword(""); setNewPassword(""); toast({ title: "Password changed" }); },
    onError: () => toast({ title: "Password change failed", variant: "destructive" }),
  });

  const changeUsernameMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/auth/change-username", { newUsername: username }),
    onSuccess: () => { setUsername(""); toast({ title: "Username changed" }); },
    onError: () => toast({ title: "Username change failed", variant: "destructive" }),
  });

  const saveSettings = (extra?: Record<string, string>) => {
    updateSettingsMutation.mutate({
      "searxng.url": searxngUrl,
      "searxng.enabled": String(searxngEnabled),
      "autoRouting": String(autoRouting),
      "skills.autoApprove": String(autoApproveSkills),
      "docker.executionTimeout": String(execTimeout),
      "docker.memoryLimit": String(memoryLimit) + "m",
      "docker.cpuLimit": String(cpuLimit),
      "contextTokenBudget": String(contextTokenBudget),
      "agent.name": agentName,
      "agent.maxIterations": maxIterations,
      "agent.maxFailedToolCalls": maxFailedToolCalls,
      "agent.personalityPrompt": personalityPrompt,
      "comfyuiHost": comfyuiHost,
      "comfyuiPort": comfyuiPort,
      "comfyuiDefaultCheckpoint": comfyuiDefaultCheckpoint,
      "comfyuiDefaultUpscaleModel": comfyuiDefaultUpscaleModel,
      "comfyuiAutoApprove": String(comfyuiAutoApprove),
      "comfyuiMaxConcurrent": comfyuiMaxConcurrent,
      ...extra,
    });
  };

  return (
    <div className="h-full overflow-y-auto p-4 max-w-3xl mx-auto" data-testid="settings-page">
      <div className="mb-4">
        <h1 className="text-base font-mono font-bold text-primary">SETTINGS</h1>
        <p className="text-xs text-muted-foreground mt-0.5">Configure Agent2077 system parameters</p>
      </div>

      {/* Internet Kill Switch */}
      <Card className="border-red-500/30 bg-red-950/10 mb-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-mono flex items-center gap-2 text-red-400">
            <Shield className="w-4 h-4" />
            INTERNET KILL SWITCH
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">
                When enabled, Agent2077 cannot access the internet. All web search and browsing tools are disabled.
                Only local network and LM Studio connections are allowed.
              </p>
            </div>
            <Switch
              checked={internetKillSwitch}
              onCheckedChange={(v) => {
                setInternetKillSwitch(v);
                saveSettings({ "internetEnabled": String(!v) });
              }}
              data-testid="switch-internet-kill"
            />
          </div>
          <div className={`mt-2 text-xs font-medium ${internetKillSwitch ? "text-red-400" : "text-green-400"}`}>
            {internetKillSwitch ? "🔒 Internet BLOCKED — local only" : "🌐 Internet ENABLED"}
          </div>
        </CardContent>
      </Card>

      {/* Selected Models — all enabled models across all endpoints */}
      <Section title="SELECTED MODELS" icon={CheckCircle2}>
        {(() => {
          const enabledModels = models.filter(m => m.isEnabled);
          if (enabledModels.length === 0) {
            return <p className="text-xs text-muted-foreground">No models enabled. Expand an endpoint below and enable models.</p>;
          }
          const uniqueEndpoints = new Set(enabledModels.map(m => m.endpointId)).size;
          return (
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground mb-2">{enabledModels.length} model{enabledModels.length !== 1 ? "s" : ""} enabled across {uniqueEndpoints} endpoint{uniqueEndpoints !== 1 ? "s" : ""}</p>
              <div className="divide-y divide-border border border-border rounded-md overflow-hidden">
                {enabledModels.map(model => {
                  const ep = endpoints.find(e => e.id === model.endpointId);
                  return (
                    <SelectedModelRow key={model.id} model={model} endpointName={ep?.name} />
                  );
                })}
              </div>
            </div>
          );
        })()}
      </Section>

      {/* API Endpoints */}
      <Section title="API ENDPOINTS" icon={Server}>
        {endpointsLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading endpoints...
          </div>
        ) : (
          <div className="space-y-2">
            {endpoints.map(ep => (
              <EndpointRow
                key={ep.id}
                endpoint={ep}
                models={models}
                onDelete={() => setDeleteEndpointId(ep.id)}
              />
            ))}
            {endpoints.length === 0 && (
              <p className="text-xs text-muted-foreground">No endpoints configured. Add an LM Studio instance below.</p>
            )}
            <Button size="sm" variant="outline" onClick={() => setAddEndpointOpen(true)} className="w-full" data-testid="button-add-endpoint">
              <Plus className="w-3.5 h-3.5 mr-1" /> Add Endpoint
            </Button>
          </div>
        )}
      </Section>

      {/* SearXNG */}
      <Section title="SEARXNG SEARCH" icon={Search}>
        <div className="flex items-center gap-2">
          <Input
            value={searxngUrl}
            onChange={e => setSearxngUrl(e.target.value)}
            placeholder="http://localhost:8888"
            className="text-xs flex-1"
            data-testid="input-searxng-url"
          />
          <Switch checked={searxngEnabled} onCheckedChange={v => { setSearxngEnabled(v); saveSettings({ "searxng.enabled": String(v) }); }} data-testid="switch-searxng-enabled" />
          <Button size="sm" variant="outline" onClick={() => testSearchMutation.mutate()} disabled={testSearchMutation.isPending} data-testid="button-test-search">
            {testSearchMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Test"}
          </Button>
          <Button size="sm" onClick={() => saveSettings()} data-testid="button-save-searxng">Save</Button>
        </div>
      </Section>

      {/* Storage / Paths */}
      <Section title="STORAGE & PATHS" icon={FolderOpen}>
        <div className="space-y-5">

          {/* Projects Root */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Workspace Projects Folder</Label>
            <p className="text-[10px] text-muted-foreground">Where new workspace projects are created. Defaults to <code className="bg-muted px-1 rounded">~/projects</code> when left blank.</p>
            <div className="flex gap-2">
              <Input
                value={projectsRoot}
                onChange={e => setProjectsRoot(e.target.value)}
                placeholder="~/projects"
                className="text-xs font-mono"
                data-testid="input-projects-root"
              />
              <Button size="sm" onClick={() => updateSettingsMutation.mutate({ "paths.projectsRoot": projectsRoot })} data-testid="button-save-projects-root">
                Save
              </Button>
            </div>
          </div>

          <Separator />

          {/* Chat DB Path */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-muted-foreground" />
              <Label className="text-xs font-medium">Chat Database Location</Label>
            </div>
            <p className="text-[10px] text-muted-foreground">
              All chats and messages are stored in a SQLite database. Changes take effect on next restart.
            </p>
            {dbPathInfo && (
              <div className="text-[10px] font-mono bg-muted/40 rounded px-2 py-1.5 text-muted-foreground break-all">
                Active: {dbPathInfo.active}
                {dbPathInfo.pending && dbPathInfo.pending !== dbPathInfo.active && (
                  <span className="ml-2 text-amber-400">(pending restart: {dbPathInfo.pending})</span>
                )}
              </div>
            )}
            <div className="flex gap-2">
              <Input
                value={pendingDbPath}
                onChange={e => setPendingDbPath(e.target.value)}
                placeholder="/path/to/agent2077.db (leave blank for default)"
                className="text-xs font-mono"
                data-testid="input-db-path"
              />
              <Button
                size="sm"
                disabled={dbPathSaving}
                onClick={async () => {
                  setDbPathSaving(true);
                  try {
                    const r = await apiRequest("POST", "/api/settings/db-path", { dbPath: pendingDbPath });
                    const d = await r.json();
                    toast({ title: d.message });
                    // Re-fetch to update displayed paths
                    const info = await apiRequest("GET", "/api/settings/db-path").then(r2 => r2.json());
                    setDbPathInfo(info);
                  } catch { toast({ title: "Failed to save DB path", variant: "destructive" }); }
                  finally { setDbPathSaving(false); }
                }}
                data-testid="button-save-db-path"
              >
                {dbPathSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : "Save"}
              </Button>
            </div>
          </div>

          <Separator />

          {/* Workspace chats in sidebar */}
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-xs font-medium">Show workspace chats in sidebar</Label>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                When enabled, chats linked to workspace projects appear in the main chat sidebar.
              </p>
            </div>
            <Switch
              checked={showWorkspaceChatsInSidebar}
              onCheckedChange={(v) => {
                setShowWorkspaceChatsInSidebar(v);
                updateSettingsMutation.mutate({ "paths.showWorkspaceChatsInSidebar": String(v) });
                queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
              }}
              data-testid="switch-workspace-chats-sidebar"
            />
          </div>

        </div>
      </Section>

      {/* Network Security */}
      <Section title="NETWORK SECURITY" icon={Shield}>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-xs font-medium">LAN Serving</Label>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Bind to 0.0.0.0 so devices on your local network can reach Agent2077.
                Off = localhost only (safer default). <strong>Requires restart.</strong>
              </p>
            </div>
            <Switch
              checked={lanServing}
              onCheckedChange={v => {
                setLanServing(v);
                updateSettingsMutation.mutate({ "network.lanServing": String(v) });
              }}
              data-testid="switch-lan-serving"
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-xs font-medium">HTTPS / TLS</Label>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Encrypt LAN traffic with a self-signed certificate generated on first run.
                You will need to accept the browser security warning once. <strong>Requires restart.</strong>
              </p>
            </div>
            <Switch
              checked={httpsEnabled}
              onCheckedChange={v => {
                setHttpsEnabled(v);
                updateSettingsMutation.mutate({ "network.httpsEnabled": String(v) });
              }}
              data-testid="switch-https-enabled"
            />
          </div>
          {httpsEnabled && (
            <p className="text-[10px] text-yellow-400/80 bg-yellow-950/30 border border-yellow-500/20 rounded px-2 py-1.5">
              After enabling HTTPS, change your browser URL from http:// to https://.
              To add to Ubuntu trust store: sudo cp data/tls/server.crt /usr/local/share/ca-certificates/agent2077.crt && sudo update-ca-certificates
            </p>
          )}
        </div>
      </Section>

      {/* Auto Routing */}
      <Section title="AUTO ROUTING" icon={Zap}>
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-xs font-medium">Autonomous Model Routing</Label>
            <p className="text-[10px] text-muted-foreground mt-0.5">Automatically select the best model based on task type</p>
          </div>
          <Switch
            checked={autoRouting}
            onCheckedChange={v => { setAutoRouting(v); saveSettings({ "autoRouting": String(v) }); }}
            data-testid="switch-auto-routing"
          />
        </div>
      </Section>

      {/* Agent Context */}
      <Section title="AGENT CONTEXT" icon={Brain}>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Context Compression Threshold</Label>
            <p className="text-[10px] text-muted-foreground">Compress conversation history when estimated tokens exceed this number. Set to 75% of your model's context window.</p>
            <div className="flex gap-1.5 flex-wrap mt-1">
              {([96000, 196000, 375000, 750000] as const).map((preset) => (
                <button
                  key={preset}
                  onClick={() => setContextTokenBudget(preset)}
                  className={`text-[10px] px-2 py-1 rounded border font-mono transition-colors ${
                    contextTokenBudget === preset
                      ? "border-primary text-primary bg-primary/10"
                      : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                  }`}
                >
                  {preset >= 1000000 ? `${(preset/1000000).toFixed(2)}M` : `${Math.round(preset/1000)}k`}
                  <span className="ml-1 opacity-60">
                    ({preset === 96000 ? "128k model" : preset === 196000 ? "262k model" : preset === 375000 ? "500k model" : "1M model"})
                  </span>
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <Input
                type="number"
                value={contextTokenBudget}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v) && v > 0) setContextTokenBudget(v);
                }}
                className="h-7 text-xs font-mono w-32"
                placeholder="e.g. 196000"
                data-testid="input-context-token-budget"
              />
              <span className="text-[10px] text-muted-foreground">tokens</span>
            </div>
          </div>
          <Button size="sm" onClick={() => saveSettings({ contextTokenBudget: String(contextTokenBudget) })} data-testid="button-save-context">
            Save Context Settings
          </Button>
        </div>
      </Section>

      {/* Docker */}
      <Section title="DOCKER EXECUTION" icon={Box}>
        <div className="flex items-center gap-2 mb-3">
          <div className={`w-2 h-2 rounded-full ${dockerStatus?.ready ? "bg-green-400" : "bg-red-400"}`} />
          <span className="text-xs text-muted-foreground">
            Docker: {dockerStatus?.ready ? `Connected — ${dockerStatus.running} running / ${dockerStatus.total} total` : "Unavailable"}
          </span>
        </div>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Execution Timeout (seconds)</Label>
              <span className="text-xs font-mono text-primary">{execTimeout}s</span>
            </div>
            <Slider value={[execTimeout]} onValueChange={(vals: number[]) => setExecTimeout(vals[0])} min={5} max={300} step={5} data-testid="slider-exec-timeout" />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Memory Limit (MB)</Label>
              <span className="text-xs font-mono text-primary">{memoryLimit}MB</span>
            </div>
            <Slider value={[memoryLimit]} onValueChange={(vals: number[]) => setMemoryLimit(vals[0])} min={64} max={4096} step={64} data-testid="slider-memory-limit" />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">CPU Limit (cores)</Label>
              <span className="text-xs font-mono text-primary">{cpuLimit.toFixed(1)}</span>
            </div>
            <Slider value={[cpuLimit]} onValueChange={(vals: number[]) => setCpuLimit(vals[0])} min={0.1} max={8} step={0.1} data-testid="slider-cpu-limit" />
          </div>
          <Button size="sm" onClick={() => saveSettings()} data-testid="button-save-docker">Save Docker Settings</Button>
        </div>
      </Section>

      {/* Skills */}
      <Section title="SKILLS" icon={Brain}>
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-xs font-medium">Auto-Approve Skill Saving</Label>
            <p className="text-[10px] text-muted-foreground mt-0.5">Automatically approve skills proposed by the agent</p>
          </div>
          <Switch
            checked={autoApproveSkills}
            onCheckedChange={v => { setAutoApproveSkills(v); saveSettings({ "skills.autoApprove": String(v) }); }}
            data-testid="switch-auto-approve-skills"
          />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-xs font-medium">Confirm App Deployments</Label>
            <p className="text-[10px] text-muted-foreground mt-0.5">Ask for permission before the agent deploys an app to the App Store</p>
          </div>
          <Switch
            checked={appStoreConfirm}
            onCheckedChange={v => { setAppStoreConfirm(v); saveSettings({ "agent.appStoreConfirm": String(v) }); }}
            data-testid="switch-app-store-confirm"
          />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-xs font-medium">Large Paste Threshold</Label>
            <p className="text-[10px] text-muted-foreground mt-0.5">Pastes longer than this many characters are auto-converted to a .txt attachment</p>
          </div>
          <div className="flex items-center gap-1">
            <Input
              type="number"
              min={500}
              max={100000}
              value={largePasteThreshold}
              onChange={e => setLargePasteThreshold(Number(e.target.value))}
              onBlur={() => saveSettings({ "input.largePasteThreshold": String(largePasteThreshold) })}
              className="h-7 text-xs w-24 text-right"
              data-testid="input-large-paste-threshold"
            />
            <span className="text-[10px] text-muted-foreground">chars</span>
          </div>
        </div>
      </Section>

      {/* Agent Personality */}
      <Section title="AGENT PERSONALITY" icon={Bot}>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-xs font-medium">Ask for Clarification</Label>
              <p className="text-[10px] text-muted-foreground">When enabled, the agent will ask you for more details on vague requests before starting work</p>
            </div>
            <Switch
              checked={askClarification}
              onCheckedChange={v => { setAskClarification(v); saveSettings({ "agent.askClarification": String(v) }); }}
              data-testid="switch-ask-clarification"
            />
          </div>
          <Separator />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Agent Name</Label>
              <p className="text-[10px] text-muted-foreground mt-0.5">How the agent refers to itself</p>
              <Input
                value={agentName}
                onChange={e => setAgentName(e.target.value)}
                placeholder="Agent2077"
                data-testid="input-agent-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Max Iterations</Label>
              <p className="text-[10px] text-muted-foreground mt-0.5">Steps per task (10–500, default 90)</p>
              <Input
                type="number"
                value={maxIterations}
                onChange={e => setMaxIterations(e.target.value)}
                onBlur={e => {
                  const v = parseInt(e.target.value);
                  if (isNaN(v) || v < 10) setMaxIterations("10");
                  else if (v > 500) setMaxIterations("500");
                  else setMaxIterations(String(v));
                }}
                placeholder="90"
                min={10}
                max={500}
                data-testid="input-max-iterations"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Max Consecutive Failed Tool Calls</Label>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Halt the agent after this many tool calls fail back-to-back (1–50, default 4). Raise this if complex tasks keep tripping the give-up threshold.
            </p>
            <Input
              type="number"
              value={maxFailedToolCalls}
              onChange={e => setMaxFailedToolCalls(e.target.value)}
              onBlur={e => {
                const v = parseInt(e.target.value);
                if (isNaN(v) || v < 1) setMaxFailedToolCalls("1");
                else if (v > 50) setMaxFailedToolCalls("50");
                else setMaxFailedToolCalls(String(v));
              }}
              placeholder="4"
              min={1}
              max={50}
              className="w-32"
              data-testid="input-max-failed-tool-calls"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Personality Prompt</Label>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Custom instructions that shape the agent's personality, tone, and behavior. This is injected into every conversation's system prompt.
            </p>
            <Textarea
              value={personalityPrompt}
              onChange={e => setPersonalityPrompt(e.target.value)}
              placeholder="e.g. You are a friendly and witty AI assistant. Respond with dry humor and always suggest the most efficient solution..."
              className="min-h-[100px] text-xs"
              data-testid="textarea-personality-prompt"
            />
          </div>
          <Button
            size="sm"
            onClick={() => saveSettings({ "agent.name": agentName, "agent.maxIterations": maxIterations, "agent.maxFailedToolCalls": maxFailedToolCalls, "agent.personalityPrompt": personalityPrompt })}
            data-testid="button-save-personality"
          >
            <Save className="w-3 h-3 mr-2" />
            Save Personality
          </Button>
        </div>
      </Section>

      {/* Account */}
      <Section title="ACCOUNT" icon={User}>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Change Username</Label>
            <div className="flex gap-2">
              <Input
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="New username"
                className="text-xs"
                data-testid="input-new-username"
              />
              <Button size="sm" onClick={() => changeUsernameMutation.mutate()} disabled={!username || changeUsernameMutation.isPending} data-testid="button-change-username">
                {changeUsernameMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Update"}
              </Button>
            </div>
          </div>
          <Separator />
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Change Password</Label>
            <Input
              type="password"
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              placeholder="Current password"
              className="text-xs"
              data-testid="input-current-password"
            />
            <Input
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              placeholder="New password"
              className="text-xs"
              data-testid="input-new-password"
            />
            <Button size="sm" onClick={() => changePasswordMutation.mutate()} disabled={!currentPassword || !newPassword || changePasswordMutation.isPending} data-testid="button-change-password">
              {changePasswordMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Change Password"}
            </Button>
          </div>
        </div>
      </Section>

      {/* Self-Development */}
      <Card className="mb-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-mono flex items-center gap-2 text-primary">
            <Cpu className="w-4 h-4" />
            SELF-DEVELOPMENT
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Enable toggle */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">
                Allow Agent2077 to read and modify its own source code. When enabled, the agent can fix bugs,
                add features, and rebuild itself. Changes are backed up automatically.
              </p>
            </div>
            <Switch
              checked={selfDevEnabled}
              onCheckedChange={(v) => {
                setSelfDevEnabled(v);
                saveSettings({ "selfDevEnabled": String(v) });
              }}
              data-testid="switch-self-dev"
            />
          </div>
          <div className={`text-xs font-medium ${selfDevEnabled ? "text-yellow-400" : "text-muted-foreground"}`}>
            {selfDevEnabled ? "⚡ Self-development ENABLED — agent can modify itself" : "Self-development disabled"}
          </div>

          <Separator />

          {/* Coding Model */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Coding Model</Label>
            <p className="text-[10px] text-muted-foreground">Model used for self-dev coding tasks</p>
            <Select
              value={selfDevCodingModel || "__auto__"}
              onValueChange={(v) => {
                const val = v === "__auto__" ? "" : v;
                setSelfDevCodingModel(val);
                saveSettings({ selfDevCodingModel: val });
              }}
            >
              <SelectTrigger className="text-xs" data-testid="select-selfdev-coding-model">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__auto__">(Auto — agent chooses)</SelectItem>
                {models.filter(m => m.isEnabled).map(m => (
                  <SelectItem key={m.id} value={m.modelId}>{shortModelName(m.modelId)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Orchestrator Model */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Orchestrator Model</Label>
            <p className="text-[10px] text-muted-foreground">Model used for orchestrating self-dev tasks</p>
            <Select
              value={selfDevOrchModel || "__auto__"}
              onValueChange={(v) => {
                const val = v === "__auto__" ? "" : v;
                setSelfDevOrchModel(val);
                saveSettings({ selfDevOrchModel: val });
              }}
            >
              <SelectTrigger className="text-xs" data-testid="select-selfdev-orch-model">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__auto__">(Auto — agent chooses)</SelectItem>
                {models.filter(m => m.isEnabled).map(m => (
                  <SelectItem key={m.id} value={m.modelId}>{shortModelName(m.modelId)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Separator />

          {/* Auto-approve skill saves */}
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-xs font-medium">Allow autonomous skill saving</Label>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                When enabled, Agent2077 can save new skills without asking for approval
              </p>
            </div>
            <Switch
              checked={selfDevAutoApproveSkills}
              onCheckedChange={(v) => {
                setSelfDevAutoApproveSkills(v);
                saveSettings({ selfDevAutoApproveSkills: String(v) });
              }}
              data-testid="switch-selfdev-auto-approve-skills"
            />
          </div>
        </CardContent>
      </Card>

      {/* ComfyUI / Image Generation */}
      <ComfyUISection
        host={comfyuiHost}
        setHost={setComfyuiHost}
        port={comfyuiPort}
        setPort={setComfyuiPort}
        defaultCheckpoint={comfyuiDefaultCheckpoint}
        setDefaultCheckpoint={setComfyuiDefaultCheckpoint}
        defaultUpscaleModel={comfyuiDefaultUpscaleModel}
        setDefaultUpscaleModel={setComfyuiDefaultUpscaleModel}
        autoApprove={comfyuiAutoApprove}
        setAutoApprove={setComfyuiAutoApprove}
        maxConcurrent={comfyuiMaxConcurrent}
        setMaxConcurrent={setComfyuiMaxConcurrent}
        testResult={comfyuiTestResult}
        setTestResult={setComfyuiTestResult}
        testing={comfyuiTesting}
        setTesting={setComfyuiTesting}
        saveSettings={saveSettings}
      />

      {/* SSH Targets */}
      <Section title="SSH TARGETS" icon={MonitorDot}>
        <div className="space-y-2">
          <p className="text-[10px] text-muted-foreground">
            Add remote machines the agent can SSH into. Refer to them by name — e.g. "ssh into DGX Spark and set up vLLM".
            Requires <code className="font-mono">sshpass</code> on this machine
            (<code className="font-mono">sudo apt-get install sshpass</code>).
          </p>
          {sshTargets.length === 0 && (
            <div className="text-[11px] text-muted-foreground border border-dashed border-border rounded-md py-4 text-center">
              No SSH targets configured
            </div>
          )}
          {sshTargets.map(t => (
            <SshTargetRow
              key={t.id}
              target={t}
              onUpdate={sshUpdateTarget}
              onDelete={() => sshDeleteTarget(t.id)}
            />
          ))}
          <Button
            size="sm"
            variant="outline"
            className="w-full h-8 text-xs border-dashed"
            onClick={() => setSshAddOpen(true)}
          >
            <Plus className="w-3 h-3 mr-1" /> Add SSH Target
          </Button>
        </div>
      </Section>

      {/* MCP Servers */}
      <McpServerSection />

      {/* Theme */}
      <ThemeSection />

      {/* Add SSH Target Dialog */}
      <Dialog open={sshAddOpen} onOpenChange={setSshAddOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm font-mono text-primary">Add SSH Target</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label className="text-xs">Name</Label>
              <Input
                value={sshNewTarget.name}
                onChange={e => setSshNewTarget(n => ({ ...n, name: e.target.value }))}
                placeholder="e.g. DGX Spark"
                className="text-xs"
              />
              <p className="text-[10px] text-muted-foreground">This is what you tell the agent — "ssh into DGX Spark"</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Host / IP</Label>
                <Input
                  value={sshNewTarget.host}
                  onChange={e => setSshNewTarget(n => ({ ...n, host: e.target.value }))}
                  placeholder="192.168.0.20"
                  className="text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Port</Label>
                <Input
                  type="number"
                  value={sshNewTarget.port}
                  onChange={e => setSshNewTarget(n => ({ ...n, port: Number(e.target.value) }))}
                  className="text-xs"
                  min={1}
                  max={65535}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Username</Label>
              <Input
                value={sshNewTarget.user}
                onChange={e => setSshNewTarget(n => ({ ...n, user: e.target.value }))}
                placeholder="ubuntu"
                className="text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Password</Label>
              <Input
                type="password"
                value={sshNewTarget.password}
                onChange={e => setSshNewTarget(n => ({ ...n, password: e.target.value }))}
                placeholder="SSH password"
                className="text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setSshAddOpen(false)}>Cancel</Button>
            <Button
              size="sm"
              onClick={sshAddTarget}
              disabled={!sshNewTarget.name || !sshNewTarget.host || !sshNewTarget.user || sshPersistMutation.isPending}
            >
              {sshPersistMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Add Target"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Endpoint Dialog */}
      <Dialog open={addEndpointOpen} onOpenChange={setAddEndpointOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm font-mono text-primary">Add API Endpoint</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {/* Quick preset buttons */}
            <div className="flex gap-2 flex-wrap">
              <Button size="sm" variant="outline" className="text-xs flex-1" onClick={() => setNewEndpoint(n => ({ ...n, name: "LM Studio", url: "http://localhost:1234", providerType: "lmstudio", apiKey: "" }))} data-testid="preset-lmstudio">
                <Box className="w-3 h-3 mr-1" /> LM Studio
              </Button>
              <Button size="sm" variant="outline" className="text-xs flex-1 border-green-500/40 text-green-400 hover:bg-green-500/10" onClick={() => setNewEndpoint(n => ({ ...n, name: "OpenAI Compatible", url: "https://api.openai.com/v1", providerType: "openai_compatible", apiKey: "", parallelSlots: 4 }))} data-testid="preset-openai-compatible">
                <Zap className="w-3 h-3 mr-1" /> OpenAI Compatible
              </Button>
              <Button size="sm" variant="outline" className="text-xs flex-1 border-purple-500/40 text-purple-400 hover:bg-purple-500/10" onClick={() => setNewEndpoint(n => ({ ...n, name: "OpenRouter", url: "https://openrouter.ai/api/v1", providerType: "openrouter", apiKey: "", parallelSlots: 4 }))} data-testid="preset-openrouter">
                <Zap className="w-3 h-3 mr-1" /> OpenRouter
              </Button>
            </div>
            <Separator />
            <div className="space-y-1">
              <Label className="text-xs">Provider</Label>
              <Select value={newEndpoint.providerType} onValueChange={v => setNewEndpoint(n => ({ ...n, providerType: v }))}>
                <SelectTrigger className="text-xs" data-testid="select-new-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="lmstudio">LM Studio (Local)</SelectItem>
                  <SelectItem value="openrouter">OpenRouter (Cloud)</SelectItem>
                  <SelectItem value="openai_compatible">OpenAI Compatible</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground">
                Use <strong>OpenAI Compatible</strong> for any provider exposing <code>/v1/chat/completions</code> — OpenAI, Together, Fireworks, Groq, vLLM, Ollama, local gateways, etc. Set the base URL and API key below.
              </p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Name</Label>
              <Input value={newEndpoint.name} onChange={e => setNewEndpoint(n => ({ ...n, name: e.target.value }))} placeholder={newEndpoint.providerType === "openai_compatible" ? "OpenAI Compatible" : newEndpoint.providerType === "openrouter" ? "OpenRouter" : "Local LM Studio"} className="text-xs" data-testid="input-new-endpoint-name" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">URL</Label>
              <Input value={newEndpoint.url} onChange={e => setNewEndpoint(n => ({ ...n, url: e.target.value }))} placeholder={newEndpoint.providerType === "openai_compatible" ? "https://api.openai.com/v1  (or any /v1-compatible base URL)" : ""} className="text-xs" data-testid="input-new-endpoint-url" />
            </div>
            {newEndpoint.providerType !== "lmstudio" && (
              <div className="space-y-1">
                <Label className="text-xs">API Key</Label>
                <Input value={newEndpoint.apiKey} onChange={e => setNewEndpoint(n => ({ ...n, apiKey: e.target.value }))} type="password" placeholder={newEndpoint.providerType === "openrouter" ? "sk-or-v1-xxx" : "API key / bearer token"} className="text-xs" data-testid="input-new-apikey" />
                {newEndpoint.providerType === "openai_compatible" && (
                  <p className="text-[10px] text-muted-foreground">
                    Bearer token sent as <code>Authorization: Bearer …</code>. Leave blank only for local endpoints that do not require authentication.
                  </p>
                )}
                {newEndpoint.providerType === "openrouter" && (
                  <p className="text-[10px] text-muted-foreground">Get your key at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener" className="text-primary hover:underline">openrouter.ai/keys</a> — pay-per-use, 200+ models</p>
                )}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Switch checked={newEndpoint.isOrchestrator} onCheckedChange={v => setNewEndpoint(n => ({ ...n, isOrchestrator: v }))} data-testid="switch-new-orchestrator" />
              <Label className="text-xs">Orchestrator endpoint</Label>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Parallel Slots</Label>
              <Input type="number" value={newEndpoint.parallelSlots} onChange={e => setNewEndpoint(n => ({ ...n, parallelSlots: Number(e.target.value) }))} min={1} max={16} className="text-xs" data-testid="input-new-parallel-slots" />
              {newEndpoint.providerType === "openai_compatible" && (
                <p className="text-[10px] text-muted-foreground">Pick based on the provider's RPM/concurrency limit. Start low for shared or rate-limited endpoints, then raise if stable.</p>
              )}
              {newEndpoint.providerType === "openrouter" && (
                <p className="text-[10px] text-muted-foreground">OpenRouter rate limits vary by model — 4 slots is a safe default</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setAddEndpointOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={() => createEndpointMutation.mutate(newEndpoint)} disabled={!newEndpoint.name || !newEndpoint.url || createEndpointMutation.isPending} data-testid="button-create-endpoint">
              {createEndpointMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <AlertDialog open={deleteEndpointId !== null} onOpenChange={() => setDeleteEndpointId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">Delete Endpoint?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">This will remove the endpoint and all associated models. This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild><Button variant="ghost" size="sm">Cancel</Button></AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button variant="destructive" size="sm" onClick={() => deleteEndpointId && deleteEndpointMutation.mutate(deleteEndpointId)} data-testid="button-confirm-delete-endpoint">
                Delete
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
