import {
  useState,
  useRef,
  useEffect,
  useCallback,
  MouseEvent as ReactMouseEvent,
} from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAgentName } from "@/lib/useAgentName";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  ImageIcon,
  Heart,
  Download,
  Trash2,
  Paintbrush,
  Eraser,
  RotateCcw,
  X,
  Search,
  SlidersHorizontal,
  MessageSquare,
  Sparkles,
  ZoomIn,
  ChevronDown,
  Loader2,
  Grid2X2,
  Grid3X3,
  LayoutGrid,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────

interface GeneratedImage {
  id: number;
  filePath: string;
  thumbnailPath: string | null;
  prompt: string | null;
  negativePrompt: string | null;
  model: string | null;
  width: number | null;
  height: number | null;
  steps: number | null;
  cfg: number | null;
  sampler: string | null;
  scheduler: string | null;
  seed: number | null;
  generationType: string;
  sourceImageId: number | null;
  conversationId: number | null;
  projectId: number | null;
  durationMs: number | null;
  comfyuiPromptId: string | null;
  tags: string | null;
  isFavorite: boolean;
  createdAt: string;
}

interface Conversation {
  id: number;
  title: string | null;
  createdAt: string;
}

// ── Helpers ──────────────────────────────────────────────────────

type GridSize = "small" | "medium" | "large";

function gridClasses(size: GridSize): string {
  switch (size) {
    case "small":  return "grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2";
    case "medium": return "grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3";
    case "large":  return "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4";
  }
}

function imageUrl(filePath: string): string {
  return `/api/images/file?path=${encodeURIComponent(filePath)}`;
}

function typeColor(type: string): string {
  const map: Record<string, string> = {
    txt2img: "bg-primary/20 text-primary border-primary/30",
    img2img: "bg-purple-500/20 text-purple-400 border-purple-500/30",
    inpaint: "bg-orange-500/20 text-orange-400 border-orange-500/30",
    upscale: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  };
  return map[type] ?? "bg-muted text-muted-foreground border-border";
}

function formatDuration(ms: number | null): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Skeleton Grid ────────────────────────────────────────────────

function GridSkeleton({ gridSize = "medium" }: { gridSize?: GridSize }) {
  return (
    <div className={`grid ${gridClasses(gridSize)}`}>
      {Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="aspect-square rounded-lg overflow-hidden">
          <Skeleton className="w-full h-full" />
        </div>
      ))}
    </div>
  );
}

// ── Empty State ──────────────────────────────────────────────────

function EmptyState({ message }: { message: string }) {
  return (
    <div
      className="flex flex-col items-center justify-center py-24 text-center"
      data-testid="empty-state"
    >
      <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-5">
        <ImageIcon className="w-8 h-8 text-primary/60" />
      </div>
      <p className="text-base font-medium text-foreground mb-1">No images yet</p>
      <p className="text-sm text-muted-foreground max-w-xs">{message}</p>
    </div>
  );
}

// ── Inpaint Canvas ───────────────────────────────────────────────

interface InpaintEditorProps {
  image: GeneratedImage;
  onClose: () => void;
}

