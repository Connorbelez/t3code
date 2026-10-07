// @vitest-environment jsdom
import { Editor, GeoShapeUtil, PageRecordType, createShapeId, createTLStore } from "tldraw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { annotationTargetPageBounds } from "./diagramAnnotationHost";
import {
  annotationSetLabel,
  commentEditorPosition,
  layoutCommentBubbles,
} from "./diagramAnnotationOverlay";

vi.hoisted(() =>
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  }),
);
const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
  vi.unstubAllGlobals();
});

describe("comment bubbles", () => {
  it("sit at their targets' viewport corners, moving to a free corner when one is taken", () => {
    const bubbles = layoutCommentBubbles(
      [
        { id: "third", number: 3, bounds: { x: 5, y: 2, w: 10, h: 10 } },
        { id: "first", number: 1, bounds: { x: 0, y: 0, w: 50, h: 30 } },
        { id: "second", number: 2, bounds: { x: 0, y: 0, w: 50, h: 30 } },
      ],
      { x: 10, y: -20, z: 2 },
    );
    expect(bubbles.map(({ id, marker }) => ({ id, marker }))).toEqual([
      { id: "first", marker: { x: 20, y: -40 } },
      { id: "second", marker: { x: 120, y: -40 } },
      { id: "third", marker: { x: 50, y: -36 } },
    ]);
  });

  it("are unavailable when a target shape is deleted or moved to another page", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const editor = new Editor({
      store: createTLStore(),
      shapeUtils: [GeoShapeUtil],
      bindingUtils: [],
      tools: [],
      getContainer: () => container,
    });
    cleanups.push(() => {
      editor.dispose();
      container.remove();
    });
    const pageId = editor.getCurrentPageId();
    const left = createShapeId("left");
    const right = createShapeId("right");
    const gone = createShapeId("gone");
    editor.createShapes([
      { id: left, type: "geo", x: -40, y: 10, props: { w: 30, h: 20 } },
      { id: right, type: "geo", x: 100, y: 50, props: { w: 20, h: 40 } },
    ]);
    const shapes = { kind: "shapes", shapeIds: [left, right] } as const;
    expect(annotationTargetPageBounds(editor, pageId, shapes)).toEqual({
      x: -40,
      y: 10,
      w: 160,
      h: 80,
    });
    expect(
      annotationTargetPageBounds(editor, pageId, { kind: "shapes", shapeIds: [left, gone] }),
    ).toBeNull();
    const other = PageRecordType.createId("other");
    editor.createPage({ id: other, name: "Other" });
    editor.moveShapesToPage([right], other);
    editor.setCurrentPage(pageId);
    expect(annotationTargetPageBounds(editor, pageId, shapes)).toBeNull();
    expect(
      annotationTargetPageBounds(editor, pageId, {
        kind: "region",
        bounds: { x: 1, y: 2, w: 3, h: 4 },
      }),
    ).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });
});

describe("the comment editor", () => {
  const viewport = { w: 800, h: 600 };
  const size = { w: 288, h: 184 };

  it("opens right of its target, flips left when that overflows, and stays on screen", () => {
    expect(commentEditorPosition({ x: 100, y: 50, w: 100, h: 60 }, viewport, size)).toEqual({
      x: 208,
      y: 50,
    });
    expect(commentEditorPosition({ x: 500, y: 500, w: 200, h: 60 }, viewport, size)).toEqual({
      x: 204,
      y: 408,
    });
    expect(commentEditorPosition({ x: 20, y: -100, w: 700, h: 60 }, viewport, size)).toEqual({
      x: 504,
      y: 8,
    });
  });
});

describe("annotationSetLabel", () => {
  it("names the page only when the diagram has more than one", () => {
    const flows = { id: "page:flows", name: "Flows" };
    expect(annotationSetLabel("Checkout", [flows], "page:flows")).toBe("Checkout comments");
    expect(
      annotationSetLabel("Checkout", [{ id: "page:main", name: "Main" }, flows], "page:flows"),
    ).toBe("Checkout comments · Flows");
  });
});
