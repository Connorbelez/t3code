import type { DiagramBounds } from "@t3tools/contracts";
import type { TLPage, TLParentId, TLRecord, TLShape } from "@tldraw/tlschema";

/**
 * Read-only geometry over document records. Rotation is ignored: these bounds place new content and
 * summarize compositions, they never feed tldraw.
 */

export type RecordIndex = ReadonlyMap<string, TLRecord>;

export function indexRecords(records: Iterable<TLRecord>): Map<string, TLRecord> {
  return new Map(Array.from(records, (record) => [record.id, record]));
}

export function shapeOf(index: RecordIndex, id: string): TLShape | undefined {
  const record = index.get(id);
  return record?.typeName === "shape" ? record : undefined;
}

export function pagesInOrder(index: RecordIndex): TLPage[] {
  const pages: TLPage[] = [];
  for (const record of index.values()) if (record.typeName === "page") pages.push(record);
  return pages.sort((a, b) => compareIndex(a.index, b.index) || compareIndex(a.id, b.id));
}

export function compareIndex(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function pageIdOf(index: RecordIndex, shape: TLShape): TLParentId | null {
  let parentId = shape.parentId;
  for (let depth = 0; depth < 1000; depth++) {
    if (parentId.startsWith("page:")) return parentId;
    const parent = shapeOf(index, parentId);
    if (!parent) return null;
    parentId = parent.parentId;
  }
  return null;
}

/** Page-space position of a parent's origin; a page's is zero. */
export function originOf(index: RecordIndex, parentId: string): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (let shape = shapeOf(index, parentId); shape; shape = shapeOf(index, shape.parentId)) {
    x += shape.x;
    y += shape.y;
  }
  return { x, y };
}

/** Shape-local box: arrows span their terminals, sized shapes their props, anything else is a point. */
export function localBox(shape: TLShape): DiagramBounds {
  if (shape.type === "arrow") {
    const { start, end } = shape.props;
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    return { x, y, w: Math.max(start.x, end.x) - x, h: Math.max(start.y, end.y) - y };
  }
  if (shape.type === "note") {
    return {
      x: 0,
      y: 0,
      w: 200 * shape.props.scale,
      h: 200 * shape.props.scale + shape.props.growY,
    };
  }
  if (shape.type === "line") {
    const points = Object.values(shape.props.points);
    if (points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  const props = shape.props;
  if ("w" in props && "h" in props) {
    const growY = "growY" in props ? props.growY : 0;
    return { x: 0, y: 0, w: props.w, h: props.h + growY };
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

export function pageBox(index: RecordIndex, shape: TLShape): DiagramBounds {
  const origin = originOf(index, shape.parentId);
  const box = localBox(shape);
  return { x: origin.x + shape.x + box.x, y: origin.y + shape.y + box.y, w: box.w, h: box.h };
}

export function unionOf(boxes: Iterable<DiagramBounds>): DiagramBounds | null {
  let union: DiagramBounds | null = null;
  for (const box of boxes) {
    if (!union) {
      union = box;
      continue;
    }
    const x = Math.min(union.x, box.x);
    const y = Math.min(union.y, box.y);
    union = {
      x,
      y,
      w: Math.max(union.x + union.w, box.x + box.w) - x,
      h: Math.max(union.y + union.h, box.y + box.h) - y,
    };
  }
  return union;
}
