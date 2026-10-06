// @vitest-environment jsdom
import type { DiagramComposeRequest, DiagramHostComposeResult } from "@t3tools/contracts";
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
  type TLShape,
  type TLShapeId,
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

const checkout = {
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
} satisfies DiagramComposeRequest;
const measureText: ComposePorts["measureText"] = (text, font) => {
  const width = text.length * font.fontSize * 0.6;
  const lines = font.maxWidth === null ? 1 : Math.max(1, Math.ceil(width / font.maxWidth));
  return { w: Math.min(width, font.maxWidth ?? width), h: lines * font.fontSize * 1.35 };
};
// Nested boundaries, arrows between frames and into them, and notes attached across frames.
const orders = {
  spec: {
    kit: "state",
    key: "orders",
    title: "Orders",
    nodes: [
      { key: "start", kind: "initial" },
      { key: "draft" },
      { key: "open", kind: "composite", label: "Open" },
      { key: "openStart", kind: "initial", parent: "open" },
      { key: "paying", parent: "open" },
      { key: "check", kind: "choice", parent: "open" },
      { key: "shipping", kind: "composite", label: "Shipping", parent: "open" },
      { key: "packed", parent: "shipping" },
      { key: "sent", parent: "shipping" },
      { key: "done", kind: "final" },
      { key: "why", kind: "note", label: "Retries card twice", body: { on: "paying" } },
      {
        key: "late",
        kind: "note",
        label: "Courier picks up at 5pm",
        parent: "shipping",
        body: { on: "draft" },
      },
    ],
    edges: [
      ["start", "draft"],
      ["draft", "paying", "submit [valid] / reserve"],
      ["openStart", "paying"],
      ["paying", "check"],
      ["check", "packed", "[paid]"],
      ["check", "draft", "[declined]"],
      ["packed", "sent", "pickup"],
      ["sent", "done"],
      ["open", "draft", "cancel"],
      ["shipping", "done", "lost"],
    ],
  },
} satisfies DiagramComposeRequest;
const grouped = {
  spec: {
    kit: "flow",
    key: "grouped",
    nodes: [
      { key: "client", kind: "group", label: "Client" },
      { key: "server", kind: "group", label: "Server" },
      { key: "click", kind: "start", parent: "client" },
      { key: "post", parent: "client" },
      { key: "handle", parent: "server" },
      { key: "store", kind: "io", parent: "server" },
      { key: "tip", kind: "note", label: "Idempotent" },
    ],
    edges: [
      ["click", "post"],
      ["post", "handle", "POST /orders"],
      ["handle", "store"],
      ["store", "client", "201"],
    ],
  },
} satisfies DiagramComposeRequest;
function composeInto(editor: Editor, request: DiagramComposeRequest = checkout) {
  const records = editor.store.serialize("document");
  return compose(request, Object.values(records), {
    measureText,
    rehearse: (puts, deletes) =>
      new Map(Object.entries(rehearseDiagramChanges(editor, records, puts, deletes))),
    parseMermaid: () => Promise.reject(new Error("not expected")),
  });
}
function applyChanges(editor: Editor, changes: NonNullable<DiagramHostComposeResult["changes"]>) {
  editor.run(
    () => {
      editor.store.put(changes.puts.map(parseDocumentRecord));
      editor.store.remove(changes.deletes as TLRecord["id"][]);
    },
    { ignoreShapeLock: true },
  );
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

  it.each([
    ["a state machine with nested composites and notes", orders, "Orders"],
    ["a flowchart with groups", grouped, "grouped"],
  ])("pass the preflight for %s and recompose to no change", async (_, request, title) => {
    const editor = mount();
    addLooseShapes(editor);
    const { changes } = await composeInto(editor, request);
    assert(changes, "a new composition must produce changes");
    expect(() => validateDiagramBatch(editor, { requestId: "nested", ...changes })).not.toThrow();
    applyChanges(editor, changes);
    expect(
      editor
        .getCurrentPageShapes()
        .flatMap((shape) =>
          shape.type === "frame" && shape.parentId === editor.getCurrentPageId()
            ? [shape.props.name]
            : [],
        ),
    ).toEqual([title]);
    expect((await composeInto(editor, request)).changes).toBeNull();
  });

  it("moves a node between boundaries and absorbs tldraw's reparenting of a human arrow", async () => {
    const editor = mount();
    const { changes } = await composeInto(editor, grouped);
    assert(changes, "a new composition must produce changes");
    applyChanges(editor, changes);
    const shapeOf = (key: string) =>
      editor
        .getCurrentPageShapes()
        .find((shape) => (shape.meta["t3Composition"] as { m?: string } | undefined)?.m === key);
    const handle = shapeOf("handle");
    const click = shapeOf("click");
    assert(handle && click, "members must exist");
    const arrow = createShapeId("human-arrow");
    editor.createShape({ id: arrow, type: "arrow" });
    editor.createBindings(
      (["start", "end"] as const).map((terminal) => ({
        type: "arrow",
        fromId: arrow,
        toId: terminal === "start" ? click.id : handle.id,
        props: {
          terminal,
          normalizedAnchor: { x: 0.5, y: 0.5 },
          isExact: false,
          isPrecise: false,
          snap: "none",
        },
      })),
    );
    const moved = await composeInto(editor, {
      spec: {
        ...grouped.spec,
        nodes: grouped.spec.nodes.map((node) =>
          node.key === "handle" ? { ...node, parent: "client" } : node,
        ),
      },
    });
    const movedChanges = moved.changes;
    assert(movedChanges, "moving a node must produce changes");
    expect(() =>
      validateDiagramBatch(editor, { requestId: "move", ...movedChanges }),
    ).not.toThrow();
    applyChanges(editor, movedChanges);
    expect(editor.getShape(handle.id)?.parentId).toBe(editor.getShape(click.id)?.parentId);
    expect(editor.getShape(arrow)?.parentId).toBe(editor.getShape(click.id)?.parentId);
  });
});

