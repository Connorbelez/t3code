import type { DiagramBounds, DiagramReadInput, DiagramStructure } from "@t3tools/contracts";
import { readCompositions } from "@t3tools/diagram-compose/model";
import type { TLRecord, TLShape } from "@tldraw/tlschema";

type Point = { x: number; y: number };
type Transform = { x: number; y: number; rotation: number };

function point(value: unknown): Point | null {
  if (
    value &&
    typeof value === "object" &&
    "x" in value &&
    "y" in value &&
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y)
  )
    return { x: value.x, y: value.y };
  return null;
}

function points(value: unknown): Point[] {
  const coordinate = point(value);
  if (coordinate) return [coordinate];
  if (Array.isArray(value)) return value.flatMap(points);
  if (value && typeof value === "object") return Object.values(value).flatMap(points);
  return [];
}

function label(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  if ("text" in value && typeof value.text === "string") return value.text;
  if ("content" in value && Array.isArray(value.content)) return value.content.map(label).join(" ");
  return "";
}

function transformPoint(value: Point, transform: Transform): Point {
  const cosine = Math.cos(transform.rotation);
  const sine = Math.sin(transform.rotation);
  return {
    x: transform.x + value.x * cosine - value.y * sine,
    y: transform.y + value.x * sine + value.y * cosine,
  };
}

function box(values: readonly Point[]): DiagramBounds | null {
  if (!values.length) return null;
  let x = Infinity,
    y = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const value of values) {
    x = Math.min(x, value.x);
    y = Math.min(y, value.y);
    right = Math.max(right, value.x);
    bottom = Math.max(bottom, value.y);
  }
  return { x, y, w: right - x, h: bottom - y };
}

