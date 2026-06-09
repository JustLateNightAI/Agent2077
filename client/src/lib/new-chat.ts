// Shared "new chat" coordination between the sidebar's + button and the
// always-mounted ChatPage.
//
// The sidebar and ChatPage are sibling components; ChatPage owns all chat
// state (current conversation id, streamed content, steps, plan, etc.) and is
// never unmounted (App keeps it mounted so streaming survives tab switches).
//
// Navigating to "/" is how a new chat is normally started, but wouter does not
// re-render on a navigation to the route you are *already* on. So when no chat
// is selected (location is already "/", or an unmatched/invalid route that
// yields no conversation id), clicking + would be a no-op and the stale chat
// state would linger. The custom event below lets the sidebar tell ChatPage to
// reset unconditionally, independent of whether the route actually changed.

export const NEW_CHAT_EVENT = "agent2077:new-chat";

/**
 * Decide what the New Chat button should do given the current route.
 *
 * - `navigateHome`: whether to call navigate("/"). True only when we are not
 *   already on the chat root, so we avoid a redundant same-route navigation.
 * - `resetState`: always true — the chat state must be cleared every time,
 *   because the route may not change (already on "/") yet a stale conversation
 *   id / streamed draft can still be showing.
 */
export function planNewChat(location: string): {
  navigateHome: boolean;
  resetState: boolean;
} {
  const onChatRoot = location === "/" || location === "";
  return {
    navigateHome: !onChatRoot,
    resetState: true,
  };
}

/** Fire the reset signal that the always-mounted ChatPage listens for. */
export function emitNewChat(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NEW_CHAT_EVENT));
}
