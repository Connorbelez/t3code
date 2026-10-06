import { DiagramOperationError, type DiagramLayoutDirection } from "@t3tools/contracts";
import type { TLParentId } from "@tldraw/tlschema";
import type { ELK, ElkNode } from "elkjs/lib/elk-api.js";

import { localBox, pageBox, pagesInOrder, type RecordIndex, unionOf } from "./canvas.ts";
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
  /** Frame-space boxes of the nodes this compose writes. */
  readonly nodes: ReadonlyMap<string, Box>;
}

/**
 * Existing nodes stay where they are on the canvas. New nodes take their ELK position from a
 * layout of every node that will exist; ELK loads only when there is a new node.
 */
export async function place(
  spec: ComposeSpec,
  decisions: readonly Decision[],
  current: CurrentComposition | null,
  index: RecordIndex,
  measure: MeasureText,
): Promise<Placement> {
  const family = LOOKS[spec.kit.look].font;
  const sizes = new Map<string, Size>();
  const existing = new Map<string, Box>();
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
    if (shape?.typeName === "shape" && shape.type === "geo") {
      const box = localBox(shape);
      existing.set(decision.key, { x: shape.x, y: shape.y, w: box.w, h: box.h });
    }
  }

  const nodes = new Map<string, Box>();
  const created = decisions.filter(
    (decision) => decision.do === "create" && sizes.has(decision.key),
  );
  if (created.length > 0) {
    const present = spec.nodes.flatMap((node) => {
      const size = sizes.get(node.key) ?? existing.get(node.key);
      return size ? [{ key: node.key, size }] : [];
    });
    const keys = new Set(present.map((node) => node.key));
    const links = spec.edges.flatMap((edge): [string, string][] =>
      keys.has(edge.from) && keys.has(edge.to) ? [[edge.from, edge.to]] : [],
    );
    const laid = await layoutLayered(present, links, spec.direction);
    for (const decision of created) {
      const at = laid.positions.get(decision.key);
      const size = sizes.get(decision.key);
      if (at && size) nodes.set(decision.key, { ...at, ...size });
    }
  }
  for (const [key, size] of sizes) {
    const at = existing.get(key);
    if (at && !nodes.has(key)) nodes.set(key, { x: at.x, y: at.y, ...size });
  }

  const frameId = current?.frame.id;
  // Nodes a human dragged out of the frame do not grow it.
  const inFrame = Array.from(new Set([...nodes.keys(), ...existing.keys()])).flatMap((key) => {
    const main = current?.members.get(key)?.parts.get("main");
    if (main?.typeName === "shape" && main.parentId !== frameId) return [];
    const box = nodes.get(key) ?? existing.get(key);
    return box ? [box] : [];
  });
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
