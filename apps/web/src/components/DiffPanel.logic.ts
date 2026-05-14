// FILE: DiffPanel.logic.ts
// Purpose: Resolve the thread context the diff panel should use across server-backed and local draft chats.
// Exports: resolveDiffPanelThread, resolveDiffSelectAllArmed
// Depends on: ChatView.logic draft-thread normalization.

import { DEFAULT_MODEL_BY_PROVIDER, type ModelSelection, type ThreadId } from "@t3tools/contracts";

import type { DraftThreadState } from "../composerDraftStore";
import type { Thread } from "../types";
import { buildLocalDraftThread } from "./ChatView.logic";

// Reuse the chat-view draft fallback so diff surfaces keep working before the first server turn exists.
export function resolveDiffPanelThread(input: {
  threadId: ThreadId | null | undefined;
  serverThread: Thread | undefined;
  draftThread: DraftThreadState | null | undefined;
  fallbackModelSelection: ModelSelection | null | undefined;
}): Thread | undefined {
  if (input.serverThread) {
    return input.serverThread;
  }
  if (!input.threadId || !input.draftThread) {
    return undefined;
  }

  return buildLocalDraftThread(
    input.threadId,
    input.draftThread,
    input.fallbackModelSelection ?? {
      provider: "codex",
      model: DEFAULT_MODEL_BY_PROVIDER.codex,
    },
    null,
  );
}

// Track whether the diff viewport is in a "select all then copy" gesture so the copy
// handler can substitute the full serialized diff instead of the few mounted rows the
// virtualizer left in the DOM. Pure so it can be unit tested without a real DOM.
//
// The diff surface renders into shadow DOM, so a native Cmd/Ctrl+A actually selects the
// surrounding light-DOM page and the resulting `copy` event never travels through the
// viewport element. We instead listen on `document`: the keydown still passes through the
// viewport (so we can tell the select-all happened there), and this state machine decides
// whether the very next copy should be hijacked.
export function resolveDiffSelectAllArmed(
  previous: boolean,
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">,
  isWithinDiffViewport: boolean,
): boolean {
  const key = event.key.toLowerCase();
  const hasShortcutModifier = event.metaKey || event.ctrlKey;

  // Cmd/Ctrl+A arms the gesture, but only when it happens inside the diff viewport.
  if (hasShortcutModifier && key === "a") {
    return isWithinDiffViewport;
  }
  // Cmd/Ctrl+C is the copy half of the gesture — preserve whatever state we were in.
  if (hasShortcutModifier && key === "c") {
    return previous;
  }
  // Bare modifier keydowns precede the real shortcut keys; never disarm on them.
  if (key === "meta" || key === "control" || key === "shift" || key === "alt") {
    return previous;
  }
  // Any other key starts a fresh selection intent, so drop back to native copy behavior.
  return false;
}
