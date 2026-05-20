import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAgentName } from "@/lib/useAgentName";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
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
  Slider,
} from "@/components/ui/slider";
import {
  Database, Plus, Pencil, Trash2, Search, X, Loader2, Brain,
} from "lucide-react";

type MemoryEntry = {
  id: number;
  category: string;
  content: string;
  importance: number;
  conversationId?: number;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
};

const CATEGORIES = ["fact", "preference", "project", "context"] as const;
type Category = typeof CATEGORIES[number];

const CATEGORY_CONFIG: Record<string, { color: string; emoji: string }> = {
  fact: { color: "border-blue-500/30 text-blue-400 bg-blue-500/5", emoji: "💡" },
  preference: { color: "border-purple-500/30 text-purple-400 bg-purple-500/5", emoji: "⚙️" },
  project: { color: "border-green-500/30 text-green-400 bg-green-500/5", emoji: "📁" },
  context: { color: "border-amber-500/30 text-amber-400 bg-amber-500/5", emoji: "🔗" },
};

function ImportanceDots({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-0.5" title={`Importance: ${value}/10`}>
      {Array.from({ length: 10 }, (_, i) => (
        <div
          key={i}
          className={`w-1.5 h-1.5 rounded-full transition-colors ${
            i < value
              ? value >= 8 ? "bg-red-400" : value >= 5 ? "bg-amber-400" : "bg-primary"
              : "bg-muted/50"
          }`}
        />
      ))}
    </div>
  );
}