type Changes = NonNullable<Awaited<ReturnType<typeof composeInto>>["changes"]>;
function applyComposed(editor: Editor, changes: Changes) {
  expect(() => validateDiagramBatch(editor, { requestId: "compose", ...changes })).not.toThrow();
  editor.run(
    () => {
      editor.store.put(changes.puts.map(parseDocumentRecord));
      editor.store.remove(changes.deletes as TLRecord["id"][]);
    },
    { ignoreShapeLock: true },
  );
}
function member(editor: Editor, key: string) {
  const shape = editor.getCurrentPageShapes().find((candidate) => {
    const meta = candidate.meta["t3Composition"];
    return (
      typeof meta === "object" &&
      meta !== null &&
      !Array.isArray(meta) &&
      meta["m"] === key &&
      meta["p"] === "main"
    );
  });
  assert(shape, `member ${key} is on the canvas`);
  return shape;
}
describe("regenerated batches", () => {
  it("pass the preflight after human edits, for new members, rewrites and relayout", async () => {
    const editor = mount();
    const first = await composeInto(editor);
    assert(first.changes, "a new composition must produce changes");
    applyComposed(editor, first.changes);

    const valid = member(editor, "valid");
    editor.updateShape({ id: valid.id, type: "geo", x: valid.x + 400 });
    editor.updateShape({ id: member(editor, "cart").id, type: "geo", props: { color: "red" } });
    editor.deleteShapes([member(editor, "receipt").id]);

    const next: DiagramComposeRequest = {
      spec: {
        ...checkout.spec,
        nodes: [
          ...checkout.spec.nodes.map((node) =>
            node.key === "pay" ? { ...node, label: "Take card payment" } : node,
          ),
          { key: "refund", label: "Refund" },
        ],
        edges: [...(checkout.spec.edges ?? []), ["valid", "refund", "no"]],
      },
    };
    const regenerated = await composeInto(editor, next);
    expect(regenerated.counts).toEqual({ created: 2, updated: 1, kept: 11, removed: 0 });
    assert(regenerated.changes, "the changed spec must produce changes");
    applyComposed(editor, regenerated.changes);
    expect(member(editor, "valid").x).toBe(valid.x + 400);
    expect(member(editor, "cart").props).toMatchObject({ color: "red" });

    const relayout = { ...next, relayout: true };
    const relaid = await composeInto(editor, relayout);
    assert(relaid.changes, "relayout must move the dragged member back");
    applyComposed(editor, relaid.changes);
    expect(member(editor, "cart").props).toMatchObject({ color: "red" });
    expect((await composeInto(editor, relayout)).changes).toBeNull();
    expect((await composeInto(editor, next)).changes).toBeNull();
  });
});
function compositionShapes(editor: Editor) {
  return editor.getCurrentPageShapes().filter((shape) => shape.meta["t3Composition"] !== undefined);
}
/** A note drawn inside the frame and an arrow from a loose shape to the `pay` member. */
function drawAround(editor: Editor) {
  const frame = editor.getCurrentPageShapes().find((shape) => shape.type === "frame");
  assert(frame, "the composition has a frame");
  const note = createShapeId("inside");
  const loose = createShapeId("loose");
  const arrow = createShapeId("human-arrow");
  editor.createShapes([
    {
      id: note,
      type: "text",
      parentId: frame.id,
      x: 20,
      y: 30,
      props: { richText: toRichText("mine") },
    },
    { id: loose, type: "geo", x: -400, y: 0 },
    { id: arrow, type: "arrow" },
  ]);
  editor.createBindings(
    (["start", "end"] as const).map((terminal) => ({
      type: "arrow",
      fromId: arrow,
      toId: terminal === "start" ? loose : member(editor, "pay").id,
      props: {
        terminal,
        normalizedAnchor: { x: 0.5, y: 0.5 },
        isExact: false,
        isPrecise: false,
        snap: "none",
      },
    })),
  );
  return { note, arrow, notePage: editor.getShapePageBounds(note)?.toJson() };
}

