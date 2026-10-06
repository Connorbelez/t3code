import {
  toRichText,
  type TLArrowBinding,
  type TLArrowShape,
  type TLFrameShape,
  type TLGeoShape,
  type TLGroupShape,
  type TLLineShape,
  type TLNoteShape,
  type TLParentId,
  type TLRecord,
  type TLShape,
  type TLTextShape,
} from "@tldraw/tlschema";

import type * as Schema from "effect/Schema";

import { compareIndex, originOf, pageBox, pageIdOf, type RecordIndex, shapeOf } from "./canvas.ts";
import {
  encodeMeta,
  isContent,
  fingerprint,
  type FrameMeta,
  frameShapeId,
  memberBindingId,
  memberShapeId,
  META_KEY,
  type PartName,
  type StoredMember,
} from "./identity.ts";
import { indexBetween, type IndexKey } from "./indexKeys.ts";
import {
  compartmentTexts,
  type CompartmentsKind,
  edgeKindOf,
  geoDrawing,
  LOOKS,
  type NodeKind,
  type Size,
} from "./kit.ts";
import { NOTE_SIZE, type Placement } from "./layout.ts";
import type { Decision } from "./merge.ts";
import { type CurrentComposition, type CurrentMember, topShape } from "./membership.ts";
import { CONTENT_KINDS } from "./screens.ts";
import type { ComposeSpec } from "./spec.ts";

/**
 * Decisions plus geometry to exact tldraw 5.5.2 records. `store.put` fills no defaults, so every
 * record is complete, and arrows sit where tldraw's `reparentArrow` would leave them.
 */

interface EmitInput {
  readonly spec: ComposeSpec;
  readonly epoch: number;
  readonly current: CurrentComposition | null;
  readonly decisions: readonly Decision[];
  readonly ledger: ReadonlyArray<readonly [string, string]>;
  readonly arrangements: ReadonlyArray<readonly [string, string]>;
  /** Screens whose contents were laid out again. */
  readonly arranged: ReadonlySet<string>;
  readonly placement: Placement;
  readonly index: RecordIndex;
}

