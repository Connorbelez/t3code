import {
  DIAGRAM_ANNOTATION_MAX_IMAGES,
  type DiagramAnnotationId,
  type DiagramAnnotationImage,
  type DiagramAnnotationTarget,
  type DiagramBounds,
  type DiagramPoint,
} from "@t3tools/contracts";

/** Output pixels. A badge keeps this size in every image, however far the diagram is scaled down. */
export const ANNOTATION_BADGE_RADIUS = 12;
/** The longest side of any annotated image, as for plain Canvas captures. */
export const ANNOTATION_IMAGE_MAX_SIDE = 2048;
/** An overview scaled below this also gets detail images of its targets. */
export const ANNOTATION_DETAIL_BELOW_SCALE = 0.5;
/** One saturated color for outlines, leaders and badges, rare in diagrams. */
export const ANNOTATION_COLOR = "#e8178a";

/** Output pixels kept between a badge and the image edge. It also absorbs the last rescale. */
const BADGE_EDGE = 2;
const OUTLINE_WIDTH = 2;
/** Output pixels between a target and its outline, so the outline does not cover the shape's own stroke. */
const OUTLINE_OFFSET = 3;
const MAX_DETAILS = DIAGRAM_ANNOTATION_MAX_IMAGES - 1;

type MarkerTarget = {
  readonly id: unknown;
  readonly number: number;
  readonly bounds: DiagramBounds;
};

/** A comment's target where the captured revision has it, in page coordinates. */
export type AnnotationTargetBox = {
  readonly id: DiagramAnnotationId;
  readonly number: number;
  readonly kind: DiagramAnnotationTarget["kind"];
  readonly bounds: DiagramBounds;
};
export type PlacedAnnotation = AnnotationTargetBox & { readonly marker: DiagramPoint };
/** `scale` is output pixels per page unit. */
export type PlannedAnnotationImage = DiagramAnnotationImage & { readonly scale: number };
export type AnnotatedCapturePlan = {
  /** In input order, which the capture's `resolved` must keep. */
  readonly resolved: readonly PlacedAnnotation[];
  /** The overview first, listing every comment, then up to four details. */
  readonly images: readonly PlannedAnnotationImage[];
};

const byNumber = (a: { readonly number: number }, b: { readonly number: number }) =>
  a.number - b.number;
