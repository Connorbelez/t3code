// @vitest-environment jsdom
import { DiagramAnnotationId } from "@t3tools/contracts";
import {
  Editor,
  GeoShapeUtil,
  SelectTool,
  createShapeId,
  createTLStore,
  type TLPointerEventInfo,
} from "tldraw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ANNOTATE_TOOL_ID,
  AnnotateTool,
  annotateSelection,
  annotationSession,
  clickTarget,
  dragTarget,
  toggleAnnotationMode,
} from "./annotateTool";

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

const a = createShapeId("a");
const b = createShapeId("b");
const c = createShapeId("c");

/** Three rectangles with `a` and `b` selected, viewed at 2x from camera (50, 20). */
function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const editor = new Editor({
    store: createTLStore(),
    shapeUtils: [GeoShapeUtil],
    bindingUtils: [],
    tools: [SelectTool, AnnotateTool],
    initialState: "select",
    getContainer: () => container,
  });
  cleanups.push(() => {
    editor.dispose();
    container.remove();
  });
  editor.createShapes([
    { id: a, type: "geo", x: 0, y: 0, props: { w: 100, h: 60 } },
    { id: b, type: "geo", x: 200, y: 0, props: { w: 100, h: 60 } },
    { id: c, type: "geo", x: 0, y: 200, props: { w: 100, h: 60 } },
  ]);
  editor.setSelectedShapes([a, b]);
  editor.setCamera({ x: 50, y: 20, z: 2 });
  editor.clearHistory();
  return editor;
}

/** Screen point (x, y) is page point (x / 2 - 50, y / 2 - 20). */
function pointer(editor: Editor, name: TLPointerEventInfo["name"], x: number, y: number) {
  editor.dispatch({
    type: "pointer",
    name,
    target: "canvas",
    point: { x, y, z: 0.5 },
    pointerId: 1,
    button: 0,
    isPen: false,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    accelKey: false,
  });
  editor.emit("tick", 16);
}
const click = (editor: Editor, x: number, y: number) => {
  pointer(editor, "pointer_down", x, y);
  pointer(editor, "pointer_up", x, y);
};
/** What tldraw's Escape key handler sends to the current tool. */
const escape = (editor: Editor) => editor.cancel();

const untouched = (editor: Editor) => ({
  document: editor.store.serialize("document"),
  selection: editor.getSelectedShapeIds(),
  camera: { x: editor.getCamera().x, y: editor.getCamera().y, z: editor.getCamera().z },
  canUndo: editor.getCanUndo(),
  canRedo: editor.getCanRedo(),
});

describe("annotation gestures", () => {
  it("turn a click into its shape, a click on the selection into the selection", () => {
    expect(clickTarget("shape:c", ["shape:a", "shape:b"])).toEqual({
      kind: "shapes",
      shapeIds: ["shape:c"],
    });
    expect(clickTarget("shape:b", ["shape:a", "shape:b"])).toEqual({
      kind: "shapes",
      shapeIds: ["shape:a", "shape:b"],
    });
  });

  it("normalize reverse drags and ignore regions under 4 screen pixels a side", () => {
    expect(dragTarget({ x: 30, y: 40 }, { x: 10, y: 15 }, 1)).toEqual({
      kind: "region",
      bounds: { x: 10, y: 15, w: 20, h: 25 },
    });
    expect(dragTarget({ x: 0, y: 0 }, { x: 3, y: 10 }, 1)).toBeNull();
    expect(dragTarget({ x: 0, y: 0 }, { x: 3, y: 10 }, 2)).toEqual({
      kind: "region",
      bounds: { x: 0, y: 0, w: 3, h: 10 },
    });
  });
});

describe("the t3-annotate tool", () => {
  it("opens comments from clicks and drags without touching the diagram, selection, camera or undo", () => {
    const editor = mount();
    const before = untouched(editor);
    const session = annotationSession(editor);
    editor.setCurrentTool(ANNOTATE_TOOL_ID);

    click(editor, 200, 500);
    expect(session.edit.get()).toEqual({
      kind: "new",
      target: { kind: "shapes", shapeIds: [c] },
    });
    escape(editor);
    expect(session.edit.get()).toBeNull();
    expect(editor.getCurrentToolId()).toBe(ANNOTATE_TOOL_ID);

    click(editor, 200, 100);
    expect(session.edit.get()).toEqual({
      kind: "new",
      target: { kind: "shapes", shapeIds: [a, b] },
    });
    escape(editor);

    pointer(editor, "pointer_down", 1100, 840);
    pointer(editor, "pointer_move", 1000, 740);
    expect(session.brush.get()).toEqual({ x: 450, y: 350, w: 50, h: 50 });
    pointer(editor, "pointer_move", 900, 640);
    pointer(editor, "pointer_up", 900, 640);
    expect(session.brush.get()).toBeNull();
    expect(session.edit.get()).toEqual({
      kind: "new",
      target: { kind: "region", bounds: { x: 400, y: 300, w: 100, h: 100 } },
    });

    pointer(editor, "pointer_down", 900, 640);
    pointer(editor, "pointer_move", 906, 642);
    pointer(editor, "pointer_up", 906, 642);
    expect(session.edit.get()).toBeNull();

    const id = DiagramAnnotationId.make("comment-1");
    session.retarget(id, "Move this up");
    click(editor, 200, 500);
    expect(session.edit.get()).toEqual({
      kind: "existing",
      id,
      retarget: { target: { kind: "shapes", shapeIds: [c] }, comment: "Move this up" },
    });
    escape(editor);

    pointer(editor, "pointer_down", 900, 640);
    pointer(editor, "pointer_move", 1000, 740);
    escape(editor);
    expect(session.brush.get()).toBeNull();
    pointer(editor, "pointer_up", 1000, 740);
    expect(session.edit.get()).toBeNull();
    expect(editor.getCurrentToolId()).toBe(ANNOTATE_TOOL_ID);

    escape(editor);
    expect(editor.getCurrentToolId()).toBe("select");
    expect(untouched(editor)).toEqual(before);
    expect(before.canUndo).toBe(false);
  });

  it("annotates the selection and drops the unsaved comment when the mode ends", () => {
    const editor = mount();
    const session = annotationSession(editor);

    expect(annotateSelection(editor)).toBe(true);
    expect(editor.getCurrentToolId()).toBe(ANNOTATE_TOOL_ID);
    expect(session.edit.get()).toEqual({
      kind: "new",
      target: { kind: "shapes", shapeIds: [a, b] },
    });
    toggleAnnotationMode(editor);
    expect(editor.getCurrentToolId()).toBe("select");
    expect(session.edit.get()).toBeNull();

    editor.selectNone();
    expect(annotateSelection(editor)).toBe(false);
    expect(editor.getCurrentToolId()).toBe("select");
  });
});
