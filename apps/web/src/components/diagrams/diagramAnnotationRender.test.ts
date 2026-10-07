import {
  diagramAnnotationCaptureIssues,
  type DiagramAnnotationId,
  type DiagramBounds,
} from "@t3tools/contracts";
import sharp from "sharp";
import { describe, expect, it } from "vite-plus/test";

import {
  annotationOverlaySvg,
  blankExportSvg,
  layoutAnnotationMarkers,
  planAnnotatedCapture,
  withAnnotationOverlay,
  type AnnotatedCapturePlan,
  type AnnotationTargetBox,
} from "./diagramAnnotationRender";

const shapes = (id: string, number: number, bounds: DiagramBounds): AnnotationTargetBox => ({
  id: id as DiagramAnnotationId,
  number,
  kind: "shapes",
  bounds,
});
const region = (id: string, number: number, bounds: DiagramBounds): AnnotationTargetBox => ({
  ...shapes(id, number, bounds),
  kind: "region",
});

const box = { x: 100, y: 200, w: 300, h: 100 };
const crowded = { x: 0, y: 0, w: 20, h: 20 };

// Expected values are worked by hand: margin max(48, 8% of the longest side), scale
// min(1, 2048 / longest side), badge radius 12 / scale, badge spacing 7/3 of the radius, and
// badges fitted with 14 / scale of room.
const fixtures: {
  name: string;
  targets: AnnotationTargetBox[];
  markers: [string, number, number][];
  images: {
    role: "overview" | "detail";
    annotationIds: string[];
    bounds: DiagramBounds;
    scale: number;
    width: number;
    height: number;
  }[];
}[] = [
  {
    name: "one comment at a nonzero origin",
    targets: [shapes("a", 1, box)],
    markers: [["a", 100, 200]],
    images: [
      {
        role: "overview",
        annotationIds: ["a"],
        bounds: { x: 52, y: 152, w: 396, h: 196 },
        scale: 1,
        width: 396,
        height: 196,
      },
    ],
  },
  {
    name: "two comments on one shape and a region, at a negative origin, listed out of number order",
    targets: [
      region("r", 3, { x: -250, y: -280, w: 100, h: 60 }),
      shapes("a", 1, { x: -500, y: -300, w: 200, h: 120 }),
      shapes("b", 2, { x: -500, y: -300, w: 200, h: 120 }),
    ],
    markers: [
      ["r", -250, -280],
      ["a", -500, -300],
      ["b", -300, -300],
    ],
    images: [
      {
        role: "overview",
        annotationIds: ["a", "b", "r"],
        bounds: { x: -548, y: -348, w: 446, h: 216 },
        scale: 1,
        width: 446,
        height: 216,
      },
    ],
  },
  {
    name: "three comments on a shape too small for its corners",
    targets: [shapes("a", 1, crowded), shapes("b", 2, crowded), shapes("c", 3, crowded)],
    markers: [
      ["a", 0, 0],
      ["b", 20, 20],
      ["c", 56, 0],
    ],
    images: [
      {
        role: "overview",
        annotationIds: ["a", "b", "c"],
        bounds: { x: -48, y: -48, w: 118, h: 116 },
        scale: 1,
        width: 118,
        height: 116,
      },
    ],
  },
  {
    name: "a region overlapping a crowded shape",
    targets: [
      shapes("a", 1, crowded),
      shapes("b", 2, crowded),
      shapes("c", 3, crowded),
      region("r", 4, { x: 10, y: 10, w: 30, h: 30 }),
    ],
    markers: [
      ["a", 0, 0],
      ["b", 20, 20],
      ["c", 56, 0],
      ["r", 40, 40],
    ],
    images: [
      {
        role: "overview",
        annotationIds: ["a", "b", "c", "r"],
        bounds: { x: -48, y: -48, w: 136, h: 136 },
        scale: 1,
        width: 136,
        height: 136,
      },
    ],
  },
  {
    name: "an overview scaled below one half, with a detail per nearby run of comments",
    targets: [
      shapes("a", 1, { x: 0, y: 0, w: 200, h: 100 }),
      shapes("b", 2, { x: 300, y: 0, w: 200, h: 100 }),
      region("r", 3, { x: 5000, y: 3000, w: 400, h: 200 }),
      shapes("d", 4, { x: 9000, y: 0, w: 100, h: 100 }),
    ],
    markers: [
      ["a", 0, 0],
      ["b", 300, 0],
      ["r", 5000, 3000],
      ["d", 9000, 0],
    ],
    images: [
      {
        role: "overview",
        annotationIds: ["a", "b", "r", "d"],
        bounds: { x: -728, y: -728, w: 10556, h: 4656 },
        scale: 2048 / 10556,
        width: 2048,
        height: 903,
      },
      {
        role: "detail",
        annotationIds: ["a", "b"],
        bounds: { x: -48, y: -48, w: 596, h: 196 },
        scale: 1,
        width: 596,
        height: 196,
      },
      {
        role: "detail",
        annotationIds: ["r"],
        bounds: { x: 4952, y: 2952, w: 496, h: 296 },
        scale: 1,
        width: 496,
        height: 296,
      },
      {
        role: "detail",
        annotationIds: ["d"],
        bounds: { x: 8952, y: -48, w: 196, h: 196 },
        scale: 1,
        width: 196,
        height: 196,
      },
    ],
  },
  {
    name: "six far-apart comments, where the nearest groups merge down to four details",
    targets: [
      shapes("a", 1, { x: 0, y: 0, w: 100, h: 100 }),
      shapes("b", 2, { x: 10000, y: 0, w: 100, h: 100 }),
      shapes("c", 3, { x: 2500, y: 0, w: 100, h: 100 }),
      shapes("d", 4, { x: 20000, y: 0, w: 100, h: 100 }),
      shapes("e", 5, { x: 12600, y: 0, w: 100, h: 100 }),
      shapes("f", 6, { x: 30000, y: 0, w: 100, h: 100 }),
    ],
    markers: [
      ["a", 0, 0],
      ["b", 10000, 0],
      ["c", 2500, 0],
      ["d", 20000, 0],
      ["e", 12600, 0],
      ["f", 30000, 0],
    ],
    images: [
      {
        role: "overview",
        annotationIds: ["a", "b", "c", "d", "e", "f"],
        bounds: { x: -2408, y: -2408, w: 34916, h: 4916 },
        scale: 2048 / 34916,
        width: 2048,
        height: 288,
      },
      {
        role: "detail",
        annotationIds: ["a", "c"],
        bounds: { x: -208, y: -208, w: 3016, h: 516 },
        scale: 2048 / 3016,
        width: 2048,
        height: 350,
      },
      {
        role: "detail",
        annotationIds: ["b", "e"],
        bounds: { x: 9784, y: -216, w: 3132, h: 532 },
        scale: 2048 / 3132,
        width: 2048,
        height: 348,
      },
      {
        role: "detail",
        annotationIds: ["d"],
        bounds: { x: 19952, y: -48, w: 196, h: 196 },
        scale: 1,
        width: 196,
        height: 196,
      },
      {
        role: "detail",
        annotationIds: ["f"],
        bounds: { x: 29952, y: -48, w: 196, h: 196 },
        scale: 1,
        width: 196,
        height: 196,
      },
    ],
  },
];

