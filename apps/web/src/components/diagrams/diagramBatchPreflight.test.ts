// @vitest-environment jsdom
import {
  Editor,
  createTLStore,
  defaultShapeUtils,
  defaultBindingUtils,
  defaultTools,
  defaultShapeTools,
  createShapeId,
  createBindingId,
  type TLAnyShapeUtilConstructor,
} from "tldraw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { validateDiagramBatch } from "./diagramBatchPreflight";

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
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      addEventListener() {},
      removeEventListener() {},
      check: () => true,
      load: () => Promise.resolve([]),
      ready: Promise.resolve(),
    },
  });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.unstubAllGlobals();
});
function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const editor = new Editor({
    store: createTLStore(),
    shapeUtils: defaultShapeUtils as unknown as readonly TLAnyShapeUtilConstructor[],
    bindingUtils: defaultBindingUtils,
    tools: [...defaultTools, ...defaultShapeTools],
    initialState: "select",
    autoFocus: false,
    getContainer: () => container,
  });
  cleanups.push(() => {
    editor.dispose();
    container.remove();
  });
  return editor;
}
describe("native batch preflight", () => {
  it("accepts an exact record edit without changing the mounted document or Undo history", () => {
    const editor = mount();
    const id = createShapeId("geo");
    editor.createShape({ id, type: "geo", x: 10 });
    const before = editor.getShape(id)!;
    const document = editor.store.serialize("document");
    expect(() =>
      validateDiagramBatch(editor, {
        requestId: "edit",
        expected: [{ id, record: before }],
        puts: [{ ...before, x: 80 }],
        deletes: [],
      }),
    ).not.toThrow();
    expect(editor.store.serialize("document")).toEqual(document);
    editor.undo();
    expect(editor.getShape(id)).toBeUndefined();
  });
  it("rejects a binding whose native SDK effects additionally reorder the arrow before touching the mounted document", () => {
    const editor = mount();
    const arrowId = createShapeId("arrow");
    const targetId = createShapeId("target");
    editor.createShape({ id: arrowId, type: "arrow" });
    editor.createShape({ id: targetId, type: "geo" });
    const arrow = editor.getShape(arrowId)!;
    const target = editor.getShape(targetId)!;
    const before = editor.store.serialize("document");
    const binding = {
      id: createBindingId("native"),
      typeName: "binding",
      type: "arrow",
      fromId: arrowId,
      toId: targetId,
      meta: {},
      props: {
        terminal: "end",
        normalizedAnchor: { x: 0.5, y: 0.5 },
        isExact: false,
        isPrecise: false,
        snap: "none",
      },
    };
    expect(() =>
      validateDiagramBatch(editor, {
        requestId: "binding",
        expected: [
          { id: binding.id, record: null },
          { id: arrowId, record: arrow },
          { id: targetId, record: target },
        ],
        puts: [binding],
        deletes: [],
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-records" }));
    expect(editor.store.serialize("document")).toEqual(before);
  });
  it("rejects a bound outline change that resnaps a precise anchor in the mounted select state", () => {
    const editor = mount();
    const arrowId = createShapeId("arrow");
    const targetId = createShapeId("target");
    editor.createShape({ id: arrowId, type: "arrow" });
    editor.createShape({ id: targetId, type: "geo", props: { w: 100, h: 100 } });
    const bindingId = createBindingId("precise");
    editor.createBinding({
      id: bindingId,
      type: "arrow",
      fromId: arrowId,
      toId: targetId,
      props: {
        terminal: "end",
        normalizedAnchor: { x: 0.95, y: 0.05 },
        isExact: false,
        isPrecise: true,
        snap: "none",
      },
    });
    const bindingBefore = editor.getBinding(bindingId);
    const target = editor.getShape(targetId)!;
    const before = editor.store.serialize("document");
    expect(() =>
      validateDiagramBatch(editor, {
        requestId: "outline",
        expected: [{ id: targetId, record: target }],
        puts: [{ ...target, props: { ...target.props, geo: "triangle" } }],
        deletes: [],
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-records" }));
    expect(editor.store.serialize("document")).toEqual(before);
    editor.updateShape({ id: targetId, type: "geo", props: { geo: "triangle" } });
    expect(editor.getBinding(bindingId)).not.toEqual(bindingBefore);
  });
});
