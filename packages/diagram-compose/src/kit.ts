import {
  DiagramMemberKey,
  type DiagramKit,
  type DiagramKitReference,
  type DiagramLayoutDirection,
  type DiagramSpec,
} from "@t3tools/contracts";
import type {
  TLArrowShapeArrowheadStyle,
  TLDefaultColorStyle,
  TLDefaultDashStyle,
  TLDefaultFillStyle,
  TLDefaultFontStyle,
  TLDefaultHorizontalAlignStyle,
  TLDefaultSizeStyle,
  TLGeoShapeGeoStyle,
} from "@tldraw/tlschema";
import * as Schema from "effect/Schema";

import {
  MEMBER_PARTS,
  type PartName,
  type StoredEdge,
  type StoredMember,
  type StoredNode,
} from "./identity.ts";
import type { SpecIssue } from "./spec.ts";

/** A kit is vocabulary plus style rows. Lowering, layout and emission stay generic. */

export interface Size {
  readonly w: number;
  readonly h: number;
}

/** The fields a kind's `body` accepts. Bodies are JSON, so fields are JSON-shaped schemas. */
export type BodySchema = Schema.Struct<Schema.Struct.Fields> & Schema.ConstraintDecoder<unknown>;

interface KindBase {
  readonly description: string;
  /** Kinds without a body schema take no body. */
  readonly body?: BodySchema;
}

/** One stock geo shape with the label inside. */
export interface GeoKind extends KindBase {
  readonly shape: "geo";
  readonly geo: TLGeoShapeGeoStyle;
  readonly color: TLDefaultColorStyle;
  /** Overrides the look's dash. */
  readonly dash?: TLDefaultDashStyle;
  /** Overrides the look's fill. */
  readonly fill?: TLDefaultFillStyle;
  readonly minSize: Size;
  /** Geos whose outline cuts into their box (diamonds, pills) need room around the label. */
  readonly labelRoom?: number;
  /** Markers such as initial and final states draw no label. */
  readonly hideLabel?: true;
  /** Label size, `m` unless set. */
  readonly size?: TLDefaultSizeStyle;
  /** Label alignment, centered unless set. */
  readonly align?: TLDefaultHorizontalAlignStyle;
  readonly labelColor?: TLDefaultColorStyle;
  /** Draws the body: extra label lines and, for an external element, its style. */
  readonly draw?: (label: string, body: Schema.JsonObject) => GeoDrawing;
}

export interface GeoDrawing {
  readonly label: string;
  readonly color?: TLDefaultColorStyle;
  readonly dash?: TLDefaultDashStyle;
}

/** A geo node's text and style as drawn; layout measures exactly what emit writes. */
export function geoDrawing(kind: GeoKind, label: string, body: Schema.JsonObject | null) {
  const drawing: GeoDrawing = kind.hideLabel
    ? { label: "" }
    : kind.draw && body
      ? kind.draw(label, body)
      : { label };
  return {
    label: drawing.label,
    color: drawing.color ?? kind.color,
    dash: drawing.dash ?? kind.dash,
  };
}

/** A boundary: a frame titled by the label that holds every node whose `parent` names it. */
export interface FrameKind extends KindBase {
  readonly shape: "frame";
}

/** A tldraw sticky note. */
export interface NoteKind extends KindBase {
  readonly shape: "note";
  readonly color: TLDefaultColorStyle;
}

/** The lines of one compartment, from the node's validated body. */
export type CompartmentLines = (body: Schema.JsonObject) => readonly string[];

/**
 * A UML class or a table: a header box spanning the whole node with stacked compartments of
 * multiline text over its lower part, grouped so the node moves as one unit. Arrows bind to the
 * header box, so they end at the node's outline.
 */
export interface CompartmentsKind extends KindBase {
  readonly shape: "compartments";
  readonly body: BodySchema;
  readonly color: TLDefaultColorStyle;
  /** Lines above the label, such as «interface». */
  readonly heading: (body: Schema.JsonObject) => readonly string[];
  /** Always drawn, empty or not, so a kind's parts are fixed. */
  readonly compartments: readonly [CompartmentLines, ...CompartmentLines[]];
}

/** A device frame titled by the label, holding the elements its body lays out. */
export interface ScreenKind extends KindBase {
  readonly shape: "screen";
  readonly body: BodySchema;
}

