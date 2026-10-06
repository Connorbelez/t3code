import { DiagramOperationError, type DiagramLayoutDirection } from "@t3tools/contracts";
import type { TLParentId } from "@tldraw/tlschema";
import type { ELK, ElkNode } from "elkjs/lib/elk-api.js";

import { localBox, pageBox, pagesInOrder, type RecordIndex, unionOf } from "./canvas.ts";
import type { StoredNode } from "./identity.ts";
import {
  type CompartmentsKind,
  compartmentTexts,
  type GeoKind,
  geoDrawing,
  LOOKS,
  type Size,
} from "./kit.ts";
import type { Decision } from "./merge.ts";
import { type CurrentComposition, topShape } from "./membership.ts";
import { listOf, type ComposeSpec } from "./spec.ts";

/** Geometry the pipeline owns: node sizes from measured labels and layered positions from ELK. */

export interface TextFont {
  readonly family: "sans" | "draw";
  readonly fontSize: number;
  readonly maxWidth: number | null;
}

export type MeasureText = (text: string, font: TextFont) => Size;

interface Box extends Size {
  readonly x: number;
  readonly y: number;
}

/** tldraw's geo and note label: base font size 16 scaled for size `m`, inside 16px of padding per side. */
const LABEL_FONT_SIZE_M = 16 * 1.375;
const LABEL_FONT_SIZE_S = 16 * 1.125;
const LABEL_PADDING = 16;
const LABEL_MAX_WIDTH = 240;
/** tldraw notes are a fixed 200px square that grows down to fit its text. */
export const NOTE_SIZE = 200;
const GRID = 8;
const FRAME_PADDING = 48;
/** Inside a boundary; its title sits above the frame, outside it. */
const BOUNDARY_PADDING = 32;
const EMPTY_BOUNDARY: Size = { w: 160, h: 96 };
/** Space between a new composition and the content to its left. */
const PLACEMENT_GAP = 160;

/** Rounded up to the grid so sub-pixel font differences between hosts rarely change a size. */
function geoSize(
  kind: GeoKind,
  label: string,
  family: TextFont["family"],
  measure: MeasureText,
): Size {
  const text =
    label.trim() === ""
      ? { w: 0, h: 0 }
      : measure(label, { family, fontSize: LABEL_FONT_SIZE_M, maxWidth: LABEL_MAX_WIDTH });
  const room = kind.labelRoom ?? 1;
  return {
    w: snap(Math.max(kind.minSize.w, (text.w + 2 * LABEL_PADDING) * room)),
    h: snap(Math.max(kind.minSize.h, (text.h + 2 * LABEL_PADDING) * room)),
  };
}

/** The height tldraw's note gives its label, so a later human edit does not make it jump. */
function noteSize(label: string, family: TextFont["family"], measure: MeasureText): Size {
  if (label.trim() === "") return { w: NOTE_SIZE, h: NOTE_SIZE };
  // tldraw leaves a pixel of slack inside the padding.
  const maxWidth = NOTE_SIZE - 2 * LABEL_PADDING - 1;
  const text = measure(label, { family, fontSize: LABEL_FONT_SIZE_M, maxWidth });
  return { w: NOTE_SIZE, h: Math.max(NOTE_SIZE, Math.ceil(text.h + 2 * LABEL_PADDING)) };
}

/** Compartment text wraps past this width, so one long signature does not stretch the node. */
const COMPARTMENT_MAX_WIDTH = 480;
const COMPARTMENTS_MIN_WIDTH = 160;
/** An empty compartment still shows as a band. */
const EMPTY_COMPARTMENT = 24;

/**
 * Header text at size `m` and compartments at size `s`, each row tall enough that tldraw never
 * grows it; the rows stack into the node's height.
 */
function compartmentsSize(
  kind: CompartmentsKind,
  node: StoredNode,
  family: TextFont["family"],
  measure: MeasureText,
): { readonly size: Size; readonly rows: readonly number[] } {
  const texts = compartmentTexts(kind, node.label, node.body).map((text, i) =>
    text.trim() === ""
      ? null
      : measure(text, {
          family,
          fontSize: i === 0 ? LABEL_FONT_SIZE_M : LABEL_FONT_SIZE_S,
          maxWidth: COMPARTMENT_MAX_WIDTH,
        }),
  );
  const rows = texts.map((text) => (text ? snap(text.h + 2 * LABEL_PADDING) : EMPTY_COMPARTMENT));
  const w = snap(
    Math.max(COMPARTMENTS_MIN_WIDTH, ...texts.map((text) => (text?.w ?? 0) + 2 * LABEL_PADDING)),
  );
  return { size: { w, h: rows.reduce((sum, row) => sum + row, 0) }, rows };
}

