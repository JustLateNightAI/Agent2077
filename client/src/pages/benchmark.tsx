import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plus, Play, Trash2, Star, GitCompare, Loader2, FlaskConical,
  ChevronDown, ChevronRight, Clock, Hash,
} from "lucide-react";

type BenchmarkSuite = {
  id: number;
  name: string;
  description?: string;
  prompts: string;
  createdAt: string;
};

type BenchmarkResult = {
  promptIndex: number;
  response: string;
  tokenCount?: number;
  durationMs?: number;
  rating?: number;
};

type PromptSpec = {
  prompt: string;
  category?: string;
  difficulty?: "easy" | "medium" | "hard";
  expectedBehavior?: string;
  requires?: ("tools" | "internet")[];
};

function difficultyClass(d?: string) {
  switch (d) {
    case "easy": return "border-green-500/30 text-green-400";
    case "medium": return "border-amber-500/30 text-amber-400";
    case "hard": return "border-red-500/30 text-red-400";
    default: return "border-border text-muted-foreground";
  }
}

type BenchmarkRun = {
  id: number;
  suiteId: number;
  modelId: string;
  endpointId: number;
  status: string;
  results?: string;
  averageRating?: number;
  totalTokens?: number;
  totalDurationMs?: number;
  createdAt: string;
  completedAt?: string;
};

type Endpoint = { id: number; name: string; url: string };
type Model = { id: number; endpointId: number; modelId: string; isEnabled: boolean };

function StarRating({ value, onChange, readonly }: { value?: number; onChange?: (v: number) => void; readonly?: boolean }) {
  const [hover, setHover] = useState(0);
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(star => (
        <button
          key={star}
          className={`text-sm ${(hover || value || 0) >= star ? "text-amber-400" : "text-muted-foreground/30"} ${readonly ? "cursor-default" : "cursor-pointer hover:text-amber-400"} transition-colors`}
          onClick={() => !readonly && onChange?.(star)}
          onMouseEnter={() => !readonly && setHover(star)}
          onMouseLeave={() => !readonly && setHover(0)}
          data-testid={`star-${star}`}
        >
          ★
        </button>
      ))}
    </div>
  );
}

function RunResultCard({ run, suite, onRate }: { run: BenchmarkRun; suite?: BenchmarkSuite; onRate: (runId: number, promptIndex: number, rating: number) => void }) {
  const [expanded, setExpanded] = useState(false);
  let results: BenchmarkResult[] = [];
  let prompts: PromptSpec[] = [];
  try { results = JSON.parse(run.results || "[]"); } catch {}
  try { prompts = JSON.parse(suite?.prompts || "[]"); } catch {}

  return (
    <Card className="mb-2" data-testid={`run-card-${run.id}`}>
      <CardHeader className="pb-0 pt-3 px-3">
        <div className="flex items-center gap-2">
          <button onClick={() => setExpanded(!expanded)} className="text-muted-foreground hover:text-foreground" data-testid={`expand-run-${run.id}`}>
            {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] font-mono text-muted-foreground">{run.modelId.split("/").pop()}</span>
              <Badge variant="outline" className={`text-[10px] ${
                run.status === "completed" ? "border-green-500/30 text-green-400" :
                run.status === "running" ? "border-primary/30 text-primary" :
                run.status === "failed" ? "border-red-500/30 text-red-400" :
                "border-border text-muted-foreground"
              }`}>{run.status}</Badge>
              {run.averageRating !== undefined && run.averageRating !== null && (
                <StarRating value={Math.round(run.averageRating)} readonly />
              )}
            </div>
            <div className="flex items-center gap-3 mt-0.5 text-[10px] text-muted-foreground">
              {run.totalTokens !== undefined && <span><Hash className="w-2.5 h-2.5 inline" />{run.totalTokens} tokens</span>}
              {run.totalDurationMs !== undefined && <span><Clock className="w-2.5 h-2.5 inline" />{(run.totalDurationMs / 1000).toFixed(1)}s</span>}
              <span>{new Date(run.createdAt).toLocaleString()}</span>
            </div>
          </div>
        </div>
      </CardHeader>
      {expanded && results.length > 0 && (
        <CardContent className="px-3 pb-3 pt-2 space-y-3">
          {results.map((r, i) => (
            <div key={i} className="border border-border rounded-md p-2 space-y-2" data-testid={`result-${run.id}-${i}`}>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className="text-[10px]">#{i + 1}</Badge>
                {prompts[r.promptIndex]?.category && (
                  <Badge variant="outline" className="text-[10px]">{prompts[r.promptIndex].category}</Badge>
                )}
                {prompts[r.promptIndex]?.difficulty && (
                  <Badge variant="outline" className={`text-[10px] ${difficultyClass(prompts[r.promptIndex].difficulty)}`}>{prompts[r.promptIndex].difficulty}</Badge>
                )}
                {prompts[r.promptIndex]?.requires?.map(req => (
                  <Badge key={req} variant="outline" className="text-[10px] border-primary/30 text-primary">{req}</Badge>
                ))}
                <div className="flex items-center gap-3 ml-auto text-[10px] text-muted-foreground">
                  {r.tokenCount !== undefined && <span>{r.tokenCount} tok</span>}
                  {r.durationMs !== undefined && <span>{(r.durationMs / 1000).toFixed(2)}s</span>}
                </div>
              </div>
              {prompts[r.promptIndex] && (
                <p className="text-[10px] text-muted-foreground bg-muted/30 rounded p-1.5 font-mono">{prompts[r.promptIndex].prompt}</p>
              )}
              {prompts[r.promptIndex]?.expectedBehavior && (
                <p className="text-[10px] text-muted-foreground italic border-l-2 border-primary/30 pl-2">
                  <span className="not-italic font-mono text-primary/70">expected: </span>{prompts[r.promptIndex].expectedBehavior}
                </p>
              )}
              <div className="bg-card border border-border rounded p-2">
                <p className="text-[10px] whitespace-pre-wrap leading-relaxed line-clamp-6">{r.response}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground">Rating:</span>
                <StarRating value={r.rating} onChange={v => onRate(run.id, r.promptIndex, v)} />
              </div>
            </div>
          ))}
        </CardContent>
      )}
    </Card>
  );
}

