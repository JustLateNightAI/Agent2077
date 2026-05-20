import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAgentName } from "@/lib/useAgentName";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
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
  Play, Square, FileText, Trash2, ExternalLink, Package, Loader2,
  RefreshCw, Download, RotateCcw,
} from "lucide-react";

type AppStatus = "building" | "running" | "stopped" | "error";

type App = {
  id: number;
  name: string;
  description: string;
  category: string;
  containerId?: string;
  status: AppStatus;
  port?: number;
  iconEmoji?: string;
  version?: number;
  lastStarted?: string;
  lastStopped?: string;
  errorLog?: string;
  createdAt: string;
};

type VersionInfo = {
  version: number;
  isCurrent: boolean;
  hasBackup: boolean;
};

const STATUS_CONFIG: Record<AppStatus, { label: string; className: string; dotClass: string }> = {
  running: { label: "Running", className: "border-green-500/40 text-green-400", dotClass: "bg-green-400" },
  stopped: { label: "Stopped", className: "border-border text-muted-foreground", dotClass: "bg-muted-foreground" },
  error: { label: "Error", className: "border-red-500/40 text-red-400", dotClass: "bg-red-400" },
  building: { label: "Building", className: "border-amber-500/40 text-amber-400", dotClass: "bg-amber-400 animate-pulse" },
};

const CATEGORY_COLORS: Record<string, string> = {
  tool: "border-primary/30 text-primary",
  game: "border-purple-500/30 text-purple-400",
  web: "border-blue-400/30 text-blue-400",
  utility: "border-cyan-400/30 text-cyan-400",
  media: "border-pink-400/30 text-pink-400",
};

