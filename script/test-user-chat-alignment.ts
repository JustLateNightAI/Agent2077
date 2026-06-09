/**
 * User chat text alignment smoke test.
 *
 * The user bubble stays positioned on the right, but the text *inside* it must
 * read left-aligned (not right-aligned). So the user message paragraph carries
 * `text-left` (overriding any inherited right alignment from the bubble
 * container) across all chat surfaces (main chat, workspace, self-dev —
 * including the optimistic "pending" bubble), and must not carry `text-right`.
 *
 * These are static-source assertions (the components are React/JSX with no
 * headless render harness in this repo). They pin the alignment class to the
 * user paragraph so it cannot silently regress, while leaving assistant/tool
 * markdown untouched.
 *
 * Run with: npx tsx script/test-user-chat-alignment.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dirname, "..");
let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${label}${detail ? " — " + detail : ""}`);
  if (!ok) { failures++; process.exitCode = 1; }
}

const sharedBubble = readFileSync(join(root, "client/src/components/ChatMessageBubble.tsx"), "utf8");
const mainChat = readFileSync(join(root, "client/src/pages/chat.tsx"), "utf8");
const selfDev = readFileSync(join(root, "client/src/pages/self-dev.tsx"), "utf8");

// ── Shared component: both variants left-align the user paragraph ───────────
check(
  "shared compact user <p> is left-aligned",
  /<p className="whitespace-pre-wrap text-left">\{message\.content\}<\/p>/.test(sharedBubble),
);
check(
  "shared default user <p> is left-aligned",
  /<p className="text-sm text-foreground\/90 whitespace-pre-wrap text-left">\{message\.content\}<\/p>/.test(sharedBubble),
);
check(
  "shared component user <p> does not force text-right",
  !/text-right">\{message\.content\}<\/p>/.test(sharedBubble),
);

// Assistant content must NOT be force-aligned — markdown stays readable.
check(
  "shared component still renders assistant markdown via MarkdownMessage",
  sharedBubble.includes("<MarkdownMessage"),
);

// ── Main chat (chat.tsx): user paragraph left-aligned ───────────────────────
check(
  "main chat user <p> is left-aligned",
  /<p className="whitespace-pre-wrap text-left">\{message\.content\}<\/p>/.test(mainChat),
);
check(
  "main chat user <p> does not force text-right",
  !/text-right">\{message\.content\}<\/p>/.test(mainChat),
);
// Bubble stays positioned on the right (container right-aligns the inline bubble).
check(
  "main chat user bubble container keeps right positioning",
  /isUser \? "max-w-\[85%\] text-right"/.test(mainChat),
);
// Assistant branch keeps markdown-content (no forced alignment on assistant).
check(
  "main chat assistant still uses markdown-content wrapper",
  mainChat.includes('<div className="markdown-content">'),
);

// ── Self-dev optimistic pending bubble: left-aligned, right-positioned ──────
check(
  "self-dev pending user <p> is left-aligned",
  /<p className="text-sm text-foreground\/90 whitespace-pre-wrap text-left">\{pendingUserMessage\}<\/p>/.test(selfDev),
);
check(
  "self-dev pending user <p> does not force text-right",
  !/text-right">\{pendingUserMessage\}<\/p>/.test(selfDev),
);
check(
  "self-dev pending bubble stays positioned on the right",
  selfDev.includes('<div className="flex gap-2.5 justify-end">'),
);

if (failures === 0) {
  console.log("\nAll user-chat alignment checks passed.");
} else {
  console.log(`\n${failures} check(s) failed.`);
}
