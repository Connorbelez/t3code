import type { RecordIndex } from "./canvas.ts";
import type { PartName, StoredEdge, StoredNode } from "./identity.ts";
import { ATTACH_EDGE_KIND, edgeKindOf, LOOKS, type Size } from "./kit.ts";
import {
  type ArrowPlace,
  type Box,
  FRAME_PADDING,
  frameAround,
  geoSize,
  LABEL_FONT_SIZE_S,
  LABEL_PADDING,
  type MeasureText,
  noteSize,
  type PartPlace,
  type Placement,
  snap,
} from "./layout.ts";
import type { CurrentComposition } from "./membership.ts";
import type { ComposeSpec } from "./spec.ts";

/**
 * Participants as columns, messages as rows in member order. Order is the meaning, so every
 * member is placed from the spec on every compose; positions and sizes are geometry, never edits.
 */

const COLUMN_GAP = 48;
/** tldraw's arrow label: base font size 16 scaled for size `m`. */
const ARROW_LABEL_FONT_SIZE = 16 * 1.25;
const ARROW_LABEL_MAX_WIDTH = 320;
/** tldraw squeezes a label into the arrow's length less 64px, plus the label's own padding. */
const ARROW_LABEL_ROOM = 96;
const FIRST_ROW_GAP = 24;
const ROW_MIN = 40;
const ROW_PADDING = 12;
/** A self call is a half circle this tall on the right of its lifeline. */
const SELF_HEIGHT = 32;
const LIFELINE_TAIL = 32;
const BAR_WIDTH = 12;
const BAR_MIN = 16;
const BLOCK_SIDE = 32;
const BLOCK_INSET = 12;
const BLOCK_FOOTER = 16;
const NOTE_GAP = 48;

interface Row {
  readonly edge: StoredEdge;
  readonly from: number;
  readonly to: number;
  readonly label: Size;
  /** Arrow start and end heights; equal unless the message is a self call. */
  start: number;
  end: number;
}

interface Block {
  readonly node: StoredNode;
  readonly first: number;
  readonly last: number;
  readonly sections: ReadonlyArray<{ readonly at: number; readonly text: string }>;
  readonly text: string;
  readonly order: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
  readonly sectionTops: number[];
}