function snap(value: number): number {
  return Math.ceil(value / GRID) * GRID;
}

const ELK_DIRECTIONS = { down: "DOWN", right: "RIGHT", up: "UP", left: "LEFT" } as const;

interface LayeredNode {
  readonly key: string;
  /** A boundary's key, or null for the composition frame. */
  readonly parent: string | null;
  /** Null for a boundary, which ELK sizes around its children. */
  readonly size: Size | null;
}

/**
 * Parent-relative boxes, boundaries sized around their children. Deterministic: fixed seed, input
 * in spec order, model order respected, coordinates rounded.
 */
async function layoutLayered(
  nodes: readonly LayeredNode[],
  edges: ReadonlyArray<readonly [string, string]>,
  direction: DiagramLayoutDirection,
): Promise<Map<string, Box>> {
  // CommonJS: Node and Vite both resolve the default import to the constructor, but NodeNext and
  // Bundler type resolution disagree about it.
  const { default: Elk } = (await import("elkjs/lib/elk.bundled.js")) as unknown as {
    default: new () => ELK;
  };
  const children = new Map<string | null, LayeredNode[]>();
  for (const node of nodes) children.set(node.parent, [...(children.get(node.parent) ?? []), node]);
  const nested = nodes.some((node) => node.parent !== null);
  const options = (padding: number) => ({
    "elk.algorithm": "layered",
    "elk.direction": ELK_DIRECTIONS[direction],
    "elk.randomSeed": "1",
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.spacing.nodeNode": "48",
    "elk.layered.spacing.nodeNodeBetweenLayers": "72",
    // Edges pointing back in spec order are the loops, as a reader of the spec expects. ELK 0.12
    // crashes on any model-order option across a hierarchy, so nested graphs break cycles
    // depth-first from the first node, which also follows spec order.
    "elk.layered.considerModelOrder.strategy": nested ? "NONE" : "NODES_AND_EDGES",
    "elk.layered.cycleBreaking.strategy": nested ? "DEPTH_FIRST" : "MODEL_ORDER",
    "elk.padding": `[top=${padding},left=${padding},bottom=${padding},right=${padding}]`,
  });
  const toElk = (node: LayeredNode): ElkNode => {
    const inner = children.get(node.key) ?? [];
    if (inner.length === 0) {
      const size = node.size ?? EMPTY_BOUNDARY;
      return { id: node.key, width: size.w, height: size.h };
    }
    return { id: node.key, layoutOptions: options(BOUNDARY_PADDING), children: inner.map(toElk) };
  };
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      ...options(FRAME_PADDING),
      ...(nested ? { "elk.hierarchyHandling": "INCLUDE_CHILDREN" } : {}),
    },
    children: (children.get(null) ?? []).map(toElk),
    edges: edges.map(([from, to], i) => ({ id: `e${i}`, sources: [from], targets: [to] })),
  };
  const laid = await new Elk().layout(graph);
  const boxes = new Map<string, Box>();
  const collect = (node: ElkNode) => {
    for (const child of node.children ?? []) {
      boxes.set(child.id, {
        x: Math.round(child.x ?? 0),
        y: Math.round(child.y ?? 0),
        w: Math.ceil(child.width ?? 0),
        h: Math.ceil(child.height ?? 0),
      });
      collect(child);
    }
  };
  collect(laid);
  return boxes;
}

export interface Placement {
  readonly pageId: TLParentId;
  /** Page-space for a new frame; an existing frame keeps its position and only grows. */
  readonly frame: Box;
  /**
   * Boxes of the nodes this compose writes or moves, in the coordinates of each node's parent:
   * its boundary (or the frame) when placed, its current parent otherwise. Kept nodes appear only
   * when relaid out, and kept boundaries also when they grow to hold their children.
   */
  readonly nodes: ReadonlyMap<string, Box>;
  /**
   * Where placed nodes go: a boundary's key, or null for the composition frame. Every other node
   * stays in whatever frame it is in now, wherever a human dragged it.
   */
  readonly parents: ReadonlyMap<string, string | null>;
  /** Header and compartment heights, top to bottom, of the compartments nodes this compose writes. */
  readonly rows: ReadonlyMap<string, readonly number[]>;
}