describe("planAnnotatedCapture", () => {
  it.each(fixtures)("plans $name", ({ targets, markers, images }) => {
    const plan = planAnnotatedCapture(targets);
    expect(plan.resolved.map(({ id, marker }) => [id, marker.x, marker.y])).toEqual(markers);
    expect(plan.images).toEqual(images);
    expect(diagramAnnotationCaptureIssues({ annotations: targets, ...plan })).toEqual([]);
  });
});

describe("layoutAnnotationMarkers", () => {
  it("spaces badges by the radius it is given and returns them in number order", () => {
    const targets = [
      { id: "second", number: 2, bounds: { x: 0, y: 0, w: 10, h: 10 } },
      { id: "first", number: 1, bounds: { x: 0, y: 0, w: 10, h: 10 } },
    ];
    expect(
      layoutAnnotationMarkers(targets, 6).map(({ id, marker }) => [id, marker.x, marker.y]),
    ).toEqual([
      ["first", 0, 0],
      ["second", 10, 10],
    ]);
    expect(
      layoutAnnotationMarkers(targets, 12).map(({ id, marker }) => [id, marker.x, marker.y]),
    ).toEqual([
      ["first", 0, 0],
      ["second", 28, 0],
    ]);
  });
});

const ink = "e8178a";
const paper = "ffffff";

