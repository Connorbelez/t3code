import { randomUUID } from "~/lib/utils";
import {
  ComposerContextId,
  WS_METHODS,
  type CapturedDiagramAnnotationsRecord,
  type DiagramAnnotationsContextRecord,
  type DiagramContextRecord,
} from "@t3tools/contracts";
import { attachAnnotationCapture } from "@t3tools/client-runtime/diagram-annotations";
import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import type { ComposerImageAttachment } from "~/composerDraftStore";
import { flushMountedDiagram } from "~/components/diagrams/diagramHosts";
import { toKindScopedComposerContextId } from "./composerContextReferences";

const prepareDiagram = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "Prepare diagram context",
  tag: WS_METHODS.diagramsPrepareContext,
});
const prepareAnnotations = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "Prepare Canvas comments",
  tag: WS_METHODS.diagramsPrepareAnnotations,
});

export async function prepareDiagramContexts(records: ReadonlyArray<DiagramContextRecord>) {
  const contexts: DiagramContextRecord[] = [];
  const images: ComposerImageAttachment[] = [];
  try {
    for (const record of records) {
      const { environmentId, projectId, diagramId, scope } = record.payload;
      await flushMountedDiagram(environmentId, diagramId);
      const result = await runAtomCommand(
        appAtomRegistry,
        prepareDiagram,
        {
          environmentId,
          input: { projectId, diagramId, scope, format: "png" },
        },
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
        contexts.push({
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
      const id = randomUUID();
      const bytes = Uint8Array.from(atob(capture.base64), (char) => char.charCodeAt(0));
      const imageContextId = toKindScopedComposerContextId("image", id);
      const file = new File([bytes], `${record.label}-${imageContextId}.png`, {
        type: capture.mimeType,
      });
      images.push({
        type: "image",
        id,
        file,
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl: URL.createObjectURL(file),
      });
      contexts.push({
        ...record,
        payload: {
          ...payload,
          revision: capture.revision,
          structure: prepared.structure,
          imageStatus: "current",
          screenshotContextId: ComposerContextId.make(imageContextId),
        },
      });
    }
    return { contexts, images };
  } catch (error) {
    for (const image of images) URL.revokeObjectURL(image.previewUrl);
    throw error;
  }
}

/**
 * Captures each comment set, one page at a time, against the diagram's current revision. The
 * draft records are never touched: a failure leaves them as they were for a retry, and success
 * returns new captured records with the numbered images they name by context id.
 */
export async function prepareDiagramAnnotations(
  records: ReadonlyArray<DiagramAnnotationsContextRecord>,
  options: { readonly annotationsSupported: boolean },
): Promise<{ records: CapturedDiagramAnnotationsRecord[]; images: ComposerImageAttachment[] }> {
  if (records.length > 0 && !options.annotationsSupported) {
    // Older servers cannot draw the numbers, and sending the comments without them is never valid.
    throw new Error("Update T3 Code on this environment to send Canvas comments.");
  }
  const captured: CapturedDiagramAnnotationsRecord[] = [];
  const images: ComposerImageAttachment[] = [];
  try {
    for (const record of records) {
      const { environmentId, projectId, diagramId, pageId, annotations } = record.payload;
      await flushMountedDiagram(environmentId, diagramId);
      const result = await runAtomCommand(
        appAtomRegistry,
        prepareAnnotations,
        { environmentId, input: { projectId, diagramId, pageId, annotations } },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const attached = attachAnnotationCapture(record, result.value, randomUUID);
      captured.push(attached.record);
      for (const image of attached.images) {
        const bytes = Uint8Array.from(atob(image.base64), (char) => char.charCodeAt(0));
        const file = new File([bytes], image.name, { type: image.mimeType });
        images.push({
          type: "image",
          // `image_<id>` is the context id the captured record names this image by.
          id: image.id,
          file,
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          previewUrl: URL.createObjectURL(file),
        });
      }
    }
    return { records: captured, images };
  } catch (error) {
    for (const image of images) URL.revokeObjectURL(image.previewUrl);
    throw error;
  }
}
