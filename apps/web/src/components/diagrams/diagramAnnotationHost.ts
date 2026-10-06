import {
  DiagramOperationError,
  type DiagramAnnotatedCapture,
  type DiagramAnnotationTarget,
  type DiagramAnnotations,
  type DiagramBounds,
} from "@t3tools/contracts";
import { Box, type Editor, type TLShapeId } from "tldraw";
import {
  annotationOverlaySvg,
  planAnnotatedCapture,
  withAnnotationOverlay,
  type AnnotationTargetBox,
  type PlannedAnnotationImage,
} from "./diagramAnnotationRender";

/** Leaves room in the 16 MiB host response for everything beside the images. */
const MAX_IMAGES_BASE64 = 15 * 1024 * 1024;
/** The most issues a DiagramOperationError carries. */
const MAX_ISSUES = 20;

/**
 * Where a comment's target is on `pageId`, in page space. Null when any of its shapes is gone or on
 * another page: the comment is unavailable until it is retargeted or deleted.
 */
export function annotationTargetPageBounds(
  editor: Editor,
  pageId: string,
  target: DiagramAnnotationTarget,
): DiagramBounds | null {
  if (target.kind === "region") return target.bounds;
  const boxes: Box[] = [];
  for (const shapeId of target.shapeIds) {
    const shape = editor.getShape(shapeId as TLShapeId);
    const box =
      shape && editor.getAncestorPageId(shape) === pageId
        ? editor.getShapePageBounds(shape)
        : undefined;
    if (!box) return null;
    boxes.push(box);
  }
  return Box.Common(boxes).toJson();
}

/**
 * Where each comment's target sits on `pageId` in this editor. A shapes target covers the
 * axis-aligned page bounds of all its shapes, so rotation and group transforms count. Fails
 * scope-unavailable with one issue per comment whose shapes are gone or on another page.
 */
export function resolveAnnotationTargets(
  editor: Editor,
  pageId: string,
  annotations: DiagramAnnotations,
): AnnotationTargetBox[] {
  const issues: { path: string; message: string }[] = [];
  const targets = annotations.flatMap(({ id, number, target }): AnnotationTargetBox[] => {
    const bounds = annotationTargetPageBounds(editor, pageId, target);
    if (bounds) return [{ id, number, kind: target.kind, bounds }];
    issues.push({
      path: `annotations/${number}`,
      message: `Comment ${number} targets a shape that was deleted or moved to another page. Retarget or delete it.`,
    });
    return [];
  });
  if (issues.length > 0)
    throw new DiagramOperationError({
      code: "scope-unavailable",
      details: { issues: issues.slice(0, MAX_ISSUES) },
    });
  return targets;
}

export type AnnotationImageSeams = {
  /** The page as SVG with viewBox `image.bounds`, drawn `image.width` by `image.height`. */
  exportSvg: (image: PlannedAnnotationImage) => Promise<string>;
  /** `svg` as a PNG of exactly `width` by `height` pixels, base64-encoded. */
  rasterize: (svg: string, width: number, height: number) => Promise<string>;
};

/** Plans the images for `targets`, then draws each one's badges over the page export. */
export async function renderAnnotatedCapture(
  targets: readonly AnnotationTargetBox[],
  seams: AnnotationImageSeams,
): Promise<Pick<DiagramAnnotatedCapture, "resolved" | "images">> {
  const plan = planAnnotatedCapture(targets);
  const images: DiagramAnnotatedCapture["images"][number][] = [];
  let size = 0;
  for (const image of plan.images) {
    const svg = withAnnotationOverlay(
      await seams.exportSvg(image),
      annotationOverlaySvg(image, plan.resolved),
    );
    const base64 = await seams.rasterize(svg, image.width, image.height);
    size += base64.length;
    if (size > MAX_IMAGES_BASE64)
      throw new DiagramOperationError({
        code: "too-large",
        details: {
          issues: [
            {
              path: "images",
              message:
                "The commented page renders larger than 15 MiB. Send fewer comments at once, or comment on targets that sit closer together.",
            },
          ],
        },
      });
    const { role, annotationIds, bounds, width, height } = image;
    images.push({ role, annotationIds, bounds, width, height, mimeType: "image/png", base64 });
  }
  return {
    resolved: plan.resolved.map(({ id, bounds, marker }) => ({ id, bounds, marker })),
    images,
  };
}
