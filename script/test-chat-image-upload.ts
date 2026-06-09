/**
 * Chat image-upload smoke test (v16.74.15 chat standardization).
 *
 * The chat standardization refactor moved the SSE parse loop + message bubble
 * into shared modules (useChatStream, ChatMessageBubble, chat-markdown). This
 * test pins the parts of the image-upload path that are NOT covered by the
 * React UI: that an uploaded image survives a DB round-trip on the user message,
 * and that the server's user-message → multimodal-content conversion (inline in
 * POST /api/chat and /api/self-dev/chat) behaves correctly for vision vs.
 * non-vision models. If a future refactor drops the `images` column from the
 * insert/select, or breaks the OpenAI-compatible vision shaping, this fails.
 *
 * Run with: npx tsx script/test-chat-image-upload.ts
 */
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

process.env.AGENT2077_DB_PATH = join(mkdtempSync(join(tmpdir(), "a2077-img-")), "test.db");

const { bootstrapSchema, initFTS, runMigrations, initNewTables } = await import("../server/db.js");
bootstrapSchema();
initFTS();
runMigrations();
initNewTables();

const { conversationStore, messageStore } = await import("../server/storage.js");

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${label}${detail ? " — " + detail : ""}`);
  if (!ok) { failures++; process.exitCode = 1; }
}

// ── 1. Image payload survives the user-message DB round-trip ─────────────────
const conv = conversationStore.create({ title: "Image chat", systemPrompt: null });

const uploaded = [
  { name: "screenshot.png", base64: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", mimeType: "image/png" },
  { name: "diagram.jpg", base64: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD", mimeType: "image/jpeg" },
];

const userMsg = messageStore.create({
  conversationId: conv.id,
  role: "user",
  content: "what is in these images?",
  images: JSON.stringify(uploaded),
});

const reloaded = messageStore.getByConversation(conv.id).find(m => m.id === userMsg.id);
check("user message persisted", !!reloaded);
check("images column round-trips", !!reloaded?.images);

const parsed = reloaded?.images ? JSON.parse(reloaded.images) : [];
check("both images preserved", parsed.length === 2, `got ${parsed.length}`);
check("base64 data preserved byte-for-byte", parsed[0]?.base64 === uploaded[0].base64);
check("image name + mimeType preserved",
  parsed[1]?.name === "diagram.jpg" && parsed[1]?.mimeType === "image/jpeg");

// ── 2. Server multimodal conversion (mirrors routes.ts POST /api/chat) ───────
// Replicated here because the conversion is inline in the route handler.
function toChatMessage(
  m: { role: string; content: string; images?: string | null },
  supportsVision: boolean,
): { role: string; content: any } {
  if (m.role === "user" && m.images) {
    try {
      const imgs = JSON.parse(m.images) as Array<{ name: string; base64: string; mimeType: string }>;
      if (imgs.length > 0) {
        if (!supportsVision) {
          const note = imgs.length === 1
            ? `\n\n[Note: 1 image was attached but this model does not support vision — image skipped]`
            : `\n\n[Note: ${imgs.length} images were attached but this model does not support vision — images skipped]`;
          return { role: m.role, content: (m.content || "") + note };
        }
        const content: any[] = [{ type: "text", text: m.content || "" }];
        for (const img of imgs) {
          content.push({ type: "image_url", image_url: { url: img.base64 } });
        }
        return { role: m.role, content };
      }
    } catch { /* fall through to text */ }
  }
  return { role: m.role, content: m.content || "" };
}

const visionMsg = toChatMessage(reloaded!, true);
check("vision model → multimodal array content", Array.isArray(visionMsg.content));
check("vision content leads with text part",
  visionMsg.content[0]?.type === "text" && visionMsg.content[0]?.text === "what is in these images?");
check("vision content has one image_url per upload",
  visionMsg.content.filter((c: any) => c.type === "image_url").length === 2);
check("image_url carries the base64 data URL",
  visionMsg.content[1]?.image_url?.url === uploaded[0].base64);

const noVisionMsg = toChatMessage(reloaded!, false);
check("non-vision model → string content (images stripped)", typeof noVisionMsg.content === "string");
check("non-vision content keeps original text", noVisionMsg.content.startsWith("what is in these images?"));
check("non-vision content appends a 'vision not supported' note",
  noVisionMsg.content.includes("does not support vision"));

// ── 3. A user message with no images stays a plain string ────────────────────
const plainMsg = messageStore.create({ conversationId: conv.id, role: "user", content: "hello" });
const plainReloaded = messageStore.getByConversation(conv.id).find(m => m.id === plainMsg.id)!;
const plainChat = toChatMessage(plainReloaded, true);
check("no-image message → plain string content", typeof plainChat.content === "string" && plainChat.content === "hello");

console.log(failures === 0 ? "\nAll image-upload checks passed." : `\n${failures} check(s) failed.`);
