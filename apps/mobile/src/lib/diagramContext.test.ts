import {
  ComposerContextId,
  DiagramAnnotationsContextRecord,
  DiagramContextRecord,
  DiagramPreparedAnnotations,
  DiagramPreparedContext,
  OrchestrationMessageContext,
  type ComposerContextRecord,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  nextId: 0,
  annotationsCapability: true as boolean | undefined,
  calls: [] as unknown[],
  responses: {} as Record<string, unknown>,
}));

vi.mock("./uuid", () => ({ uuidv4: () => `uuid-${++harness.nextId}` }));

vi.mock("../state/diagrams", async () => {
  const { AsyncResult } = await import("effect/reactivity");
  const command = (tag: string) => ({
    label: tag,
    run: async (_registry: unknown, target: object) => {
      harness.calls.push({ tag, ...target });
      return AsyncResult.success(harness.responses[tag]);
    },
  });
  return {
    diagramCommands: {
      prepare: command("prepare"),
      prepareAnnotations: command("prepareAnnotations"),
    },
  };
});

vi.mock("../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    serverEnvironment: {
      configValueAtom: () =>
        Atom.make(() => ({
          environment: {
            capabilities: {
              diagrams: {
                protocolVersion: 1,
                ...(harness.annotationsCapability === undefined
                  ? {}
                  : { annotations: harness.annotationsCapability }),
              },
            },
          },
        })),
    },
  };
});

import { prepareMobileDiagramContext } from "./diagramContext";

const decodeAnnotationSet = Schema.decodeUnknownSync(DiagramAnnotationsContextRecord);
const decodeDiagram = Schema.decodeUnknownSync(DiagramContextRecord);
const decodePreparedContext = Schema.decodeUnknownSync(DiagramPreparedContext);
const isMessageContext = Schema.is(OrchestrationMessageContext);

const diagramId = "0b6d3f4e-1a2b-4c3d-8e9f-0123456789ab";
const box = { x: 100, y: 80, w: 200, h: 120 };
const corner = { x: 400, y: -40, w: 120, h: 80 };
const overviewBounds = { x: 52, y: -88, w: 516, h: 336 };
const detailBounds = { x: 352, y: -88, w: 216, h: 176 };
const annotations = [
  {
    id: "a1",
    number: 1,
    comment: "Make this box blue",
    target: { kind: "shapes", shapeIds: ["shape:box"] },
  },
  { id: "a3", number: 3, comment: "Room for a legend", target: { kind: "region", bounds: corner } },
];
const resolved = [
  { id: "a1", bounds: box, marker: { x: 100, y: 80 } },
  { id: "a3", bounds: corner, marker: { x: 400, y: -40 } },
];
const structure = {
  revision: 7,
  pages: [{ id: "page:main", name: "Main", shapeCount: 1 }],
  compositions: [],
  shapes: [],
  bindings: [],
  totalShapes: 1,
  truncated: false,
};
const metadata = {
  id: diagramId,
  projectId: "project-1",
  name: "Architecture",
  revision: 7,
  archivedAt: null,
  createdAt: "2026-10-06T00:00:00.000Z",
  updatedAt: "2026-10-06T00:00:00.000Z",
};
const draftSetInput = {
  version: 1,
  kind: "diagram-annotations",
  contextId: "diagram-annotations_main",
  label: "Architecture",
  payload: {
    environmentId: "env-1",
    projectId: "project-1",
    diagramId,
    pageId: "page:main",
    annotations,
  },
};
const draftSet = decodeAnnotationSet(draftSetInput);
const preparedAnnotations = Schema.decodeUnknownSync(DiagramPreparedAnnotations)({
  diagram: metadata,
  structure,
  capture: {
    diagramId,
    revision: 7,
    pageId: "page:main",
    annotations,
    resolved,
    images: [
      {
        role: "overview",
        annotationIds: ["a1", "a3"],
        bounds: overviewBounds,
        width: 516,
        height: 336,
        mimeType: "image/png",
        base64: "b3ZlcnZpZXc=",
      },
      {
        role: "detail",
        annotationIds: ["a3"],
        bounds: detailBounds,
        width: 432,
        height: 352,
        mimeType: "image/png",
        base64: "ZGV0YWls",
      },
    ],
  },
});
const terminal: ComposerContextRecord = {
  version: 1,
  kind: "terminal",
  contextId: ComposerContextId.make("terminal-1"),
  label: "Build output",
  terminalId: "main",
  terminalLabel: "Terminal",
  lineStart: 4,
  lineEnd: 5,
  text: "build failed",
};