describe("patch, remove and detach batches", () => {
  it("patch one member and drop another, then remove keeping the user's shapes", async () => {
    const editor = mount();
    const first = await composeInto(editor);
    assert(first.changes, "a new composition must produce changes");
    applyComposed(editor, first.changes);
    const { note, arrow, notePage } = drawAround(editor);

    const patch: DiagramComposeRequest = {
      mode: "patch",
      spec: { kit: "flow", key: "checkout", nodes: [{ key: "pay", label: "Charge card" }] },
      removeKeys: ["receipt"],
    };
    const patched = await composeInto(editor, patch);
    expect(patched.counts).toEqual({ created: 0, updated: 1, kept: 8, removed: 3 });
    assert(patched.changes, "the patch must produce changes");
    applyComposed(editor, patched.changes);
    expect(editor.getShape(member(editor, "pay").id)?.props).toMatchObject({
      richText: toRichText("Charge card"),
    });
    expect((await composeInto(editor, patch)).changes).toBeNull();

    const remove: DiagramComposeRequest = { operation: "remove", key: "checkout" };
    const removed = await composeInto(editor, remove);
    assert(removed.changes, "removing must produce changes");
    applyComposed(editor, removed.changes);
    expect(compositionShapes(editor)).toEqual([]);
    expect(editor.getShape(note)?.parentId).toBe(editor.getCurrentPageId());
    expect(editor.getShapePageBounds(note)?.toJson()).toEqual(notePage);
    expect(editor.getShape(arrow)).toBeDefined();
    expect(editor.getBindingsFromShape(arrow, "arrow").map((binding) => binding.toId)).toEqual([
      createShapeId("loose"),
    ]);
    expect((await composeInto(editor, remove)).changes).toBeNull();
  });

  it("detach leaves the shapes as they are, and composing again starts a new composition", async () => {
    const editor = mount();
    const first = await composeInto(editor);
    assert(first.changes, "a new composition must produce changes");
    applyComposed(editor, first.changes);
    drawAround(editor);
    const strip = (shapes: TLShape[]) => shapes.map((shape) => ({ ...shape, meta: {} }));
    const before = strip(editor.getCurrentPageShapes());

    const detach: DiagramComposeRequest = { operation: "detach", key: "checkout" };
    const detached = await composeInto(editor, detach);
    assert(detached.changes, "detaching must produce changes");
    applyComposed(editor, detached.changes);
    expect(compositionShapes(editor)).toEqual([]);
    expect(strip(editor.getCurrentPageShapes())).toEqual(before);
    expect((await composeInto(editor, detach)).changes).toBeNull();

    const again = await composeInto(editor);
    expect(again.counts.created).toBe(12);
    assert(again.changes, "composing a detached key again must produce changes");
    applyComposed(editor, again.changes);
    expect(compositionShapes(editor)).toHaveLength(13);
    expect(strip(before.flatMap((shape) => editor.getShape(shape.id) ?? []))).toEqual(before);
  });
});

