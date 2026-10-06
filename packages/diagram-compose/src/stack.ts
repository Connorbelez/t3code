import type { Size } from "./kit.ts";

/**
 * The stack engine: nested columns and rows with gap, padding, cross-axis alignment, and fixed,
 * natural or fill sizes along the main axis. Not CSS and not Yoga; just enough for wireframes.
 */

export const ALIGNS = ["start", "center", "end", "stretch"] as const;
export type Align = (typeof ALIGNS)[number];

/** Pixels, a share of the space left over, or null for the natural size. */
export type MainSize = number | "fill" | null;

export interface StackLeaf {
  readonly member: string;
  readonly size: MainSize;
}

export interface StackContainer {
  readonly axis: "column" | "row";
  /** The member drawn as this container's box, such as a card; null for an invisible container. */
  readonly member: string | null;
  readonly gap: number;
  readonly padding: number;
  readonly align: Align;
  readonly size: MainSize;
  readonly children: readonly StackItem[];
}

export type StackItem = StackLeaf | StackContainer;

export interface Box extends Size {
  readonly x: number;
  readonly y: number;
}

export interface LeafSizer {
  /** Natural size at most `maxWidth` wide. More width never makes a leaf taller. */
  readonly size: (member: string, maxWidth: number) => Size;
  /** Rigid leaves keep their natural cross size when their container stretches. */
  readonly rigid: (member: string) => boolean;
}

function isContainer(item: StackItem): item is StackContainer {
  return "axis" in item;
}

/** The size an item needs when at most `maxWidth` wide. Fill children count at their natural size. */
export function naturalSize(item: StackItem, maxWidth: number, sizer: LeafSizer): Size {
  if (!isContainer(item)) return sizer.size(item.member, maxWidth);
  const inner = Math.max(0, maxWidth - 2 * item.padding);
  const gaps = item.gap * Math.max(0, item.children.length - 1);
  if (item.axis === "column") {
    const sizes = item.children.map((child) => {
      const size = naturalSize(child, inner, sizer);
      return { w: size.w, h: typeof child.size === "number" ? child.size : size.h };
    });
    return {
      w: Math.max(0, ...sizes.map((size) => size.w)) + 2 * item.padding,
      h: sizes.reduce((sum, size) => sum + size.h, 0) + gaps + 2 * item.padding,
    };
  }
  const widths = rowWidths(item, inner, sizer, false);
  const heights = item.children.map((child, i) => naturalSize(child, widths[i] ?? 0, sizer).h);
  return {
    w: Math.min(maxWidth, widths.reduce((sum, w) => sum + w, 0) + gaps + 2 * item.padding),
    h: Math.max(0, ...heights) + 2 * item.padding,
  };
}

/** Main-axis widths of a row's children; fill children share what is left only when arranging. */
function rowWidths(row: StackContainer, inner: number, sizer: LeafSizer, fill: boolean): number[] {
  const widths = row.children.map((child) =>
    typeof child.size === "number"
      ? child.size
      : child.size === "fill" && fill
        ? 0
        : naturalSize(child, inner, sizer).w,
  );
  if (!fill) return widths;
  return shareFill(row, widths, inner);
}

/** Splits the space the fixed and natural children leave over evenly between the fill children. */
function shareFill(container: StackContainer, mains: number[], inner: number): number[] {
  const fills = container.children.filter((child) => child.size === "fill").length;
  if (fills === 0) return mains;
  const used = mains.reduce((sum, main) => sum + main, 0);
  const gaps = container.gap * Math.max(0, container.children.length - 1);
  const share = Math.max(0, inner - used - gaps) / fills;
  return container.children.map((child, i) => (child.size === "fill" ? share : (mains[i] ?? 0)));
}

function offset(align: Align, free: number): number {
  return align === "center" ? free / 2 : align === "end" ? free : 0;
}

/**
 * Boxes for every leaf and drawn container under `root`, laid out inside `box`, keyed by member
 * and rounded to whole pixels. Children past the end of the box overflow it rather than shrink.
 */
export function arrangeStack(root: StackContainer, box: Box, sizer: LeafSizer): Map<string, Box> {
  const boxes = new Map<string, Box>();
  const stretches = (container: StackContainer, child: StackItem) =>
    container.align === "stretch" && (isContainer(child) || !sizer.rigid(child.member));

  const place = (item: StackItem, at: Box) => {
    if (item.member !== null) {
      boxes.set(item.member, {
        x: Math.round(at.x),
        y: Math.round(at.y),
        w: Math.round(at.w),
        h: Math.round(at.h),
      });
    }
    if (!isContainer(item)) return;
    const innerW = Math.max(0, at.w - 2 * item.padding);
    const innerH = Math.max(0, at.h - 2 * item.padding);
    let x = at.x + item.padding;
    let y = at.y + item.padding;
    if (item.axis === "column") {
      const widths = item.children.map((child) =>
        stretches(item, child) ? innerW : Math.min(innerW, naturalSize(child, innerW, sizer).w),
      );
      const heights = shareFill(
        item,
        item.children.map((child, i) =>
          typeof child.size === "number"
            ? child.size
            : child.size === "fill"
              ? 0
              : naturalSize(child, widths[i] ?? 0, sizer).h,
        ),
        innerH,
      );
      item.children.forEach((child, i) => {
        const w = widths[i] ?? 0;
        const h = heights[i] ?? 0;
        place(child, { x: x + offset(item.align, innerW - w), y, w, h });
        y += h + item.gap;
      });
      return;
    }
    const widths = rowWidths(item, innerW, sizer, true);
    item.children.forEach((child, i) => {
      const w = widths[i] ?? 0;
      const h = stretches(item, child) ? innerH : naturalSize(child, w, sizer).h;
      place(child, { x, y: y + offset(item.align, innerH - h), w, h });
      x += w + item.gap;
    });
  };
  place(root, box);
  return boxes;
}
