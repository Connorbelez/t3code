import { DiagramAnnotationsContextRecord, DiagramPreparedAnnotations } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { attachAnnotationCapture, stripAnnotationCapture } from "./diagramAnnotations.ts";

const decodeRecord = Schema.decodeUnknownSync(DiagramAnnotationsContextRecord);
const decodePrepared = Schema.decodeUnknownSync(DiagramPreparedAnnotations);

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
const structure = {
  revision: 7,
  pages: [{ id: "page:main", name: "Main", shapeCount: 1 }],
  compositions: [],
  shapes: [
    {
      id: "shape:box",
      pageId: "page:main",
      parentId: "page:main",
      type: "geo",
      label: "Srv",
      bounds: box,
      locked: false,
    },
  ],
  bindings: [],
  totalShapes: 1,
  truncated: false,
};
const prepared = decodePrepared({
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
    resolved: [
      { id: "a1", bounds: box, marker: { x: 100, y: 80 } },
      { id: "a3", bounds: corner, marker: { x: 400, y: -40 } },
    ],
    images: [
      {
        role: "overview",
        annotationIds: ["a1", "a3"],
        bounds: { x: 52, y: -88, w: 516, h: 336 },
        width: 516,
        height: 336,
        mimeType: "image/png",
        base64: "b3ZlcnZpZXc=",
      },
      {
        role: "detail",
        annotationIds: ["a3"],
        bounds: { x: 352, y: -88, w: 216, h: 176 },
        width: 432,
        height: 352,
        mimeType: "image/png",
        base64: "ZGV0YWls",
      },
    ],
  },
});

const counter = () => {
  let next = 0;
  return () => `id${++next}`;
};

describe("attachAnnotationCapture", () => {
  it("freezes a draft into a captured record and one named PNG per image", () => {
    const draft = decodeRecord(draftInput);
    const result = attachAnnotationCapture(draft, prepared, counter());

    expect(result).toEqual({
      record: {
        ...draftInput,
        payload: {
          ...draftInput.payload,
          capture: {
            revision: 7,
            resolved: [
              { id: "a1", bounds: box, marker: { x: 100, y: 80 } },
              { id: "a3", bounds: corner, marker: { x: 400, y: -40 } },
            ],
            images: [
              {
                role: "overview",
                annotationIds: ["a1", "a3"],
                bounds: { x: 52, y: -88, w: 516, h: 336 },
                width: 516,
                height: 336,
                contextId: "image_id1",
              },
              {
                role: "detail",
                annotationIds: ["a3"],
                bounds: { x: 352, y: -88, w: 216, h: 176 },
                width: 432,
                height: 352,
                contextId: "image_id2",
              },
            ],
            structure,
          },
        },
      },
      images: [
        {
          id: "id1",
          contextId: "image_id1",
          name: "Architecture-overview-image_id1.png",
          mimeType: "image/png",
          base64: "b3ZlcnZpZXc=",
        },
        {
          id: "id2",
          contextId: "image_id2",
          name: "Architecture-detail-image_id2.png",
          mimeType: "image/png",
          base64: "ZGV0YWls",
        },
      ],
    });
    expect(decodeRecord(JSON.parse(JSON.stringify(result.record)))).toEqual(result.record);
    expect(draft).toStrictEqual(decodeRecord(draftInput));
  });

  it("fails stale when the capture does not describe exactly the draft's comments", () => {
    const [first, second] = annotations;
    const variants = [
      { annotations: [{ ...first, comment: "Make this box red" }, second] },
      { annotations: [first, { ...second, number: 2 }] },
      {
        annotations: [{ ...first, target: { kind: "shapes", shapeIds: ["shape:other"] } }, second],
      },
      { annotations: [{ ...first, id: "a9" }, second] },
      { annotations: [second, first] },
      { annotations: [first] },
      { pageId: "page:other" },
      { diagramId: "1b6d3f4e-1a2b-4c3d-8e9f-0123456789ab" },
    ];
    for (const variant of variants) {
      const draft = decodeRecord({
        ...draftInput,
        payload: { ...draftInput.payload, ...variant },
      });
      expect(
        () => attachAnnotationCapture(draft, prepared, counter()),
        JSON.stringify(variant),
      ).toThrow("Diagram operation failed (stale).");
    }
    expect(
      attachAnnotationCapture(decodeRecord(draftInput), prepared, counter()).images,
    ).toHaveLength(2);
  });

  it("shortens only the label so the longest name still fits an attachment", () => {
    const draft = decodeRecord({ ...draftInput, label: "L".repeat(200) });
    const ids = ["0b6d3f4e-1a2b-4c3d-8e9f-0123456789ab", "1b6d3f4e-1a2b-4c3d-8e9f-0123456789ab"];
    const { images } = attachAnnotationCapture(draft, prepared, () => ids.shift()!);

    expect(images.map((image) => image.name)).toEqual([
      `${"L".repeat(199)}-overview-image_0b6d3f4e-1a2b-4c3d-8e9f-0123456789ab.png`,
      `${"L".repeat(200)}-detail-image_1b6d3f4e-1a2b-4c3d-8e9f-0123456789ab.png`,
    ]);
    expect(images[0]!.name).toHaveLength(255);
  });
});

describe("stripAnnotationCapture", () => {
  it("returns the authored comments with no capture key", () => {
    const { record } = attachAnnotationCapture(decodeRecord(draftInput), prepared, counter());

    expect(stripAnnotationCapture(record)).toStrictEqual({
      version: 1,
      contextId: "diagram-annotations_main",
      kind: "diagram-annotations",
      label: "Architecture",
      payload: {
        environmentId: "env-1",
        projectId: "project-1",
        diagramId,
        pageId: "page:main",
        annotations: [
          {
            id: "a1",
            number: 1,
            comment: "Make this box blue",
            target: { kind: "shapes", shapeIds: ["shape:box"] },
          },
          {
            id: "a3",
            number: 3,
            comment: "Room for a legend",
            target: { kind: "region", bounds: { x: 400, y: -40, w: 120, h: 80 } },
          },
        ],
      },
    });
    expect(record.payload.capture.revision).toBe(7);
  });
});
