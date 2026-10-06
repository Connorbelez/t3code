import type { DiagramBounds } from "@t3tools/contracts";

import { ANNOTATION_BADGE_RADIUS, layoutAnnotationMarkers } from "./diagramAnnotationRender";

type Camera = { readonly x: number; readonly y: number; readonly z: number };
type Size = { readonly w: number; readonly h: number };

/** Viewport pixels kept between the comment editor, its target and the viewport edge. */
const EDITOR_GAP = 8;

/** `bounds` in the editor viewport, where overlay elements are positioned. */
export function pageToViewportBounds(bounds: DiagramBounds, camera: Camera): DiagramBounds {
  return {
    x: (bounds.x + camera.x) * camera.z,
    y: (bounds.y + camera.y) * camera.z,
    w: bounds.w * camera.z,
    h: bounds.h * camera.z,
  };
}

/**
 * Bubble centers in the viewport. The image badges' layout runs at screen scale, so bubbles keep
 * their size at every zoom and sit where the badges do relative to their targets.
 */
export function layoutCommentBubbles<
  T extends { readonly id: unknown; readonly number: number; readonly bounds: DiagramBounds },
>(targets: readonly T[], camera: Camera) {
  return layoutAnnotationMarkers(
    targets.map((target) => ({ ...target, bounds: pageToViewportBounds(target.bounds, camera) })),
    ANNOTATION_BADGE_RADIUS,
  );
}

/**
 * The comment editor's top-left corner: right of its target, else left of it, kept inside the
 * viewport. `anchor` is the target in the viewport.
 */
export function commentEditorPosition(anchor: DiagramBounds, viewport: Size, editor: Size) {
  const clamp = (value: number, max: number) =>
    Math.max(EDITOR_GAP, Math.min(value, max - EDITOR_GAP));
  const right = anchor.x + anchor.w + EDITOR_GAP;
  const left = anchor.x - EDITOR_GAP - editor.w;
  const x = right + editor.w + EDITOR_GAP <= viewport.w || left < EDITOR_GAP ? right : left;
  return { x: clamp(x, viewport.w - editor.w), y: clamp(anchor.y, viewport.h - editor.h) };
}

/** The composer chip label for a page's comments. */
export function annotationSetLabel(
  diagramName: string,
  pages: readonly { readonly id: string; readonly name: string }[],
  pageId: string,
): string {
  const page = pages.length > 1 ? pages.find((entry) => entry.id === pageId) : undefined;
  return page ? `${diagramName} comments · ${page.name}` : `${diagramName} comments`;
}
