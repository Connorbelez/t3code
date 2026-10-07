/**
 * The Canvas panel's selection actions, "Add selection to chat" and the comment actions, published
 * so the keybindings, command palette and panel toolbar reach the editor on screen. The panel's
 * editor registers itself and reports whether anything is selected and whether annotation mode is
 * on; the newest registration wins, as the panel remounts its editor.
 */
export type CanvasSelectionChatState = "unavailable" | "empty" | "selected";
/** "unavailable" when no editor is registered or it cannot save comments. */
export type CanvasAnnotationState = "unavailable" | "off" | "on";

type AnnotationActions = { annotate: () => void; toggle: () => void };
type Entry = {
  hasSelection: boolean;
  annotating: boolean;
  add: () => void;
  annotation: AnnotationActions | null;
};
let current: Entry | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

export function canvasSelectionChatState(): CanvasSelectionChatState {
  if (!current) return "unavailable";
  return current.hasSelection ? "selected" : "empty";
}

export function canvasAnnotationState(): CanvasAnnotationState {
  if (!current?.annotation) return "unavailable";
  return current.annotating ? "on" : "off";
}

/** Notifies on any change to either state. */
export function subscribeCanvasSelectionChat(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `annotation` is null when this editor cannot save comments. */
export function registerCanvasSelectionChat(
  add: () => void,
  annotation: AnnotationActions | null = null,
) {
  const entry: Entry = { hasSelection: false, annotating: false, add, annotation };
  current = entry;
  notify();
  return {
    setHasSelection: (hasSelection: boolean) => {
      if (entry.hasSelection === hasSelection) return;
      entry.hasSelection = hasSelection;
      if (current === entry) notify();
    },
    setAnnotating: (annotating: boolean) => {
      if (entry.annotating === annotating) return;
      entry.annotating = annotating;
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

/** Opens a new comment on the selection. False tells a key handler to leave the event alone. */
export function annotateCanvasSelection(): boolean {
  if (!current?.annotation || !current.hasSelection) return false;
  current.annotation.annotate();
  return true;
}

/** Turns annotation mode on or off. False when no editor on screen can save comments. */
export function toggleCanvasAnnotationMode(): boolean {
  if (!current?.annotation) return false;
  current.annotation.toggle();
  return true;
}