function MemoryCard({
  entry,
  onEdit,
  onDelete,
}: {
  entry: MemoryEntry;
  onEdit: (entry: MemoryEntry) => void;
  onDelete: (id: number) => void;
}) {
  const config = CATEGORY_CONFIG[entry.category] || { color: "border-border", emoji: "📌" };
  const [expanded, setExpanded] = useState(false);

  return (
    <Card className="mb-2" data-testid={`memory-card-${entry.id}`}>
      <CardContent className="px-3 py-2.5">
        <div className="flex items-start gap-2">
          <span className="text-sm leading-none mt-0.5 shrink-0">{config.emoji}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <Badge variant="outline" className={`text-[10px] ${config.color}`} data-testid={`badge-category-${entry.id}`}>
                {entry.category}
              </Badge>
              <ImportanceDots value={entry.importance} />
              <span className="text-[10px] text-muted-foreground ml-auto">
                {new Date(entry.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
            </div>
            <p
              className={`text-xs leading-relaxed ${expanded ? "" : "line-clamp-2"} cursor-pointer`}
              onClick={() => setExpanded(!expanded)}
              data-testid={`content-${entry.id}`}
            >
              {entry.content}
            </p>
            {entry.expiresAt && (
              <p className="text-[10px] text-amber-400 mt-1">Expires: {new Date(entry.expiresAt).toLocaleDateString()}</p>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button size="icon" variant="ghost" onClick={() => onEdit(entry)} data-testid={`button-edit-memory-${entry.id}`}>
              <Pencil className="w-3.5 h-3.5" />
            </Button>
            <Button size="icon" variant="ghost" onClick={() => onDelete(entry.id)} data-testid={`button-delete-memory-${entry.id}`}>
              <Trash2 className="w-3.5 h-3.5 text-destructive" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function MemoryPage() {
  const { toast } = useToast();
  const agentName = useAgentName();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MemoryEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editEntry, setEditEntry] = useState<MemoryEntry | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const [form, setForm] = useState({
    content: "",
    category: "fact" as Category,
    importance: 5,
  });
  const [editForm, setEditForm] = useState({
    content: "",
    category: "fact" as Category,
    importance: 5,
  });

  const { data: memories = [], isLoading } = useQuery<MemoryEntry[]>({ queryKey: ["/api/memory"] });

  const filteredMemories = (searchResults ?? memories).filter(m =>
    !categoryFilter || m.category === categoryFilter
  );

  const createMutation = useMutation({
    mutationFn: (data: typeof form) => apiRequest("POST", "/api/memory", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/memory"] });
      setAddOpen(false);
      setForm({ content: "", category: "fact", importance: 5 });
      toast({ title: "Memory saved" });
    },
    onError: () => toast({ title: "Failed to save memory", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<MemoryEntry> }) =>
      apiRequest("PATCH", `/api/memory/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/memory"] });
      setEditEntry(null);
      toast({ title: "Memory updated" });
    },
    onError: () => toast({ title: "Update failed", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/memory/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/memory"] });
      setDeleteId(null);
      toast({ title: "Memory deleted" });
    },
    onError: () => toast({ title: "Delete failed", variant: "destructive" }),
  });

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    try {
      const res = await apiRequest("POST", "/api/memory/search", { query: searchQuery });
      setSearchResults(await res.json());
    } catch {
      toast({ title: "Search failed", variant: "destructive" });
    } finally {
      setSearching(false);
    }
  };

  const clearSearch = () => {
    setSearchQuery("");
    setSearchResults(null);
  };

  const openEdit = (entry: MemoryEntry) => {
    setEditEntry(entry);
    setEditForm({ content: entry.content, category: entry.category as Category, importance: entry.importance });
  };

  const categoryCounts = CATEGORIES.reduce((acc, cat) => {
    acc[cat] = memories.filter(m => m.category === cat).length;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="h-full flex flex-col" data-testid="memory-page">
      {/* Header */}
      <div className="border-b border-border px-4 py-3 flex items-center gap-3">
        <Database className="w-4 h-4 text-primary" />
        <div className="flex-1">
          <h1 className="text-sm font-mono font-bold text-primary">MEMORY</h1>
          <p className="text-[10px] text-muted-foreground">Cross-session knowledge store — {memories.length} entries</p>
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)} data-testid="button-add-memory">
          <Plus className="w-3.5 h-3.5 mr-1" /> Add Memory
        </Button>
      </div>

      {/* Search + filters */}
      <div className="border-b border-border px-4 py-2 space-y-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleSearch()}
              placeholder="Search memories..."
              className="pl-8 text-xs h-8"
              data-testid="input-search-memory"
            />
          </div>
          {searchQuery && (
            <Button size="icon" variant="ghost" onClick={clearSearch} className="h-8 w-8" data-testid="button-clear-search">
              <X className="w-3.5 h-3.5" />
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={handleSearch} disabled={searching} data-testid="button-search">
            {searching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Search"}
          </Button>
        </div>

        {/* Category filters */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${!categoryFilter ? "border-primary/50 text-primary bg-primary/10" : "border-border text-muted-foreground hover:border-border/80"}`}
            onClick={() => setCategoryFilter(null)}
            data-testid="filter-all"
          >
            All ({memories.length})
          </button>
          {CATEGORIES.map(cat => {
            const config = CATEGORY_CONFIG[cat];
            return (
              <button
                key={cat}
                className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${categoryFilter === cat ? config.color : "border-border text-muted-foreground hover:border-border/80"}`}
                onClick={() => setCategoryFilter(categoryFilter === cat ? null : cat)}
                data-testid={`filter-${cat}`}
              >
                {config.emoji} {cat} ({categoryCounts[cat] || 0})
              </button>
            );
          })}
        </div>
      </div>

      {/* Memory list */}
      <ScrollArea className="flex-1 p-4">
        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground justify-center py-8">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading memories...
          </div>
        ) : filteredMemories.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center space-y-2" data-testid="empty-memory">
            <Brain className="w-8 h-8 text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground">
              {searchResults !== null ? "No results found for your search." : "No memories stored yet."}
            </p>
            {searchResults === null && (
              <p className="text-[10px] text-muted-foreground max-w-xs">Memories are automatically saved by the agent during conversations, or you can add them manually.</p>
            )}
          </div>
        ) : (
          filteredMemories.map(entry => (
            <MemoryCard
              key={entry.id}
              entry={entry}
              onEdit={openEdit}
              onDelete={setDeleteId}
            />
          ))
        )}
      </ScrollArea>

      {/* Add Memory Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm font-mono text-primary">Add Memory Entry</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label className="text-xs">Content</Label>
              <Textarea
                value={form.content}
                onChange={e => setForm(f => ({ ...f, content: e.target.value }))}
                rows={4}
                className="text-xs resize-none"
                placeholder={`What should ${agentName} remember?`}
                data-testid="textarea-memory-content"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Category</Label>
              <Select value={form.category} onValueChange={(v: Category) => setForm(f => ({ ...f, category: v }))}>
                <SelectTrigger className="h-8 text-xs" data-testid="select-memory-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map(cat => (
                    <SelectItem key={cat} value={cat} className="text-xs">
                      {CATEGORY_CONFIG[cat].emoji} {cat}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs">Importance</Label>
                <span className="text-xs font-mono text-primary">{form.importance}/10</span>
              </div>
              <Slider
                value={[form.importance]}
                onValueChange={(vals: number[]) => setForm(f => ({ ...f, importance: vals[0] }))}
                min={1}
                max={10}
                step={1}
                data-testid="slider-memory-importance"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>Low</span>
                <span>High</span>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={() => createMutation.mutate(form)} disabled={!form.content.trim() || createMutation.isPending} data-testid="button-save-memory">
              {createMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save Memory"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Memory Dialog */}
      <Dialog open={editEntry !== null} onOpenChange={() => setEditEntry(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm font-mono text-primary">Edit Memory Entry</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label className="text-xs">Content</Label>
              <Textarea
                value={editForm.content}
                onChange={e => setEditForm(f => ({ ...f, content: e.target.value }))}
                rows={4}
                className="text-xs resize-none"
                data-testid="textarea-edit-memory-content"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Category</Label>
              <Select value={editForm.category} onValueChange={(v: Category) => setEditForm(f => ({ ...f, category: v }))}>
                <SelectTrigger className="h-8 text-xs" data-testid="select-edit-memory-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map(cat => (
                    <SelectItem key={cat} value={cat} className="text-xs">
                      {CATEGORY_CONFIG[cat].emoji} {cat}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs">Importance</Label>
                <span className="text-xs font-mono text-primary">{editForm.importance}/10</span>
              </div>
              <Slider
                value={[editForm.importance]}
                onValueChange={(vals: number[]) => setEditForm(f => ({ ...f, importance: vals[0] }))}
                min={1}
                max={10}
                step={1}
                data-testid="slider-edit-memory-importance"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setEditEntry(null)}>Cancel</Button>
            <Button
              size="sm"
              onClick={() => editEntry && updateMutation.mutate({ id: editEntry.id, data: editForm })}
              disabled={!editForm.content.trim() || updateMutation.isPending}
              data-testid="button-update-memory"
            >
              {updateMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Update"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <AlertDialog open={deleteId !== null} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">Delete Memory?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">This will permanently remove this memory entry. The agent will no longer have access to this information.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild><Button variant="ghost" size="sm">Cancel</Button></AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button variant="destructive" size="sm" onClick={() => deleteId && deleteMutation.mutate(deleteId)} disabled={deleteMutation.isPending} data-testid="button-confirm-delete-memory">
                {deleteMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Delete"}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
