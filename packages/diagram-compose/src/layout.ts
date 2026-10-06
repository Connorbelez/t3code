import { DiagramOperationError, type DiagramLayoutDirection } from "@t3tools/contracts";
import type { TLParentId, TLShape } from "@tldraw/tlschema";
import type { ELK, ElkNode } from "elkjs/lib/elk-api.js";

import { originOf, pageBox, pagesInOrder, type RecordIndex, unionOf } from "./canvas.ts";
import { LOOKS, type NodeKind, type Size } from "./kit.ts";
import type { Decision } from "./merge.ts";
import type { CurrentComposition } from "./membership.ts";
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

/** tldraw's geo label: base font size 16 scaled for size `m`, inside 16px of padding per side. */
const LABEL_FONT_SIZE_M = 16 * 1.375;
const LABEL_PADDING = 16;
const LABEL_MAX_WIDTH = 240;
const GRID = 8;
const FRAME_PADDING = 48;
/** Space between a new composition and the content to its left. */
const PLACEMENT_GAP = 160;

/** Rounded up to the grid so sub-pixel font differences between hosts rarely change a size. */
function nodeSize(
  kind: NodeKind,
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

function snap(value: number): number {
  return Math.ceil(value / GRID) * GRID;
}

const ELK_DIRECTIONS = { down: "DOWN", right: "RIGHT", up: "UP", left: "LEFT" } as const;

interface LayeredResult {
  /** Top-left per node, relative to the composition frame. */
  readonly positions: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
  /** The frame size that holds every node with padding. */
  readonly size: Size;
}

/** Deterministic: fixed seed, input in spec order, model order respected, coordinates rounded. */
async function layoutLayered(
  nodes: ReadonlyArray<{ readonly key: string; readonly size: Size }>,
  edges: ReadonlyArray<readonly [string, string]>,
  direction: DiagramLayoutDirection,
): Promise<LayeredResult> {
  // CommonJS: Node and Vite both resolve the default import to the constructor, but NodeNext and
  // Bundler type resolution disagree about it.
  const { default: Elk } = (await import("elkjs/lib/elk.bundled.js")) as unknown as {
    default: new () => ELK;
  };
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": ELK_DIRECTIONS[direction],
      "elk.randomSeed": "1",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": "48",
      "elk.layered.spacing.nodeNodeBetweenLayers": "72",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      // Edges pointing back in spec order are the loops, as a reader of the spec expects.
      "elk.layered.cycleBreaking.strategy": "MODEL_ORDER",
      "elk.padding": `[top=${FRAME_PADDING},left=${FRAME_PADDING},bottom=${FRAME_PADDING},right=${FRAME_PADDING}]`,
    },
    children: nodes.map((node) => ({ id: node.key, width: node.size.w, height: node.size.h })),
    edges: edges.map(([from, to], i) => ({ id: `e${i}`, sources: [from], targets: [to] })),
  };
  const laid = await new Elk().layout(graph);
  const positions = new Map(
    (laid.children ?? []).map((child): [string, { x: number; y: number }] => [
      child.id,
      { x: Math.round(child.x ?? 0), y: Math.round(child.y ?? 0) },
    ]),
  );
  return {
    positions,
    size: { w: Math.ceil(laid.width ?? 0), h: Math.ceil(laid.height ?? 0) },
  };
}

export interface Placement {
  readonly pageId: TLParentId;
  /** Page-space for a new frame; an existing frame keeps its position and only grows. */
  readonly frame: Box;
  /**
   * Boxes of the nodes this compose writes, in the coordinates of each node's parent: the frame
   * for new nodes, the current parent otherwise. Kept nodes appear only when relaid out.
   */
  readonly nodes: ReadonlyMap<string, Box>;
}