describe("removing boundaries", () => {
  function drawInside(editor: Editor, parentKey: string, name: string) {
    const id = createShapeId(name);
    editor.createShape({
      id,
      type: "text",
      parentId: member(editor, parentKey).id,
      x: 8,
      y: 12,
      props: { richText: toRichText(name) },
    });
    return { id, page: editor.getShapePageBounds(id)?.toJson() };
  }
  function expectKept(editor: Editor, shape: { id: TLShapeId; page: unknown }, parentId: string) {
    expect(editor.getShape(shape.id)?.parentId).toBe(parentId);
    expect(editor.getShapePageBounds(shape.id)?.toJson()).toEqual(shape.page);
  }

  it("keeps shapes a user drew inside a boundary the spec drops, a patch removes, or remove deletes", async () => {
    const editor = mount();
    const first = await composeInto(editor, grouped);
    assert(first.changes, "a new composition must produce changes");
    applyComposed(editor, first.changes);
    const frame = editor
      .getCurrentPageShapes()
      .find(
        (shape) =>
          shape.type === "frame" &&
          shape.meta["t3Composition"] !== undefined &&
          shape.parentId === editor.getCurrentPageId(),
      );
    assert(frame, "the composition has a frame");
    const inServer = drawInside(editor, "server", "in-server");
    const inClient = drawInside(editor, "client", "in-client");

    const withoutServer: DiagramComposeRequest = {
      spec: {
        ...grouped.spec,
        nodes: [
          { key: "client", kind: "group", label: "Client" },
          { key: "click", kind: "start", parent: "client" },
          { key: "post", parent: "client" },
          { key: "handle" },
          { key: "store", kind: "io" },
          { key: "tip", kind: "note", label: "Idempotent" },
        ],
      },
    };
    const replaced = await composeInto(editor, withoutServer);
    assert(replaced.changes, "dropping a boundary must produce changes");
    applyComposed(editor, replaced.changes);
    expectKept(editor, inServer, frame.id);

    const removeClient = {
      mode: "patch",
      spec: { kit: "flow", key: "grouped", nodes: [] },
      removeKeys: ["client"],
    } satisfies DiagramComposeRequest;
    await expect(composeInto(editor, removeClient)).rejects.toMatchObject({
      code: "invalid-spec",
      details: {
        issues: [
          {
            path: "removeKeys",
            message: '"client" still holds "click"; remove it too, or patch its parent',
          },
          {
            path: "removeKeys",
            message: '"client" still holds "post"; remove it too, or patch its parent',
          },
        ],
      },
    });
    const patched = await composeInto(editor, {
      ...removeClient,
      spec: { ...removeClient.spec, nodes: [{ key: "click", kind: "start" }, { key: "post" }] },
    });
    assert(patched.changes, "removing a boundary must produce changes");
    applyComposed(editor, patched.changes);
    expectKept(editor, inClient, frame.id);

    const removed = await composeInto(editor, { operation: "remove", key: "grouped" });
    assert(removed.changes, "removing must produce changes");
    applyComposed(editor, removed.changes);
    expect(compositionShapes(editor)).toEqual([]);
    expectKept(editor, inServer, editor.getCurrentPageId());
    expectKept(editor, inClient, editor.getCurrentPageId());
  });

  it("carries a shape out of a nested boundary when the whole composition is removed", async () => {
    const editor = mount();
    const first = await composeInto(editor, orders);
    assert(first.changes, "a new composition must produce changes");
    applyComposed(editor, first.changes);
    const deep = drawInside(editor, "shipping", "deep");
    const removed = await composeInto(editor, { operation: "remove", key: "orders" });
    assert(removed.changes, "removing must produce changes");
    applyComposed(editor, removed.changes);
    expect(compositionShapes(editor)).toEqual([]);
    expectKept(editor, deep, editor.getCurrentPageId());
  });
});