/**
 * Existing nodes stay where they are and are obstacles for new ones in the same boundary;
 * `relayout` lays out every node from scratch, back inside the boundary its spec names. Nodes the
 * spec moves to another boundary are placed like new ones. Each boundary, and the frame, works in
 * its own coordinates and grows to hold what is inside it. ELK loads only when something needs
 * placing.
 */
export async function place(
  spec: ComposeSpec,
  decisions: readonly Decision[],
  current: CurrentComposition | null,
  index: RecordIndex,
  measure: MeasureText,
  relayout: boolean,
): Promise<Placement> {
  const family = LOOKS[spec.kit.look].font;
  const sizes = new Map<string, Size>();
  const rows = new Map<string, readonly number[]>();
  /** Parent-relative boxes of nodes on the canvas, with their canvas size. */
  const canvas = new Map<string, Box & { readonly parentId: string }>();
  const written = new Set<string>();
  const moved = new Set<string>();
  for (const decision of decisions) {
    if (decision.do === "create" || decision.do === "overwrite") {
      const node = decision.draft.spec;
      if (node.role !== "node") continue;
      written.add(node.key);
      const kind = spec.kit.nodeKinds[node.kind];
      if (kind?.shape === "geo")
        sizes.set(
          node.key,
          geoSize(kind, geoDrawing(kind, node.label, node.body).label, family, measure),
        );
      if (kind?.shape === "note") sizes.set(node.key, noteSize(node.label, family, measure));
      if (kind?.shape === "compartments") {
        const measured = compartmentsSize(kind, node, family, measure);
        sizes.set(node.key, measured.size);
        rows.set(node.key, measured.rows);
      }
      const stored = decision.do === "overwrite" ? decision.current.stored : null;
      if (stored?.role === "node" && stored.parent !== node.parent) moved.add(node.key);
    }
    const member = decision.do === "keep" || decision.do === "overwrite" ? decision.current : null;
    const shape = member?.parts.get("main");
    const top = member && topShape(member);
    if (shape?.typeName === "shape" && top && member?.stored.role === "node") {
      // A compartments node's header box spans it, inside the group that places it.
      const box = localBox(shape);
      canvas.set(decision.key, { x: top.x, y: top.y, w: box.w, h: box.h, parentId: top.parentId });
    }
  }
  const sizeOf = (key: string): Size | undefined => sizes.get(key) ?? canvas.get(key);
  const kinds = new Map(spec.nodes.map((node) => [node.key, node.kind]));
  const isBoundary = (key: string) => spec.kit.nodeKinds[kinds.get(key) ?? ""]?.shape === "frame";

  const present = spec.nodes.flatMap((node) =>
    written.has(node.key) || canvas.has(node.key) ? [node.key] : [],
  );
  const presentKeys = new Set(present);
  const specParents = new Map(spec.nodes.map((node) => [node.key, node.parent]));
  // A boundary a human deleted is gone, so its children fall back to the next boundary up.
  // Validation rules out parent loops.
  const scopeOf = (key: string): string | null => {
    let parent = specParents.get(key) ?? null;
    while (parent !== null && !presentKeys.has(parent)) parent = specParents.get(parent) ?? null;
    return parent;
  };

  const nodes = new Map<string, Box>();
  const parents = new Map<string, string | null>();
  const keyOfShape = new Map<string | undefined, string>(
    Array.from(canvas.keys(), (key) => [current?.members.get(key)?.parts.get("main")?.id, key]),
  );
  /**
   * The boundary a node sits in after this compose: null for the composition frame, undefined
   * when a human dragged it out of the composition.
   */
  const hostOf = (key: string): string | null | undefined => {
    if (parents.has(key)) return parents.get(key);
    const parentId = canvas.get(key)?.parentId;
    if (parentId === undefined) return undefined;
    return parentId === current?.frame.id ? null : keyOfShape.get(parentId);
  };

  const laid = present.filter((key) => relayout || !canvas.has(key) || moved.has(key));
  if (laid.length > 0) {
    const links = spec.edges.flatMap((edge): [string, string][] =>
      presentKeys.has(edge.from) && presentKeys.has(edge.to) ? [[edge.from, edge.to]] : [],
    );
    const holders = new Set(present.map(scopeOf));
    const elk = await layoutLayered(
      present.map((key) => ({
        key,
        parent: scopeOf(key),
        size: isBoundary(key) && holders.has(key) ? null : (sizeOf(key) ?? EMPTY_BOUNDARY),
      })),
      links,
      spec.direction,
    );
    if (relayout) {
      for (const key of present) {
        const box = elk.get(key);
        if (!box) continue;
        const size = isBoundary(key) ? box : (sizeOf(key) ?? box);
        nodes.set(key, { x: box.x, y: box.y, w: size.w, h: size.h });
        parents.set(key, scopeOf(key));
      }
    } else {
      // Each boundary is its own coordinate space, so new nodes are fitted per boundary.
      for (const scope of new Set(laid.map(scopeOf))) {
        const inScope = new Set(present.filter((key) => scopeOf(key) === scope));
        const fixed = new Map<string, Box>();
        for (const [key, box] of canvas) {
          if (moved.has(key) || hostOf(key) !== scope) continue;
          const size = isBoundary(key) ? box : (sizeOf(key) ?? box);
          fixed.set(key, { x: box.x, y: box.y, w: size.w, h: size.h });
        }
        const placed = placeAround({
          added: laid.filter((key) => scopeOf(key) === scope),
          elk: new Map(
            Array.from(inScope).flatMap((key): [string, Box][] => {
              const box = elk.get(key);
              return box ? [[key, box]] : [];
            }),
          ),
          fixed,
          links: links.filter(([from, to]) => inScope.has(from) && inScope.has(to)),
          direction: spec.direction,
          padding: scope === null ? FRAME_PADDING : BOUNDARY_PADDING,
        });
        for (const [key, box] of placed) {
          nodes.set(key, box);
          parents.set(key, scope);
        }
      }
    }
  }
  // Rewritten content keeps its top-left and takes its new size.
  for (const [key, size] of sizes) {
    const at = canvas.get(key);
    if (at && !nodes.has(key)) nodes.set(key, { x: at.x, y: at.y, ...size });
  }

  const boxOf = (key: string): Box | undefined => {
    const box = nodes.get(key);
    if (box) return box;
    const at = canvas.get(key);
    return at && { x: at.x, y: at.y, w: at.w, h: at.h };
  };
  const fitAround = (host: string | null, padding: number): Size => {
    const inside = present.flatMap((key) => {
      const box = hostOf(key) === host ? boxOf(key) : undefined;
      return box ? [box] : [];
    });
    return {
      w: Math.max(2 * padding, ...inside.map((box) => box.x + box.w + padding)),
      h: Math.max(2 * padding, ...inside.map((box) => box.y + box.h + padding)),
    };
  };
  // Deepest boundaries first, so each parent fits its grown children.
  const depthOf = (key: string): number => {
    let depth = 0;
    for (let at = scopeOf(key); at !== null; at = scopeOf(at)) depth++;
    return depth;
  };
  const boundaries = present.filter(isBoundary).sort((a, b) => depthOf(b) - depthOf(a));
  for (const key of boundaries) {
    const box = boxOf(key);
    if (!box) continue;
    const fit = fitAround(key, BOUNDARY_PADDING);
    if (fit.w > box.w || fit.h > box.h || nodes.has(key) || written.has(key)) {
      nodes.set(key, { ...box, w: Math.max(box.w, fit.w), h: Math.max(box.h, fit.h) });
    }
  }

  // Nodes a human dragged out of the frame do not grow it, unless relayout moved them back.
  const fit = fitAround(null, FRAME_PADDING);
  if (current) {
    const { x, y, props } = current.frame;
    return {
      pageId: current.pageId,
      frame: { x, y, w: Math.max(props.w, fit.w), h: Math.max(props.h, fit.h) },
      nodes,
      parents,
      rows,
    };
  }
  const pageId = targetPage(spec, index);
  const at = spec.position ?? besideContent(index, pageId);
  return { pageId, frame: { x: at.x, y: at.y, ...fit }, nodes, parents, rows };
}

