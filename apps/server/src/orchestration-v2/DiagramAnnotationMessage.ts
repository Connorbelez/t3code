import {
  isKnownComposerContextRecord,
  type ChatAttachment,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";

/** A sent comment set must resolve its frozen image references to this message's attachments. */
export function diagramAnnotationMessageError(
  context: OrchestrationMessageContext | undefined,
  attachments: ReadonlyArray<ChatAttachment>,
): string | null {
  const records = context?.records ?? [];
  const byContextId = new Map(records.map((record) => [record.contextId, record]));
  const images = new Set(
    attachments.filter((attachment) => attachment.type === "image").map((image) => image.id),
  );
  for (const record of records) {
    if (!isKnownComposerContextRecord(record) || record.kind !== "diagram-annotations") continue;
    const { capture } = record.payload;
    if (!capture) {
      return "Capture Canvas comments before sending. Update T3 Code on this client and try again.";
    }
    for (const image of capture.images) {
      const bound = byContextId.get(image.contextId);
      if (
        !bound ||
        !isKnownComposerContextRecord(bound) ||
        bound.kind !== "image" ||
        !images.has(bound.attachmentId)
      ) {
        return "Canvas comments are missing their numbered images. Capture the comments again before sending.";
      }
    }
  }
  return null;
}