/** What a fresh capture of `draftSet` produces when ids mint as uuid-1, uuid-2. */
const expectedCapture = {
  attachments: [
    {
      type: "image",
      id: "uuid-1",
      name: "Architecture-overview-image_uuid-1.png",
      sizeBytes: 8,
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,b3ZlcnZpZXc=",
      previewUri: "data:image/png;base64,b3ZlcnZpZXc=",
    },
    {
      type: "image",
      id: "uuid-2",
      name: "Architecture-detail-image_uuid-2.png",
      sizeBytes: 6,
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,ZGV0YWls",
      previewUri: "data:image/png;base64,ZGV0YWls",
    },
  ],
  records: [
    {
      version: 1,
      kind: "image",
      contextId: "image_uuid-1",
      label: "Architecture-overview-image_uuid-1.png",
      attachmentId: "uuid-1",
      name: "Architecture-overview-image_uuid-1.png",
      sizeBytes: 8,
      mimeType: "image/png",
    },
    {
      version: 1,
      kind: "image",
      contextId: "image_uuid-2",
      label: "Architecture-detail-image_uuid-2.png",
      attachmentId: "uuid-2",
      name: "Architecture-detail-image_uuid-2.png",
      sizeBytes: 6,
      mimeType: "image/png",
    },
    {
      ...draftSetInput,
      payload: {
        ...draftSetInput.payload,
        capture: {
          revision: 7,
          resolved,
          images: [
            {
              role: "overview",
              annotationIds: ["a1", "a3"],
              bounds: overviewBounds,
              width: 516,
              height: 336,
              contextId: "image_uuid-1",
            },
            {
              role: "detail",
              annotationIds: ["a3"],
              bounds: detailBounds,
              width: 432,
              height: 352,
              contextId: "image_uuid-2",
            },
          ],
          structure,
        },
      },
    },
  ],
};

beforeEach(() => {
  harness.nextId = 0;
  harness.annotationsCapability = true;
  harness.calls = [];
  harness.responses = {};
});

describe("prepareMobileDiagramContext with Canvas comments", () => {
  it("captures a comment set through its own RPC and pairs each numbered image with the set", async () => {
    const diagram = decodeDiagram({
      version: 1,
      kind: "diagram",
      contextId: "diagram_main",
      label: "Whole diagram",
      payload: {
        environmentId: "env-1",
        projectId: "project-1",
        diagramId,
        scope: { kind: "diagram", pageId: "page:main" },
      },
    });
    harness.responses = {
      prepareAnnotations: preparedAnnotations,
      prepare: decodePreparedContext({
        diagram: metadata,
        scope: { kind: "diagram", pageId: "page:main" },
        structure,
        image: { status: "unavailable", reason: "no-editor" },
      }),
    };

    const result = await prepareMobileDiagramContext({
      context: { version: 1, records: [terminal, diagram, draftSet] },
      attachments: [],
    });

    expect(harness.calls).toEqual([
      {
        tag: "prepare",
        environmentId: "env-1",
        input: {
          projectId: "project-1",
          diagramId,
          scope: { kind: "diagram", pageId: "page:main" },
          allowImageUnavailable: true,
        },
      },
      {
        tag: "prepareAnnotations",
        environmentId: "env-1",
        input: { projectId: "project-1", diagramId, pageId: "page:main", annotations },
      },
    ]);
    expect(result).toEqual({
      context: {
        version: 1,
        records: [
          terminal,
          {
            ...diagram,
            payload: {
              ...diagram.payload,
              revision: 7,
              structure,
              imageStatus: "unavailable",
              imageUnavailableReason: "no-editor",
            },
          },
          ...expectedCapture.records,
        ],
      },
      attachments: expectedCapture.attachments,
    });
    expect(isMessageContext(result.context)).toBe(true);
  });

  it("recaptures a set that already carries a capture and replaces its earlier images", async () => {
    harness.responses = { prepareAnnotations: preparedAnnotations };
    const staleImage = (role: string): ComposerContextRecord => ({
      version: 1,
      kind: "image",
      contextId: ComposerContextId.make(`image_old_${role}`),
      label: `old-${role}.png`,
      attachmentId: `old-${role}`,
      name: `old-${role}.png`,
      sizeBytes: 3,
      mimeType: "image/png",
    });
    const staleAttachment = (id: string) => ({
      type: "image" as const,
      id,
      name: `${id}.png`,
      sizeBytes: 3,
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,AAAA",
      previewUri: "data:image/png;base64,AAAA",
    });
    const sentSet = decodeAnnotationSet({
      ...draftSetInput,
      payload: {
        ...draftSetInput.payload,
        capture: {
          revision: 5,
          resolved,
          images: [
            {
              role: "overview",
              annotationIds: ["a1", "a3"],
              bounds: overviewBounds,
              width: 516,
              height: 336,
              contextId: "image_old_overview",
            },
            {
              role: "detail",
              annotationIds: ["a3"],
              bounds: detailBounds,
              width: 432,
              height: 352,
              contextId: "image_old_detail",
            },
          ],
          structure: { ...structure, revision: 5 },
        },
      },
    });

    const result = await prepareMobileDiagramContext({
      context: {
        version: 1,
        records: [sentSet, staleImage("overview"), staleImage("detail"), terminal],
      },
      attachments: [
        staleAttachment("old-overview"),
        staleAttachment("photo"),
        staleAttachment("old-detail"),
      ],
    });

    expect(result).toEqual({
      context: { version: 1, records: [terminal, ...expectedCapture.records] },
      attachments: [staleAttachment("photo"), ...expectedCapture.attachments],
    });
  });

  it("refuses to send comments to an environment that cannot capture them", async () => {
    harness.annotationsCapability = undefined;
    harness.responses = { prepareAnnotations: preparedAnnotations };

    await expect(
      prepareMobileDiagramContext({
        context: { version: 1, records: [draftSet] },
        attachments: [],
      }),
    ).rejects.toThrow("Update T3 Code on this environment to send Canvas comments.");
    expect(harness.calls).toEqual([]);
  });
});
