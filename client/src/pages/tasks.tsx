import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  ListTodo, Plus, Play, Square, Trash2, RefreshCw, Clock,
  CheckCircle2, XCircle, Loader2, AlertCircle, Calendar,
} from "lucide-react";

interface BackgroundTask {
  id: number;
  title: string;
  description?: string;
  status: string;
  type: string;
  cronExpression?: string;
  result?: string;
  progress: number;
  logs?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  nextRunAt?: string;
  createdAt: string;
}

function statusIcon(status: string) {
  switch (status) {
    case "queued": return <Clock className="w-3.5 h-3.5 text-muted-foreground" />;
    case "running": return <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />;
    case "completed": return <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />;
    case "failed": return <XCircle className="w-3.5 h-3.5 text-destructive" />;
    case "cancelled": return <Square className="w-3.5 h-3.5 text-muted-foreground" />;
    default: return <AlertCircle className="w-3.5 h-3.5" />;
  }
}

function statusBadge(status: string) {
  const variants: Record<string, string> = {
    queued: "bg-muted text-muted-foreground",
    running: "bg-primary/20 text-primary border-primary/30",
    completed: "bg-green-500/20 text-green-400 border-green-500/30",
    failed: "bg-destructive/20 text-destructive border-destructive/30",
    cancelled: "bg-muted text-muted-foreground",
  };
  return (
    <Badge variant="outline" className={`text-[10px] ${variants[status] || ""}`}>
      {status}
    </Badge>
  );
}

