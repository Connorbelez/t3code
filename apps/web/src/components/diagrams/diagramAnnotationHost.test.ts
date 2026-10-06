// @vitest-environment jsdom
import {
  DiagramAnnotatedCapture,
  DiagramAnnotations,
  DiagramOperationError,
  type DiagramAnnotationId,
  type DiagramBounds,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import sharp from "sharp";
import {
  Editor,
  GeoShapeUtil,
  PageRecordType,
  createShapeId,
  createTLStore,
  type TLShapeId,
} from "tldraw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { renderAnnotatedCapture, resolveAnnotationTargets } from "./diagramAnnotationHost";
import { blankExportSvg } from "./diagramAnnotationRender";

vi.hoisted(() =>
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  }),
);
const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      addEventListener() {},
      removeEventListener() {},
      check: () => true,
      load: () => Promise.resolve([]),
      ready: Promise.resolve(),
    },
  });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
  vi.unstubAllGlobals();
});
function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const editor = new Editor({
    store: createTLStore(),
    shapeUtils: [GeoShapeUtil],
    bindingUtils: [],
    tools: [],
    getContainer: () => container,
  });
  cleanups.push(() => {
    editor.dispose();
    container.remove();
  });
  return editor;
}

const decodeAnnotations = Schema.decodeUnknownSync(DiagramAnnotations);
const decodeCapture = Schema.decodeUnknownSync(DiagramAnnotatedCapture);
const onShapes = (number: number, ...shapeIds: TLShapeId[]) => ({
  id: `comment-${number}`,
  number,
  comment: `Comment ${number}`,
  target: { kind: "shapes", shapeIds },
});
const onRegion = (number: number, bounds: DiagramBounds) => ({
  id: `comment-${number}`,
  number,
  comment: `Comment ${number}`,
  target: { kind: "region", bounds },
});
const rounded = ({ x, y, w, h }: DiagramBounds) =>
  [x, y, w, h].map((value) => Math.round(value * 1e6) / 1e6 || 0);

describe("resolveAnnotationTargets", () => {
  it("bounds rotated and grouped shapes by their axis-aligned page boxes", () => {
    const editor = mount();
    const turned = createShapeId("turned");
    const left = createShapeId("left");
    const right = createShapeId("right");
    const group = createShapeId("group");
    editor.createShapes([
      { id: turned, type: "geo", x: 100, y: 100, rotation: Math.PI / 2, props: { w: 100, h: 50 } },
      { id: left, type: "geo", x: 0, y: 0, props: { w: 10, h: 10 } },
      { id: right, type: "geo", x: 90, y: 40, props: { w: 10, h: 10 } },
    ]);
    editor.groupShapes([left, right], { groupId: group });
    editor.updateShape({ id: group, type: "group", rotation: Math.PI / 2 });

    const targets = resolveAnnotationTargets(
      editor,
      editor.getCurrentPageId(),
      decodeAnnotations([
        onShapes(1, turned),
        onShapes(2, right),
        onShapes(3, group),
        onShapes(4, turned, left),
        onRegion(5, { x: -40, y: -30, w: 20, h: 10 }),
      ]),
    );

    expect(targets.map(({ number, kind, bounds }) => [number, kind, rounded(bounds)])).toEqual([
      [1, "shapes", [50, 100, 50, 100]],
      [2, "shapes", [-50, 90, 10, 10]],
      [3, "shapes", [-50, 0, 50, 100]],
      [4, "shapes", [-10, 0, 110, 200]],
      [5, "region", [-40, -30, 20, 10]],
    ]);
  });

  it("names every comment whose shapes were deleted or moved to another page", () => {
    const editor = mount();
    const here = createShapeId("here");
    const elsewhere = createShapeId("elsewhere");
    const otherPage = PageRecordType.createId("other");
    editor.createPage({ id: otherPage, name: "Other" });
    editor.createShapes([
      { id: here, type: "geo", x: 0, y: 0 },
      { id: elsewhere, type: "geo", parentId: otherPage, x: 0, y: 0 },
    ]);

    const resolve = () =>
      resolveAnnotationTargets(
        editor,
        editor.getCurrentPageId(),
        decodeAnnotations([
          onShapes(1, here),
          onShapes(4, here, createShapeId("deleted")),
          onShapes(7, elsewhere),
        ]),
      );

    expect(resolve).toThrow(
      new DiagramOperationError({
        code: "scope-unavailable",
        details: {
          issues: [
            {
              path: "annotations/4",
              message:
                "Comment 4 targets a shape that was deleted or moved to another page. Retarget or delete it.",
            },
            {
              path: "annotations/7",
              message:
                "Comment 7 targets a shape that was deleted or moved to another page. Retarget or delete it.",
            },
          ],
        },
      }),
    );
  });
});

const box = { x: 100, y: 200, w: 300, h: 100 };
const target = (number: number, bounds: DiagramBounds) => ({
  id: `comment-${number}` as DiagramAnnotationId,
  number,
  kind: "region" as const,
  bounds,
});
const blankPage = async (image: { bounds: DiagramBounds; width: number; height: number }) =>
  blankExportSvg(image.bounds, image.width, image.height);

describe("renderAnnotatedCapture", () => {
  it("returns wire-ready images drawn over the page export at their planned size", async () => {
    const annotations = decodeAnnotations([onRegion(1, box)]);
    const rendered = await renderAnnotatedCapture([target(1, box)], {
      exportSvg: blankPage,
      rasterize: async (svg) => (await sharp(Buffer.from(svg)).png().toBuffer()).toString("base64"),
    });

    expect(rendered.resolved).toEqual([
      { id: "comment-1", bounds: box, marker: { x: 100, y: 200 } },
    ]);
    const [image] = rendered.images;
    expect(image && { ...image, base64: "png" }).toEqual({
      role: "overview",
      annotationIds: ["comment-1"],
      bounds: { x: 52, y: 152, w: 396, h: 196 },
      width: 396,
      height: 196,
      mimeType: "image/png",
      base64: "png",
    });
    const png = sharp(Buffer.from(image?.base64 ?? "", "base64"));
    const { data, info } = await png.raw().toBuffer({ resolveWithObject: true });
    const offset = (48 * info.width + 40) * info.channels;
    // Badge 1 is centered on pixel (48, 48), so the overlay reached the rasterized image.
    expect([info.width, info.height, ...data.subarray(offset, offset + 3)]).toEqual([
      396, 196, 0xe8, 0x17, 0x8a,
    ]);
    expect(
      decodeCapture({
        diagramId: "00000000-0000-4000-8000-000000000001",
        revision: 3,
        pageId: "page:page",
        annotations,
        ...rendered,
      }).images.length,
    ).toBe(1);
  });

  it("fails too-large once the images pass 15 MiB together", async () => {
    const eightMiB = "A".repeat(8 * 1024 * 1024);
    const seams = { exportSvg: blankPage, rasterize: async () => eightMiB };
    const near = [target(1, box)];
    // Far enough apart that the overview gets a detail image too.
    const far = [target(1, box), target(2, { x: 9000, y: 0, w: 100, h: 100 })];

    const single = await renderAnnotatedCapture(near, seams);
    expect(single.images.map((image) => image.base64.length)).toEqual([8 * 1024 * 1024]);
    await expect(renderAnnotatedCapture(far, seams)).rejects.toThrow(
      new DiagramOperationError({
        code: "too-large",
        details: {
          issues: [
            {
              path: "images",
              message:
                "The commented page renders larger than 15 MiB. Send fewer comments at once, or comment on targets that sit closer together.",
            },
          ],
        },
      }),
    );
  });
});