/** A tldraw text shape; it wraps at the width layout gives it. */
export interface TextKind extends KindBase {
  readonly shape: "text";
  readonly size: TLDefaultSizeStyle;
  readonly color: TLDefaultColorStyle;
}

/** A straight horizontal tldraw line across the width layout gives it. */
export interface LineKind extends KindBase {
  readonly shape: "line";
  readonly color: TLDefaultColorStyle;
}

/**
 * A sequence participant: a head box over a dashed lifeline, grouped so dragging the head carries
 * the lifeline. Messages and note lines bind to the lifeline.
 */
export interface LifelineKind extends KindBase {
  readonly shape: "lifeline";
  readonly geo: TLGeoShapeGeoStyle;
  readonly color: TLDefaultColorStyle;
  readonly minSize: Size;
  readonly labelRoom?: number;
}

/** A block's messages, by key, and where its sections start. */
export interface BlockSpan {
  readonly from: string;
  readonly to: string;
  readonly sections: ReadonlyArray<{ readonly from: string; readonly label: string }>;
}

/**
 * A dashed box behind a range of sequence messages, titled "operator [label]". Each section, such
 * as an alt's else, is a dashed box from its first message to the block's end, so its top edge
 * divides the block.
 */
export interface BlockKind extends KindBase {
  readonly shape: "block";
  readonly body: BodySchema;
  readonly color: TLDefaultColorStyle;
  readonly span: (body: Schema.JsonObject) => BlockSpan;
}

export type NodeKind =
  | GeoKind
  | FrameKind
  | NoteKind
  | CompartmentsKind
  | ScreenKind
  | TextKind
  | LineKind
  | LifelineKind
  | BlockKind;

export interface EdgeKind {
  readonly description: string;
  readonly color: TLDefaultColorStyle;
  readonly arrowheadStart: TLArrowShapeArrowheadStyle;
  readonly arrowheadEnd: TLArrowShapeArrowheadStyle;
  readonly dash?: TLDefaultDashStyle;
  /** Fills closed arrowheads; `none` draws them hollow. */
  readonly fill?: TLDefaultFillStyle;
  /** Overrides the kit's arrow kind. */
  readonly arrowKind?: "elbow" | "arc";
  /** Edge kinds without a body schema take no body. */
  readonly body?: BodySchema;
  /** Draws the body: the arrow's text and, for a directed association, its head. */
  readonly draw?: (label: string, body: Schema.JsonObject) => EdgeDrawing;
  /** Sequence messages: whether the message activates its receiver or ends its sender's activation. */
  readonly activation?: (body: Schema.JsonObject) => {
    readonly activate: boolean;
    readonly deactivate: boolean;
  };
}

export interface EdgeDrawing {
  readonly label: string;
  readonly arrowheadEnd?: TLArrowShapeArrowheadStyle;
}

export const LOOKS = {
  precise: { font: "sans", dash: "solid", fill: "semi" },
  sketch: { font: "draw", dash: "draw", fill: "semi" },
} as const satisfies Record<
  string,
  {
    font: TLDefaultFontStyle & ("sans" | "draw");
    dash: TLDefaultDashStyle;
    fill: TLDefaultFillStyle;
  }
>;

export interface Kit<N extends string = string, E extends string = string> {
  readonly name: DiagramKit;
  readonly guidance: string;
  readonly look: keyof typeof LOOKS;
  readonly direction: DiagramLayoutDirection;
  readonly arrowKind: "elbow" | "arc";
  /** Space between layered layers when edge labels need more room than the default 72. */
  readonly layerGap?: number;
  readonly nodeKinds: Readonly<Record<N, NodeKind>>;
  readonly defaultKind: NoInfer<N>;
  readonly edgeKinds: Readonly<Record<E, EdgeKind>>;
  /** Null for a kit without edges. */
  readonly defaultEdgeKind: NoInfer<E> | null;
  readonly example: DiagramSpec;
  /** `layered` (the default) places nodes with ELK; `sequence` lays out every member from the spec. */
  readonly layout?: "layered" | "sequence";
  /** Rules across members that a body schema cannot state, such as a block naming its messages. */
  readonly check?: (spec: {
    readonly nodes: readonly StoredNode[];
    readonly edges: readonly StoredEdge[];
    /**
     * Members only the canvas knows, for a patch: nodes as stored, null for one a human deleted.
     * Null when unknown, as on the server.
     */
    readonly outside: {
      readonly nodes: ReadonlyMap<string, StoredNode | null>;
      readonly edges: ReadonlySet<string>;
    } | null;
  }) => SpecIssue[];
}

