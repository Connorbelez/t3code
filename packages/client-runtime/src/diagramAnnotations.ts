import {
  ComposerContextId,
  DIAGRAM_ANNOTATIONS_MAX_PER_PAGE,
  DiagramAnnotationNumber,
  type DiagramAnnotation,
  DiagramAnnotations,
  DiagramOperationError,
  type CapturedDiagramAnnotationsRecord,
  type DiagramAnnotationsContextRecord,
  type DiagramPreparedAnnotations,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { sanitizeComposerContextLabel } from "@t3tools/shared/composerContextReferences";

/** One rendered capture, ready to become an attachment plus the image record `contextId` names. */
export interface DiagramAnnotationImageFile {
  readonly id: string;
  readonly contextId: ComposerContextId;
  readonly name: string;
  readonly mimeType: "image/png";
  readonly base64: string;
}

const sameAnnotations = Schema.toEquivalence(DiagramAnnotations);
const ATTACHMENT_NAME_MAX_CHARS = 255;

/**
 * Freezes a draft set for sending: the prepared snapshot's geometry, images and structure. The
 * capture must describe exactly these comments; anything else means the draft moved underneath
 * the preparation, so the send must not go out with mismatched numbers.
 *
 * Image names repeat `image_<id>` because the agent pairs an attachment's saved path with the
 * `ref` in the context through the file name alone.
 */
export function attachAnnotationCapture(
  record: DiagramAnnotationsContextRecord,
  prepared: DiagramPreparedAnnotations,
  mintId: () => string,
): {
  record: CapturedDiagramAnnotationsRecord;
  images: ReadonlyArray<DiagramAnnotationImageFile>;
} {
  const { capture } = prepared;
  if (
    capture.diagramId !== record.payload.diagramId ||
    capture.pageId !== record.payload.pageId ||
    !sameAnnotations(capture.annotations, record.payload.annotations)
  ) {
    throw new DiagramOperationError({ code: "stale", diagramId: record.payload.diagramId });
  }
  const rendered = capture.images.map(({ mimeType, base64, ...image }) => {
    const id = mintId();
    const contextId = ComposerContextId.make(`image_${id}`);
    const suffix = `-${image.role}-${contextId}.png`;
    const name = `${record.label.slice(0, ATTACHMENT_NAME_MAX_CHARS - suffix.length)}${suffix}`;
    return { image: { ...image, contextId }, file: { id, contextId, name, mimeType, base64 } };
  });
  return {
    record: {
      ...record,
      payload: {
        ...record.payload,
        capture: {
          revision: capture.revision,
          resolved: capture.resolved,
          images: rendered.map((entry) => entry.image),
          structure: prepared.structure,
        },
      },
    },
    images: rendered.map((entry) => entry.file),
  };
}

/** The authored comments without a frozen snapshot, for turning a sent set back into work. */
export function stripAnnotationCapture(
  record: DiagramAnnotationsContextRecord,
): DiagramAnnotationsContextRecord {
  const { capture: _capture, ...payload } = record.payload;
  return { ...record, payload };
}

export function copyDiagramAnnotation(annotation: DiagramAnnotation): DiagramAnnotation {
  const { target } = annotation;
  return {
    ...annotation,
    target:
      target.kind === "shapes"
        ? { kind: "shapes", shapeIds: [...target.shapeIds] }
        : { kind: "region", bounds: { ...target.bounds } },
  };
}

/** A deep copy without `capture`: what a draft holds, sharing nothing with its source. */
export function draftDiagramAnnotationsRecord(
  record: DiagramAnnotationsContextRecord,
): DiagramAnnotationsContextRecord {
  const draft = stripAnnotationCapture(record);
  return {
    ...draft,
    payload: {
      ...draft.payload,
      annotations: draft.payload.annotations.map(copyDiagramAnnotation),
    },
  };
}

const isAnnotationNumber = Schema.is(DiagramAnnotationNumber);
const isPageAnnotations = Schema.is(DiagramAnnotations);
const isSamePage = (
  left: DiagramAnnotationsContextRecord["payload"],
  right: DiagramAnnotationsContextRecord["payload"],
) =>
  left.environmentId === right.environmentId &&
  left.diagramId === right.diagramId &&
  left.pageId === right.pageId;

/** Merges imported draft comments by page, preserving identities and allocating unique message-wide numbers. */
export function mergeDiagramAnnotationDrafts(
  state: {
    readonly records: ReadonlyArray<DiagramAnnotationsContextRecord>;
    readonly nextNumber: number;
  },
  incoming: ReadonlyArray<DiagramAnnotationsContextRecord>,
): {
  state: { records: DiagramAnnotationsContextRecord[]; nextNumber: number };
  rewritten: ReadonlyMap<ComposerContextId, ComposerContextId>;
  dropped: number;
} {
  const present = new Set(
    state.records.flatMap((record) => record.payload.annotations.map(({ id }) => id)),
  );
  const pending = incoming
    .flatMap((record) =>
      draftDiagramAnnotationsRecord(record).payload.annotations.map((annotation) => ({
        record,
        annotation,
      })),
    )
    .sort((left, right) => left.annotation.number - right.annotation.number);
  let records = [...state.records];
  let nextNumber = state.nextNumber;
  let dropped = 0;
  for (const { record, annotation } of pending) {
    if (present.has(annotation.id)) continue;
    present.add(annotation.id);
    const number = Math.max(annotation.number, nextNumber);
    const index = records.findIndex((entry) => isSamePage(entry.payload, record.payload));
    const target = records[index];
    const annotations = [...(target?.payload.annotations ?? []), { ...annotation, number }];
    if (
      !isAnnotationNumber(number) ||
      annotations.length > DIAGRAM_ANNOTATIONS_MAX_PER_PAGE ||
      !isPageAnnotations(annotations)
    ) {
      dropped += 1;
      continue;
    }
    nextNumber = number + 1;
    const draft = stripAnnotationCapture(target ?? record);
    const updated = {
      ...draft,
      label: sanitizeComposerContextLabel(draft.label, "diagram-annotations"),
      payload: { ...draft.payload, annotations },
    };
    records = target
      ? records.map((entry, position) => (position === index ? updated : entry))
      : [...records, updated];
  }
  const rewritten = new Map<ComposerContextId, ComposerContextId>();
  for (const record of incoming) {
    const target = records.find((entry) => isSamePage(entry.payload, record.payload));
    if (target) rewritten.set(record.contextId, target.contextId);
  }
  return { state: { records, nextNumber }, rewritten, dropped };
}
