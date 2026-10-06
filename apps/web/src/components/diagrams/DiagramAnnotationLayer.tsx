import {
  DIAGRAM_ANNOTATIONS_MAX_PER_PAGE,
  type DiagramAnnotation,
  type DiagramAnnotationId,
  type DiagramBounds,
  type DiagramId,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useEditor, useValue, type Editor } from "tldraw";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import type { DiagramAnnotationSaveResult } from "../../lib/diagramAnnotationDrafts";
import { ANNOTATE_TOOL_ID, annotationSession, type AnnotationSession } from "./annotateTool";
import type { DiagramAnnotationBinding } from "./diagramAnnotationBinding";
import { annotationTargetPageBounds } from "./diagramAnnotationHost";
import {
  annotationSetLabel,
  commentEditorPosition,
  layoutCommentBubbles,
  pageToViewportBounds,
} from "./diagramAnnotationOverlay";
import { ANNOTATION_BADGE_RADIUS, ANNOTATION_COLOR } from "./diagramAnnotationRender";

/** The diagram a panel editor shows and the message draft its comments are saved to. */
export type DiagramAnnotationScope = {
  readonly binding: DiagramAnnotationBinding;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly diagramId: DiagramId;
  readonly diagramName: string;
};
export const DiagramAnnotationScopeContext = createContext<DiagramAnnotationScope | null>(null);

const NO_ANNOTATIONS: readonly DiagramAnnotation[] = [];
/** The editor's footprint for keeping it on screen. It grows with its text up to the textarea's cap. */
const EDITOR_SIZE = { w: 288, h: 184 };
/** Pixels between a target and its outline, as in the sent image. */
const OUTLINE_OFFSET = 3;
const saveErrors: Record<Extract<DiagramAnnotationSaveResult, { ok: false }>["reason"], string> = {
  empty: "Write a comment before saving.",
  "too-large": "This comment is too long for this page. Shorten it, or target fewer shapes.",
  "too-many": `A page holds at most ${DIAGRAM_ANNOTATIONS_MAX_PER_PAGE} comments. Delete one to add another.`,
  "numbers-exhausted": "This message has used every comment number. Send it to start a new set.",
};

/** DOM focus and tldraw's focus state, which gates its Escape handling. */
function focusCanvas(editor: Editor) {
  editor.getContainer().focus();
  editor.focus();
}

function bubbleLabel(annotation: DiagramAnnotation, unavailable: boolean) {
  const text = annotation.comment.replace(/\s+/g, " ");
  const preview = text.length > 80 ? `${text.slice(0, 79)}…` : text;
  return unavailable
    ? `Comment ${annotation.number}, target unavailable: ${preview}`
    : `Comment ${annotation.number}: ${preview}`;
}

/**
 * Numbered bubbles for the current page's saved comments, the region being dragged, and the
 * inline comment editor. Mounted in front of panel editors only.
 */
export function DiagramAnnotationLayer() {
  const scope = useContext(DiagramAnnotationScopeContext);
  if (!scope?.binding.supported) return null;
  return <AnnotationLayer scope={scope} />;
}