/** Puts in tldraw-safe order (frame, nodes, arrows, bindings) and deletes. */
export function emit(input: EmitInput): { puts: TLRecord[]; deletes: string[] } {
  const { spec, epoch, current, decisions, placement, index } = input;
  const look = LOOKS[spec.kit.look];
  const at = (key: string, part: PartName) => memberShapeId(spec.key, epoch, key, part);
  const final = new Map(index);
  const remember = <T extends TLRecord>(record: T): T => {
    final.set(record.id, record);
    return record;
  };

  const frameMeta: FrameMeta = {
    v: 1,
    c: spec.key,
    e: epoch,
    kit: spec.kit.name,
    title: spec.title,
    direction: spec.direction,
    ledger: input.ledger,
    ...(input.arrangements.length > 0 ? { arrangements: input.arrangements } : {}),
  };
  const frameSize = { w: placement.frame.w, h: placement.frame.h, name: spec.title };
  const frame = remember<TLFrameShape>(
    current
      ? {
          ...current.frame,
          props: { ...current.frame.props, ...frameSize },
          meta: { ...current.frame.meta, [META_KEY]: encodeMeta(frameMeta) },
        }
      : {
          id: frameShapeId(spec.key, epoch),
          typeName: "shape",
          type: "frame",
          x: placement.frame.x,
          y: placement.frame.y,
          rotation: 0,
          index: indexBetween(maxChildIndex(final, placement.pageId), null),
          parentId: placement.pageId,
          isLocked: false,
          opacity: 1,
          meta: { [META_KEY]: encodeMeta(frameMeta) },
          props: { ...frameSize, color: "black" },
        },
  );

  const deletes: string[] = [];
  for (const decision of decisions) {
    if (decision.do !== "remove") continue;
    for (const record of partsInDeleteOrder(decision.current)) {
      deletes.push(record.id);
      final.delete(record.id);
    }
  }

  const written = decisions.flatMap((decision) =>
    decision.do === "create" || decision.do === "overwrite" ? [decision] : [],
  );
  const lastIndex = new Map<string, IndexKey | null>();
  /** New children go above everything already in their parent, in member order. */
  const nextIndex = (parentId: string): IndexKey => {
    const index = indexBetween(lastIndex.get(parentId) ?? maxChildIndex(final, parentId), null);
    lastIndex.set(parentId, index);
    return index;
  };
  const shapeIdOf = (key: string | null) => (key === null ? frame.id : at(key, "main"));
  const nodes: TLShape[] = [];
  // Boundaries before what they hold, so every parent exists when its children are placed.
  const parents = new Map(spec.nodes.map((node) => [node.key, node.parent]));
  const depthOf = (key: string): number => {
    let depth = 0;
    for (let parent = parents.get(key); parent; parent = parents.get(parent)) depth++;
    return depth;
  };
  const writtenNodes = written
    .flatMap((decision) => {
      const node = decision.draft.spec;
      return node.role === "node" && !isContent(node)
        ? [{ decision, node, depth: depthOf(node.key) }]
        : [];
    })
    .sort((a, b) => a.depth - b.depth);
  for (const { decision, node } of writtenNodes) {
    const box = placement.nodes.get(node.key);
    const kind = spec.kit.nodeKinds[node.kind];
    if (!box || !kind) continue;
    const base = decision.do === "overwrite" ? topShape(decision.current) : undefined;
    const moved = placement.parents.get(node.key);
    const parentId = moved === undefined ? (base?.parentId ?? frame.id) : shapeIdOf(moved);
    const shape = {
      id: at(node.key, "main"),
      typeName: "shape",
      x: box.x,
      y: box.y,
      rotation: base?.rotation ?? 0,
      index: base?.parentId === parentId ? base.index : nextIndex(parentId),
      parentId,
      isLocked: base?.isLocked ?? false,
      opacity: base?.opacity ?? 1,
      meta: base?.meta ?? {},
    } as const;
    if (kind.shape === "compartments") {
      // The group places the node; the header box spans it and each compartment covers one band.
      const group = { ...shape, id: at(node.key, "group"), type: "group", props: {} } as const;
      nodes.push(remember(withPartMeta<TLGroupShape>(group, spec.key, epoch, node, "group")));
      const rows = placement.rows.get(node.key) ?? [];
      let y = 0;
      let index: IndexKey | null = null;
      for (const [i, text] of compartmentTexts(kind, node.label, node.body).entries()) {
        const part = i === 0 ? "main" : (`c${i}` as const);
        const prior = decision.do === "overwrite" ? decision.current.parts.get(part) : undefined;
        index = indexBetween(index, null);
        const geo: TLGeoShape = {
          id: at(node.key, part),
          typeName: "shape",
          type: "geo",
          x: 0,
          y,
          rotation: 0,
          index,
          parentId: group.id,
          isLocked: false,
          opacity: 1,
          meta: prior?.meta ?? {},
          props: {
            geo: "rectangle",
            dash: look.dash,
            url: "",
            w: box.w,
            h: i === 0 ? box.h : (rows[i] ?? 0),
            growY: 0,
            scale: 1,
            flipX: false,
            flipY: false,
            labelColor: "black",
            color: kind.color,
            fill: i === 0 ? look.fill : "none",
            size: i === 0 ? "m" : "s",
            font: look.font,
            align: i === 0 ? "middle" : "start",
            verticalAlign: "start",
            richText: toRichText(text),
          },
        };
        y += rows[i] ?? 0;
        nodes.push(remember(withPartMeta(geo, spec.key, epoch, node, part)));
      }
      continue;
    }
    const record = drawNode(kind, node.label, node.body, box, look, shape);
    nodes.push(remember(withPartMeta(record, spec.key, epoch, node, "main")));
  }
  // Relayout moves kept nodes, back into their boundary; a kept boundary also takes its new size
  // to hold its children. Size is not content, so neither makes a member edited.
  for (const decision of decisions) {
    const box = placement.nodes.get(decision.key);
    const top = decision.do === "keep" && decision.current ? topShape(decision.current) : undefined;
    if (
      !box ||
      !top ||
      (decision.do === "keep" && decision.current && isContent(decision.current.stored))
    )
      continue;
    const moved = placement.parents.get(decision.key);
    const parentId = moved === undefined ? top.parentId : shapeIdOf(moved);
    const index = parentId === top.parentId ? top.index : nextIndex(parentId);
    const record = { ...top, x: box.x, y: box.y, parentId, index };
    nodes.push(remember(record.type === "frame" ? resized(record, box) : record));
  }

  // An arranged screen's contents take new boxes, and indexes in member order so stacking follows
  // the spec: screen parts under elements, a card under what it holds.
  const decided = new Map(decisions.map((decision) => [decision.key, decision]));
  for (const screen of input.arranged) {
    const contents = spec.contents.get(screen);
    if (!contents) continue;
    const parentId = at(screen, "main");
    let order: IndexKey | null = null;
    for (const node of contents.members) {
      order = indexBetween(order, null);
      const box = placement.nodes.get(node.key);
      const decision = decided.get(node.key);
      const kind = CONTENT_KINDS[node.kind];
      if (!box || !decision || !kind) continue;
      const placed = { x: box.x, y: box.y, parentId, index: order };
      if (decision.do === "create" || decision.do === "overwrite") {
        const base = decision.do === "overwrite" ? mainShape(decision.current) : undefined;
        const record = drawNode(kind, node.label, null, box, look, {
          id: at(node.key, "main"),
          typeName: "shape",
          rotation: base?.rotation ?? 0,
          isLocked: base?.isLocked ?? false,
          opacity: base?.opacity ?? 1,
          meta: base?.meta ?? {},
          ...placed,
        });
        nodes.push(remember(withPartMeta(record, spec.key, epoch, node, "main")));
      } else if (decision.do === "keep" && decision.current) {
        const main = mainShape(decision.current);
        if (main) nodes.push(remember(resized({ ...main, ...placed }, box)));
      }
    }
  }

  const placeArrow = arrowPlacer(final);
  const arrows: TLArrowShape[] = [];
  const bindings: TLArrowBinding[] = [];
  for (const decision of written) {
    const edge = decision.draft.spec;
    if (edge.role !== "edge") continue;
    const start = shapeOf(final, at(edge.from, "main"));
    const end = shapeOf(final, at(edge.to, "main"));
    const kind = edgeKindOf(spec.kit, edge.kind);
    if (!start || !end || !kind) continue;
    const id = at(edge.key, "main");
    const base = decision.do === "overwrite" ? mainShape(decision.current) : undefined;
    const drawing = kind.draw && edge.body ? kind.draw(edge.label, edge.body) : null;
    const parentId = arrowParent(final, start, end);
    const index = placeArrow(
      id,
      parentId,
      start,
      end,
      base?.parentId === parentId ? base.index : null,
    );
    const origin = originOf(final, parentId);
    const from = center(final, start);
    const to = center(final, end);
    const arrow: TLArrowShape = {
      id,
      typeName: "shape",
      type: "arrow",
      x: from.x - origin.x,
      y: from.y - origin.y,
      rotation: 0,
      index,
      parentId,
      isLocked: base?.isLocked ?? false,
      opacity: base?.opacity ?? 1,
      meta: base?.meta ?? {},
      props: {
        kind: kind.arrowKind ?? spec.kit.arrowKind,
        labelColor: "black",
        color: kind.color,
        fill: kind.fill ?? "none",
        dash: kind.dash ?? look.dash,
        size: "m",
        arrowheadStart: kind.arrowheadStart,
        arrowheadEnd: drawing?.arrowheadEnd ?? kind.arrowheadEnd,
        font: look.font,
        start: { x: 0, y: 0 },
        end: { x: to.x - from.x, y: to.y - from.y },
        bend: 0,
        richText: toRichText(drawing?.label ?? edge.label),
        labelPosition: 0.5,
        scale: 1,
        elbowMidPoint: 0.5,
      },
    };
    arrows.push(remember(withPartMeta(arrow, spec.key, epoch, edge, "main")));
    for (const terminal of ["start", "end"] as const) {
      const binding: TLArrowBinding = {
        id: memberBindingId(spec.key, epoch, edge.key, terminal),
        typeName: "binding",
        type: "arrow",
        fromId: id,
        toId: terminal === "start" ? start.id : end.id,
        meta: {},
        props: {
          terminal,
          normalizedAnchor: { x: 0.5, y: 0.5 },
          isExact: false,
          isPrecise: false,
          snap: "none",
        },
      };
      bindings.push(remember(withPartMeta(binding, spec.key, epoch, edge, terminal)));
    }
  }

  return { puts: [frame, ...nodes, ...arrows, ...bindings], deletes };
}