export function placeSequence(
  spec: ComposeSpec,
  current: CurrentComposition | null,
  index: RecordIndex,
  measure: MeasureText,
): Placement {
  const family = LOOKS[spec.kit.look].font;
  const kinds = spec.kit.nodeKinds;
  const labelSize = (text: string, fontSize: number, maxWidth: number | null): Size =>
    text.trim() === "" ? { w: 0, h: 0 } : measure(text, { family, fontSize, maxWidth });

  const lifelines = spec.nodes.flatMap((node) => {
    const kind = kinds[node.kind];
    return kind?.shape === "lifeline"
      ? [{ node, size: geoSize(kind, node.label, family, measure) }]
      : [];
  });
  const column = new Map(lifelines.map(({ node }, i) => [node.key, i]));
  const headHeight = Math.max(0, ...lifelines.map(({ size }) => size.h));
  const rows = spec.edges.flatMap((edge): Row[] => {
    const from = column.get(edge.from);
    const to = column.get(edge.to);
    if (edge.kind === ATTACH_EDGE_KIND || from === undefined || to === undefined) return [];
    const label = labelSize(edge.label, ARROW_LABEL_FONT_SIZE, ARROW_LABEL_MAX_WIDTH);
    return [{ edge, from, to, label, start: 0, end: 0 }];
  });
  const rowOf = new Map(rows.map((row, i) => [row.edge.key, i]));

  // Each column clears its left neighbor's head and every label of a message ending at it.
  const centers: number[] = [];
  for (const [i, { size }] of lifelines.entries()) {
    const previous = centers[i - 1];
    const left = lifelines[i - 1]?.size.w ?? 0;
    let center =
      previous === undefined
        ? FRAME_PADDING + size.w / 2
        : previous + left / 2 + COLUMN_GAP + size.w / 2;
    for (const row of rows) {
      const half = row.label.w / 2;
      if (row.from !== row.to) {
        const near = centers[Math.min(row.from, row.to)];
        if (Math.max(row.from, row.to) === i && near !== undefined)
          center = Math.max(center, near + row.label.w + ARROW_LABEL_ROOM);
      } else if (row.from === i) {
        // A self call's label is centered on its loop, half a loop right of the lifeline.
        const room = previous === undefined ? FRAME_PADDING : previous + COLUMN_GAP / 2;
        center = Math.max(center, room + half - SELF_HEIGHT / 2);
      } else if (row.from === i - 1 && previous !== undefined) {
        center = Math.max(center, previous + SELF_HEIGHT / 2 + half + COLUMN_GAP / 2);
      }
    }
    centers.push(Math.round(center));
  }
  const centerOf = (i: number) => centers[i] ?? 0;
  const reach = (row: Row) =>
    row.from === row.to
      ? centerOf(row.from) + SELF_HEIGHT / 2 + row.label.w / 2
      : Math.max(centerOf(row.from), centerOf(row.to));

  const blocks = spec.nodes.flatMap((node, order): Block[] => {
    const kind = kinds[node.kind];
    if (kind?.shape !== "block") return [];
    const span = kind.span(node.body ?? {});
    const a = rowOf.get(span.from);
    const b = rowOf.get(span.to);
    if (a === undefined || b === undefined) return [];
    const first = Math.min(a, b);
    const last = Math.max(a, b);
    // Every section is drawn, so the member keeps its parts; a misplaced one clamps into the block.
    const sections = span.sections.map((section) => ({
      at: Math.min(Math.max(rowOf.get(section.from) ?? last, first + 1), last),
      text: sectionText(section.label),
    }));
    return [
      {
        node,
        first,
        last,
        sections,
        text: blockText(node),
        order,
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        sectionTops: [],
      },
    ];
  });
  const headerOf = (text: string) =>
    snap(labelSize(text, LABEL_FONT_SIZE_S, null).h + LABEL_PADDING + 8);
  /** Outer first: longer spans, then earlier in the spec. */
  const outerFirst = (a: Block, b: Block) =>
    b.last - b.first - (a.last - a.first) || a.order - b.order;
  const innerFirst = (a: Block, b: Block) => outerFirst(b, a);
  const encloses = (outer: Block, inner: Block) =>
    outer !== inner &&
    outer.first <= inner.first &&
    inner.last <= outer.last &&
    outerFirst(outer, inner) < 0;

  const lifelineTop = FRAME_PADDING + headHeight;
  let y = lifelineTop + FIRST_ROW_GAP;
  for (const [i, row] of rows.entries()) {
    for (const block of blocks.filter((block) => block.first === i).sort(outerFirst)) {
      block.top = y;
      y += headerOf(block.text);
    }
    for (const block of blocks.toSorted(outerFirst)) {
      block.sections.forEach((section, j) => {
        if (section.at !== i) return;
        block.sectionTops[j] = y;
        y += headerOf(section.text);
      });
    }
    const self = row.from === row.to;
    const height = Math.max(
      ROW_MIN,
      Math.ceil(self ? Math.max(SELF_HEIGHT, row.label.h) : row.label.h) + 2 * ROW_PADDING,
    );
    const middle = y + height / 2;
    row.start = self ? middle - SELF_HEIGHT / 2 : middle;
    row.end = self ? middle + SELF_HEIGHT / 2 : middle;
    y += height;
    for (const block of blocks.filter((block) => block.last === i).sort(innerFirst)) {
      y += BLOCK_FOOTER;
      block.bottom = y;
    }
  }
  const lifelineBottom = y + LIFELINE_TAIL;
  const lifelineHeight = lifelineBottom - lifelineTop;

  // Innermost first, so each block encloses the blocks inside it.
  for (const block of blocks.toSorted(innerFirst)) {
    const inside = rows.slice(block.first, block.last + 1);
    block.left =
      Math.min(...inside.map((row) => centerOf(Math.min(row.from, row.to)))) - BLOCK_SIDE;
    block.right = Math.max(...inside.map(reach)) + BLOCK_SIDE;
    for (const inner of blocks) {
      if (!encloses(block, inner)) continue;
      block.left = Math.min(block.left, inner.left - BLOCK_INSET);
      block.right = Math.max(block.right, inner.right + BLOCK_INSET);
    }
    const title = Math.max(
      ...[block.text, ...block.sections.map((section) => section.text)].map(
        (text) => labelSize(text, LABEL_FONT_SIZE_S, null).w,
      ),
    );
    block.right = Math.max(block.right, block.left + title + 2 * LABEL_PADDING);
  }

  const parts = new Map<string, Map<PartName, PartPlace>>();
  const arrows = new Map<string, ArrowPlace>();
  const nodes = new Map<string, Box>();
  const parents = new Map<string, string | null>();
  const anchor = (at: number) => ({ x: 0.5, y: (at - lifelineTop) / lifelineHeight });

  for (const [i, { node, size }] of lifelines.entries()) {
    const x = centerOf(i) - size.w / 2;
    const group = { key: node.key, part: "group" } as const;
    parts.set(
      node.key,
      new Map<PartName, PartPlace>([
        ["group", { x, y: FRAME_PADDING, w: 0, h: 0, parent: null }],
        ["main", { x, y: FRAME_PADDING, w: size.w, h: headHeight, parent: group }],
        ["lifeline", { x: centerOf(i), y: lifelineTop, w: 0, h: lifelineHeight, parent: group }],
      ]),
    );
  }

  // Bars stack per participant; a later activation of an active participant sits half a bar right.
  const open = new Map<number, { readonly key: string; readonly top: number }[]>();
  const bar = (
    on: number,
    opened: { readonly key: string; readonly top: number },
    bottom: number,
  ) => {
    const depth = open.get(on)?.length ?? 0;
    parts.set(
      opened.key,
      new Map<PartName, PartPlace>([
        [
          "activation",
          {
            x: centerOf(on) - BAR_WIDTH / 2 + (depth * BAR_WIDTH) / 2,
            y: opened.top,
            w: BAR_WIDTH,
            h: Math.max(BAR_MIN, bottom - opened.top),
            parent: { key: lifelines[on]?.node.key ?? "", part: "group" },
          },
        ],
      ]),
    );
  };
  for (const row of rows) {
    arrows.set(row.edge.key, {
      start: anchor(row.start),
      end: anchor(row.end),
      bend: row.from === row.to ? -SELF_HEIGHT / 2 : 0,
    });
    const activation = edgeKindOf(spec.kit, row.edge.kind)?.activation?.(row.edge.body ?? {});
    if (activation?.deactivate) {
      const opened = open.get(row.from)?.pop();
      if (opened) bar(row.from, opened, row.start);
    }
    if (activation?.activate) {
      const stack = open.get(row.to) ?? [];
      open.set(row.to, stack);
      stack.push({ key: row.edge.key, top: row.end });
    }
  }
  for (const [on, stack] of open) {
    while (stack.length > 0) {
      const opened = stack.pop();
      if (opened) bar(on, opened, lifelineBottom - LIFELINE_TAIL / 2);
    }
  }

  for (const block of blocks) {
    const w = block.right - block.left;
    parts.set(
      block.node.key,
      new Map<PartName, PartPlace>([
        [
          "main",
          {
            x: block.left,
            y: block.top,
            w,
            h: block.bottom - block.top,
            parent: null,
            behind: true,
          },
        ],
        ...block.sections.map((_, j): [PartName, PartPlace] => {
          const top = block.sectionTops[j] ?? block.top;
          return [
            `c${j + 1}`,
            { x: block.left, y: top, w, h: block.bottom - top, parent: null, behind: true },
          ];
        }),
      ]),
    );
  }

  // Notes hang below the lifeline they explain, left to right in spec order.
  const noteTop = lifelineBottom + NOTE_GAP;
  let cursor = FRAME_PADDING;
  let bottom = lifelineBottom;
  for (const node of spec.nodes) {
    if (kinds[node.kind]?.shape !== "note") continue;
    const size = noteSize(node.label, family, measure);
    const on = node.body?.["on"];
    const at = typeof on === "string" ? column.get(on) : undefined;
    const x = Math.max(cursor, at === undefined ? cursor : centerOf(at) - size.w / 2);
    nodes.set(node.key, { x, y: noteTop, ...size });
    parents.set(node.key, null);
    cursor = x + size.w + COLUMN_GAP / 2;
    bottom = Math.max(bottom, noteTop + size.h);
    const attach = spec.edges.find(
      (edge) => edge.kind === ATTACH_EDGE_KIND && edge.from === node.key,
    );
    if (attach && at !== undefined) {
      arrows.set(attach.key, { start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 }, bend: 0 });
    }
  }

  const right = Math.max(
    FRAME_PADDING,
    ...lifelines.map(({ size }, i) => centerOf(i) + size.w / 2),
    ...rows.map(reach),
    ...blocks.map((block) => block.right),
    cursor - COLUMN_GAP / 2,
  );
  const fit = { w: Math.ceil(right + FRAME_PADDING), h: Math.ceil(bottom + FRAME_PADDING) };
  return {
    ...frameAround(spec, current, index, fit),
    nodes,
    parents,
    rows: new Map(),
    parts,
    arrows,
  };
}

/** "alt [card valid]": the operator, then the label as its condition. */
export function blockText(node: StoredNode): string {
  return node.label === "" ? node.kind : `${node.kind} [${node.label}]`;
}

/** "[declined]" over a later branch, such as an alt's else. */
export function sectionText(label: string): string {
  return label === "" ? "" : `[${label}]`;
}