function intersects(a: DiagramBounds, b: DiagramBounds) {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

/**
 * Compositions are listed once each in place of their members, so they never consume the shape
 * limit. A selected member or frame selects its composition; a viewport selects compositions
 * whose bounds it intersects.
 */
export function diagramStructure(
  records: readonly TLRecord[],
  revision: number,
  input: Pick<DiagramReadInput, "pageId" | "recordIds" | "offset" | "limit"> & {
    priorityPageId?: string;
    viewport?: DiagramBounds;
  } = {},
  compositions = readCompositions(records),
) {
  const collapsed = (id: string) =>
    compositions.isMember(id) || compositions.compositionOf(id) !== undefined;
  const byId = new Map(records.map((item) => [item.id as string, item]));
  const shapes = records.filter((item) => item.typeName === "shape");
  const ancestors = (shape: TLShape) => {
    const result: TLShape[] = [];
    const seen = new Set<string>([shape.id]);
    let parent = byId.get(shape.parentId);
    while (parent?.typeName === "shape" && !seen.has(parent.id)) {
      result.push(parent);
      seen.add(parent.id);
      parent = byId.get(parent.parentId);
    }
    return { shapes: result, pageId: parent?.typeName === "page" ? parent.id : shape.parentId };
  };
  const ancestry = new Map(shapes.map((shape) => [shape.id, ancestors(shape)]));
  const transform = (shape: TLShape) => {
    let result: Transform = { x: 0, y: 0, rotation: 0 };
    const parents = ancestry.get(shape.id)?.shapes ?? [];
    for (const item of [...parents].reverse().concat(shape)) {
      result = { ...transformPoint(item, result), rotation: result.rotation + item.rotation };
    }
    return result;
  };
  const bounds = (
    shape: TLShape,
    visited: ReadonlySet<string> = new Set(),
  ): DiagramBounds | null => {
    if (visited.has(shape.id)) return null;
    if (shape.type === "group") {
      const next = new Set([...visited, shape.id]);
      return box(
        shapes
          .filter((child) => child.parentId === shape.id)
          .flatMap((child) => {
            const value = bounds(child, next);
            return value
              ? [
                  { x: value.x, y: value.y },
                  { x: value.x + value.w, y: value.y + value.h },
                ]
              : [];
          }),
      );
    }
    const props = shape.props;
    let local: Point[] = [];
    if ("w" in props && "h" in props && typeof props.w === "number" && typeof props.h === "number")
      local = [
        { x: 0, y: 0 },
        { x: props.w, y: 0 },
        { x: 0, y: props.h },
        { x: props.w, y: props.h },
      ];
    else if (shape.type === "draw" || shape.type === "highlight")
      local = points(shape.props.segments).map((value) => ({
        x: value.x * shape.props.scale,
        y: value.y * shape.props.scale,
      }));
    else if (shape.type === "line" && shape.props.spline === "line")
      local = points(shape.props.points);
    else if (
      shape.type === "arrow" &&
      shape.props.bend === 0 &&
      !records.some((item) => item.typeName === "binding" && item.fromId === shape.id)
    )
      local = points([shape.props.start, shape.props.end]);
    const world = transform(shape);
    return box(local.map((value) => transformPoint(value, world)));
  };
  const selected = shapes.filter(
    (item) =>
      !collapsed(item.id) &&
      (!input.pageId || ancestry.get(item.id)?.pageId === input.pageId) &&
      (!input.recordIds || input.recordIds.includes(item.id)),
  );
  if (input.recordIds) {
    const priorities = new Map(input.recordIds.map((id, index) => [id, index]));
    selected.sort(
      (a, b) => (priorities.get(a.id) ?? Infinity) - (priorities.get(b.id) ?? Infinity),
    );
  } else if (input.priorityPageId)
    selected.sort(
      (a, b) =>
        Number(ancestry.get(b.id)?.pageId === input.priorityPageId) -
        Number(ancestry.get(a.id)?.pageId === input.priorityPageId),
    );
  const offset = input.offset ?? 0;
  const limit = Math.min(input.limit ?? 200, 200);
  const selectedIds = new Set<string>(selected.map((item) => item.id));
  const bindings = records
    .filter((item) => item.typeName === "binding")
    .filter(
      (item) =>
        !collapsed(item.fromId) &&
        ((!input.recordIds && !input.pageId) ||
          selectedIds.has(item.fromId) ||
          selectedIds.has(item.toId)),
    );
  if (input.priorityPageId) {
    const onPriorityPage = (id: string) => {
      const endpoint = byId.get(id);
      return (
        endpoint?.typeName === "shape" && ancestry.get(endpoint.id)?.pageId === input.priorityPageId
      );
    };
    bindings.sort(
      (a, b) =>
        Number(onPriorityPage(b.fromId) || onPriorityPage(b.toId)) -
        Number(onPriorityPage(a.fromId) || onPriorityPage(a.toId)),
    );
  }
  const selectedKeys =
    input.recordIds &&
    new Set(input.recordIds.flatMap((id) => compositions.compositionOf(id)?.key ?? []));
  const listed = compositions.summaries.filter(
    (item) =>
      (!input.pageId || item.pageId === input.pageId) &&
      (!selectedKeys || selectedKeys.has(item.key)) &&
      (!input.viewport || (item.bounds !== null && intersects(item.bounds, input.viewport))),
  );
  if (input.priorityPageId)
    listed.sort(
      (a, b) =>
        Number(b.pageId === input.priorityPageId) - Number(a.pageId === input.priorityPageId),
    );
  const pages = records.filter((item) => item.typeName === "page");
  return {
    revision,
    pages: pages.slice(0, 100).map((page) => ({
      id: page.id,
      name: page.name.slice(0, 256),
      shapeCount: shapes.filter((shape) => ancestry.get(shape.id)?.pageId === page.id).length,
    })),
    compositions: listed.slice(0, 100),
    shapes: selected.slice(offset, offset + limit).map((shape) => ({
      id: shape.id,
      pageId: ancestry.get(shape.id)?.pageId ?? shape.parentId,
      parentId: shape.parentId,
      type: shape.type,
      label: label("richText" in shape.props ? shape.props.richText : shape.props).slice(0, 256),
      bounds: bounds(shape),
      locked:
        shape.isLocked ||
        (ancestry.get(shape.id)?.shapes.some((parent) => parent.isLocked) ?? false),
    })),
    bindings: bindings
      .slice(offset, offset + limit)
      .map((item) => ({ id: item.id, type: item.type, fromId: item.fromId, toId: item.toId })),
    totalShapes: shapes.length,
    truncated:
      offset + limit < selected.length ||
      offset + limit < bindings.length ||
      listed.length > 100 ||
      pages.length > 100,
  } satisfies DiagramStructure;
}