export default function TasksPage() {
  const { toast } = useToast();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [selectedTask, setSelectedTask] = useState<BackgroundTask | null>(null);
  const [newTask, setNewTask] = useState({ title: "", description: "", type: "one-shot", cronExpression: "" });
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const { data: tasks = [], isLoading } = useQuery<BackgroundTask[]>({
    queryKey: ["/api/tasks"],
    queryFn: async () => {
      try {
        const res = await apiRequest("GET", "/api/tasks");
        return res.json();
      } catch {
        // Fallback to background-tasks endpoint
        const res2 = await apiRequest("GET", "/api/background-tasks");
        return res2.json();
      }
    },
    refetchInterval: 3000,
  });

  const createMutation = useMutation({
    mutationFn: (data: typeof newTask) => apiRequest("POST", "/api/tasks", data).catch(() => apiRequest("POST", "/api/background-tasks", data)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/background-tasks"] });
      setShowCreateDialog(false);
      setNewTask({ title: "", description: "", type: "one-shot", cronExpression: "" });
      toast({ title: "Task created" });
    },
    onError: (err: any) => toast({ variant: "destructive", title: "Failed", description: err.message }),
  });

  const cancelMutation = useMutation({
    mutationFn: (id: number) => apiRequest("PATCH", `/api/tasks/${id}`, { status: "cancelled" }).catch(() => apiRequest("POST", `/api/background-tasks/${id}/cancel`)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/background-tasks"] });
      toast({ title: "Task cancelled" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/tasks/${id}`).catch(() => apiRequest("DELETE", `/api/background-tasks/${id}`)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/background-tasks"] });
      setSelectedTask(null);
      toast({ title: "Task deleted" });
    },
  });

  const retryMutation = useMutation({
    mutationFn: (id: number) => apiRequest("PATCH", `/api/tasks/${id}`, { status: "queued" }).catch(() => apiRequest("POST", `/api/background-tasks/${id}/retry`)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/background-tasks"] });
      toast({ title: "Task retried" });
    },
  });

  const filteredTasks = statusFilter === "all" ? tasks : tasks.filter(t => t.status === statusFilter);
  const running = tasks.filter(t => t.status === "running").length;
  const queued = tasks.filter(t => t.status === "queued").length;
  const completed = tasks.filter(t => t.status === "completed").length;
  const failed = tasks.filter(t => t.status === "failed").length;

  const parseLogs = (logs?: string): string[] => {
    if (!logs) return [];
    try { return JSON.parse(logs); } catch { return []; }
  };

  return (
    <div className="h-full flex flex-col overflow-hidden bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-3">
          <ListTodo className="w-5 h-5 text-primary" />
          <h1 className="text-lg font-mono font-bold">
            <span className="text-primary">BACKGROUND</span>{" "}
            <span className="text-muted-foreground">TASKS</span>
          </h1>
        </div>
        <Button size="sm" onClick={() => setShowCreateDialog(true)} data-testid="button-create-task">
          <Plus className="w-3.5 h-3.5 mr-1" /> New Task
        </Button>
      </div>

      {/* Stats bar */}
      <div className="flex items-center gap-4 px-6 py-2 border-b border-border/50 text-xs">
        <button
          className={`flex items-center gap-1 ${statusFilter === "all" ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          onClick={() => setStatusFilter("all")}
        >
          All ({tasks.length})
        </button>
        <button
          className={`flex items-center gap-1 ${statusFilter === "running" ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}
          onClick={() => setStatusFilter("running")}
        >
          <Loader2 className="w-3 h-3" /> Running ({running})
        </button>
        <button
          className={`flex items-center gap-1 ${statusFilter === "queued" ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          onClick={() => setStatusFilter("queued")}
        >
          <Clock className="w-3 h-3" /> Queued ({queued})
        </button>
        <button
          className={`flex items-center gap-1 ${statusFilter === "completed" ? "text-green-400" : "text-muted-foreground hover:text-foreground"}`}
          onClick={() => setStatusFilter("completed")}
        >
          <CheckCircle2 className="w-3 h-3" /> Done ({completed})
        </button>
        <button
          className={`flex items-center gap-1 ${statusFilter === "failed" ? "text-destructive" : "text-muted-foreground hover:text-foreground"}`}
          onClick={() => setStatusFilter("failed")}
        >
          <XCircle className="w-3 h-3" /> Failed ({failed})
        </button>
      </div>

      {/* Task list */}
      <div className="flex flex-1 overflow-hidden">
        <ScrollArea className="flex-1">
          <div className="p-4 space-y-2">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
              </div>
            ) : filteredTasks.length === 0 ? (
              <div className="text-center py-12">
                <ListTodo className="w-10 h-10 mx-auto text-muted-foreground/20 mb-3" />
                <p className="text-sm text-muted-foreground">
                  {tasks.length === 0 ? "No background tasks yet" : "No tasks match this filter"}
                </p>
              </div>
            ) : (
              filteredTasks.map(task => (
                <Card
                  key={task.id}
                  className={`cursor-pointer transition-colors hover:border-primary/30 ${selectedTask?.id === task.id ? "border-primary/50" : ""}`}
                  onClick={() => setSelectedTask(task)}
                  data-testid={`task-${task.id}`}
                >
                  <CardContent className="p-3">
                    <div className="flex items-start gap-2">
                      {statusIcon(task.status)}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium truncate">{task.title}</span>
                          {statusBadge(task.status)}
                          {task.type === "scheduled" && (
                            <Badge variant="outline" className="text-[10px]">
                              <Calendar className="w-2.5 h-2.5 mr-0.5" /> {task.cronExpression}
                            </Badge>
                          )}
                        </div>
                        {task.description && (
                          <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{task.description}</p>
                        )}
                        {task.status === "running" && (
                          <Progress value={task.progress} className="h-1 mt-1.5" />
                        )}
                        <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground/60">
                          <span>Created {new Date(task.createdAt).toLocaleString()}</span>
                          {task.completedAt && <span>Done {new Date(task.completedAt).toLocaleString()}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {task.status === "running" && (
                          <Button variant="ghost" size="sm" className="h-6 w-6 p-0"
                            onClick={(e) => { e.stopPropagation(); cancelMutation.mutate(task.id); }}
                            data-testid={`cancel-task-${task.id}`}
                          >
                            <Square className="w-3 h-3" />
                          </Button>
                        )}
                        {task.status === "failed" && (
                          <Button variant="ghost" size="sm" className="h-6 w-6 p-0"
                            onClick={(e) => { e.stopPropagation(); retryMutation.mutate(task.id); }}
                            data-testid={`retry-task-${task.id}`}
                          >
                            <RefreshCw className="w-3 h-3" />
                          </Button>
                        )}
                        {(task.status === "completed" || task.status === "failed" || task.status === "cancelled") && (
                          <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-destructive"
                            onClick={(e) => { e.stopPropagation(); deleteMutation.mutate(task.id); }}
                            data-testid={`delete-task-${task.id}`}
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </ScrollArea>

        {/* Task detail panel */}
        {selectedTask && (
          <div className="w-80 border-l border-border overflow-auto bg-card/30 p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-mono font-bold text-primary">{selectedTask.title}</h3>
              {statusBadge(selectedTask.status)}
            </div>
            {selectedTask.description && (
              <p className="text-xs text-muted-foreground">{selectedTask.description}</p>
            )}
            {selectedTask.error && (
              <div className="bg-destructive/10 border border-destructive/30 rounded p-2">
                <p className="text-xs text-destructive font-mono">{selectedTask.error}</p>
              </div>
            )}
            {selectedTask.result && (
              <div>
                <h4 className="text-[10px] text-muted-foreground uppercase mb-1">Result</h4>
                <pre className="text-xs bg-muted/20 rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap font-mono">{selectedTask.result}</pre>
              </div>
            )}
            {/* Logs */}
            <div>
              <h4 className="text-[10px] text-muted-foreground uppercase mb-1">Logs</h4>
              <div className="bg-black/40 rounded p-2 max-h-60 overflow-auto font-mono text-[10px] space-y-0.5">
                {parseLogs(selectedTask.logs).length === 0 ? (
                  <span className="text-muted-foreground/50">No logs</span>
                ) : (
                  parseLogs(selectedTask.logs).map((log, i) => (
                    <div key={i} className="text-muted-foreground">{log}</div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Create dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm font-mono text-primary">Create Background Task</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs">Task prompt</label>
              <Input value={newTask.title} onChange={e => setNewTask(n => ({ ...n, title: e.target.value }))}
                placeholder="e.g., Refactor the auth module" className="text-xs" data-testid="input-task-title" />
            </div>
            <div className="space-y-1">
              <label className="text-xs">Details (optional)</label>
              <Textarea value={newTask.description} onChange={e => setNewTask(n => ({ ...n, description: e.target.value }))}
                placeholder="Additional context..." className="text-xs min-h-[60px]" />
            </div>
            <div className="space-y-1">
              <label className="text-xs">Type</label>
              <Select value={newTask.type} onValueChange={v => setNewTask(n => ({ ...n, type: v }))}>
                <SelectTrigger className="text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="one-shot">One-shot (run once)</SelectItem>
                  <SelectItem value="scheduled">Scheduled (recurring)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {newTask.type === "scheduled" && (
              <div className="space-y-1">
                <label className="text-xs">Cron Expression</label>
                <Input value={newTask.cronExpression} onChange={e => setNewTask(n => ({ ...n, cronExpression: e.target.value }))}
                  placeholder="0 * * * * (every hour)" className="text-xs font-mono" />
                <p className="text-[10px] text-muted-foreground">Standard cron: minute hour day month weekday</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setShowCreateDialog(false)}>Cancel</Button>
            <Button size="sm" onClick={() => createMutation.mutate(newTask)}
              disabled={!newTask.title || createMutation.isPending} data-testid="button-submit-task">
              {createMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
