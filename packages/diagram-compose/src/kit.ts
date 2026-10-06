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
  TLGeoShapeGeoStyle,
} from "@tldraw/tlschema";
import * as Schema from "effect/Schema";

import { MEMBER_PARTS, type PartName, type StoredMember } from "./identity.ts";

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

export type NodeKind = GeoKind | FrameKind | NoteKind | CompartmentsKind;

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
  readonly nodeKinds: Readonly<Record<N, NodeKind>>;
  readonly defaultKind: NoInfer<N>;
  readonly edgeKinds: Readonly<Record<E, EdgeKind>>;
  readonly defaultEdgeKind: NoInfer<E>;
  readonly example: DiagramSpec;
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

export function edgeKindOf(kit: Kit, kind: string): EdgeKind | undefined {
  return kind === ATTACH_EDGE_KIND ? attach : kit.edgeKinds[kind];
}

/** Every part a member is drawn with, `main` first. A member missing one of them was edited. */
export function partsOf(kit: Kit, member: StoredMember): readonly PartName[] {
  const kind = member.role === "node" ? kit.nodeKinds[member.kind] : undefined;
  if (kind?.shape !== "compartments") return MEMBER_PARTS[member.role];
  return ["main", "group", ...kind.compartments.map((_, i) => `c${i + 1}` as const)];
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
