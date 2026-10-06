// @vitest-environment jsdom
import type { DiagramComposeRequest } from "@t3tools/contracts";
import { compose, type ComposePorts } from "@t3tools/diagram-compose/compose";
import {
  Editor,
  createTLStore,
  defaultShapeUtils,
  defaultBindingUtils,
  defaultTools,
  defaultShapeTools,
  createShapeId,
  createBindingId,
  defaultAddFontsFromNode,
  tipTapDefaultExtensions,
  toRichText,
  type TLAnyShapeUtilConstructor,
  type TLRecord,
} from "tldraw";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { rehearseDiagramChanges, validateDiagramBatch } from "./diagramBatchPreflight";
import { parseDocumentRecord } from "./diagramSocket";

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
    // What <Tldraw> supplies to the mounted editor.
    textOptions: {
      addFontsFromNode: defaultAddFontsFromNode,
      tipTapConfig: { extensions: tipTapDefaultExtensions },
    },
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
  it("accepts an edit in a document that contains text", () => {
    const editor = mount();
    const id = createShapeId("label");
    editor.createShape({ id, type: "text", x: 10, props: { richText: toRichText("Hello") } });
    const before = editor.getShape(id)!;
    expect(() =>
      validateDiagramBatch(editor, {
        requestId: "text",
        expected: [{ id, record: before }],
        puts: [{ ...before, x: 80 }],
        deletes: [],
      }),
    ).not.toThrow();
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

const checkout: DiagramComposeRequest = {
  spec: {
    kit: "flow",
    key: "checkout",
    title: "Checkout",
    nodes: [
      { key: "start", kind: "start" },
      { key: "cart", kind: "process", label: "Review cart" },
      { key: "pay", kind: "process", label: "Take payment" },
      { key: "valid", kind: "decision", label: "Payment valid?" },
      { key: "receipt", kind: "io", label: "Email receipt" },
      { key: "end", kind: "end" },
    ],
    edges: [
      ["start", "cart"],
      ["cart", "pay"],
      ["pay", "valid"],
      ["valid", "receipt", "yes"],
      ["valid", "cart", "no"],
      ["receipt", "end"],
    ],
  },
};
const measureText: ComposePorts["measureText"] = (text, font) => {
  const width = text.length * font.fontSize * 0.6;
  const lines = font.maxWidth === null ? 1 : Math.max(1, Math.ceil(width / font.maxWidth));
  return { w: Math.min(width, font.maxWidth ?? width), h: lines * font.fontSize * 1.35 };
};
function composeInto(editor: Editor) {
  const records = editor.store.serialize("document");
  return compose(checkout, Object.values(records), {
    measureText,
    rehearse: (puts, deletes) =>
      new Map(Object.entries(rehearseDiagramChanges(editor, records, puts, deletes))),
  });
}
function addLooseShapes(editor: Editor) {
  const [left, right, arrow] = [
    createShapeId("left"),
    createShapeId("right"),
    createShapeId("arrow"),
  ];
  editor.createShapes([
    { id: left, type: "geo", x: 0, y: 0 },
    { id: right, type: "geo", x: 400, y: 0 },
    { id: createShapeId("note"), type: "text", x: 0, y: 300 },
    { id: arrow, type: "arrow" },
  ]);
  editor.createBindings(
    (["start", "end"] as const).map((terminal) => ({
      type: "arrow",
      fromId: arrow,
      toId: terminal === "start" ? left : right,
      props: {
        terminal,
        normalizedAnchor: { x: 0.5, y: 0.5 },
        isExact: false,
        isPrecise: false,
        snap: "none",
      },
    })),
  );
}
describe("composed batches", () => {
  it.each([
    ["an empty diagram", (_editor: Editor) => {}],
    ["a diagram with loose shapes", addLooseShapes],
  ])("pass the preflight on %s and recompose to no change", async (_, seed) => {
    const editor = mount();
    seed(editor);
    const loose = editor.store.serialize("document");
    const { changes } = await composeInto(editor);
    assert(changes, "a new composition must produce changes");
    expect(() => validateDiagramBatch(editor, { requestId: "compose", ...changes })).not.toThrow();

    editor.run(
      () => {
        editor.store.put(changes.puts.map(parseDocumentRecord));
        editor.store.remove(changes.deletes as TLRecord["id"][]);
      },
      { ignoreShapeLock: true },
    );
    const after = editor.store.serialize("document");
    for (const [id, record] of Object.entries(loose))
      expect(after[id as TLRecord["id"]]).toEqual(record);
    expect(
      editor
        .getCurrentPageShapes()
        .flatMap((shape) => (shape.type === "frame" ? [shape.props.name] : [])),
    ).toEqual(["Checkout"]);
    expect((await composeInto(editor)).changes).toBeNull();
  });
});
