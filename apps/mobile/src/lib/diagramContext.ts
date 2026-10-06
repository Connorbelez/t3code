import {
  type OrchestrationMessageContext,
  DiagramContextRecord,
  ComposerContextId,
  type ComposerContextRecord,
} from "@t3tools/contracts";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { appAtomRegistry } from "../state/atom-registry";
import { uuidv4 } from "./uuid";
import { estimateBase64ByteSize } from "./base64";
import type { DraftComposerAttachment } from "./composerImages";

export async function prepareMobileDiagramContext(input: {
  context?: OrchestrationMessageContext;
  attachments: ReadonlyArray<DraftComposerAttachment>;
}) {
  const diagrams = input.context?.records.filter(Schema.is(DiagramContextRecord)) ?? [];
  if (!diagrams.length) return input;
  const { diagramCommands: commands } = await import("../state/diagrams");
  const previousScreenshotIds = new Set(
    diagrams.flatMap((record) =>
      record.payload.screenshotContextId ? [record.payload.screenshotContextId] : [],
    ),
  );
  const previousAttachments = new Set(
    input.context?.records.flatMap((record) =>
      previousScreenshotIds.has(record.contextId) && "attachmentId" in record
        ? [record.attachmentId]
        : [],
    ) ?? [],
  );
  const attachments = input.attachments.filter(
    (attachment) => !previousAttachments.has(attachment.id),
  );
  const records: ComposerContextRecord[] =
    input.context?.records.filter(
      (record) => record.kind !== "diagram" && !previousScreenshotIds.has(record.contextId),
    ) ?? [];
  for (const record of diagrams) {
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
    const dataUrl = `data:${capture.mimeType};base64,${capture.base64}`;
    const name = `${record.label}-${contextId}.png`;
    const sizeBytes = estimateBase64ByteSize(capture.base64);
    attachments.push({
      type: "image",
      id,
      name,
      sizeBytes,
      mimeType: capture.mimeType,
      dataUrl,
      previewUri: dataUrl,
    });
    records.push({
      version: 1,
      kind: "image",
      contextId,
      label: name,
      attachmentId: id,
      name,
      sizeBytes,
      mimeType: capture.mimeType,
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
