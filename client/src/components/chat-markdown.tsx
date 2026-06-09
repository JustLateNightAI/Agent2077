/**
 * Shared chat markdown + inline-image rendering primitives.
 *
 * `IMAGE_PATH_REGEX`, `imagePathToUrl`, and `MessageContentWithImages` were
 * duplicated verbatim in chat.tsx, workspace.tsx, and self-dev.tsx; `MarkdownMessage`
 * was duplicated in chat + self-dev. They are pure render helpers with no
 * page-specific state, so they consolidate here cleanly. Inline-image size is
 * the only thing that differed between pages, exposed via `imageSize`.
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

// Absolute paths the agent writes to its image dir, surfaced inline in replies.
export const IMAGE_PATH_REGEX =
  /(\/(?:home|root)\/[^\s]*\/agent2077-images\/[^\s]+\.(?:png|jpg|jpeg|webp|gif))/gi;

export function imagePathToUrl(filePath: string): string {
  return `/api/images/file?path=${encodeURIComponent(filePath)}`;
}

/** Extract and render only inline images from message content (text is handled by ReactMarkdown). */
export function MessageContentWithImages({
  content,
  onImageClick,
  imageSize = "md",
}: {
  content: string;
  onImageClick?: (src: string, alt: string) => void;
  /** `sm` = max-w-xs/max-h-64 (workspace, self-dev); `md` = max-w-sm/max-h-80 (main chat). */
  imageSize?: "sm" | "md";
}) {
  const parts = content.split(IMAGE_PATH_REGEX);
  if (parts.length === 1) return null; // No image paths found

  const images = parts.filter((part) => {
    IMAGE_PATH_REGEX.lastIndex = 0;
    return IMAGE_PATH_REGEX.test(part);
  });
  if (images.length === 0) return null;

  const sizeClass = imageSize === "md" ? "max-w-sm max-h-80" : "max-w-xs max-h-64";

  return (
    <div className="space-y-2">
      {images.map((imgPath, i) => {
        IMAGE_PATH_REGEX.lastIndex = 0;
        const url = imagePathToUrl(imgPath);
        const filename = imgPath.split("/").pop() || "image.png";
        return (
          <div key={i} className="my-2">
            <img
              src={url}
              alt={filename}
              className={`${sizeClass} rounded-lg border border-border/40 cursor-pointer hover:opacity-90 transition-opacity shadow-lg`}
              onClick={() => onImageClick?.(url, filename)}
              loading="lazy"
              data-testid={`inline-image-${i}`}
            />
          </div>
        );
      })}
    </div>
  );
}

/** Full markdown renderer with inline-image extraction + syntax highlighting. */
export function MarkdownMessage({
  content,
  onImageClick,
  imageSize = "md",
}: {
  content: string;
  onImageClick?: (src: string, alt: string) => void;
  imageSize?: "sm" | "md";
}) {
  return (
    <>
      <MessageContentWithImages content={content} onImageClick={onImageClick} imageSize={imageSize} />
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        className="prose prose-invert prose-sm max-w-none text-foreground break-words"
        components={{
          code({ className, children, ...props }: any) {
            const inline = !className;
            if (inline) {
              return (
                <code className="bg-muted/60 px-1 py-0.5 rounded text-xs font-mono text-primary" {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code className={`${className ?? ""} text-xs`} {...props}>
                {children}
              </code>
            );
          },
          pre({ children }: any) {
            return (
              <pre className="bg-black/50 border border-border/40 rounded-md p-3 overflow-x-auto text-xs my-2">
                {children}
              </pre>
            );
          },
        }}
      >
        {content.replace(IMAGE_PATH_REGEX, "").trim()}
      </ReactMarkdown>
    </>
  );
}