const union = (boxes: readonly DiagramBounds[]): DiagramBounds => {
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.w));
  const maxY = Math.max(...boxes.map((box) => box.y + box.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
};
const around = (point: DiagramPoint, radius: number): DiagramBounds => ({
  x: point.x - radius,
  y: point.y - radius,
  w: radius * 2,
  h: radius * 2,
});
const longestSide = (box: DiagramBounds) => Math.max(box.w, box.h);
const padded = (box: DiagramBounds): DiagramBounds => {
  const margin = Math.max(48, 0.08 * longestSide(box));
  return { x: box.x - margin, y: box.y - margin, w: box.w + margin * 2, h: box.h + margin * 2 };
};
const scaleFor = (box: DiagramBounds) =>
  Math.min(1, ANNOTATION_IMAGE_MAX_SIDE / Math.max(longestSide(box), 1));
const center = (box: DiagramBounds): DiagramPoint => ({
  x: box.x + box.w / 2,
  y: box.y + box.h / 2,
});

/**
 * Badge centers in number order. Each badge tries its target's top-left, top-right, bottom-left
 * and bottom-right corners, then steps right along the top edge; the first spot clear of every
 * badge already placed wins. Works in any space: pass page bounds with a page radius, or screen
 * bounds with a screen radius.
 */
export function layoutAnnotationMarkers<T extends MarkerTarget>(
  targets: readonly T[],
  radius: number,
): Array<T & { readonly marker: DiagramPoint }> {
  const spacing = radius * 2 + radius / 3;
  const placed: DiagramPoint[] = [];
  const clear = (point: DiagramPoint) =>
    placed.every(
      (other) => Math.hypot(point.x - other.x, point.y - other.y) >= spacing * (1 - 1e-9),
    );
  return [...targets].sort(byNumber).map((target) => {
    const { x, y, w, h } = target.bounds;
    let marker = [
      { x, y },
      { x: x + w, y },
      { x, y: y + h },
      { x: x + w, y: y + h },
    ].find(clear);
    for (let step = 1; !marker; step += 1) {
      const candidate = { x: x + step * spacing, y };
      if (clear(candidate)) marker = candidate;
    }
    placed.push(marker);
    return { ...target, marker };
  });
}

/**
 * Bounds and scale for an image of `boxes` with room for every badge. Fitting a badge can shrink
 * the scale, which grows every badge in page units, so badges are placed again until the scale
 * settles. It does settle: at most 30 badges never span the 2048 pixels that would keep it moving.
 */
function frame(
  boxes: readonly DiagramBounds[],
  place: (radius: number) => readonly PlacedAnnotation[],
) {
  const base = padded(union(boxes));
  let scale = scaleFor(base);
  for (;;) {
    const placed = place(ANNOTATION_BADGE_RADIUS / scale);
    const reach = (ANNOTATION_BADGE_RADIUS + BADGE_EDGE) / scale;
    const bounds = union([base, ...placed.map((entry) => around(entry.marker, reach))]);
    const fitted = scaleFor(bounds);
    if (fitted >= scale * 0.99) return { bounds, scale: fitted, placed };
    scale = fitted;
  }
}

/** Comments in number order share a detail while it stays at full scale; past four, the nearest pair merges. */
function detailGroups(ordered: readonly PlacedAnnotation[]): PlacedAnnotation[][] {
  const fullScale = (group: readonly PlacedAnnotation[]) =>
    union([
      padded(union(group.map((entry) => entry.bounds))),
      ...group.map((entry) => around(entry.marker, ANNOTATION_BADGE_RADIUS + BADGE_EDGE)),
    ]);
  const groups: PlacedAnnotation[][] = [];
  for (const entry of ordered) {
    const last = groups.at(-1);
    if (last && longestSide(fullScale([...last, entry])) <= ANNOTATION_IMAGE_MAX_SIDE)
      last.push(entry);
    else groups.push([entry]);
  }
  while (groups.length > MAX_DETAILS) {
    const centers = groups.map((group) => center(union(group.map((entry) => entry.bounds))));
    let nearest = { first: 0, second: 1, distance: Number.POSITIVE_INFINITY };
    centers.forEach((a, first) =>
      centers.slice(first + 1).forEach((b, offset) => {
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (distance < nearest.distance) nearest = { first, second: first + 1 + offset, distance };
      }),
    );
    const [first, second] = [groups[nearest.first] ?? [], groups[nearest.second] ?? []];
    groups[nearest.first] = [...first, ...second].sort(byNumber);
    groups.splice(nearest.second, 1);
  }
  return groups;
}

function plannedImage(
  role: PlannedAnnotationImage["role"],
  framed: { bounds: DiagramBounds; scale: number; placed: readonly PlacedAnnotation[] },
): PlannedAnnotationImage {
  return {
    role,
    annotationIds: framed.placed.map((entry) => entry.id),
    bounds: framed.bounds,
    scale: framed.scale,
    width: Math.max(1, Math.round(framed.bounds.w * framed.scale)),
    height: Math.max(1, Math.round(framed.bounds.h * framed.scale)),
  };
}

/**
 * The images that show `targets` with numbered badges. Badges are placed at the overview's scale and
 * keep those page positions in every image. Details are added only when the overview
 * is too small to read.
 */
export function planAnnotatedCapture(
  targets: readonly AnnotationTargetBox[],
): AnnotatedCapturePlan {
  const overview = frame(
    targets.map((target) => target.bounds),
    (radius) => layoutAnnotationMarkers(targets, radius),
  );
  const images = [plannedImage("overview", overview)];
  if (overview.scale < ANNOTATION_DETAIL_BELOW_SCALE)
    for (const group of detailGroups(overview.placed))
      images.push(
        plannedImage(
          "detail",
          frame(
            group.map((entry) => entry.bounds),
            () => group,
          ),
        ),
      );
  const placedById = new Map(overview.placed.map((entry) => [entry.id, entry]));
  return {
    resolved: targets.flatMap((target) => {
      const entry = placedById.get(target.id);
      return entry ? [entry] : [];
    }),
    images,
  };
}

const num = (value: number) => String(Math.round(value * 1000) / 1000);

/**
 * Outlines, leader lines and numbered badges for the comments `image` lists, as one SVG group in
 * page coordinates sized in the image's output pixels. Only badge numbers reach the markup.
 */
export function annotationOverlaySvg(
  image: Pick<PlannedAnnotationImage, "annotationIds" | "scale">,
  annotations: readonly PlacedAnnotation[],
): string {
  const px = (value: number) => num(value / image.scale);
  const shown = annotations
    .filter((annotation) => image.annotationIds.includes(annotation.id))
    .sort(byNumber);
  const offset = OUTLINE_OFFSET / image.scale;
  const stroke = `stroke="${ANNOTATION_COLOR}" stroke-width="${px(OUTLINE_WIDTH)}"`;
  const outlines = shown.map(
    ({ kind, bounds }) =>
      `<rect x="${num(bounds.x - offset)}" y="${num(bounds.y - offset)}" width="${num(bounds.w + offset * 2)}" height="${num(bounds.h + offset * 2)}" fill="none" ${stroke}${kind === "region" ? ` stroke-dasharray="${px(6)} ${px(4)}"` : ""}/>`,
  );
  const leaders = shown.flatMap(({ bounds, marker }) => {
    const nearest = {
      x: Math.min(Math.max(marker.x, bounds.x), bounds.x + bounds.w),
      y: Math.min(Math.max(marker.y, bounds.y), bounds.y + bounds.h),
    };
    return Math.hypot(marker.x - nearest.x, marker.y - nearest.y) >
      ANNOTATION_BADGE_RADIUS / image.scale
      ? [
          `<line x1="${num(marker.x)}" y1="${num(marker.y)}" x2="${num(nearest.x)}" y2="${num(nearest.y)}" ${stroke}/>`,
        ]
      : [];
  });
  const badges = shown.map(
    ({ number, marker }) =>
      `<circle cx="${num(marker.x)}" cy="${num(marker.y)}" r="${px(ANNOTATION_BADGE_RADIUS - 1)}" fill="${ANNOTATION_COLOR}" stroke="white" stroke-width="${px(2)}"/>` +
      `<text x="${num(marker.x)}" y="${num(marker.y)}" dy="0.35em" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="${px(number > 99 ? 10 : 13)}" fill="white">${Math.trunc(number)}</text>`,
  );
  return `<g data-t3-annotations="">${outlines.join("")}${leaders.join("")}${badges.join("")}</g>`;
}

/** `svg` with `overlay` drawn last, on top of everything the export drew. */
export function withAnnotationOverlay(svg: string, overlay: string): string {
  const end = svg.lastIndexOf("</svg>");
  if (end === -1) throw new Error("The page export is not an SVG document.");
  return `${svg.slice(0, end)}${overlay}${svg.slice(end)}`;
}

/** A white page export for a page with no shapes, with the same page-space viewBox. */
export function blankExportSvg(bounds: DiagramBounds, width: number, height: number): string {
  const [x, y, w, h] = [bounds.x, bounds.y, bounds.w, bounds.h].map(num);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x} ${y} ${w} ${h}" preserveAspectRatio="none"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="white"/></svg>`;
}
