/**
 * Shared chat message bubble used by the workspace and self-dev chat surfaces.
 *
 * `WsChatBubble` (workspace.tsx) and `MessageBubble` (self-dev.tsx) rendered the
 * same thing — role-aligned bubble, avatar, inline images parsed from
 * `message.images` JSON (or optimistic `pendingImages`), markdown body with
 * highlight, copy-on-hover, optional streaming spinner/cursor — differing only
 * in a few Tailwind classes. Those differences are captured by `variant` so a
 * single component serves both without visual regression.
 *
 * Main chat keeps its own richer bubble (branch/delete/resend/confidence); it
 * shares only the markdown primitives in chat-markdown.tsx.
 */
import { useState } from "react";
import { Bot, User, Copy, Check, Loader2 } from "lucide-react";
import { MarkdownMessage } from "@/components/chat-markdown";

export interface ChatBubbleMessage {
  id: number;
  role: string;
  content: string;
  images?: string; // JSON-stringified Array<{name, base64, mimeType}>
  createdAt: string;
  modelId?: string;
  taskType?: string;
}

interface ChatImage {
  name: string;
  base64: string;
  mimeType: string;
}

export interface ChatMessageBubbleProps {
  message: ChatBubbleMessage;
  isStreaming?: boolean;
  currentStatus?: { message: string; detail?: string };
  /** Optimistic images for an unsent user bubble (id === -2). */
  pendingImages?: ChatImage[];
  onImageClick?: (src: string, alt: string) => void;
  /**
   * `default` = self-dev styling (text-sm, soft user bubble, avatars both sides,
   * shows timestamp). `compact` = workspace styling (text-xs, solid user bubble).
   */
  variant?: "default" | "compact";
}

function parseImages(message: ChatBubbleMessage, pendingImages?: ChatImage[]): ChatImage[] {
  if (message.role === "user" && message.id === -2 && pendingImages) return pendingImages;
  if (!message.images) return [];
  try {
    return JSON.parse(message.images);
  } catch {
    return [];
  }
}

export function ChatMessageBubble({
  message,
  isStreaming,
  currentStatus,
  pendingImages,
  onImageClick,
  variant = "default",
}: ChatMessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === "user";
  const images = parseImages(message, pendingImages);

  const copy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (variant === "compact") {
    // Workspace styling: text-xs, solid primary user bubble, avatar opposite content.
    return (
      <div className={`flex gap-2 ${isUser ? "justify-end" : ""}`}>
        {!isUser && (
          <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
            <Bot className="w-3.5 h-3.5 text-primary" />
          </div>
        )}
        <div className={`flex-1 max-w-[90%] ${isUser ? "text-right" : ""}`}>
          <div
            className={`inline-block text-xs rounded-lg px-2.5 py-1.5 ${
              isUser ? "bg-primary text-primary-foreground ml-auto" : "bg-card border border-border"
            }`}
          >
            {isUser ? (
              <>
                {images.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-1">
                    {images.map((img, i) => (
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
                <p className="whitespace-pre-wrap text-left">{message.content}</p>
              </>
            ) : (
              <div className="markdown-content">
                {message.content ? (
                  <MarkdownMessage content={message.content} onImageClick={onImageClick} imageSize="sm" />
                ) : isStreaming ? (
                  <div className="flex items-center gap-1.5 py-0.5">
                    <Loader2 className="w-3 h-3 animate-spin text-primary" />
                    <span className="text-[10px] text-muted-foreground">
                      {currentStatus?.message || "Thinking..."}
                    </span>
                  </div>
                ) : null}
                {isStreaming && message.content && (
                  <span className="inline-block w-1.5 h-3 bg-primary animate-pulse ml-0.5" />
                )}
              </div>
            )}
          </div>
          {!isStreaming && !isUser && message.content && (
            <div className="opacity-0 hover:opacity-100 transition-opacity mt-0.5">
              <button className="h-4 px-1 inline-flex items-center" onClick={copy}>
                {copied ? <Check className="w-2.5 h-2.5 text-green-400" /> : <Copy className="w-2.5 h-2.5" />}
              </button>
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

  // Default (self-dev) styling: text-sm, soft user bubble, avatars both sides, timestamp.
  return (
    <div className={`flex gap-2.5 group ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      <div
        className={`w-6 h-6 rounded-full border flex items-center justify-center shrink-0 mt-0.5 ${
          isUser ? "bg-primary/20 border-primary/30" : "bg-cyan-500/10 border-cyan-500/20"
        }`}
      >
        {isUser ? <User className="w-3 h-3 text-primary" /> : <Bot className="w-3 h-3 text-cyan-400" />}
      </div>

      <div className={`flex-1 min-w-0 ${isUser ? "items-end" : "items-start"} flex flex-col`}>
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {images.map((img, i) => (
              <img
                key={i}
                src={img.base64}
                alt={img.name}
                className="w-24 h-24 object-cover rounded-lg border border-border/30 cursor-pointer hover:opacity-90 transition-opacity"
                onClick={() => onImageClick?.(img.base64, img.name)}
              />
            ))}
          </div>
        )}
        <div
          className={`relative max-w-[90%] rounded-xl px-3 py-2 ${
            isUser
              ? "bg-primary/10 border border-primary/20 rounded-tr-sm"
              : "bg-muted/30 border border-border/30 rounded-tl-sm"
          }`}
        >
          {isUser ? (
            <p className="text-sm text-foreground/90 whitespace-pre-wrap text-left">{message.content}</p>
          ) : message.content ? (
            <MarkdownMessage content={message.content} onImageClick={onImageClick} imageSize="sm" />
          ) : isStreaming ? (
            <div className="flex items-center gap-1.5 py-0.5">
              <Loader2 className="w-3 h-3 animate-spin text-primary" />
              <span className="text-[10px] text-muted-foreground">{currentStatus?.message || "Thinking..."}</span>
            </div>
          ) : null}
          {!isUser && message.content && (
            <button
              className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={copy}
            >
              {copied ? (
                <Check className="w-3 h-3 text-green-400" />
              ) : (
                <Copy className="w-3 h-3 text-muted-foreground hover:text-foreground" />
              )}
            </button>
          )}
          {!isUser && isStreaming && message.content && (
            <span className="inline-block w-1.5 h-3 bg-primary animate-pulse ml-0.5" />
          )}
        </div>
        <span className="text-[9px] text-muted-foreground/50 mt-0.5 px-1 font-mono">
          {new Date(message.createdAt).toLocaleTimeString()}
        </span>
      </div>
    </div>
  );
}

export default ChatMessageBubble;
