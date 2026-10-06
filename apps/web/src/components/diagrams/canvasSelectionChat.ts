/**
 * The Canvas panel's "Add selection to chat" action, published so the keybinding and command
 * palette reach the editor on screen. The panel's editor registers itself and reports whether
 * anything is selected; the newest registration wins, as the panel remounts its editor.
 */
export type CanvasSelectionChatState = "unavailable" | "empty" | "selected";

type Entry = { hasSelection: boolean; add: () => void };
let current: Entry | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

export function canvasSelectionChatState(): CanvasSelectionChatState {
  if (!current) return "unavailable";
  return current.hasSelection ? "selected" : "empty";
}

export function subscribeCanvasSelectionChat(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function registerCanvasSelectionChat(add: () => void) {
  const entry: Entry = { hasSelection: false, add };
  current = entry;
  notify();
  return {
    setHasSelection: (hasSelection: boolean) => {
      if (entry.hasSelection === hasSelection) return;
      entry.hasSelection = hasSelection;
      if (current === entry) notify();
    },
    unregister: () => {
      if (current !== entry) return;
      current = null;
      notify();
    },
  };
}

/** Adds the selection when there is one. False tells a key handler to leave the event alone. */
export function addCanvasSelectionToChat(): boolean {
  if (!current?.hasSelection) return false;
  current.add();
  return true;
}