function AnnotationLayer({ scope }: { scope: DiagramAnnotationScope }) {
  const editor = useEditor();
  const session = annotationSession(editor);
  const pageId = useValue("comment page", () => editor.getCurrentPageId(), [editor]);
  const annotations =
    scope.binding.records.find(
      (record) =>
        record.payload.environmentId === scope.environmentId &&
        record.payload.diagramId === scope.diagramId &&
        record.payload.pageId === pageId,
    )?.payload.annotations ?? NO_ANNOTATIONS;
  const edit = useValue("comment edit", () => session.edit.get(), [session]);
  const layout = useValue(
    "comment bubbles",
    () => {
      const placed: (DiagramAnnotation & { bounds: DiagramBounds })[] = [];
      const unavailable: DiagramAnnotation[] = [];
      for (const annotation of annotations) {
        const bounds = annotationTargetPageBounds(editor, pageId, annotation.target);
        if (bounds) placed.push({ ...annotation, bounds });
        else unavailable.push(annotation);
      }
      return { bubbles: layoutCommentBubbles(placed, editor.getCamera()), unavailable };
    },
    [annotations, editor, pageId],
  );
  const open = edit?.kind === "retargeting" ? null : edit;
  const saved =
    edit && edit.kind !== "new"
      ? annotations.find((annotation) => annotation.id === edit.id)
      : undefined;
  const openTarget =
    open?.kind === "new" ? open.target : (open?.retarget?.target ?? saved?.target ?? null);
  const anchor = useValue(
    "comment editor anchor",
    () => {
      if (!openTarget) return null;
      const bounds = annotationTargetPageBounds(editor, pageId, openTarget);
      return bounds ? pageToViewportBounds(bounds, editor.getCamera()) : null;
    },
    [editor, openTarget, pageId],
  );
  const screen = useValue(
    "comment viewport",
    () => {
      const { x, y, w, h } = editor.getViewportScreenBounds();
      return { x, y, w, h };
    },
    [editor],
  );
  const rootRef = useRef<HTMLDivElement>(null);
  /** Where focus goes once the edit that just ended has rendered away. */
  const focusAfterEdit = useRef<DiagramAnnotationId | "canvas" | null>(null);
  const editPage = useRef(pageId);

  // A comment belongs to the page it was written on, so switching pages drops an unsaved one.
  useEffect(() => {
    if (editPage.current === pageId) return;
    editPage.current = pageId;
    session.close();
  }, [pageId, session]);
  // The composer can delete a comment while its editor is open.
  useEffect(() => {
    if (edit && edit.kind !== "new" && !saved) session.close();
  }, [edit, saved, session]);
  useLayoutEffect(() => {
    const request = focusAfterEdit.current;
    if (request === null) return;
    if (request === "canvas") {
      focusAfterEdit.current = null;
      focusCanvas(editor);
      return;
    }
    // A new comment's bubble appears once the saved draft renders back here.
    const bubble = rootRef.current?.querySelector<HTMLElement>(`[data-annotation-id="${request}"]`);
    if (!bubble) return;
    focusAfterEdit.current = null;
    bubble.focus();
  });

  const toggleBubble = (id: DiagramAnnotationId) => {
    focusAfterEdit.current = null;
    if (open?.kind === "existing" && open.id === id) session.close();
    else session.open(id);
  };
  const save = (comment: string): string | null => {
    if (!open || !openTarget) return null;
    const result = scope.binding.save(
      {
        environmentId: scope.environmentId,
        projectId: scope.projectId,
        diagramId: scope.diagramId,
        pageId,
        label: annotationSetLabel(scope.diagramName, editor.getPages(), pageId),
      },
      open.kind === "existing"
        ? { id: open.id, comment, target: openTarget }
        : { comment, target: openTarget },
    );
    if (!result.ok) return saveErrors[result.reason];
    focusAfterEdit.current = result.annotation.id;
    session.close();
    return null;
  };
  const cancel = () => {
    focusAfterEdit.current = edit && edit.kind !== "new" ? edit.id : "canvas";
    session.close();
  };
  const remove = (id: DiagramAnnotationId) => {
    focusAfterEdit.current = "canvas";
    scope.binding.remove(id);
    session.close();
  };
  // Focus moves to the canvas, where Escape cancels the retarget.
  const retarget = (id: DiagramAnnotationId, comment: string) => {
    focusAfterEdit.current = "canvas";
    if (editor.getCurrentToolId() !== ANNOTATE_TOOL_ID) editor.setCurrentTool(ANNOTATE_TOOL_ID);
    session.retarget(id, comment);
  };
  const expandedId = open?.kind === "existing" ? open.id : null;
  const retargeting = edit?.kind === "retargeting" ? saved : undefined;
  const editorPosition = anchor
    ? commentEditorPosition(anchor, screen, EDITOR_SIZE)
    : { x: Math.max(8, (screen.w - EDITOR_SIZE.w) / 2), y: 56 };

  return (
    <div ref={rootRef} className="absolute inset-0">
      <CommentBrush editor={editor} session={session} />
      {open && anchor ? (
        <div
          aria-hidden
          className={
            openTarget?.kind === "region"
              ? "absolute top-0 left-0 border-2 border-dashed"
              : "absolute top-0 left-0 border-2"
          }
          style={{
            borderColor: ANNOTATION_COLOR,
            width: anchor.w + OUTLINE_OFFSET * 2,
            height: anchor.h + OUTLINE_OFFSET * 2,
            transform: `translate(${anchor.x - OUTLINE_OFFSET}px, ${anchor.y - OUTLINE_OFFSET}px)`,
          }}
        />
      ) : null}
      {layout.bubbles.map((bubble) => (
        <CommentBubble
          key={bubble.id}
          annotation={bubble}
          center={bubble.marker}
          expanded={expandedId === bubble.id}
          onSelect={() => toggleBubble(bubble.id)}
        />
      ))}
      {layout.unavailable.length > 0 || retargeting ? (
        <div className="pointer-events-auto absolute top-2 left-1/2 flex -translate-x-1/2 flex-col items-center gap-1">
          {retargeting ? (
            <div
              role="status"
              className="flex items-center gap-2 rounded-md border bg-popover py-1 pr-1 pl-2 text-xs text-popover-foreground shadow-sm"
            >
              Click a shape or drag an area for comment {retargeting.number}.
              <Button variant="ghost-muted" size="xs" onClick={cancel}>
                Cancel
              </Button>
            </div>
          ) : null}
          {layout.unavailable.length > 0 ? (
            <div className="flex items-center gap-1 rounded-md border bg-popover py-1 pr-1 pl-2 text-xs text-muted-foreground shadow-sm">
              Unavailable targets
              {layout.unavailable.map((annotation) => (
                <CommentBubble
                  key={annotation.id}
                  annotation={annotation}
                  center={null}
                  expanded={expandedId === annotation.id}
                  onSelect={() => toggleBubble(annotation.id)}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {open ? (
        <CommentEditor
          key={
            open.kind === "new"
              ? `new:${JSON.stringify(open.target)}`
              : `${open.id}:${JSON.stringify(open.retarget?.target ?? null)}`
          }
          label={saved ? `Comment ${saved.number}` : "New comment"}
          initialComment={
            open.kind === "existing" ? (open.retarget?.comment ?? saved?.comment ?? "") : ""
          }
          unavailable={open.kind === "existing" && anchor === null}
          position={{ x: screen.x + editorPosition.x, y: screen.y + editorPosition.y }}
          onSave={save}
          onCancel={cancel}
          {...(open.kind === "existing"
            ? {
                onDelete: () => remove(open.id),
                onRetarget: (comment: string) => retarget(open.id, comment),
              }
            : {})}
        />
      ) : null}
    </div>
  );
}

function CommentBrush({ editor, session }: { editor: Editor; session: AnnotationSession }) {
  const box = useValue(
    "comment brush",
    () => {
      const brush = session.brush.get();
      return brush ? pageToViewportBounds(brush, editor.getCamera()) : null;
    },
    [editor, session],
  );
  if (!box) return null;
  return (
    <div
      aria-hidden
      className="absolute top-0 left-0 border-2 border-dashed"
      style={{
        borderColor: ANNOTATION_COLOR,
        width: box.w,
        height: box.h,
        transform: `translate(${box.x}px, ${box.y}px)`,
      }}
    />
  );
}

/** Reads like the numbered badge drawn into the sent image. `center` is null in the unavailable list. */
function CommentBubble(props: {
  annotation: DiagramAnnotation;
  center: { x: number; y: number } | null;
  expanded: boolean;
  onSelect: () => void;
}) {
  const { annotation, center } = props;
  return (
    <button
      type="button"
      data-annotation-id={annotation.id}
      aria-label={bubbleLabel(annotation, center === null)}
      aria-expanded={props.expanded}
      className={
        center
          ? "pointer-events-auto absolute top-0 left-0 flex size-6 items-center justify-center rounded-full border-2 border-white font-bold text-white shadow-sm ring-foreground ring-offset-1 ring-offset-background focus-visible:ring-2 aria-expanded:ring-2"
          : "flex size-6 items-center justify-center rounded-full border-2 border-dashed bg-popover font-bold ring-foreground ring-offset-1 ring-offset-background focus-visible:ring-2 aria-expanded:ring-2"
      }
      style={
        center
          ? {
              backgroundColor: ANNOTATION_COLOR,
              transform: `translate(${center.x - ANNOTATION_BADGE_RADIUS}px, ${center.y - ANNOTATION_BADGE_RADIUS}px)`,
            }
          : { borderColor: ANNOTATION_COLOR, color: ANNOTATION_COLOR }
      }
      onClick={props.onSelect}
    >
      <span className={annotation.number > 99 ? "text-3xs" : "text-xs"}>{annotation.number}</span>
    </button>
  );
}

function CommentEditor(props: {
  label: string;
  initialComment: string;
  /** The saved target is gone, so the editor sits under the unavailable list instead. */
  unavailable: boolean;
  /** In the window. */
  position: { x: number; y: number };
  /** The error message to show, or null once saved. */
  onSave: (comment: string) => string | null;
  onCancel: () => void;
  onDelete?: () => void;
  onRetarget?: (comment: string) => void;
}) {
  const [comment, setComment] = useState(props.initialComment);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const errorId = useId();
  // After the frame that opened it, so a closing menu or palette cannot take focus back.
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const save = () => setError(props.onSave(comment));
  const { onDelete, onRetarget } = props;

  // Outside the tldraw container: its key handlers would treat Escape as a canvas cancel, and its
  // style reset turns off text selection and focus outlines for everything inside it.
  return createPortal(
    <div
      role="dialog"
      aria-label={props.label}
      className="fixed top-0 left-0 z-50 w-72 rounded-lg border bg-popover p-2 text-popover-foreground shadow-lg"
      style={{ transform: `translate(${props.position.x}px, ${props.position.y}px)` }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        props.onCancel();
      }}
    >
      <p className="mb-1.5 text-xs font-medium">{props.label}</p>
      {props.unavailable ? (
        <p className="mb-1.5 text-xs text-muted-foreground">
          Its target was deleted or moved to another page. Retarget or delete it.
        </p>
      ) : null}
      <Textarea
        ref={textareaRef}
        size="sm"
        value={comment}
        placeholder="Describe the change you want"
        aria-label={props.label}
        aria-invalid={error !== null}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => {
          setComment(event.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          save();
        }}
      />
      {error ? (
        <p id={errorId} role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <p className="mt-1 text-3xs text-muted-foreground">Enter saves · Shift+Enter adds a line</p>
      <div className="mt-1.5 flex items-center justify-between gap-1">
        <div className="flex items-center gap-1">
          {onDelete ? (
            <Button variant="ghost-destructive" size="xs" onClick={onDelete}>
              Delete
            </Button>
          ) : null}
          {onRetarget ? (
            <Button variant="ghost-muted" size="xs" onClick={() => onRetarget(comment)}>
              Retarget
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost-muted" size="xs" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button size="xs" onClick={save}>
            Save
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
