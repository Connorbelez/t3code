import type {
  DiagramKit,
  DiagramKitReference,
  DiagramLayoutDirection,
  DiagramSpec,
} from "@t3tools/contracts";
import type {
  TLArrowShapeArrowheadStyle,
  TLDefaultColorStyle,
  TLDefaultDashStyle,
  TLDefaultFillStyle,
  TLDefaultFontStyle,
  TLGeoShapeGeoStyle,
} from "@tldraw/tlschema";

/** A kit is vocabulary plus style rows. Lowering, layout and emission stay generic. */

export interface Size {
  readonly w: number;
  readonly h: number;
}

export interface NodeKind {
  readonly description: string;
  readonly geo: TLGeoShapeGeoStyle;
  readonly color: TLDefaultColorStyle;
  /** Overrides the look's dash. */
  readonly dash?: TLDefaultDashStyle;
  readonly minSize: Size;
  /** Geos whose outline cuts into their box (diamonds, pills) need room around the label. */
  readonly labelRoom?: number;
}

interface EdgeKind {
  readonly description: string;
  readonly color: TLDefaultColorStyle;
  readonly arrowheadStart: TLArrowShapeArrowheadStyle;
  readonly arrowheadEnd: TLArrowShapeArrowheadStyle;
  readonly dash?: TLDefaultDashStyle;
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

/** Checks at the type level that the defaults name real kinds, then forgets the literal kind names. */
export function defineKit<N extends string, E extends string>(kit: Kit<N, E>): Kit {
  return kit;
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
