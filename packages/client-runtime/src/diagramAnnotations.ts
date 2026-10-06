import {
  ComposerContextId,
  DiagramAnnotations,
  DiagramOperationError,
  type CapturedDiagramAnnotationsRecord,
  type DiagramAnnotationsContextRecord,
  type DiagramPreparedAnnotations,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

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
