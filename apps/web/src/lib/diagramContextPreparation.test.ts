import {
  DiagramAnnotationsContextRecord,
  DiagramPreparedAnnotations,
  EnvironmentId,
  OrchestrationMessageContext,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ runAtomCommand: vi.fn(), randomUUID: vi.fn() }));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: () => Symbol("rpc"),
  runAtomCommand: mocks.runAtomCommand,
  squashAtomCommandFailure: (result: { readonly error: unknown }) => result.error,
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("./utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils")>()),
  randomUUID: mocks.randomUUID,
}));

import { useComposerDraftStore } from "../composerDraftStore";
import { buildMessageContext } from "./composerContextRecords";
import { prepareDiagramAnnotations } from "./diagramContextPreparation";

const diagramId = "0b6d3f4e-1a2b-4c3d-8e9f-0123456789ab";
const box = { x: 100, y: 80, w: 200, h: 120 };
const corner = { x: 400, y: -40, w: 120, h: 80 };
const annotations = [
  {
    id: "a1",
    number: 1,
    comment: "Make this box blue",
    target: { kind: "shapes", shapeIds: ["shape:box"] },
  },
  { id: "a3", number: 3, comment: "Room for a legend", target: { kind: "region", bounds: corner } },
];
const draftInput = {
  version: 1,
  contextId: "diagram-annotations_main",
  kind: "diagram-annotations",
  label: "Architecture",
  payload: {
    environmentId: "env-1",
    projectId: "project-1",
    diagramId,
    pageId: "page:main",
    annotations,
  },
};
const decodeMessageContext = Schema.decodeUnknownSync(OrchestrationMessageContext);
const draft = Schema.decodeUnknownSync(DiagramAnnotationsContextRecord)(draftInput);
const structure = {
  revision: 7,
  pages: [{ id: "page:main", name: "Main", shapeCount: 1 }],
  compositions: [],
  shapes: [],
  bindings: [],
  totalShapes: 1,
  truncated: false,
};
const resolved = [
  { id: "a1", bounds: box, marker: { x: 100, y: 80 } },
  { id: "a3", bounds: corner, marker: { x: 400, y: -40 } },
];
const overview = {
  role: "overview",
  annotationIds: ["a1", "a3"],
  bounds: { x: 52, y: -88, w: 516, h: 336 },
  width: 516,
  height: 336,
};
const detail = {
  role: "detail",
  annotationIds: ["a3"],
  bounds: { x: 352, y: -88, w: 216, h: 176 },
  width: 432,
  height: 352,
};
const prepared = Schema.decodeUnknownSync(DiagramPreparedAnnotations)({
  diagram: {
    id: diagramId,
    projectId: "project-1",
    name: "Architecture",
    revision: 7,
    archivedAt: null,
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
  },
  structure,
  capture: {
    diagramId,
    revision: 7,
    pageId: "page:main",
    annotations,
    resolved,
    images: [
      // "overview" and "detail" in base64: 8 and 6 bytes.
      { ...overview, mimeType: "image/png", base64: "b3ZlcnZpZXc=" },
      { ...detail, mimeType: "image/png", base64: "ZGV0YWls" },
    ],
  },
});

afterEach(() => {
  mocks.runAtomCommand.mockReset();
  mocks.randomUUID.mockReset();
});

describe("prepareDiagramAnnotations", () => {
  it("pairs each numbered image with the captured set through the message context", async () => {
    mocks.runAtomCommand.mockResolvedValue({ _tag: "Success", value: prepared });
    mocks.randomUUID.mockReturnValueOnce("uuid-1").mockReturnValueOnce("uuid-2");

    const result = await prepareDiagramAnnotations([draft], { annotationsSupported: true });

    expect(mocks.runAtomCommand.mock.calls[0]?.[2]).toEqual({
      environmentId: "env-1",
      input: { projectId: "project-1", diagramId, pageId: "page:main", annotations },
    });
    expect(
      result.images.map(({ id, name, mimeType, sizeBytes }) => ({ id, name, mimeType, sizeBytes })),
    ).toEqual([
      {
        id: "uuid-1",
        name: "Architecture-overview-image_uuid-1.png",
        mimeType: "image/png",
        sizeBytes: 8,
      },
      {
        id: "uuid-2",
        name: "Architecture-detail-image_uuid-2.png",
        mimeType: "image/png",
        sizeBytes: 6,
      },
    ]);

    const context = buildMessageContext({
      terminalContexts: [],
      reviewComments: [],
      previewAnnotations: [],
      diagramAnnotations: result.records,
      attachments: result.images.map((attachment) => ({
        attachment,
        attachmentId: `upload-${attachment.id}`,
      })),
    });
    expect(context).toEqual({
      version: 1,
      records: [
        {
          ...draftInput,
          payload: {
            ...draftInput.payload,
            capture: {
              revision: 7,
              resolved,
              images: [
                { ...overview, contextId: "image_uuid-1" },
                { ...detail, contextId: "image_uuid-2" },
              ],
              structure,
            },
          },
        },
        {
          version: 1,
          kind: "image",
          contextId: "image_uuid-1",
          label: "Architecture-overview-image_uuid-1.png",
          attachmentId: "upload-uuid-1",
          name: "Architecture-overview-image_uuid-1.png",
          mimeType: "image/png",
          sizeBytes: 8,
        },
        {
          version: 1,
          kind: "image",
          contextId: "image_uuid-2",
          label: "Architecture-detail-image_uuid-2.png",
          attachmentId: "upload-uuid-2",
          name: "Architecture-detail-image_uuid-2.png",
          mimeType: "image/png",
          sizeBytes: 6,
        },
      ],
    });
    expect(decodeMessageContext(context)).toEqual(context);
  });

  it("refuses to send comments to a server that cannot capture them, leaving the draft", async () => {
    const ref = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("unsupported-comments"));
    const store = useComposerDraftStore.getState();
    store.setDiagramAnnotations(ref, [draft]);
    const before = store.getComposerDraft(ref);

    await expect(
      prepareDiagramAnnotations(before?.diagramAnnotations ?? [], { annotationsSupported: false }),
    ).rejects.toThrow("Update T3 Code on this environment to send Canvas comments.");

    expect(useComposerDraftStore.getState().getComposerDraft(ref)).toBe(before);
    expect(before?.diagramAnnotations).toEqual([draftInput]);
    expect(mocks.runAtomCommand.mock.calls).toEqual([]);
    store.clearComposerContent(ref);
  });
});
