import { randomUUID } from "~/lib/utils";
import { ComposerContextId, WS_METHODS, type DiagramContextRecord } from "@t3tools/contracts";
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