export default function BenchmarkPage() {
  const { toast } = useToast();
  const [createSuiteOpen, setCreateSuiteOpen] = useState(false);
  const [runSuiteId, setRunSuiteId] = useState<number | null>(null);
  const [deleteSuiteId, setDeleteSuiteId] = useState<number | null>(null);
  const [compareMode, setCompareMode] = useState(false);
  const [compareRunIds, setCompareRunIds] = useState<number[]>([]);
  const [selectedSuiteId, setSelectedSuiteId] = useState<number | null>(null);
  const [runModelId, setRunModelId] = useState("");
  const [runEndpointId, setRunEndpointId] = useState("");
  const [newSuite, setNewSuite] = useState({ name: "", description: "", prompts: '[{"prompt":"Hello","category":"general"}]' });

  const { data: suites = [], isLoading: suitesLoading } = useQuery<BenchmarkSuite[]>({ queryKey: ["/api/benchmarks"] });
  const { data: endpoints = [] } = useQuery<Endpoint[]>({ queryKey: ["/api/endpoints"] });
  const { data: models = [] } = useQuery<Model[]>({ queryKey: ["/api/models"] });
  const { data: runs = [] } = useQuery<BenchmarkRun[]>({
    queryKey: ["/api/benchmarks", selectedSuiteId, "runs"],
    queryFn: async () => {
      if (!selectedSuiteId) return [];
      const res = await apiRequest("GET", `/api/benchmarks/${selectedSuiteId}/runs`);
      return res.json();
    },
    enabled: selectedSuiteId !== null,
    // Poll while any run is still executing so the UI flips to completed/failed
    // and shows results without needing to start another run. Stops once every
    // run has reached a terminal state.
    refetchInterval: (query) => {
      const data = query.state.data;
      const hasActive = Array.isArray(data) && data.some(r => r.status !== "completed" && r.status !== "failed");
      return hasActive ? 2000 : false;
    },
  });

  const enabledModels = models.filter(m => m.isEnabled);

  const createSuiteMutation = useMutation({
    mutationFn: (data: typeof newSuite) => apiRequest("POST", "/api/benchmarks", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/benchmarks"] });
      setCreateSuiteOpen(false);
      setNewSuite({ name: "", description: "", prompts: '[{"prompt":"Hello","category":"general"}]' });
      toast({ title: "Suite created" });
    },
    onError: () => toast({ title: "Failed to create suite", variant: "destructive" }),
  });

  const deleteSuiteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/benchmarks/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/benchmarks"] });
      setDeleteSuiteId(null);
      if (selectedSuiteId === deleteSuiteId) setSelectedSuiteId(null);
      toast({ title: "Suite deleted" });
    },
    onError: () => toast({ title: "Delete failed", variant: "destructive" }),
  });

  const runMutation = useMutation({
    mutationFn: ({ suiteId, modelId, endpointId }: { suiteId: number; modelId: string; endpointId: number }) =>
      apiRequest("POST", `/api/benchmarks/${suiteId}/run`, { modelId, endpointId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/benchmarks", selectedSuiteId, "runs"] });
      setRunSuiteId(null);
      toast({ title: "Benchmark started" });
    },
    onError: () => toast({ title: "Run failed", variant: "destructive" }),
  });

  const rateMutation = useMutation({
    mutationFn: ({ runId, data }: { runId: number; data: { promptIndex: number; rating: number } }) =>
      apiRequest("PATCH", `/api/benchmarks/runs/${runId}`, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/benchmarks", selectedSuiteId, "runs"] }),
    onError: () => toast({ title: "Rating save failed", variant: "destructive" }),
  });

  const toggleCompareRun = (runId: number) => {
    setCompareRunIds(prev =>
      prev.includes(runId)
        ? prev.filter(id => id !== runId)
        : prev.length < 2 ? [...prev, runId] : [prev[1], runId]
    );
  };

  const compareRuns = runs.filter(r => compareRunIds.includes(r.id));
  const selectedSuite = suites.find(s => s.id === selectedSuiteId);

  // Parse prompts for compare view
  const comparePrompts = (() => {
    try { return JSON.parse(selectedSuite?.prompts || "[]"); } catch { return []; }
  })();

  const compareResults = compareRuns.map(r => {
    try { return JSON.parse(r.results || "[]") as BenchmarkResult[]; } catch { return []; }
  });

  return (
    <div className="h-full flex flex-col" data-testid="benchmark-page">
      {/* Header */}
      <div className="border-b border-border px-4 py-3 flex items-center gap-3">
        <FlaskConical className="w-4 h-4 text-primary" />
        <div className="flex-1">
          <h1 className="text-sm font-mono font-bold text-primary">BENCHMARK</h1>
          <p className="text-[10px] text-muted-foreground">Manual model evaluation tool</p>
        </div>
        <Button size="sm" variant={compareMode ? "default" : "outline"} onClick={() => setCompareMode(!compareMode)} data-testid="button-toggle-compare">
          <GitCompare className="w-3.5 h-3.5 mr-1" /> {compareMode ? "Exit Compare" : "Compare Runs"}
        </Button>
        <Button size="sm" onClick={() => setCreateSuiteOpen(true)} data-testid="button-create-suite">
          <Plus className="w-3.5 h-3.5 mr-1" /> New Suite
        </Button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Suites sidebar */}
        <div className="w-56 border-r border-border flex flex-col shrink-0">
          <div className="px-3 py-2 border-b border-border">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-mono">Suites</p>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-1">
              {suitesLoading ? (
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground p-2">
                  <Loader2 className="w-3 h-3 animate-spin" /> Loading...
                </div>
              ) : suites.length === 0 ? (
                <p className="text-[10px] text-muted-foreground p-2">No suites yet.</p>
              ) : (
                suites.map(suite => {
                  let promptCount = 0;
                  try { promptCount = JSON.parse(suite.prompts).length; } catch {}
                  return (
                    <div
                      key={suite.id}
                      className={`group flex items-center gap-1.5 rounded px-2 py-1.5 cursor-pointer transition-colors ${selectedSuiteId === suite.id ? "bg-primary/10 text-primary" : "hover:bg-muted/30"}`}
                      onClick={() => setSelectedSuiteId(suite.id)}
                      data-testid={`suite-item-${suite.id}`}
                    >
                      <FlaskConical className="w-3 h-3 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs truncate" title={suite.name}>{suite.name.replace(/^\[Preset\]\s*/, "")}</p>
                        <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                          {suite.name.startsWith("[Preset]") && (
                            <span className="text-primary/70">preset ·</span>
                          )}
                          {promptCount} prompts
                        </p>
                      </div>
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-5 w-5"
                          onClick={e => { e.stopPropagation(); setRunSuiteId(suite.id); setSelectedSuiteId(suite.id); }}
                          data-testid={`button-run-suite-${suite.id}`}
                        >
                          <Play className="w-2.5 h-2.5 text-green-400" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-5 w-5"
                          onClick={e => { e.stopPropagation(); setDeleteSuiteId(suite.id); }}
                          data-testid={`button-delete-suite-${suite.id}`}
                        >
                          <Trash2 className="w-2.5 h-2.5 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Main content */}
        <div className="flex-1 overflow-hidden flex flex-col">
          {!selectedSuiteId ? (
            <div className="flex items-center justify-center flex-1 text-center">
              <div className="space-y-2">
                <FlaskConical className="w-8 h-8 text-muted-foreground/30 mx-auto" />
                <p className="text-xs text-muted-foreground">Select a suite to view runs</p>
              </div>
            </div>
          ) : compareMode && compareRunIds.length === 2 ? (
            /* Compare View */
            <div className="flex-1 overflow-hidden flex flex-col">
              <div className="border-b border-border px-4 py-2 flex items-center gap-3">
                <GitCompare className="w-3.5 h-3.5 text-primary" />
                <span className="text-xs font-mono text-primary">Side-by-Side Comparison</span>
                <div className="ml-auto flex items-center gap-2">
                  {compareRuns.map(r => (
                    <Badge key={r.id} variant="outline" className="text-[10px]">
                      {r.modelId.split("/").pop()} — {r.averageRating ? `★ ${r.averageRating.toFixed(1)}` : "unrated"}
                    </Badge>
                  ))}
                </div>
              </div>
              <ScrollArea className="flex-1 p-4">
                {comparePrompts.map((p: any, i: number) => (
                  <div key={i} className="mb-4">
                    <div className="bg-muted/30 rounded border border-border p-2 mb-2">
                      <p className="text-[10px] font-mono text-muted-foreground">{p.prompt}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {compareResults.map((results, ri) => {
                        const result = results.find(r => r.promptIndex === i);
                        return (
                          <div key={ri} className="border border-border rounded p-2 bg-card/50">
                            <div className="flex items-center gap-2 mb-1.5">
                              <span className="text-[10px] font-mono text-primary">{compareRuns[ri]?.modelId.split("/").pop()}</span>
                              {result?.durationMs !== undefined && <span className="text-[10px] text-muted-foreground">{(result.durationMs / 1000).toFixed(2)}s</span>}
                              {result?.tokenCount !== undefined && <span className="text-[10px] text-muted-foreground">{result.tokenCount} tok</span>}
                              {result?.rating !== undefined && <StarRating value={result.rating} readonly />}
                            </div>
                            <p className="text-[10px] whitespace-pre-wrap leading-relaxed">{result?.response || "(no response)"}</p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </ScrollArea>
            </div>
          ) : (
            /* Runs list */
            <div className="flex-1 overflow-hidden flex flex-col">
              <div className="border-b border-border px-4 py-2 flex items-center gap-3">
                <span className="text-xs font-mono text-muted-foreground">{selectedSuite?.name?.replace(/^\[Preset\]\s*/, "")}</span>
                {compareMode && (
                  <span className="text-[10px] text-muted-foreground ml-auto">
                    Select 2 runs to compare ({compareRunIds.length}/2 selected)
                  </span>
                )}
                <Button size="sm" variant="outline" className="ml-auto" onClick={() => { setRunSuiteId(selectedSuiteId); }} data-testid="button-new-run">
                  <Play className="w-3.5 h-3.5 mr-1" /> Run Suite
                </Button>
              </div>
              <ScrollArea className="flex-1 p-4">
                {runs.length === 0 ? (
                  <div className="flex items-center justify-center py-16 text-center">
                    <div className="space-y-2">
                      <Play className="w-8 h-8 text-muted-foreground/30 mx-auto" />
                      <p className="text-xs text-muted-foreground">No runs yet. Run this suite against a model.</p>
                    </div>
                  </div>
                ) : (
                  runs.map(run => (
                    <div key={run.id} className={`relative ${compareMode ? "cursor-pointer" : ""}`} onClick={() => compareMode && toggleCompareRun(run.id)}>
                      {compareMode && compareRunIds.includes(run.id) && (
                        <div className="absolute inset-0 border-2 border-primary rounded-md pointer-events-none z-10" />
                      )}
                      <RunResultCard
                        run={run}
                        suite={selectedSuite}
                        onRate={(runId, promptIndex, rating) => rateMutation.mutate({ runId, data: { promptIndex, rating } })}
                      />
                    </div>
                  ))
                )}
              </ScrollArea>
            </div>
          )}
        </div>
      </div>

      {/* Create Suite Dialog */}
      <Dialog open={createSuiteOpen} onOpenChange={setCreateSuiteOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-sm font-mono text-primary">Create Benchmark Suite</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label className="text-xs">Name</Label>
              <Input value={newSuite.name} onChange={e => setNewSuite(n => ({ ...n, name: e.target.value }))} placeholder="General capability test" className="text-xs" data-testid="input-suite-name" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Description</Label>
              <Input value={newSuite.description} onChange={e => setNewSuite(n => ({ ...n, description: e.target.value }))} placeholder="Optional description" className="text-xs" data-testid="input-suite-description" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Prompts (JSON array)</Label>
              <Textarea
                value={newSuite.prompts}
                onChange={e => setNewSuite(n => ({ ...n, prompts: e.target.value }))}
                rows={8}
                className="text-xs font-mono resize-none"
                placeholder='[{"prompt": "Write hello world in Python", "category": "coding"}]'
                data-testid="textarea-suite-prompts"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setCreateSuiteOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={() => createSuiteMutation.mutate(newSuite)} disabled={!newSuite.name || createSuiteMutation.isPending} data-testid="button-save-suite">
              {createSuiteMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Create Suite"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Run Suite Dialog */}
      <Dialog open={runSuiteId !== null} onOpenChange={() => setRunSuiteId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm font-mono text-primary">Run Benchmark Suite</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label className="text-xs">Endpoint</Label>
              <Select value={runEndpointId} onValueChange={setRunEndpointId}>
                <SelectTrigger className="text-xs h-8" data-testid="select-run-endpoint">
                  <SelectValue placeholder="Select endpoint..." />
                </SelectTrigger>
                <SelectContent>
                  {endpoints.map(e => (
                    <SelectItem key={e.id} value={String(e.id)} className="text-xs">{e.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Model</Label>
              <Select value={runModelId} onValueChange={setRunModelId}>
                <SelectTrigger className="text-xs h-8" data-testid="select-run-model">
                  <SelectValue placeholder="Select model..." />
                </SelectTrigger>
                <SelectContent>
                  {enabledModels
                    .filter(m => !runEndpointId || m.endpointId === Number(runEndpointId))
                    .map(m => (
                      <SelectItem key={m.id} value={m.modelId} className="text-xs font-mono">{m.modelId.split("/").pop()}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setRunSuiteId(null)}>Cancel</Button>
            <Button
              size="sm"
              onClick={() => {
                if (!runSuiteId || !runModelId || !runEndpointId) return;
                runMutation.mutate({ suiteId: runSuiteId, modelId: runModelId, endpointId: Number(runEndpointId) });
              }}
              disabled={!runModelId || !runEndpointId || runMutation.isPending}
              data-testid="button-start-run"
            >
              {runMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <><Play className="w-3.5 h-3.5 mr-1" /> Start Run</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Suite Confirm */}
      <AlertDialog open={deleteSuiteId !== null} onOpenChange={() => setDeleteSuiteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">Delete Suite?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">This will permanently delete this suite and all its benchmark runs.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild><Button variant="ghost" size="sm">Cancel</Button></AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button variant="destructive" size="sm" onClick={() => deleteSuiteId && deleteSuiteMutation.mutate(deleteSuiteId)} disabled={deleteSuiteMutation.isPending} data-testid="button-confirm-delete-suite">
                {deleteSuiteMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Delete"}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