/** Gap kept between a new node and anything already placed. */
const NODE_GAP = 48;

/**
 * ELK has no pinning, so new nodes take their positions from a full layout and are then fitted
 * around the fixed boxes. Each cluster of connected new nodes moves as one: by the offset between
 * its first fixed neighbor's real and laid-out position, into the frame's padding, then across the
 * layout direction past every box it would touch. Deterministic for the same canvas.
 */
function placeAround(input: {
  readonly added: readonly string[];
  readonly elk: ReadonlyMap<string, Box>;
  readonly fixed: ReadonlyMap<string, Box>;
  readonly links: ReadonlyArray<readonly [string, string]>;
  readonly direction: DiagramLayoutDirection;
  /** Inner padding of the frame or boundary the nodes are placed in. */
  readonly padding: number;
}): Map<string, Box> {
  const { added, elk, fixed, links } = input;
  const across = input.direction === "down" || input.direction === "up" ? "x" : "y";
  const extent = across === "x" ? "w" : "h";
  const isAdded = new Set(added);
  const neighbors = new Map<string, string[]>();
  for (const [from, to] of links) {
    neighbors.set(from, [...(neighbors.get(from) ?? []), to]);
    neighbors.set(to, [...(neighbors.get(to) ?? []), from]);
  }

  const obstacles = Array.from(fixed.values());
  const placed = new Map<string, Box>();
  for (const seed of added) {
    if (placed.has(seed)) continue;
    const cluster = [seed];
    const seen = new Set(cluster);
    for (const key of cluster) {
      for (const next of neighbors.get(key) ?? []) {
        if (isAdded.has(next) && !seen.has(next)) {
          seen.add(next);
          cluster.push(next);
        }
      }
    }

    const anchor = cluster
      .flatMap((key) => neighbors.get(key) ?? [])
      .find((key) => fixed.has(key) && elk.has(key));
    const real = anchor === undefined ? undefined : fixed.get(anchor);
    const laidOut = anchor === undefined ? undefined : elk.get(anchor);
    const follow = real && laidOut ? { x: real.x - laidOut.x, y: real.y - laidOut.y } : null;
    let boxes = cluster.flatMap((key) => {
      const box = elk.get(key);
      return box ? [{ key, box: follow ? moveBy(box, follow.x, follow.y) : box }] : [];
    });
    const intoFrame = {
      x: Math.max(0, input.padding - Math.min(...boxes.map(({ box }) => box.x))),
      y: Math.max(0, input.padding - Math.min(...boxes.map(({ box }) => box.y))),
    };
    boxes = boxes.map(({ key, box }) => ({ key, box: moveBy(box, intoFrame.x, intoFrame.y) }));

    // Every step clears at least one box/obstacle pair for good, so this ends.
    for (;;) {
      let step = 0;
      for (const { box } of boxes) {
        for (const obstacle of obstacles) {
          if (touches(box, obstacle)) {
            step = Math.max(step, obstacle[across] + obstacle[extent] + NODE_GAP - box[across]);
          }
        }
      }
      if (step === 0) break;
      boxes = boxes.map(({ key, box }) => ({
        key,
        box: across === "x" ? moveBy(box, step, 0) : moveBy(box, 0, step),
      }));
    }
    for (const { key, box } of boxes) {
      placed.set(key, box);
      obstacles.push(box);
    }
  }
  return placed;
}