/** Rasterizes `plan`'s image the way a page with no shapes renders, and reads pixels from it. */
async function rasterize(plan: AnnotatedCapturePlan, index = 0) {
  const image = plan.images[index];
  if (!image) throw new Error(`No image ${index}.`);
  const svg = withAnnotationOverlay(
    blankExportSvg(image.bounds, image.width, image.height),
    annotationOverlaySvg(image, plan.resolved),
  );
  const { data, info } = await sharp(Buffer.from(svg)).raw().toBuffer({ resolveWithObject: true });
  return {
    size: [info.width, info.height],
    at: (x: number, y: number) => {
      const offset = (y * info.width + x) * info.channels;
      return Array.from(data.subarray(offset, offset + 3), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join("");
    },
  };
}

describe("annotationOverlaySvg", () => {
  it("draws the badge, the outline and the page at their planned pixels", async () => {
    const pixels = await rasterize(planAnnotatedCapture([shapes("a", 1, box)]));
    expect(pixels.size).toEqual([396, 196]);
    // Badge 1 is centered on pixel (48, 48); sample left of its digit.
    expect(pixels.at(40, 48)).toBe(ink);
    // The outline's bottom edge sits 3px below the target, at page y 303.
    expect(pixels.at(200, 150)).toBe(ink);
    expect(pixels.at(20, 180)).toBe(paper);
  });

  it("draws a different picture for a different set of comments on the same geometry", async () => {
    const one = await rasterize(planAnnotatedCapture([shapes("a", 1, box)]));
    const two = await rasterize(planAnnotatedCapture([shapes("a", 1, box), shapes("b", 2, box)]));
    expect([one.size, two.size]).toEqual([
      [396, 196],
      [396, 196],
    ]);
    // Badge 2 lands on the top-right corner, pixel (348, 48).
    expect([one.at(340, 48), two.at(340, 48)]).toEqual([paper, ink]);
  });

  it("joins a badge that stepped off its target with a leader line", async () => {
    const lone = await rasterize(planAnnotatedCapture([shapes("a", 1, crowded)]));
    const stepped = await rasterize(
      planAnnotatedCapture([
        shapes("a", 1, crowded),
        shapes("b", 2, crowded),
        shapes("c", 3, crowded),
      ]),
    );
    // Badge 3 sits at page (56, 0) and its leader runs left along page y 0 to the target.
    expect([lone.at(80, 47), stepped.at(80, 47)]).toEqual([paper, ink]);
  });

  it("keeps badges at output size when the overview is scaled down", async () => {
    const plan = planAnnotatedCapture(
      fixtures.find((fixture) => fixture.name.startsWith("an overview scaled"))?.targets ?? [],
    );
    const pixels = await rasterize(plan);
    expect(pixels.size).toEqual([2048, 903]);
    // Badge 1 is centered near pixel (141.2, 141.2): 8px left is inside it, 15px left is not.
    expect([pixels.at(133, 141), pixels.at(126, 141)]).toEqual([ink, paper]);
  });
});
