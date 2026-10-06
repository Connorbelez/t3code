import {
  toRichText,
  type TLArrowBinding,
  type TLArrowShape,
  type TLFrameShape,
  type TLGeoShape,
  type TLParentId,
  type TLRecord,
  type TLShape,
} from "@tldraw/tlschema";

import { compareIndex, originOf, pageIdOf, type RecordIndex, shapeOf } from "./canvas.ts";
import {
  encodeMeta,
  fingerprint,
  type FrameMeta,
  frameShapeId,
  memberBindingId,
  memberShapeId,
  META_KEY,
  type PartName,
  type StoredMember,
} from "./identity.ts";
import { indexBetween, indexesAbove, type IndexKey } from "./indexKeys.ts";
import { LOOKS } from "./kit.ts";
import type { Placement } from "./layout.ts";
import type { Decision } from "./merge.ts";
import type { CurrentComposition, CurrentMember } from "./membership.ts";
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
  const detached: TLRecord[] = [];
  for (const decision of decisions) {
    if (decision.do === "remove") {
      for (const record of partsInDeleteOrder(decision.current)) {
        deletes.push(record.id);
        final.delete(record.id);
      }
    } else if (decision.do === "detach") {
      for (const record of decision.current.parts.values()) {
        const { [META_KEY]: _dropped, ...meta } = record.meta;
        detached.push(remember({ ...record, meta }));
      }
    }
  }

  const written = decisions.flatMap((decision) =>
    decision.do === "create" || decision.do === "overwrite" ? [decision] : [],
  );
  const createdNodes = written.filter(
    (decision) => decision.do === "create" && decision.draft.spec.role === "node",
  ).length;
  const newIndexes = indexesAbove(maxChildIndex(final, frame.id), createdNodes).values();
  const nodes: TLShape[] = [];
  for (const decision of written) {
    const node = decision.draft.spec;
    const box = placement.nodes.get(node.key);
    if (node.role !== "node" || !box) continue;
    const kind = spec.kit.nodeKinds[node.kind];
    if (!kind) continue;
    const base = decision.do === "overwrite" ? mainShape(decision.current) : undefined;
    const index = base?.index ?? newIndexes.next().value;
    if (!index) continue;
    const record: TLGeoShape = {
      id: at(node.key, "main"),
      typeName: "shape",
      type: "geo",
      x: box.x,
      y: box.y,
      rotation: base?.rotation ?? 0,
      index,
      parentId: base?.parentId ?? frame.id,
      isLocked: base?.isLocked ?? false,
      opacity: base?.opacity ?? 1,
      meta: base?.meta ?? {},
      props: {
        geo: kind.geo,
        dash: kind.dash ?? look.dash,
        url: "",
        w: box.w,
        h: box.h,
        growY: 0,
        scale: 1,
        flipX: false,
        flipY: false,
        labelColor: "black",
        color: kind.color,
        fill: look.fill,
        size: "m",
        font: look.font,
        align: "middle",
        verticalAlign: "middle",
        richText: toRichText(node.label),
      },
    };
    nodes.push(remember(withPartMeta(record, spec.key, epoch, node, "main")));
  }
  // Relayout moves kept nodes; their content, size and parent stay as the canvas has them.
  for (const decision of decisions) {
    const box = placement.nodes.get(decision.key);
    const main =
      decision.do === "keep" && decision.current ? mainShape(decision.current) : undefined;
    if (box && main) nodes.push(remember({ ...main, x: box.x, y: box.y }));
  }

  const placeArrow = arrowPlacer(final);
  const arrows: TLArrowShape[] = [];
  const bindings: TLArrowBinding[] = [];
  for (const decision of written) {
    const edge = decision.draft.spec;
    if (edge.role !== "edge") continue;
    const start = shapeOf(final, at(edge.from, "main"));
    const end = shapeOf(final, at(edge.to, "main"));
    const kind = spec.kit.edgeKinds[edge.kind];
    if (!start || !end || !kind) continue;
    const id = at(edge.key, "main");
    const base = decision.do === "overwrite" ? mainShape(decision.current) : undefined;
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
        kind: spec.kit.arrowKind,
        labelColor: "black",
        color: kind.color,
        fill: "none",
        dash: kind.dash ?? look.dash,
        size: "m",
        arrowheadStart: kind.arrowheadStart,
        arrowheadEnd: kind.arrowheadEnd,
        font: look.font,
        start: { x: 0, y: 0 },
        end: { x: to.x - from.x, y: to.y - from.y },
        bend: 0,
        richText: toRichText(edge.label),
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

  return { puts: [frame, ...nodes, ...detached, ...arrows, ...bindings], deletes };
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
  const origin = originOf(final, shape.parentId);
  const size =
    shape.type === "geo"
      ? { w: shape.props.w, h: shape.props.h + shape.props.growY }
      : { w: 0, h: 0 };
  return { x: origin.x + shape.x + size.w / 2, y: origin.y + shape.y + size.h / 2 };
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