function moveBy(box: Box, x: number, y: number): Box {
  return { ...box, x: box.x + x, y: box.y + y };
}

function touches(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.w + NODE_GAP &&
    b.x < a.x + a.w + NODE_GAP &&
    a.y < b.y + b.h + NODE_GAP &&
    b.y < a.y + a.h + NODE_GAP
  );
}

function targetPage(spec: ComposeSpec, index: RecordIndex): TLParentId {
  const pages = pagesInOrder(index).map((page) => page.id);
  const pageId = spec.pageId === null ? pages[0] : pages.find((id) => id === spec.pageId);
  if (pageId !== undefined) return pageId;
  throw new DiagramOperationError({
    code: "invalid-spec",
    details: {
      issues: [{ path: "spec.pageId", message: `unknown page; valid pages: ${listOf(pages)}` }],
    },
  });
}

/** Right of everything on the page, aligned with its top; the origin on an empty page. */
function besideContent(index: RecordIndex, pageId: string): { x: number; y: number } {
  const boxes = [];
  for (const record of index.values()) {
    if (record.typeName === "shape" && record.parentId === pageId)
      boxes.push(pageBox(index, record));
  }
  const content = unionOf(boxes);
  if (!content) return { x: 0, y: 0 };
  return { x: Math.round(content.x + content.w + PLACEMENT_GAP), y: Math.round(content.y) };
}
