import { Link, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "../App";
import { useAgentName } from "@/lib/useAgentName";
import {
  MessageSquare, Settings, Package, Brain, BarChart3, Activity,
  Database, Terminal, Plus, LogOut, ChevronLeft, ChevronRight, Trash2,
  FolderOpen, FolderClosed, Check, X, MoreVertical, Code,
  CheckSquare, Square, FolderPlus, GripVertical, ListTodo, Wrench, ImagePlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuSub,
  DropdownMenuSubContent, DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useState, useCallback } from "react";

interface Conversation {
  id: number;
  title: string;
  updatedAt: string;
  groupId?: number | null;
}

interface ChatGroup {
  id: number;
  name: string;
  createdAt: string;
}

const navItems = [
  { href: "/", icon: MessageSquare, label: "Chat" },
  { href: "/images", icon: ImagePlus, label: "Images" },
  { href: "/workspace", icon: Code, label: "Workspace" },
  { href: "/apps", icon: Package, label: "App Store" },
  { href: "/skills", icon: Brain, label: "Skills" },
  { href: "/benchmark", icon: BarChart3, label: "Benchmark" },
  { href: "/analytics", icon: Activity, label: "Analytics" },
  { href: "/console", icon: Terminal, label: "Console" },
  { href: "/memory", icon: Database, label: "Memory" },
  { href: "/tasks", icon: ListTodo, label: "Tasks" },
  { href: "/self-dev", icon: Wrench, label: "Self-Dev" },
  { href: "/settings", icon: Settings, label: "Settings" },
];

export default function Sidebar() {
  const [location, navigate] = useLocation();
  const { logout, username } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const agentName = useAgentName();

  // Multi-select state
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Group state
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null);
  const [editingGroupName, setEditingGroupName] = useState("");
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");

  const { data: conversations = [] } = useQuery<Conversation[]>({
    queryKey: ["/api/conversations"],
    refetchInterval: 5000,
  });

  const { data: groups = [] } = useQuery<ChatGroup[]>({
    queryKey: ["/api/chat-groups"],
    refetchInterval: 10000,
  });

  // Mutations
  const createGroupMutation = useMutation({
    mutationFn: (name: string) => apiRequest("POST", "/api/chat-groups", { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/chat-groups"] });
      setCreatingGroup(false);
      setNewGroupName("");
    },
  });

  const updateGroupMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      apiRequest("PUT", `/api/chat-groups/${id}`, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/chat-groups"] });
      setEditingGroupId(null);
    },
  });

  const deleteGroupMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/chat-groups/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/chat-groups"] });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
    },
  });

  const moveToGroupMutation = useMutation({
    mutationFn: ({ id, groupId }: { id: number; groupId: number | null }) =>
      apiRequest("PUT", `/api/conversations/${id}/group`, { groupId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
    },
  });

  const deleteConversationMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/conversations/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: number[]) =>
      apiRequest("POST", "/api/conversations/bulk-delete", { ids }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      setSelectedIds(new Set());
      setSelectMode(false);
      setShowDeleteConfirm(false);
    },
  });

  const handleNewChat = () => {
    navigate("/");
  };

  const handleDeleteConversation = async (id: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    deleteConversationMutation.mutate(id);
    if (location === `/chat/${id}`) navigate("/");
  };

  const handleToggleSelect = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBulkDelete = () => {
    bulkDeleteMutation.mutate(Array.from(selectedIds));
    // Navigate away if current chat is being deleted
    const chatMatch = location.match(/^\/chat\/(\d+)$/);
    if (chatMatch && selectedIds.has(Number(chatMatch[1]))) navigate("/");
  };

  const handleToggleGroup = (groupId: number) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const handleStartEditGroup = (group: ChatGroup) => {
    setEditingGroupId(group.id);
    setEditingGroupName(group.name);
  };

  const handleSaveGroupName = () => {
    if (editingGroupId && editingGroupName.trim()) {
      updateGroupMutation.mutate({ id: editingGroupId, name: editingGroupName.trim() });
    }
  };

  const handleCreateGroup = () => {
    if (newGroupName.trim()) {
      createGroupMutation.mutate(newGroupName.trim());
    }
  };

  const isActive = (href: string) => {
    if (href === "/") return location === "/" || location.startsWith("/chat/");
    if (href === "/workspace") return location.startsWith("/workspace");
    return location === href;
  };

  const isChatRoute = location === "/" || location.startsWith("/chat/");

  // Organize conversations by group
  const ungrouped = conversations.filter(c => !c.groupId);
  const grouped = groups.map(g => ({
    group: g,
    convs: conversations.filter(c => c.groupId === g.id),
  }));

  const ConversationItem = ({ conv }: { conv: Conversation }) => {
    const isCurrentChat = location === `/chat/${conv.id}`;
    const isSelected = selectedIds.has(conv.id);

    return (
      <div
        className={`group flex items-center gap-1 px-2 py-1.5 rounded text-xs cursor-pointer transition-colors ${
          isCurrentChat
            ? "bg-primary/10 text-primary"
            : isSelected
            ? "bg-accent/20 text-foreground"
            : "text-muted-foreground hover:bg-accent/10 hover:text-foreground"
        }`}
        data-testid={`conversation-${conv.id}`}
        onClick={() => {
          if (selectMode) {
            handleToggleSelect(conv.id);
          } else {
            navigate(`/chat/${conv.id}`);
          }
        }}
      >
        {/* Select checkbox */}
        {selectMode && (
          <button
            className="shrink-0"
            onClick={(e) => { e.stopPropagation(); handleToggleSelect(conv.id); }}
            data-testid={`checkbox-conv-${conv.id}`}
          >
            {isSelected ? (
              <CheckSquare className="w-3.5 h-3.5 text-primary" />
            ) : (
              <Square className="w-3.5 h-3.5 text-muted-foreground" />
            )}
          </button>
        )}

        <span className="truncate flex-1">{conv.title}</span>

        {/* Context menu */}
        {!selectMode && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 shrink-0"
                onClick={(e) => e.stopPropagation()}
                data-testid={`conv-menu-${conv.id}`}
              >
                <MoreVertical className="w-3 h-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="start" className="w-44">
              {groups.length > 0 && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger data-testid={`conv-move-group-${conv.id}`}>
                    Move to group
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {groups.map(g => (
                      <DropdownMenuItem
                        key={g.id}
                        onClick={() => moveToGroupMutation.mutate({ id: conv.id, groupId: g.id })}
                        data-testid={`move-to-group-${g.id}-conv-${conv.id}`}
                      >
                        {g.name}
                        {conv.groupId === g.id && <Check className="w-3 h-3 ml-auto" />}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => moveToGroupMutation.mutate({ id: conv.id, groupId: null })}
                      data-testid={`move-ungrouped-conv-${conv.id}`}
                    >
                      Ungrouped
                      {!conv.groupId && <Check className="w-3 h-3 ml-auto" />}
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={(e) => handleDeleteConversation(conv.id, e)}
                data-testid={`conv-delete-${conv.id}`}
              >
                <Trash2 className="w-3.5 h-3.5 mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    );
  };

  return (
    <TooltipProvider>
      <div
        className={`flex flex-col h-full border-r border-border bg-card transition-all ${
          collapsed ? "w-14" : "w-60"
        }`}
        data-testid="sidebar"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-3 border-b border-border">
          {!collapsed && (
            <div className="font-mono text-sm font-bold">
              {agentName === "Agent2077" ? (
                <>
                  <span className="text-primary">AGENT</span>
                  <span className="text-accent">2077</span>
                </>
              ) : (
                <span className="text-primary">{agentName.toUpperCase()}</span>
              )}
            </div>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => setCollapsed(!collapsed)}
            data-testid="button-toggle-sidebar"
          >
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </Button>
        </div>

        {/* Navigation */}
        <div className="p-2 space-y-0.5">
          {navItems.map(item => {
            const active = isActive(item.href);
            return (
              <Tooltip key={item.href} delayDuration={collapsed ? 100 : 1000}>
                <TooltipTrigger asChild>
                  <Link href={item.href}>
                    <div
                      className={`flex items-center gap-2 px-2 py-1.5 rounded text-sm cursor-pointer transition-colors ${
                        active
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground hover:bg-accent/10 hover:text-foreground"
                      }`}
                      data-testid={`nav-${item.label.toLowerCase().replace(" ", "-")}`}
                    >
                      <item.icon className="w-4 h-4 shrink-0" />
                      {!collapsed && <span>{item.label}</span>}
                    </div>
                  </Link>
                </TooltipTrigger>
                {collapsed && <TooltipContent side="right">{item.label}</TooltipContent>}
              </Tooltip>
            );
          })}
        </div>

        {/* Conversations list (only on chat pages, and when not collapsed) */}
        {!collapsed && isChatRoute && (
          <>
            {/* Conversations header */}
            <div className="flex items-center justify-between px-3 pt-3 pb-1">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">
                Conversations
              </span>
              <div className="flex items-center gap-1">
                {/* Select mode toggle */}
                <Tooltip delayDuration={300}>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={`h-6 w-6 p-0 ${selectMode ? "text-primary bg-primary/10" : ""}`}
                      onClick={() => {
                        setSelectMode(!selectMode);
                        setSelectedIds(new Set());
                      }}
                      data-testid="button-toggle-select"
                    >
                      {selectMode ? (
                        <X className="w-3.5 h-3.5" />
                      ) : (
                        <CheckSquare className="w-3.5 h-3.5" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {selectMode ? "Cancel selection" : "Multi-select"}
                  </TooltipContent>
                </Tooltip>

                {/* New Group button */}
                <Tooltip delayDuration={300}>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => setCreatingGroup(true)}
                      data-testid="button-new-group"
                    >
                      <FolderPlus className="w-3.5 h-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">New group</TooltipContent>
                </Tooltip>

                {/* New Chat button */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  onClick={handleNewChat}
                  data-testid="button-new-chat"
                >
                  <Plus className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>

            <ScrollArea className="flex-1 px-2">
              <div className="space-y-0.5 pb-4">
                {/* New group inline input */}
                {creatingGroup && (
                  <div className="flex items-center gap-1 px-2 py-1" data-testid="new-group-input">
                    <Input
                      autoFocus
                      value={newGroupName}
                      onChange={e => setNewGroupName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter") handleCreateGroup();
                        if (e.key === "Escape") { setCreatingGroup(false); setNewGroupName(""); }
                      }}
                      placeholder="Group name..."
                      className="h-6 text-xs px-2"
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0"
                      onClick={handleCreateGroup}
                      data-testid="button-confirm-new-group"
                    >
                      <Check className="w-3 h-3 text-primary" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0"
                      onClick={() => { setCreatingGroup(false); setNewGroupName(""); }}
                      data-testid="button-cancel-new-group"
                    >
                      <X className="w-3 h-3 text-muted-foreground" />
                    </Button>
                  </div>
                )}

                {/* Groups with conversations */}
                {grouped.map(({ group, convs }) => (
                  <div key={group.id} data-testid={`group-${group.id}`}>
                    {/* Group header */}
                    <div className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/5 cursor-pointer group/folder">
                      <button
                        className="flex items-center gap-1 flex-1 min-w-0"
                        onClick={() => handleToggleGroup(group.id)}
                        data-testid={`toggle-group-${group.id}`}
                      >
                        {expandedGroups.has(group.id) ? (
                          <FolderOpen className="w-3.5 h-3.5 shrink-0 text-primary/70" />
                        ) : (
                          <FolderClosed className="w-3.5 h-3.5 shrink-0 text-primary/70" />
                        )}
                        {editingGroupId === group.id ? (
                          <Input
                            autoFocus
                            value={editingGroupName}
                            onChange={e => setEditingGroupName(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === "Enter") handleSaveGroupName();
                              if (e.key === "Escape") setEditingGroupId(null);
                            }}
                            onBlur={handleSaveGroupName}
                            className="h-5 text-xs px-1 py-0 flex-1"
                            onClick={e => e.stopPropagation()}
                            data-testid={`edit-group-name-${group.id}`}
                          />
                        ) : (
                          <span className="truncate flex-1 text-left font-medium">{group.name}</span>
                        )}
                        <span className="text-[10px] text-muted-foreground/50 shrink-0">
                          {convs.length}
                        </span>
                      </button>

                      {/* Group context menu */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 w-5 p-0 opacity-0 group-hover/folder:opacity-100 shrink-0"
                            onClick={(e) => e.stopPropagation()}
                            data-testid={`group-menu-${group.id}`}
                          >
                            <MoreVertical className="w-3 h-3" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent side="right" align="start" className="w-36">
                          <DropdownMenuItem
                            onClick={() => handleStartEditGroup(group)}
                            data-testid={`group-rename-${group.id}`}
                          >
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => deleteGroupMutation.mutate(group.id)}
                            data-testid={`group-delete-${group.id}`}
                          >
                            <Trash2 className="w-3.5 h-3.5 mr-2" />
                            Delete group
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>

                    {/* Conversations in group */}
                    {expandedGroups.has(group.id) && (
                      <div className="ml-3 border-l border-border/50 pl-1 space-y-0.5">
                        {convs.length === 0 ? (
                          <div className="px-2 py-1 text-[10px] text-muted-foreground/50 italic">
                            Empty group
                          </div>
                        ) : (
                          convs.map(conv => (
                            <ConversationItem key={conv.id} conv={conv} />
                          ))
                        )}
                      </div>
                    )}
                  </div>
                ))}

                {/* Ungrouped conversations */}
                {ungrouped.length > 0 && (
                  <div data-testid="ungrouped-section">
                    {groups.length > 0 && (
                      <div className="px-2 py-1 text-[10px] text-muted-foreground/40 uppercase tracking-wider">
                        Ungrouped
                      </div>
                    )}
                    {ungrouped.map(conv => (
                      <ConversationItem key={conv.id} conv={conv} />
                    ))}
                  </div>
                )}

                {conversations.length === 0 && (
                  <div className="px-2 py-3 text-[10px] text-muted-foreground/50 text-center">
                    No conversations yet
                  </div>
                )}
              </div>
            </ScrollArea>

            {/* Multi-select action bar */}
            {selectMode && (
              <div className="border-t border-border px-2 py-2 space-y-1" data-testid="select-action-bar">
                <div className="text-[10px] text-muted-foreground text-center">
                  {selectedIds.size} selected
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="destructive"
                    className="flex-1 h-7 text-xs"
                    disabled={selectedIds.size === 0}
                    onClick={() => setShowDeleteConfirm(true)}
                    data-testid="button-delete-selected"
                  >
                    <Trash2 className="w-3 h-3 mr-1" />
                    Delete ({selectedIds.size})
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs px-2"
                    onClick={() => { setSelectMode(false); setSelectedIds(new Set()); }}
                    data-testid="button-cancel-select"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </>
        )}

        {/* Spacer when collapsed or on non-chat routes */}
        {(collapsed || !isChatRoute) && <div className="flex-1" />}

        {/* Footer */}
        <div className="border-t border-border p-2">
          <Tooltip delayDuration={collapsed ? 100 : 1000}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={`w-full ${collapsed ? "px-0 justify-center" : "justify-start"} text-muted-foreground`}
                onClick={logout}
                data-testid="button-logout"
              >
                <LogOut className="w-4 h-4 shrink-0" />
                {!collapsed && <span className="ml-2 text-xs truncate">{username}</span>}
              </Button>
            </TooltipTrigger>
            {collapsed && <TooltipContent side="right">Logout ({username})</TooltipContent>}
          </Tooltip>
        </div>
      </div>

      {/* Bulk delete confirmation dialog */}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent data-testid="bulk-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedIds.size} conversation{selectedIds.size !== 1 ? "s" : ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. All selected conversations and their messages will be permanently deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="bulk-delete-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleBulkDelete}
              data-testid="bulk-delete-confirm"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}