function InpaintEditor({ image, onClose }: InpaintEditorProps) {
  const { toast } = useToast();
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [tool, setTool] = useState<"brush" | "eraser">("brush");
  const [brushSize, setBrushSize] = useState(30);
  const [prompt, setPrompt] = useState("");
  const [checkpoint, setCheckpoint] = useState("");
  const [resultImagePath, setResultImagePath] = useState<string | null>(null);
  const lastPos = useRef<{ x: number; y: number } | null>(null);

  // Load source image onto base canvas
  useEffect(() => {
    const base = baseCanvasRef.current;
    const mask = maskCanvasRef.current;
    if (!base || !mask) return;
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const maxW = Math.min(1024, img.naturalWidth);
      const scale = maxW / img.naturalWidth;
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      base.width = w;
      base.height = h;
      mask.width = w;
      mask.height = h;
      const ctx = base.getContext("2d")!;
      ctx.drawImage(img, 0, 0, w, h);
      const mCtx = mask.getContext("2d")!;
      mCtx.clearRect(0, 0, w, h);
    };
    img.src = imageUrl(image.filePath);
  }, [image.filePath]);

  function getPos(e: ReactMouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) {
    const canvas = maskCanvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    let clientX: number, clientY: number;
    if ("touches" in e) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = (e as ReactMouseEvent<HTMLCanvasElement>).clientX;
      clientY = (e as ReactMouseEvent<HTMLCanvasElement>).clientY;
    }
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }

  function draw(x: number, y: number) {
    const ctx = maskCanvasRef.current?.getContext("2d");
    if (!ctx) return;
    ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = brushSize;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (lastPos.current) {
      ctx.beginPath();
      ctx.moveTo(lastPos.current.x, lastPos.current.y);
      ctx.lineTo(x, y);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
      ctx.fillStyle = tool === "eraser" ? "rgba(0,0,0,0)" : "rgba(255,255,255,0.9)";
      ctx.fill();
    }
    lastPos.current = { x, y };
  }

  function handleMouseDown(e: ReactMouseEvent<HTMLCanvasElement>) {
    setIsDrawing(true);
    lastPos.current = null;
    const pos = getPos(e);
    draw(pos.x, pos.y);
  }

  function handleMouseMove(e: ReactMouseEvent<HTMLCanvasElement>) {
    if (!isDrawing) return;
    const pos = getPos(e);
    draw(pos.x, pos.y);
  }

  function handleMouseUp() {
    setIsDrawing(false);
    lastPos.current = null;
  }

  function clearMask() {
    const canvas = maskCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function getMaskDataUrl(): string {
    const src = maskCanvasRef.current!;
    const out = document.createElement("canvas");
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext("2d")!;
    // Black background
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, out.width, out.height);
    // White where user painted
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(src, 0, 0);
    return out.toDataURL("image/png");
  }

  const inpaintMutation = useMutation({
    mutationFn: async () => {
      const maskDataUrl = getMaskDataUrl();
      const res = await apiRequest("POST", "/api/images/inpaint", {
        sourceImagePath: image.filePath,
        maskDataUrl,
        prompt,
        checkpoint: checkpoint || undefined,
      });
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Inpaint complete", description: "New image generated." });
      if (data?.filePath) setResultImagePath(data.filePath);
      queryClient.invalidateQueries({ queryKey: ["/api/images"] });
    },
    onError: (err: Error) => {
      toast({ title: "Inpaint failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="flex flex-col gap-4 h-full" data-testid="inpaint-editor">
      {/* Canvas area */}
      <div
        ref={containerRef}
        className="relative flex-1 min-h-0 flex items-center justify-center bg-black/40 rounded-lg overflow-hidden border border-border"
      >
        <div className="relative" style={{ lineHeight: 0 }}>
          <canvas
            ref={baseCanvasRef}
            className="max-w-full max-h-[65vh] object-contain block rounded"
          />
          <canvas
            ref={maskCanvasRef}
            className="absolute inset-0 max-w-full max-h-[65vh] cursor-crosshair"
            style={{ opacity: 0.55, mixBlendMode: "screen" }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            data-testid="mask-canvas"
          />
        </div>
      </div>

      {/* Tools */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={tool === "brush" ? "default" : "outline"}
            onClick={() => setTool("brush")}
            data-testid="tool-brush"
          >
            <Paintbrush className="w-4 h-4 mr-1" />
            Brush
          </Button>
          <Button
            size="sm"
            variant={tool === "eraser" ? "default" : "outline"}
            onClick={() => setTool("eraser")}
            data-testid="tool-eraser"
          >
            <Eraser className="w-4 h-4 mr-1" />
            Eraser
          </Button>
        </div>

        <div className="flex items-center gap-2 flex-1 min-w-32 max-w-48">
          <span className="text-xs text-muted-foreground font-mono whitespace-nowrap">
            Size {brushSize}px
          </span>
          <Slider
            min={5}
            max={100}
            step={1}
            value={[brushSize]}
            onValueChange={([v]) => setBrushSize(v)}
            className="flex-1"
            data-testid="brush-size-slider"
          />
        </div>

        <Button
          size="sm"
          variant="ghost"
          onClick={clearMask}
          data-testid="clear-mask"
        >
          <RotateCcw className="w-4 h-4 mr-1" />
          Clear
        </Button>
      </div>

      {/* Result preview */}
      {resultImagePath && (
        <div className="rounded-lg overflow-hidden border border-primary/30 bg-black/30">
          <p className="text-xs text-primary font-mono px-3 py-1.5 border-b border-primary/20">
            Result
          </p>
          <img
            src={imageUrl(resultImagePath)}
            alt="Inpaint result"
            className="w-full max-h-48 object-contain"
            data-testid="inpaint-result"
          />
        </div>
      )}

      {/* Prompt + Generate */}
      <div className="flex flex-col gap-2">
        <Textarea
          placeholder="What to generate in the masked area…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={2}
          className="resize-none text-sm font-mono"
          data-testid="inpaint-prompt"
        />
        <div className="flex gap-2">
          <Input
            placeholder="Checkpoint (optional)"
            value={checkpoint}
            onChange={(e) => setCheckpoint(e.target.value)}
            className="flex-1 text-sm font-mono"
            data-testid="inpaint-checkpoint"
          />
          <Button
            onClick={() => inpaintMutation.mutate()}
            disabled={inpaintMutation.isPending || !prompt.trim()}
            className="shrink-0"
            data-testid="inpaint-generate"
          >
            {inpaintMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4 mr-1.5" />
            )}
            Generate
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Image Detail Lightbox ────────────────────────────────────────

interface LightboxProps {
  image: GeneratedImage;
  onClose: () => void;
  onDelete: (id: number) => void;
  onFavoriteToggle: (id: number) => void;
  isFavPending: boolean;
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  if (!value && value !== 0) return null;
  return (
    <div className="flex gap-2 text-xs">
      <span className="text-muted-foreground font-mono w-24 shrink-0">{label}</span>
      <span className="text-foreground font-mono break-all">{value}</span>
    </div>
  );
}

function ImageLightbox({
  image,
  onClose,
  onDelete,
  onFavoriteToggle,
  isFavPending,
}: LightboxProps) {
  const [showDeleteAlert, setShowDeleteAlert] = useState(false);
  const [showInpaint, setShowInpaint] = useState(false);

  function handleDownload() {
    const a = document.createElement("a");
    a.href = imageUrl(image.filePath);
    a.download = image.filePath.split("/").pop() ?? "image.png";
    a.click();
  }

  return (
    <>
      <div className="flex flex-col gap-4 max-h-[85vh] overflow-y-auto" data-testid="image-lightbox">
        {/* Full-size image */}
        <div className="flex items-center justify-center bg-black/50 rounded-xl overflow-hidden min-h-48">
          <img
            src={imageUrl(image.filePath)}
            alt={image.prompt ?? "Generated image"}
            className="max-w-full object-contain rounded-xl"
            style={{ maxHeight: "55vh" }}
            data-testid="lightbox-image"
          />
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={image.isFavorite ? "default" : "outline"}
            onClick={() => onFavoriteToggle(image.id)}
            disabled={isFavPending}
            data-testid="lightbox-favorite"
          >
            <Heart className={`w-4 h-4 mr-1.5 ${image.isFavorite ? "fill-current" : ""}`} />
            {image.isFavorite ? "Favorited" : "Favorite"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleDownload}
            data-testid="lightbox-download"
          >
            <Download className="w-4 h-4 mr-1.5" />
            Download
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowInpaint(true)}
            data-testid="lightbox-inpaint"
          >
            <Paintbrush className="w-4 h-4 mr-1.5" />
            Inpaint Edit
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setShowDeleteAlert(true)}
            data-testid="lightbox-delete"
          >
            <Trash2 className="w-4 h-4 mr-1.5" />
            Delete
          </Button>
        </div>

        <Separator />

        {/* Metadata */}
        <div className="flex flex-col gap-1.5">
          {image.prompt && (
            <div className="rounded-lg bg-muted/40 border border-border p-3 mb-1">
              <p className="text-xs text-muted-foreground font-mono mb-1">Prompt</p>
              <p className="text-sm text-foreground leading-relaxed" data-testid="lightbox-prompt">
                {image.prompt}
              </p>
            </div>
          )}
          {image.negativePrompt && (
            <div className="rounded-lg bg-muted/30 border border-border p-3 mb-1">
              <p className="text-xs text-muted-foreground font-mono mb-1">Negative prompt</p>
              <p className="text-sm text-foreground/80 leading-relaxed" data-testid="lightbox-negative-prompt">
                {image.negativePrompt}
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 pt-1">
            <InfoRow label="Type" value={
              <Badge className={`text-xs py-0 ${typeColor(image.generationType)}`} variant="outline">
                {image.generationType}
              </Badge>
            } />
            <InfoRow label="Model" value={image.model} />
            <InfoRow
              label="Dimensions"
              value={image.width && image.height ? `${image.width} × ${image.height}` : null}
            />
            <InfoRow label="Steps" value={image.steps} />
            <InfoRow label="CFG" value={image.cfg} />
            <InfoRow label="Sampler" value={image.sampler} />
            <InfoRow label="Scheduler" value={image.scheduler} />
            <InfoRow label="Seed" value={image.seed} />
            <InfoRow label="Duration" value={formatDuration(image.durationMs)} />
            <InfoRow label="Created" value={formatDate(image.createdAt)} />
          </div>
        </div>
      </div>

      {/* Delete confirmation */}
      <AlertDialog open={showDeleteAlert} onOpenChange={setShowDeleteAlert}>
        <AlertDialogContent data-testid="delete-alert-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete image?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the image from disk. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="delete-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                onDelete(image.id);
                setShowDeleteAlert(false);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="delete-confirm"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Inpaint editor dialog — extra-wide for painting comfort */}
      <Dialog open={showInpaint} onOpenChange={setShowInpaint}>
        <DialogContent
          className="max-w-5xl w-[95vw]"
          style={{ maxHeight: "95vh", overflowY: "auto" }}
          data-testid="inpaint-dialog"
        >
          <DialogHeader>
            <DialogTitle className="font-mono text-primary">
              Inpaint Editor
            </DialogTitle>
          </DialogHeader>
          <InpaintEditor image={image} onClose={() => setShowInpaint(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Image Card ───────────────────────────────────────────────────

interface ImageCardProps {
  image: GeneratedImage;
  onSelect: (img: GeneratedImage) => void;
  onFavoriteToggle: (id: number) => void;
  isFavPending: boolean;
}

function ImageCard({ image, onSelect, onFavoriteToggle, isFavPending }: ImageCardProps) {
  const [imgError, setImgError] = useState(false);
  const src = image.thumbnailPath
    ? imageUrl(image.thumbnailPath)
    : imageUrl(image.filePath);

  return (
    <div
      className="group relative aspect-square rounded-xl overflow-hidden bg-muted/30 border border-border hover:border-primary/40 transition-all duration-200 cursor-pointer"
      onClick={() => onSelect(image)}
      data-testid={`image-card-${image.id}`}
    >
      {/* Image */}
      {imgError ? (
        <div className="w-full h-full flex items-center justify-center bg-muted/50">
          <ImageIcon className="w-8 h-8 text-muted-foreground/40" />
        </div>
      ) : (
        <img
          src={src}
          alt={image.prompt ?? "Generated image"}
          className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
          onError={() => setImgError(true)}
          loading="lazy"
          data-testid={`image-thumb-${image.id}`}
        />
      )}

      {/* Hover overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200" />

      {/* Type badge */}
      <div className="absolute top-2 left-2">
        <Badge
          className={`text-[10px] py-0 px-1.5 border ${typeColor(image.generationType)}`}
          variant="outline"
          data-testid={`badge-type-${image.id}`}
        >
          {image.generationType}
        </Badge>
      </div>

      {/* Favorite button */}
      <button
        className={`absolute top-2 right-2 w-7 h-7 rounded-full flex items-center justify-center transition-all duration-150 ${
          image.isFavorite
            ? "bg-pink-500/90 text-white opacity-100"
            : "bg-black/50 text-white/70 opacity-0 group-hover:opacity-100 hover:bg-pink-500/80"
        }`}
        onClick={(e) => {
          e.stopPropagation();
          onFavoriteToggle(image.id);
        }}
        disabled={isFavPending}
        aria-label={image.isFavorite ? "Remove from favorites" : "Add to favorites"}
        data-testid={`favorite-btn-${image.id}`}
      >
        <Heart className={`w-3.5 h-3.5 ${image.isFavorite ? "fill-current" : ""}`} />
      </button>

      {/* Bottom info */}
      <div className="absolute bottom-0 left-0 right-0 p-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
        {image.model && (
          <p
            className="text-[10px] text-white/80 font-mono truncate"
            data-testid={`model-label-${image.id}`}
          >
            {image.model.length > 28 ? `${image.model.slice(0, 26)}…` : image.model}
          </p>
        )}

        {/* Zoom hint */}
        <div className="flex justify-end mt-0.5">
          <ZoomIn className="w-3 h-3 text-white/50" />
        </div>
      </div>
    </div>
  );
}

// ── Sort helper ──────────────────────────────────────────────────

type SortMode = "newest" | "oldest" | "type";

function sortImages(images: GeneratedImage[], mode: SortMode): GeneratedImage[] {
  const copy = [...images];
  if (mode === "newest") return copy.sort((a, b) => b.id - a.id);
  if (mode === "oldest") return copy.sort((a, b) => a.id - b.id);
  if (mode === "type")
    return copy.sort((a, b) => a.generationType.localeCompare(b.generationType) || b.id - a.id);
  return copy;
}

// ── Main Page ────────────────────────────────────────────────────

export default function ImageGalleryPage() {
  const { toast } = useToast();
  const agentName = useAgentName();

  // View state
  const [tab, setTab] = useState<"all" | "chat" | "favorites" | "search">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [selectedConvId, setSelectedConvId] = useState<string>("");
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [gridSize, setGridSize] = useState<GridSize>("medium");

  // Lightbox
  const [selectedImage, setSelectedImage] = useState<GeneratedImage | null>(null);

  // Build query params per tab
  function buildQueryKey(): string {
    if (tab === "favorites") return "/api/images?favorites=true";
    if (tab === "chat" && selectedConvId) return `/api/images?conversationId=${selectedConvId}`;
    if (tab === "search" && submittedSearch) return `/api/images?search=${encodeURIComponent(submittedSearch)}`;
    if (tab === "all") return "/api/images";
    return "/api/images";
  }

  const queryKey = buildQueryKey();

  const { data: images = [], isLoading: imagesLoading } = useQuery<GeneratedImage[]>({
    queryKey: [queryKey],
    enabled:
      tab === "all" ||
      tab === "favorites" ||
      (tab === "chat" && !!selectedConvId) ||
      (tab === "search" && !!submittedSearch),
  });

  const { data: conversations = [] } = useQuery<Conversation[]>({
    queryKey: ["/api/conversations"],
  });

  // Favorite mutation
  const favMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/images/${id}/favorite`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [queryKey] });
      if (selectedImage) {
        queryClient.invalidateQueries({ queryKey: ["/api/images"] });
      }
    },
    onError: (err: Error) => {
      toast({ title: "Failed to toggle favorite", description: err.message, variant: "destructive" });
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/images/${id}`);
    },
    onSuccess: () => {
      toast({ title: "Image deleted" });
      setSelectedImage(null);
      queryClient.invalidateQueries({ queryKey: [queryKey] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
    },
  });

  const sorted = sortImages(images, sortMode);

  function handleFavoriteToggle(id: number) {
    favMutation.mutate(id);
    // Optimistically update the lightbox image if it's the one
    if (selectedImage?.id === id) {
      setSelectedImage((prev) =>
        prev ? { ...prev, isFavorite: !prev.isFavorite } : prev
      );
    }
  }

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmittedSearch(searchQuery);
  }

  const showGrid =
    tab === "all" ||
    tab === "favorites" ||
    (tab === "chat" && !!selectedConvId) ||
    (tab === "search" && !!submittedSearch);

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-6 pt-6 pb-4 border-b border-border">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center">
              <ImageIcon className="w-4 h-4 text-primary" />
            </div>
            <h1 className="text-xl font-semibold text-foreground tracking-tight" data-testid="page-title">
              Image Gallery
            </h1>
          </div>

          {/* Grid size + Sort */}
          <div className="flex items-center gap-3">
            {/* Grid size toggle */}
            <div className="flex items-center gap-0.5 bg-muted/50 border border-border rounded-md p-0.5" data-testid="grid-size-toggle">
              <button
                onClick={() => setGridSize("small")}
                className={`p-1.5 rounded transition-colors ${
                  gridSize === "small"
                    ? "bg-background text-primary shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                title="Small grid"
                data-testid="grid-size-small"
              >
                <Grid3X3 className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setGridSize("medium")}
                className={`p-1.5 rounded transition-colors ${
                  gridSize === "medium"
                    ? "bg-background text-primary shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                title="Medium grid"
                data-testid="grid-size-medium"
              >
                <Grid2X2 className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setGridSize("large")}
                className={`p-1.5 rounded transition-colors ${
                  gridSize === "large"
                    ? "bg-background text-primary shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                title="Large grid"
                data-testid="grid-size-large"
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
            </div>

            <SlidersHorizontal className="w-4 h-4 text-muted-foreground" />
            <Select value={sortMode} onValueChange={(v) => setSortMode(v as SortMode)}>
              <SelectTrigger
                className="h-8 text-xs w-40 font-mono"
                data-testid="sort-select"
              >
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">Most Recent</SelectItem>
                <SelectItem value="oldest">Oldest First</SelectItem>
                <SelectItem value="type">By Type</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="shrink-0 px-6 pt-4">
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList className="bg-muted/50 border border-border h-9" data-testid="gallery-tabs">
            <TabsTrigger value="all" className="text-xs font-mono" data-testid="tab-all">
              All Images
            </TabsTrigger>
            <TabsTrigger value="chat" className="text-xs font-mono" data-testid="tab-chat">
              <MessageSquare className="w-3 h-3 mr-1" />
              By Chat
            </TabsTrigger>
            <TabsTrigger value="favorites" className="text-xs font-mono" data-testid="tab-favorites">
              <Heart className="w-3 h-3 mr-1" />
              Favorites
            </TabsTrigger>
            <TabsTrigger value="search" className="text-xs font-mono" data-testid="tab-search">
              <Search className="w-3 h-3 mr-1" />
              Search
            </TabsTrigger>
          </TabsList>

          {/* ── By Chat: conversation picker ── */}
          {tab === "chat" && (
            <div className="flex items-center gap-3 mt-3">
              <MessageSquare className="w-4 h-4 text-muted-foreground shrink-0" />
              <Select
                value={selectedConvId}
                onValueChange={setSelectedConvId}
              >
                <SelectTrigger
                  className="h-8 text-xs w-64 font-mono"
                  data-testid="conversation-select"
                >
                  <SelectValue placeholder="Pick a conversation…" />
                </SelectTrigger>
                <SelectContent>
                  {conversations.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.title ?? `Chat #${c.id}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* ── Search bar ── */}
          {tab === "search" && (
            <form onSubmit={handleSearchSubmit} className="flex gap-2 mt-3">
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search prompts…"
                className="h-8 text-xs font-mono flex-1 max-w-sm"
                data-testid="search-input"
              />
              <Button type="submit" size="sm" className="h-8 text-xs" data-testid="search-submit">
                <Search className="w-3 h-3 mr-1" />
                Search
              </Button>
            </form>
          )}
        </Tabs>
      </div>

      {/* Grid area */}
      <div className="flex-1 overflow-y-auto px-6 pt-4 pb-6">
        {imagesLoading ? (
          <GridSkeleton gridSize={gridSize} />
        ) : !showGrid ? (
          /* Prompt user to take action */
          tab === "chat" ? (
            <EmptyState message="Select a conversation above to view its images." />
          ) : (
            <EmptyState message="Enter a search term above and press Search." />
          )
        ) : sorted.length === 0 ? (
          <EmptyState
            message={
              tab === "favorites"
                ? "No favorited images yet. Click ♥ on any image to save it here."
                : tab === "search"
                ? "No images matched your search."
                : tab === "chat"
                ? "No images from this conversation."
                : `No images yet. Generate your first image by asking ${agentName} in chat.`
            }
          />
        ) : (
          <div
            className={`grid ${gridClasses(gridSize)}`}
            data-testid="image-grid"
          >
            {sorted.map((img) => (
              <ImageCard
                key={img.id}
                image={img}
                onSelect={setSelectedImage}
                onFavoriteToggle={handleFavoriteToggle}
                isFavPending={favMutation.isPending}
              />
            ))}
          </div>
        )}

        {/* Image count */}
        {!imagesLoading && sorted.length > 0 && (
          <p className="text-xs text-muted-foreground font-mono text-center mt-6" data-testid="image-count">
            {sorted.length} image{sorted.length !== 1 ? "s" : ""}
          </p>
        )}
      </div>

      {/* Lightbox Dialog */}
      <Dialog open={!!selectedImage} onOpenChange={(open) => !open && setSelectedImage(null)}>
        <DialogContent
          className="max-w-4xl w-[90vw] p-6"
          style={{ maxHeight: "95vh", overflowY: "auto" }}
          data-testid="lightbox-dialog"
        >
          <DialogHeader className="mb-2">
            <DialogTitle className="font-mono text-primary text-sm flex items-center gap-2">
              <ZoomIn className="w-4 h-4" />
              Image Detail
              {selectedImage && (
                <Badge
                  className={`ml-auto text-xs border ${typeColor(selectedImage.generationType)}`}
                  variant="outline"
                >
                  {selectedImage.generationType}
                </Badge>
              )}
            </DialogTitle>
          </DialogHeader>

          {selectedImage && (
            <ImageLightbox
              image={selectedImage}
              onClose={() => setSelectedImage(null)}
              onDelete={(id) => deleteMutation.mutate(id)}
              onFavoriteToggle={handleFavoriteToggle}
              isFavPending={favMutation.isPending}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