/**
 * The composition ends. Remove deletes every member part, then the frame; detach strips the
 * composition meta from all of them and leaves everything else exactly as it is.
 */
export function emitRelease(
  kind: "remove" | "detach",
  current: CurrentComposition,
  decisions: readonly Decision[],
): { puts: TLRecord[]; deletes: string[] } {
  if (kind === "remove") {
    const parts = decisions.flatMap((decision) =>
      decision.do === "remove" ? partsInDeleteOrder(decision.current) : [],
    );
    return { puts: [], deletes: [...parts.map((record) => record.id), current.frame.id] };
  }
  const parts = decisions.flatMap((decision) =>
    decision.do === "detach" ? Array.from(decision.current.parts.values()) : [],
  );
  return { puts: [current.frame, ...parts].map(withoutCompositionMeta), deletes: [] };
}

function withoutCompositionMeta<T extends TLRecord>(record: T): T {
  const { [META_KEY]: _dropped, ...meta } = record.meta;
  return { ...record, meta };
}

type ShapeBase = Omit<TLGeoShape, "type" | "props">;
type Look = (typeof LOOKS)[keyof typeof LOOKS];

/** The complete record tldraw stores for a node of this kind. */
function drawNode(
  kind: Exclude<NodeKind, CompartmentsKind>,
  label: string,
  body: Schema.JsonObject | null,
  box: Size,
  look: Look,
  base: ShapeBase,
): TLShape {
  switch (kind.shape) {
    case "geo": {
      const drawing = geoDrawing(kind, label, body);
      return {
        ...base,
        type: "geo",
        props: {
          geo: kind.geo,
          dash: drawing.dash ?? look.dash,
          url: "",
          w: box.w,
          h: box.h,
          growY: 0,
          scale: 1,
          flipX: false,
          flipY: false,
          labelColor: kind.labelColor ?? "black",
          color: drawing.color,
          fill: kind.fill ?? look.fill,
          size: kind.size ?? "m",
          font: look.font,
          align: kind.align ?? "middle",
          verticalAlign: "middle",
          richText: toRichText(drawing.label),
        },
      } satisfies TLGeoShape;
    }
    case "frame":
    case "screen":
      return {
        ...base,
        type: "frame",
        props: { w: box.w, h: box.h, name: label, color: "black" },
      } satisfies TLFrameShape;
    case "note":
      return {
        ...base,
        type: "note",
        props: {
          color: kind.color,
          richText: toRichText(label),
          size: "m",
          font: look.font,
          align: "middle",
          verticalAlign: "middle",
          labelColor: "black",
          growY: box.h - NOTE_SIZE,
          fontSizeAdjustment: 1,
          url: "",
          scale: 1,
          textLastEditedBy: null,
        },
      } satisfies TLNoteShape;
    case "text":
      return {
        ...base,
        type: "text",
        props: {
          color: kind.color,
          size: kind.size,
          w: box.w,
          font: look.font,
          textAlign: "start",
          autoSize: false,
          scale: 1,
          richText: toRichText(label),
        },
      } satisfies TLTextShape;
    case "line":
      return {
        ...base,
        type: "line",
        props: {
          color: kind.color,
          dash: look.dash,
          size: "s",
          spline: "line",
          scale: 1,
          points: linePoints(box.w),
        },
      } satisfies TLLineShape;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/** A horizontal line from the shape's origin, `w` long. */
function linePoints(w: number): TLLineShape["props"]["points"] {
  const start = indexBetween(null, null);
  const end = indexBetween(start, null);
  return {
    [start]: { id: start, index: start, x: 0, y: 0 },
    [end]: { id: end, index: end, x: w, y: 0 },
  };
}

/** The shape with its geometry props set to fill `box`; size is layout, not content. */
function resized(shape: TLShape, box: Size): TLShape {
  switch (shape.type) {
    case "geo":
      return { ...shape, props: { ...shape.props, w: box.w, h: box.h, growY: 0 } };
    case "frame":
      return { ...shape, props: { ...shape.props, w: box.w, h: box.h } };
    case "text":
      return { ...shape, props: { ...shape.props, w: box.w } };
    case "line":
      return { ...shape, props: { ...shape.props, points: linePoints(box.w) } };
    default:
      return shape;
  }
}

function withPartMeta<T extends TLRecord>(
  record: T,
  c: string,
  e: number,
  member: StoredMember,
  p: PartName,
): T {
  const meta = encodeMeta({
    v: 1,
    c,
    e,
    m: member.key,
    p,
    f: fingerprint(record),
    ...(p === "main" ? { spec: member } : {}),
  });
  return { ...record, meta: { ...record.meta, [META_KEY]: meta } };
}

function mainShape(member: CurrentMember): TLShape | undefined {
  const main = member.parts.get("main");
  return main?.typeName === "shape" ? main : undefined;
}

/** Bindings before arrows before nodes, so nothing is isolated by a delete still to come. */
function partsInDeleteOrder(member: CurrentMember): TLRecord[] {
  const rank = (record: TLRecord) => (record.typeName === "binding" ? 0 : 1);
  return Array.from(member.parts.values()).sort((a, b) => rank(a) - rank(b));
}

function maxChildIndex(final: RecordIndex, parentId: string): string | null {
  let max: string | null = null;
  for (const record of final.values()) {
    if (
      record.typeName === "shape" &&
      record.parentId === parentId &&
      (max === null || record.index > max)
    ) {
      max = record.index;
    }
  }
  return max;
}

function center(final: RecordIndex, shape: TLShape): { x: number; y: number } {
  const box = pageBox(final, shape);
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

function hasAncestor(final: RecordIndex, shape: TLShape, ancestorId: string): boolean {
  for (
    let parent = shapeOf(final, shape.parentId);
    parent;
    parent = shapeOf(final, parent.parentId)
  ) {
    if (parent.id === ancestorId) return true;
  }
  return false;
}

/**
 * tldraw's parent for an arrow bound at both ends: the endpoint frame that contains the other,
 * else the nearest common ancestor shape, else the page.
 */
function arrowParent(final: RecordIndex, start: TLShape, end: TLShape): TLParentId {
  const container =
    start.id === end.id
      ? start
      : hasAncestor(final, start, end.id)
        ? end
        : hasAncestor(final, end, start.id)
          ? start
          : undefined;
  if (container?.type === "frame") return container.id;
  for (
    let parent = shapeOf(final, start.parentId);
    parent;
    parent = shapeOf(final, parent.parentId)
  ) {
    if (hasAncestor(final, end, parent.id)) return parent.id;
  }
  return pageIdOf(final, start) ?? start.parentId;
}

interface Sibling {
  readonly id: string;
  readonly index: IndexKey;
  readonly arrow: boolean;
}

/**
 * An arrow must sit above the higher of its endpoints (or their ancestors under its parent) and
 * below the next non-arrow sibling; otherwise tldraw re-indexes it on put. Arrows sharing a gap
 * keep spec order. Sibling lists are cached per parent and updated as arrows are placed.
 */
function arrowPlacer(final: RecordIndex) {
  const byParent = new Map<string, Sibling[]>();
  const siblingsOf = (parentId: string): Sibling[] => {
    const cached = byParent.get(parentId);
    if (cached) return cached;
    const list: Sibling[] = [];
    for (const record of final.values()) {
      if (record.typeName === "shape" && record.parentId === parentId) {
        list.push({ id: record.id, index: record.index, arrow: record.type === "arrow" });
      }
    }
    return list.sort(bySiblingOrder);
  };
  /** The endpoint itself or its ancestor whose parent is `parentId`. */
  const under = (shape: TLShape, parentId: string): TLShape | undefined => {
    for (let at: TLShape | undefined = shape; at; at = shapeOf(final, at.parentId)) {
      if (at.parentId === parentId) return at;
    }
    return undefined;
  };

  return (
    id: string,
    parentId: string,
    start: TLShape,
    end: TLShape,
    keep: IndexKey | null,
  ): IndexKey => {
    const list = siblingsOf(parentId).filter((sibling) => sibling.id !== id);
    const ends = [under(start, parentId), under(end, parentId)].flatMap((shape) =>
      shape ? [list.findIndex((sibling) => sibling.id === shape.id)] : [],
    );
    let slot = ends.length > 0 ? Math.max(...ends) : list.length - 1;
    const low = list[slot]?.index ?? null;
    const nextNonArrow = list.slice(slot + 1).find((sibling) => !sibling.arrow);
    const fits =
      keep !== null && (low === null || keep > low) && (!nextNonArrow || keep < nextNonArrow.index);
    let index = keep;
    if (!fits || index === null) {
      while (list[slot + 1]?.arrow) slot++;
      index = indexBetween(list[slot]?.index ?? null, list[slot + 1]?.index ?? null);
    }
    list.push({ id, index, arrow: true });
    byParent.set(parentId, list.sort(bySiblingOrder));
    return index;
  };
}

function bySiblingOrder(a: Sibling, b: Sibling): number {
  return compareIndex(a.index, b.index) || compareIndex(a.id, b.id);
}
