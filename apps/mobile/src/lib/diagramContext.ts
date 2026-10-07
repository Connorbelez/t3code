import {
  type OrchestrationMessageContext,
  ComposerContextId,
  type ComposerContextRecord,
  type DiagramAnnotationsContextRecord,
  type DiagramContextRecord,
  isKnownComposerContextRecord,
} from "@t3tools/contracts";
import { attachAnnotationCapture } from "@t3tools/client-runtime/diagram-annotations";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { composerContextImageDependencies } from "@t3tools/shared/composerContextReferences";
import { appAtomRegistry } from "../state/atom-registry";
import { uuidv4 } from "./uuid";
import { estimateBase64ByteSize } from "./base64";
import type { DraftComposerAttachment } from "./composerImages";

const CANVAS_COMMENTS_UNSUPPORTED_MESSAGE =
  "Update T3 Code on this environment to send Canvas comments.";

type PreparedDiagramRecord = DiagramContextRecord | DiagramAnnotationsContextRecord;

function isPreparedDiagramRecord(record: ComposerContextRecord): record is PreparedDiagramRecord {
  return (
    isKnownComposerContextRecord(record) &&
    (record.kind === "diagram" || record.kind === "diagram-annotations")
  );
}

/**
 * Captures every diagram reference at the revision being sent. Images from an earlier attempt
 * are replaced, so a retried or restored message never sends a stale snapshot. Canvas comments
 * have no image-less fallback: without their numbered images the send fails instead.
 */
export async function prepareMobileDiagramContext(input: {
  context?: OrchestrationMessageContext;
  attachments: ReadonlyArray<DraftComposerAttachment>;
}) {
  const prepares = input.context?.records.filter(isPreparedDiagramRecord) ?? [];
  if (!prepares.length) return input;
  const [{ diagramCommands: commands }, { serverEnvironment }] = await Promise.all([
    import("../state/diagrams"),
    import("../state/server"),
  ]);
  for (const record of prepares) {
    if (record.kind !== "diagram-annotations") continue;
    const config = appAtomRegistry.get(
      serverEnvironment.configValueAtom(record.payload.environmentId),
    );
    if (config?.environment.capabilities.diagrams?.annotations !== true) {
      throw new Error(CANVAS_COMMENTS_UNSUPPORTED_MESSAGE);
    }
  }
  const previousImageIds = new Set(prepares.flatMap(composerContextImageDependencies));
  const previousAttachments = new Set(
    input.context?.records.flatMap((record) =>
      previousImageIds.has(record.contextId) && "attachmentId" in record
        ? [record.attachmentId]
        : [],
    ) ?? [],
  );
  const attachments = input.attachments.filter(
    (attachment) => !previousAttachments.has(attachment.id),
  );
  const records: ComposerContextRecord[] =
    input.context?.records.filter(
      (record) => !isPreparedDiagramRecord(record) && !previousImageIds.has(record.contextId),
    ) ?? [];
  const pushImage = (image: {
    id: string;
    contextId: ComposerContextId;
    name: string;
    mimeType: string;
    base64: string;
  }) => {
    const dataUrl = `data:${image.mimeType};base64,${image.base64}`;
    const sizeBytes = estimateBase64ByteSize(image.base64);
    attachments.push({
      type: "image",
      id: image.id,
      name: image.name,
      sizeBytes,
      mimeType: image.mimeType,
      dataUrl,
      previewUri: dataUrl,
    });
    records.push({
      version: 1,
      kind: "image",
      contextId: image.contextId,
      label: image.name,
      attachmentId: image.id,
      name: image.name,
      sizeBytes,
      mimeType: image.mimeType,
    });
  };
  for (const record of prepares) {
    if (record.kind === "diagram-annotations") {
      const { environmentId, projectId, diagramId, pageId, annotations } = record.payload;
      const result = await runAtomCommand(
        appAtomRegistry,
        commands.prepareAnnotations,
        { environmentId, input: { projectId, diagramId, pageId, annotations } },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const captured = attachAnnotationCapture(record, result.value, uuidv4);
      captured.images.forEach(pushImage);
      records.push(captured.record);
      continue;
    }
    const { environmentId, projectId, diagramId, scope } = record.payload;
    const result = await runAtomCommand(
      appAtomRegistry,
      commands.prepare,
      { environmentId, input: { projectId, diagramId, scope, allowImageUnavailable: true } },
      { reportFailure: false },
    );
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    const prepared = result.value;
    const {
      screenshotContextId: _oldScreenshot,
      imageUnavailableReason: _oldReason,
      ...payload
    } = record.payload;
    if (prepared.image.status === "unavailable") {
      records.push({
        ...record,
        payload: {
          ...payload,
          revision: prepared.diagram.revision,
          structure: prepared.structure,
          imageStatus: "unavailable",
          imageUnavailableReason: prepared.image.reason,
        },
      });
      continue;
    }
    const capture = prepared.image.capture;
    const id = uuidv4();
    const contextId = ComposerContextId.make(`image_${id}`);
    pushImage({
      id,
      contextId,
      name: `${record.label}-${contextId}.png`,
      mimeType: capture.mimeType,
      base64: capture.base64,
    });
    records.push({
      ...record,
      payload: {
        ...payload,
        revision: capture.revision,
        structure: prepared.structure,
        imageStatus: "current",
        screenshotContextId: contextId,
      },
    });
  }
  return { context: { version: 1 as const, records }, attachments };
}