export const NOTE_KIND = "note";
/** The edge kind of a note's attach line. Specs never write it; a note's `body.on` lowers to it. */
export const ATTACH_EDGE_KIND = "attach";

const note: NoteKind = {
  shape: "note",
  description:
    'A sticky note. Set body.on to a node key, e.g. { "on": "pay" }, to attach it to that node with a dashed line.',
  color: "yellow",
  body: Schema.Struct({ on: Schema.optional(DiagramMemberKey) }),
};

const attach: EdgeKind = {
  description: "Dashed line from a note to the node it explains.",
  color: "grey",
  arrowheadStart: "none",
  arrowheadEnd: "none",
  dash: "dashed",
  arrowKind: "arc",
};

/**
 * Checks at the type level that the defaults name real kinds, adds the shared `note` kind, then
 * forgets the literal kind names.
 */
export function defineKit<N extends string, E extends string>(kit: Kit<N, E>): Kit {
  const nodeKinds: Record<string, NodeKind> = { ...kit.nodeKinds, [NOTE_KIND]: note };
  return { ...kit, nodeKinds };
}

/** A kind's row. Own keys only: kinds come from specs and canvas meta, and "constructor" is no kind. */
export function rowOf<T>(rows: Readonly<Record<string, T>>, kind: string): T | undefined {
  return Object.hasOwn(rows, kind) ? rows[kind] : undefined;
}

export function nodeKindOf(kit: Kit, kind: string): NodeKind | undefined {
  return rowOf(kit.nodeKinds, kind);
}

/** Spec edge kinds, plus the attach line notes lower to. */
export function edgeKindOf(kit: Kit, kind: string): EdgeKind | undefined {
  return kind === ATTACH_EDGE_KIND ? attach : rowOf(kit.edgeKinds, kind);
}

/** Every part a member is drawn with, `main` first. A member missing one of them was edited. */
export function partsOf(kit: Kit, member: StoredMember): readonly PartName[] {
  if (member.role === "edge") {
    const activation = edgeKindOf(kit, member.kind)?.activation;
    return activation && member.body && activation(member.body).activate
      ? [...MEMBER_PARTS.edge, "activation"]
      : MEMBER_PARTS.edge;
  }
  const kind = nodeKindOf(kit, member.kind);
  switch (kind?.shape) {
    case "compartments":
      return ["main", "group", ...kind.compartments.map((_, i) => `c${i + 1}` as const)];
    case "lifeline":
      return ["main", "group", "lifeline"];
    case "block":
      return ["main", ...kind.span(member.body ?? {}).sections.map((_, i) => `c${i + 1}` as const)];
    default:
      return MEMBER_PARTS.node;
  }
}

/** The header box's text, then each compartment's, as drawn. */
export function compartmentTexts(
  kind: CompartmentsKind,
  label: string,
  body: Schema.JsonObject | null,
): string[] {
  const fields = body ?? {};
  return [
    [...kind.heading(fields), label].join("\n"),
    ...kind.compartments.map((lines) => lines(fields).join("\n")),
  ];
}

/** One midpoint label for an edge and what sits at its two ends, e.g. "1 ── places ── 0..*". */
export function endsLabel(from: string | undefined, label: string, to: string | undefined): string {
  if (from === undefined && to === undefined) return label;
  return [from, label, to].filter((part) => part !== undefined && part !== "").join(" ── ");
}

export function referenceOf(kit: Kit): DiagramKitReference {
  return {
    kit: kit.name,
    defaultKind: kit.defaultKind,
    nodeKinds: Object.entries(kit.nodeKinds).map(([kind, row]) => ({
      kind,
      description: row.description,
    })),
    defaultEdgeKind: kit.defaultEdgeKind,
    edgeKinds: Object.entries(kit.edgeKinds).map(([kind, row]) => ({
      kind,
      description: row.description,
    })),
    guidance: kit.guidance,
    example: kit.example,
  };
}