/**
 * Existing nodes stay where they are and are obstacles for new ones; `relayout` lays out every
 * node from scratch. Layout works in frame space. ELK loads only when something needs placing.
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
  const frameOrigin = current ? originOf(index, current.frame.id) : { x: 0, y: 0 };
  const sizes = new Map<string, Size>();
  /** Frame-space boxes of nodes on the canvas, with their canvas size. */
  const canvas = new Map<string, Box & { readonly shape: TLShape }>();
  for (const decision of decisions) {
    if (decision.do === "create" || decision.do === "overwrite") {
      const node = decision.draft.spec;
      const kind = node.role === "node" ? spec.kit.nodeKinds[node.kind] : undefined;
      if (node.role === "node" && kind)
        sizes.set(node.key, nodeSize(kind, node.label, family, measure));
    }
    const shape =
      decision.do === "keep" || decision.do === "overwrite"
        ? decision.current?.parts.get("main")
        : undefined;
    if (shape?.typeName === "shape" && shape.type !== "arrow") {
      const box = pageBox(index, shape);
      canvas.set(decision.key, {
        ...box,
        x: box.x - frameOrigin.x,
        y: box.y - frameOrigin.y,
        shape,
      });
    }
  }
  const sizeOf = (key: string) => sizes.get(key) ?? canvas.get(key);

  const laid = relayout
    ? spec.nodes.filter((node) => sizeOf(node.key))
    : spec.nodes.filter((node) => sizes.has(node.key) && !canvas.has(node.key));
  const framed = new Map<string, Box>();
  if (laid.length > 0) {
    const present = spec.nodes.flatMap((node) => {
      const size = sizeOf(node.key);
      return size ? [{ key: node.key, size: { w: size.w, h: size.h } }] : [];
    });
    const keys = new Set(present.map((node) => node.key));
    const links = spec.edges.flatMap((edge): [string, string][] =>
      keys.has(edge.from) && keys.has(edge.to) ? [[edge.from, edge.to]] : [],
    );
    const elk = await layoutLayered(present, links, spec.direction);
    const boxes = new Map(
      present.flatMap((node): [string, Box][] => {
        const at = elk.positions.get(node.key);
        return at ? [[node.key, { ...at, ...node.size }]] : [];
      }),
    );
    if (relayout) {
      for (const [key, box] of boxes) framed.set(key, box);
    } else {
      const fixed = new Map<string, Box>();
      for (const [key, box] of canvas) {
        const size = sizeOf(key) ?? box;
        fixed.set(key, { x: box.x, y: box.y, w: size.w, h: size.h });
      }
      const placed = placeAround({
        added: laid.map((node) => node.key),
        elk: boxes,
        fixed,
        links,
        direction: spec.direction,
      });
      for (const [key, box] of placed) framed.set(key, box);
    }
  }

  const frameId = current?.frame.id;
  const nodes = new Map<string, Box>();
  const inFrame: Box[] = [];
  for (const node of spec.nodes) {
    const size = sizes.get(node.key);
    const onCanvas = canvas.get(node.key);
    const box = framed.get(node.key);
    if (box) {
      // Laid out in frame space; a node a human moved into another parent keeps that parent.
      const parentOrigin = onCanvas ? originOf(index, onCanvas.shape.parentId) : frameOrigin;
      nodes.set(node.key, {
        ...box,
        x: box.x + frameOrigin.x - parentOrigin.x,
        y: box.y + frameOrigin.y - parentOrigin.y,
      });
    } else if (onCanvas && size) {
      // Rewritten content keeps its top-left and takes its new size.
      nodes.set(node.key, { x: onCanvas.shape.x, y: onCanvas.shape.y, ...size });
    }
    // Nodes a human dragged out of the frame do not grow it, unless relayout moved them back.
    const final = box ?? (onCanvas && { ...onCanvas, ...size });
    if (final && (relayout || !onCanvas || onCanvas.shape.parentId === frameId))
      inFrame.push(final);
  }
  const fit = {
    w: Math.max(2 * FRAME_PADDING, ...inFrame.map((box) => box.x + box.w + FRAME_PADDING)),
    h: Math.max(2 * FRAME_PADDING, ...inFrame.map((box) => box.y + box.h + FRAME_PADDING)),
  };
  if (current) {
    const { x, y, props } = current.frame;
    return {
      pageId: current.pageId,
      frame: { x, y, w: Math.max(props.w, fit.w), h: Math.max(props.h, fit.h) },
      nodes,
    };
  }
  const pageId = targetPage(spec, index);
  const at = spec.position ?? besideContent(index, pageId);
  return { pageId, frame: { x: at.x, y: at.y, ...fit }, nodes };
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
      x: Math.max(0, FRAME_PADDING - Math.min(...boxes.map(({ box }) => box.x))),
      y: Math.max(0, FRAME_PADDING - Math.min(...boxes.map(({ box }) => box.y))),
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
