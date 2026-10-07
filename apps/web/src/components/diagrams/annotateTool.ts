import type {
  DiagramAnnotationId,
  DiagramAnnotationTarget,
  DiagramBounds,
} from "@t3tools/contracts";
import { Box, StateNode, atom, type Editor, type TLPointerEventInfo, type VecLike } from "tldraw";

export const ANNOTATE_TOOL_ID = "t3-annotate";
/** A drag narrower or shorter than this on screen is a slip, not a region. */
const MIN_REGION_SCREEN_SIDE = 4;

/** What the inline comment editor is open on. */
export type AnnotationEdit =
  | { readonly kind: "new"; readonly target: DiagramAnnotationTarget }
  /**
   * A saved comment. After a retarget, `retarget` holds the unsaved new target and the text the
   * editor held when the user chose Retarget.
   */
  | {
      readonly kind: "existing";
      readonly id: DiagramAnnotationId;
      readonly retarget?: { readonly target: DiagramAnnotationTarget; readonly comment: string };
    }
  /** A saved comment waiting for the click or drag that picks its new target. */
  | { readonly kind: "retargeting"; readonly id: DiagramAnnotationId; readonly comment: string };

/**
 * One panel editor's commenting state, read by the comment overlay. It lives outside the tldraw
 * store, so commenting never touches the document, the selection or the undo history.
 */
export class AnnotationSession {
  /** The region being dragged, in page space. */
  readonly brush = atom<DiagramBounds | null>("t3 annotation brush", null);
  readonly edit = atom<AnnotationEdit | null>("t3 annotation edit", null);

  /** A gesture or "Annotate selection" chose `target`: for the comment being retargeted, or a new one. */
  pick(target: DiagramAnnotationTarget) {
    const edit = this.edit.get();
    this.edit.set(
      edit?.kind === "retargeting"
        ? { kind: "existing", id: edit.id, retarget: { target, comment: edit.comment } }
        : { kind: "new", target },
    );
  }

  open(id: DiagramAnnotationId) {
    this.edit.set({ kind: "existing", id });
  }

  retarget(id: DiagramAnnotationId, comment: string) {
    this.edit.set({ kind: "retargeting", id, comment });
  }

  close() {
    this.edit.set(null);
  }
}

const sessions = new WeakMap<Editor, AnnotationSession>();
export function annotationSession(editor: Editor): AnnotationSession {
  let session = sessions.get(editor);
  if (!session) {
    session = new AnnotationSession();
    sessions.set(editor, session);
  }
  return session;
}

/**
 * The target for a click on `shapeId`. A click on one shape of a multi-selection comments on the
 * whole selection.
 */
export function clickTarget(
  shapeId: string,
  selectedIds: readonly string[],
): DiagramAnnotationTarget {
  return {
    kind: "shapes",
    shapeIds: selectedIds.includes(shapeId) ? [...selectedIds] : [shapeId],
  };
}

/** The page region a drag from `origin` to `current` covers, or null when it is too small on screen. */
export function dragTarget(
  origin: VecLike,
  current: VecLike,
  zoom: number,
): DiagramAnnotationTarget | null {
  const bounds = Box.FromPoints([origin, current]).toJson();
  if (bounds.w * zoom < MIN_REGION_SCREEN_SIDE || bounds.h * zoom < MIN_REGION_SCREEN_SIDE)
    return null;
  return { kind: "region", bounds };
}

/** Opens a new comment on the selected shapes in annotation mode. False when nothing is selected. */
export function annotateSelection(editor: Editor): boolean {
  const shapeIds = editor.getSelectedShapeIds();
  if (shapeIds.length === 0) return false;
  if (editor.getCurrentToolId() !== ANNOTATE_TOOL_ID) editor.setCurrentTool(ANNOTATE_TOOL_ID);
  annotationSession(editor).pick({ kind: "shapes", shapeIds: [...shapeIds] });
  return true;
}

export function toggleAnnotationMode(editor: Editor) {
  editor.setCurrentTool(
    editor.getCurrentToolId() === ANNOTATE_TOOL_ID ? "select" : ANNOTATE_TOOL_ID,
  );
}

/**
 * Annotation mode. A click picks the outermost shape under the pointer and a drag picks a page
 * region; either opens the comment editor through the session. It reads the selection but never
 * changes it or any record.
 */
export class AnnotateTool extends StateNode {
  static override id = ANNOTATE_TOOL_ID;
  static override initial = "idle";
  static override isLockable = false;
  static override children = () => [AnnotateIdle, AnnotatePointing, AnnotateBrushing];

  override onEnter() {
    this.editor.setCursor({ type: "cross", rotation: 0 });
  }

  /** Leaving the mode drops an unsaved comment; saved ones stay in the draft. */
  override onExit() {
    const session = annotationSession(this.editor);
    session.brush.set(null);
    session.close();
  }
}

class AnnotateIdle extends StateNode {
  static override id = "idle";

  override onPointerDown(info: TLPointerEventInfo) {
    if (info.button !== 0) return;
    const session = annotationSession(this.editor);
    // Clicking away from an open editor drops its unsaved text; a retarget waits for this gesture.
    if (session.edit.get()?.kind !== "retargeting") session.close();
    this.parent.transition("pointing");
  }

  override onCancel() {
    const session = annotationSession(this.editor);
    if (session.edit.get()) session.close();
    else this.editor.setCurrentTool("select");
  }
}

class AnnotatePointing extends StateNode {
  static override id = "pointing";

  override onPointerMove() {
    if (this.editor.inputs.getIsDragging()) this.parent.transition("brushing");
  }

  override onPointerUp() {
    const { editor } = this;
    this.parent.transition("idle");
    const hit = editor.getShapeAtPoint(editor.inputs.getCurrentPagePoint(), {
      hitInside: true,
      hitLabels: true,
      hitLocked: true,
      margin: editor.getHitTestMargin(),
    });
    if (!hit) return;
    annotationSession(editor).pick(
      clickTarget(editor.getOutermostSelectableShape(hit).id, editor.getSelectedShapeIds()),
    );
  }

  override onCancel() {
    this.parent.transition("idle");
  }

  override onComplete() {
    this.parent.transition("idle");
  }

  override onInterrupt() {
    this.parent.transition("idle");
  }
}

class AnnotateBrushing extends StateNode {
  static override id = "brushing";

  override onEnter() {
    this.update();
  }

  override onExit() {
    annotationSession(this.editor).brush.set(null);
  }

  override onPointerMove() {
    this.update();
  }

  override onPointerUp() {
    const { inputs } = this.editor;
    const target = dragTarget(
      inputs.getOriginPagePoint(),
      inputs.getCurrentPagePoint(),
      this.editor.getZoomLevel(),
    );
    this.parent.transition("idle");
    if (target) annotationSession(this.editor).pick(target);
  }

  override onCancel() {
    this.parent.transition("idle");
  }

  override onComplete() {
    this.parent.transition("idle");
  }

  override onInterrupt() {
    this.parent.transition("idle");
  }

  private update() {
    const { inputs } = this.editor;
    annotationSession(this.editor).brush.set(
      Box.FromPoints([inputs.getOriginPagePoint(), inputs.getCurrentPagePoint()]).toJson(),
    );
  }
}
