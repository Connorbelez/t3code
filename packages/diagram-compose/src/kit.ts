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

export type NodeKind = GeoKind | FrameKind | NoteKind;

export interface EdgeKind {
  readonly description: string;
  readonly color: TLDefaultColorStyle;
  readonly arrowheadStart: TLArrowShapeArrowheadStyle;
  readonly arrowheadEnd: TLArrowShapeArrowheadStyle;
  readonly dash?: TLDefaultDashStyle;
  /** Overrides the kit's arrow kind. */
  readonly arrowKind?: "elbow" | "arc";
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