export default function AppStorePage() {
  const { toast } = useToast();
  const agentName = useAgentName();
  const [logsAppId, setLogsAppId] = useState<number | null>(null);
  const [deleteAppId, setDeleteAppId] = useState<number | null>(null);
  const [logsContent, setLogsContent] = useState<string>("");
  const [logsLoading, setLogsLoading] = useState(false);
  const [rollbackAppId, setRollbackAppId] = useState<number | null>(null);
  const [rollbackVersions, setRollbackVersions] = useState<VersionInfo[]>([]);
  const [rollbackTarget, setRollbackTarget] = useState<number | null>(null);

  const { data: apps = [], isLoading, refetch } = useQuery<App[]>({ queryKey: ["/api/apps"] });

  const startMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/apps/${id}/start`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/apps"] }); toast({ title: "App starting..." }); },
    onError: () => toast({ title: "Failed to start app", variant: "destructive" }),
  });

  const stopMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/apps/${id}/stop`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/apps"] }); toast({ title: "App stopped" }); },
    onError: () => toast({ title: "Failed to stop app", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/apps/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/apps"] });
      setDeleteAppId(null);
      toast({ title: "App deleted" });
    },
    onError: () => toast({ title: "Failed to delete app", variant: "destructive" }),
  });

  const rollbackMutation = useMutation({
    mutationFn: ({ id, version }: { id: number; version: number }) =>
      apiRequest("POST", `/api/apps/${id}/rollback`, { targetVersion: version }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/apps"] });
      setRollbackAppId(null);
      setRollbackTarget(null);
      toast({ title: "Rolled back successfully" });
    },
    onError: () => toast({ title: "Rollback failed", variant: "destructive" }),
  });

  const openRollback = async (appId: number) => {
    try {
      const res = await apiRequest("GET", `/api/apps/${appId}/versions`);
      const data = await res.json();
      setRollbackVersions(data.versions || []);
      setRollbackAppId(appId);
      setRollbackTarget(null);
    } catch {
      toast({ title: "Failed to load versions", variant: "destructive" });
    }
  };

  const openLogs = async (appId: number) => {
    setLogsAppId(appId);
    setLogsLoading(true);
    setLogsContent("");
    try {
      const res = await apiRequest("GET", `/api/apps/${appId}/logs?tail=100`);
      const data = await res.json();
      setLogsContent(data.logs || "(no logs)");
    } catch {
      setLogsContent("Failed to load logs.");
    } finally {
      setLogsLoading(false);
    }
  };

  const logsApp = apps.find(a => a.id === logsAppId);
  const deleteApp = apps.find(a => a.id === deleteAppId);
  const rollbackApp = apps.find(a => a.id === rollbackAppId);

  return (
    <div className="h-full flex flex-col" data-testid="app-store-page">
      {/* Header */}
      <div className="border-b border-border px-4 py-3 flex items-center gap-3">
        <Package className="w-4 h-4 text-primary" />
        <div className="flex-1">
          <h1 className="text-sm font-mono font-bold text-primary">APP STORE</h1>
          <p className="text-[10px] text-muted-foreground">Deployed applications built by {agentName}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => refetch()} data-testid="button-refresh-apps">
          <RefreshCw className="w-3.5 h-3.5 mr-1" /> Refresh
        </Button>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1 p-4">
        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground justify-center py-16">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading apps...
          </div>
        ) : apps.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center space-y-3" data-testid="empty-apps">
            <div className="text-4xl">📦</div>
            <p className="text-sm font-mono text-muted-foreground">No apps yet — ask {agentName} to build something!</p>
            <p className="text-xs text-muted-foreground max-w-xs">
              Try: "Build me a simple note-taking web app" or "Create a Pomodoro timer"
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {apps.map(app => {
              const status = STATUS_CONFIG[app.status] || STATUS_CONFIG.stopped;
              return (
                <Card key={app.id} className="flex flex-col" data-testid={`app-card-${app.id}`}>
                  <CardHeader className="pb-2 pt-3 px-3">
                    <div className="flex items-start gap-2">
                      <span className="text-xl leading-none">{app.iconEmoji || "📦"}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <h3 className="text-xs font-semibold truncate">{app.name}</h3>
                          <Badge variant="outline" className={`text-[10px] shrink-0 ${status.className}`} data-testid={`status-${app.id}`}>
                            <span className={`w-1.5 h-1.5 rounded-full mr-1 inline-block ${status.dotClass}`} />
                            {status.label}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <Badge variant="outline" className={`text-[10px] ${CATEGORY_COLORS[app.category] || "text-muted-foreground"}`}>
                            {app.category}
                          </Badge>
                          {(app.version ?? 1) > 0 && (
                            <Badge variant="outline" className="text-[10px] border-border text-muted-foreground font-mono">
                              v{app.version ?? 1}
                            </Badge>
                          )}
                          {app.port && (
                            <span className="text-[10px] font-mono text-muted-foreground">:{app.port}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="flex-1 flex flex-col gap-3 px-3 pb-3">
                    <p className="text-[10px] text-muted-foreground leading-relaxed line-clamp-2">{app.description}</p>

                    {/* Actions */}
                    <div className="flex items-center gap-1 mt-auto flex-wrap">
                      {app.status === "running" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-xs h-7 px-2"
                          onClick={() => stopMutation.mutate(app.id)}
                          disabled={stopMutation.isPending}
                          data-testid={`button-stop-${app.id}`}
                        >
                          {stopMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3 mr-1" />}
                          Stop
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          className="text-xs h-7 px-2"
                          onClick={() => startMutation.mutate(app.id)}
                          disabled={startMutation.isPending || app.status === "building"}
                          data-testid={`button-start-${app.id}`}
                        >
                          {startMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3 mr-1" />}
                          Launch
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-xs h-7 px-2"
                        onClick={() => openLogs(app.id)}
                        data-testid={`button-logs-${app.id}`}
                      >
                        <FileText className="w-3 h-3 mr-1" /> Logs
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-xs h-7 px-2"
                        asChild
                        data-testid={`button-download-${app.id}`}
                      >
                        <a href={`/api/apps/${app.id}/download`} download>
                          <Download className="w-3 h-3 mr-1" /> Download
                        </a>
                      </Button>
                      {(app.version ?? 1) > 1 && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-xs h-7 px-2"
                          onClick={() => openRollback(app.id)}
                          data-testid={`button-rollback-${app.id}`}
                        >
                          <RotateCcw className="w-3 h-3 mr-1" /> Rollback
                        </Button>
                      )}
                      {app.status === "running" && app.port && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-xs h-7 px-2"
                          asChild
                          data-testid={`button-open-${app.id}`}
                        >
                          <a href={`http://Agent2077.local:${app.port}`} target="_blank" rel="noopener noreferrer">
                            <ExternalLink className="w-3 h-3 mr-1" /> Open
                          </a>
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 ml-auto"
                        onClick={() => setDeleteAppId(app.id)}
                        data-testid={`button-delete-${app.id}`}
                      >
                        <Trash2 className="w-3 h-3 text-destructive" />
                      </Button>
                    </div>

                    {app.status === "error" && app.errorLog && (
                      <div className="bg-destructive/10 border border-destructive/20 rounded p-2">
                        <p className="text-[10px] font-mono text-red-400 line-clamp-2">{app.errorLog}</p>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </ScrollArea>

      {/* Logs Modal */}
      <Dialog open={logsAppId !== null} onOpenChange={() => setLogsAppId(null)}>
        <DialogContent className="max-w-2xl h-[70vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-sm font-mono text-primary flex items-center gap-2">
              <FileText className="w-4 h-4" />
              {logsApp?.iconEmoji} {logsApp?.name} — Logs
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-auto bg-muted/30 rounded-md border border-border p-3" data-testid="logs-content">
            {logsLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading logs...
              </div>
            ) : (
              <pre className="text-[10px] font-mono text-muted-foreground whitespace-pre-wrap leading-relaxed">
                {logsContent}
              </pre>
            )}
          </div>
          <div className="flex justify-between items-center pt-2">
            <Button size="sm" variant="outline" onClick={() => logsAppId && openLogs(logsAppId)} data-testid="button-refresh-logs">
              <RefreshCw className="w-3.5 h-3.5 mr-1" /> Refresh
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setLogsAppId(null)}>Close</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Rollback Dialog */}
      <Dialog open={rollbackAppId !== null} onOpenChange={() => setRollbackAppId(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm font-mono text-primary flex items-center gap-2">
              <RotateCcw className="w-4 h-4" />
              {rollbackApp?.iconEmoji} {rollbackApp?.name} — Rollback
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Select a version to restore. The current version will be saved as a backup.
            </p>
            <div className="space-y-1.5">
              {rollbackVersions.map(v => (
                <button
                  key={v.version}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded border text-xs font-mono transition-colors ${
                    v.isCurrent
                      ? "border-primary/30 bg-primary/5 text-primary cursor-default"
                      : rollbackTarget === v.version
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border hover:border-primary/40 text-muted-foreground hover:text-foreground cursor-pointer"
                  }`}
                  onClick={() => !v.isCurrent && setRollbackTarget(v.version)}
                  disabled={v.isCurrent}
                  data-testid={`version-option-${v.version}`}
                >
                  <span>v{v.version}</span>
                  {v.isCurrent && <Badge variant="outline" className="text-[10px] border-primary/30 text-primary">current</Badge>}
                  {!v.isCurrent && v.hasBackup && <Badge variant="outline" className="text-[10px] border-border text-muted-foreground">backup available</Badge>}
                </button>
              ))}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button size="sm" variant="ghost" onClick={() => setRollbackAppId(null)}>Cancel</Button>
              <Button
                size="sm"
                disabled={!rollbackTarget || rollbackMutation.isPending}
                onClick={() => rollbackTarget && rollbackAppId && rollbackMutation.mutate({ id: rollbackAppId, version: rollbackTarget })}
                data-testid="button-confirm-rollback"
              >
                {rollbackMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <RotateCcw className="w-3.5 h-3.5 mr-1" />}
                Restore v{rollbackTarget}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <AlertDialog open={deleteAppId !== null} onOpenChange={() => setDeleteAppId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">Delete {deleteApp?.name}?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              This will stop and permanently remove the app container. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild><Button variant="ghost" size="sm">Cancel</Button></AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => deleteAppId && deleteMutation.mutate(deleteAppId)}
                disabled={deleteMutation.isPending}
                data-testid="button-confirm-delete-app"
              >
                {deleteMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Delete"}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
