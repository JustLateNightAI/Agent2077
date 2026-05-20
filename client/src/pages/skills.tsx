import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  ChevronDown, ChevronRight, Plus, Pencil, Trash2, CheckCircle2, XCircle,
  Brain, Clock, User, Bot, Hash, Loader2, History,
} from "lucide-react";

type Skill = {
  id: number;
  name: string;
  description: string;
  category: string;
  triggerPatterns?: string;
  systemPrompt?: string;
  instructions: string;
  version: number;
  isEnabled: boolean;
  usageCount: number;
  lastUsedAt?: string;
  createdBy: string;
  approvalStatus: string;
  createdAt: string;
  updatedAt: string;
};

type SkillVersion = {
  id: number;
  skillId: number;
  version: number;
  instructions: string;
  systemPrompt?: string;
  changeReason?: string;
  createdAt: string;
};

const CATEGORY_COLORS: Record<string, string> = {
  coding: "border-green-500/30 text-green-400",
  research: "border-blue-500/30 text-blue-400",
  creative: "border-purple-500/30 text-purple-400",
  math: "border-orange-500/30 text-orange-400",
  general: "border-border text-muted-foreground",
  writing: "border-pink-500/30 text-pink-400",
};

function formatDate(iso?: string) {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ── Skill Card ───────────────────────────────────────────────
function SkillCard({
  skill,
  onEdit,
  onDelete,
  onApprove,
  onReject,
  showApproval,
}: {
  skill: Skill;
  onEdit: (skill: Skill) => void;
  onDelete: (id: number) => void;
  onApprove?: (id: number) => void;
  onReject?: (id: number) => void;
  showApproval?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState<SkillVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);

  const loadVersions = async () => {
    if (versionsOpen) { setVersionsOpen(false); return; }
    setVersionsOpen(true);
    setVersionsLoading(true);
    try {
      const res = await apiRequest("GET", `/api/skills/${skill.id}/versions`);
      setVersions(await res.json());
    } catch {
      setVersions([]);
    } finally {
      setVersionsLoading(false);
    }
  };

  return (
    <Card className="mb-2" data-testid={`skill-card-${skill.id}`}>
      <CardHeader className="pb-0 pt-3 px-3">
        <div className="flex items-start gap-2">
          <button onClick={() => setExpanded(!expanded)} className="text-muted-foreground mt-0.5 hover:text-foreground shrink-0" data-testid={`expand-skill-${skill.id}`}>
            {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold">{skill.name}</span>
              <Badge variant="outline" className={`text-[10px] ${CATEGORY_COLORS[skill.category] || CATEGORY_COLORS.general}`}>
                {skill.category}
              </Badge>
              <Badge variant="outline" className="text-[10px]">v{skill.version}</Badge>
              <Badge variant="outline" className={`text-[10px] ${skill.createdBy === "agent" ? "border-primary/30 text-primary" : "border-border text-muted-foreground"}`}>
                {skill.createdBy === "agent" ? <Bot className="w-2.5 h-2.5 mr-0.5 inline" /> : <User className="w-2.5 h-2.5 mr-0.5 inline" />}
                {skill.createdBy}
              </Badge>
            </div>
            <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-1">{skill.description}</p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-[10px] text-muted-foreground font-mono"><Hash className="w-2.5 h-2.5 inline" />{skill.usageCount}</span>
            {!showApproval && (
              <>
                <Button size="icon" variant="ghost" onClick={() => onEdit(skill)} data-testid={`button-edit-skill-${skill.id}`}>
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
                <Button size="icon" variant="ghost" onClick={() => onDelete(skill.id)} data-testid={`button-delete-skill-${skill.id}`}>
                  <Trash2 className="w-3.5 h-3.5 text-destructive" />
                </Button>
              </>
            )}
            {showApproval && (
              <>
                <Button size="sm" variant="outline" className="h-7 px-2 text-xs border-green-500/30 text-green-400" onClick={() => onApprove?.(skill.id)} data-testid={`button-approve-skill-${skill.id}`}>
                  <CheckCircle2 className="w-3 h-3 mr-1" /> Approve
                </Button>
                <Button size="sm" variant="outline" className="h-7 px-2 text-xs border-red-500/30 text-red-400" onClick={() => onReject?.(skill.id)} data-testid={`button-reject-skill-${skill.id}`}>
                  <XCircle className="w-3 h-3 mr-1" /> Reject
                </Button>
              </>
            )}
          </div>
        </div>
      </CardHeader>

      {expanded && (
        <CardContent className="px-3 pb-3 pt-2 space-y-3">
          {/* Meta */}
          <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1"><Clock className="w-2.5 h-2.5" /> Last used: {formatDate(skill.lastUsedAt)}</span>
            <span className="flex items-center gap-1"><Clock className="w-2.5 h-2.5" /> Created: {formatDate(skill.createdAt)}</span>
          </div>

          {/* Instructions */}
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground uppercase tracking-wider">Instructions</Label>
            <div className="bg-muted/30 rounded border border-border p-2">
              <pre className="text-[10px] font-mono whitespace-pre-wrap text-foreground leading-relaxed">{skill.instructions}</pre>
            </div>
          </div>

          {/* Trigger patterns */}
          {skill.triggerPatterns && (() => {
            try {
              const patterns = JSON.parse(skill.triggerPatterns);
              return (
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground uppercase tracking-wider">Trigger Patterns</Label>
                  <div className="flex flex-wrap gap-1">
                    {patterns.map((p: string, i: number) => (
                      <Badge key={i} variant="outline" className="text-[10px]">{p}</Badge>
                    ))}
                  </div>
                </div>
              );
            } catch { return null; }
          })()}

          {/* Version history */}
          <button
            onClick={loadVersions}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary transition-colors"
            data-testid={`button-versions-${skill.id}`}
          >
            <History className="w-3 h-3" />
            {versionsOpen ? "Hide" : "Show"} version history
          </button>
          {versionsOpen && (
            <div className="space-y-1.5 pl-4 border-l border-border">
              {versionsLoading ? (
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <Loader2 className="w-3 h-3 animate-spin" /> Loading...
                </div>
              ) : versions.length === 0 ? (
                <p className="text-[10px] text-muted-foreground">No version history.</p>
              ) : (
                versions.map(v => (
                  <div key={v.id} className="text-[10px] space-y-0.5" data-testid={`version-${v.id}`}>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">v{v.version}</Badge>
                      <span className="text-muted-foreground">{formatDate(v.createdAt)}</span>
                      {v.changeReason && <span className="text-muted-foreground italic">{v.changeReason}</span>}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

// ── Main Skills Page ──────────────────────────────────────────
export default function SkillsPage() {
  const { toast } = useToast();
  const [editSkill, setEditSkill] = useState<Skill | null>(null);
  const [deleteSkillId, setDeleteSkillId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", category: "general", instructions: "", triggerPatterns: "" });

  const { data: skills = [], isLoading } = useQuery<Skill[]>({ queryKey: ["/api/skills"] });
  const { data: pendingSkills = [] } = useQuery<Skill[]>({ queryKey: ["/api/skills/pending"] });

  const activeSkills = skills.filter(s => s.approvalStatus === "approved");

  const createMutation = useMutation({
    mutationFn: (data: typeof form) => apiRequest("POST", "/api/skills", {
      ...data,
      triggerPatterns: data.triggerPatterns ? JSON.stringify(data.triggerPatterns.split(",").map(s => s.trim())) : "[]",
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/skills"] });
      setCreateOpen(false);
      setForm({ name: "", description: "", category: "general", instructions: "", triggerPatterns: "" });
      toast({ title: "Skill created" });
    },
    onError: () => toast({ title: "Create failed", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Skill> }) => apiRequest("PATCH", `/api/skills/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/skills"] });
      setEditSkill(null);
      toast({ title: "Skill updated" });
    },
    onError: () => toast({ title: "Update failed", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/skills/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/skills"] });
      queryClient.invalidateQueries({ queryKey: ["/api/skills/pending"] });
      setDeleteSkillId(null);
      toast({ title: "Skill deleted" });
    },
    onError: () => toast({ title: "Delete failed", variant: "destructive" }),
  });

  const approveMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/skills/${id}/approve`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/skills"] });
      queryClient.invalidateQueries({ queryKey: ["/api/skills/pending"] });
      toast({ title: "Skill approved" });
    },
    onError: () => toast({ title: "Approve failed", variant: "destructive" }),
  });

  const rejectMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/skills/${id}/reject`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/skills/pending"] });
      toast({ title: "Skill rejected" });
    },
    onError: () => toast({ title: "Reject failed", variant: "destructive" }),
  });

  const [editForm, setEditForm] = useState({ name: "", description: "", category: "general", instructions: "", triggerPatterns: "" });

  const openEdit = (skill: Skill) => {
    setEditSkill(skill);
    let patterns = "";
    try { patterns = skill.triggerPatterns ? JSON.parse(skill.triggerPatterns).join(", ") : ""; } catch {}
    setEditForm({
      name: skill.name,
      description: skill.description,
      category: skill.category,
      instructions: skill.instructions,
      triggerPatterns: patterns,
    });
  };

  const handleUpdate = () => {
    if (!editSkill) return;
    updateMutation.mutate({
      id: editSkill.id,
      data: {
        ...editForm,
        triggerPatterns: editForm.triggerPatterns
          ? JSON.stringify(editForm.triggerPatterns.split(",").map(s => s.trim()))
          : "[]",
      },
    });
  };

  return (
    <div className="h-full flex flex-col" data-testid="skills-page">
      {/* Header */}
      <div className="border-b border-border px-4 py-3 flex items-center gap-3">
        <Brain className="w-4 h-4 text-primary" />
        <div className="flex-1">
          <h1 className="text-sm font-mono font-bold text-primary">SKILLS LIBRARY</h1>
          <p className="text-[10px] text-muted-foreground">Reusable agent capabilities</p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)} data-testid="button-create-skill">
          <Plus className="w-3.5 h-3.5 mr-1" /> New Skill
        </Button>
      </div>

      <Tabs defaultValue="active" className="flex-1 flex flex-col overflow-hidden">
        <div className="border-b border-border px-4">
          <TabsList className="h-8 bg-transparent gap-1 p-0">
            <TabsTrigger value="active" className="text-xs h-8 data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none" data-testid="tab-active-skills">
              Active Skills
              {activeSkills.length > 0 && <Badge variant="outline" className="ml-1.5 text-[10px] h-4">{activeSkills.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="pending" className="text-xs h-8 data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none" data-testid="tab-pending-skills">
              Pending Approval
              {pendingSkills.length > 0 && <Badge variant="outline" className="ml-1.5 text-[10px] h-4 border-amber-500/40 text-amber-400">{pendingSkills.length}</Badge>}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="active" className="flex-1 overflow-hidden m-0">
          <ScrollArea className="h-full p-4">
            {isLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground py-8 justify-center">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading skills...
              </div>
            ) : activeSkills.length === 0 ? (
              <div className="flex flex-col items-center py-16 text-center space-y-2" data-testid="empty-skills">
                <Brain className="w-8 h-8 text-muted-foreground/30" />
                <p className="text-xs text-muted-foreground">No skills yet. Create one or let the agent propose skills during conversations.</p>
              </div>
            ) : (
              activeSkills.map(skill => (
                <SkillCard
                  key={skill.id}
                  skill={skill}
                  onEdit={openEdit}
                  onDelete={setDeleteSkillId}
                />
              ))
            )}
          </ScrollArea>
        </TabsContent>

        <TabsContent value="pending" className="flex-1 overflow-hidden m-0">
          <ScrollArea className="h-full p-4">
            {pendingSkills.length === 0 ? (
              <div className="flex flex-col items-center py-16 text-center space-y-2" data-testid="empty-pending">
                <CheckCircle2 className="w-8 h-8 text-muted-foreground/30" />
                <p className="text-xs text-muted-foreground">No pending skills. The agent will propose new skills during conversations.</p>
              </div>
            ) : (
              pendingSkills.map(skill => (
                <SkillCard
                  key={skill.id}
                  skill={skill}
                  onEdit={openEdit}
                  onDelete={setDeleteSkillId}
                  onApprove={id => approveMutation.mutate(id)}
                  onReject={id => rejectMutation.mutate(id)}
                  showApproval
                />
              ))
            )}
          </ScrollArea>
        </TabsContent>
      </Tabs>

      {/* Create Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-sm font-mono text-primary">Create New Skill</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2 max-h-[60vh] overflow-y-auto">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Name</Label>
                <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="text-xs" placeholder="Skill name" data-testid="input-skill-name" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Category</Label>
                <Input value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} className="text-xs" placeholder="general" data-testid="input-skill-category" />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Description</Label>
              <Input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="text-xs" placeholder="Brief description of what this skill does" data-testid="input-skill-description" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Instructions</Label>
              <Textarea value={form.instructions} onChange={e => setForm(f => ({ ...f, instructions: e.target.value }))} rows={6} className="text-xs resize-none font-mono" placeholder="Step-by-step instructions for this skill..." data-testid="textarea-skill-instructions" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Trigger Patterns (comma-separated)</Label>
              <Input value={form.triggerPatterns} onChange={e => setForm(f => ({ ...f, triggerPatterns: e.target.value }))} className="text-xs" placeholder="build, create, code, deploy" data-testid="input-skill-triggers" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={() => createMutation.mutate(form)} disabled={!form.name || !form.instructions || createMutation.isPending} data-testid="button-save-new-skill">
              {createMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Create Skill"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editSkill !== null} onOpenChange={() => setEditSkill(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-sm font-mono text-primary">Edit Skill</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2 max-h-[60vh] overflow-y-auto">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Name</Label>
                <Input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} className="text-xs" data-testid="input-edit-skill-name" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Category</Label>
                <Input value={editForm.category} onChange={e => setEditForm(f => ({ ...f, category: e.target.value }))} className="text-xs" data-testid="input-edit-skill-category" />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Description</Label>
              <Input value={editForm.description} onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))} className="text-xs" data-testid="input-edit-skill-description" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Instructions</Label>
              <Textarea value={editForm.instructions} onChange={e => setEditForm(f => ({ ...f, instructions: e.target.value }))} rows={6} className="text-xs resize-none font-mono" data-testid="textarea-edit-skill-instructions" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Trigger Patterns (comma-separated)</Label>
              <Input value={editForm.triggerPatterns} onChange={e => setEditForm(f => ({ ...f, triggerPatterns: e.target.value }))} className="text-xs" data-testid="input-edit-skill-triggers" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setEditSkill(null)}>Cancel</Button>
            <Button size="sm" onClick={handleUpdate} disabled={!editForm.name || !editForm.instructions || updateMutation.isPending} data-testid="button-save-edit-skill">
              {updateMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <AlertDialog open={deleteSkillId !== null} onOpenChange={() => setDeleteSkillId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">Delete Skill?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">This will permanently remove the skill and all its version history.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild><Button variant="ghost" size="sm">Cancel</Button></AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button variant="destructive" size="sm" onClick={() => deleteSkillId && deleteMutation.mutate(deleteSkillId)} disabled={deleteMutation.isPending} data-testid="button-confirm-delete-skill">
                {deleteMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Delete"}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
