import type { DiagramHostComposeResult, DiagramSpec, DiagramSpecNode } from "@t3tools/contracts";
import type { TLRecord, TLShape } from "@tldraw/tlschema";
import { describe, expect, it } from "vite-plus/test";

import { compose, type ComposePorts } from "./compose.ts";
import { readCompositions, validateComposeRequest } from "./model.ts";

const BASE = [
  { id: "document:document", typeName: "document", gridSize: 10, name: "", meta: {} },
  { id: "page:main", typeName: "page", name: "Page 1", index: "a1", meta: {} },
] as unknown as TLRecord[];

function rehearse(records: readonly TLRecord[]) {
  return (puts: readonly TLRecord[], deletes: readonly string[]) => {
    const after = new Map(records.map((record) => [record.id as string, record]));
    for (const record of puts) after.set(record.id, record);
    for (const id of deletes) after.delete(id);
    return after;
  };
}

/** 8px per character and 20px per line, wrapping at the width it gets. */
const ports = (records: readonly TLRecord[]): ComposePorts => ({
  measureText: (text, font) => {
    const width = text.length * 8;
    const max = font.maxWidth ?? width;
    return { w: Math.min(width, max), h: 20 * Math.max(1, Math.ceil(width / Math.max(1, max))) };
  },
  rehearse: rehearse(records),
  parseMermaid: () => Promise.reject(new Error("not expected")),
});

const run = (spec: DiagramSpec, records: readonly TLRecord[] = BASE) =>
  compose({ spec }, records, ports(records));

function applied(records: readonly TLRecord[], result: DiagramHostComposeResult): TLRecord[] {
  const puts = (result.changes?.puts ?? []) as TLRecord[];
  return Array.from(rehearse(records)(puts, result.changes?.deletes ?? []).values());
}

function memberOf(record: TLRecord): string | undefined {
  const meta = record.meta["t3Composition"];
  return meta && typeof meta === "object" && "m" in meta ? String(meta.m) : undefined;
}

function shapeOf(records: readonly TLRecord[], key: string): TLShape {
  const shape = records.find(
    (record): record is TLShape => record.typeName === "shape" && memberOf(record) === key,
  );
  if (!shape) throw new Error(`no member ${key}`);
  return shape;
}

/** Position and size within the screen; text shapes have no stored height. */
function box(records: readonly TLRecord[], key: string) {
  const shape = shapeOf(records, key);
  const props: Record<string, unknown> = { ...shape.props };
  return { x: shape.x, y: shape.y, w: props["w"], ...("h" in props ? { h: props["h"] } : {}) };
}

function edit(records: readonly TLRecord[], key: string, props: Record<string, unknown>) {
  const target = shapeOf(records, key);
  return records.map((record) =>
    record.id === target.id
      ? ({ ...target, props: { ...target.props, ...props } } as TLShape)
      : record,
  );
}

const screen = (key: string, body: Record<string, unknown>): DiagramSpecNode => ({ key, body });
const wireframe = (...nodes: DiagramSpecNode[]): DiagramSpec => ({
  kit: "wireframe",
  key: "app",
  nodes,
});

const FORM = wireframe(
  screen("home", {
    padding: 16,
    gap: 8,
    children: [
      { key: "title", kind: "heading", label: "Hi" },
      { key: "a", kind: "button", label: "A" },
      { key: "b", kind: "button", label: "B" },
    ],
  }),
);
const withInserted = (spec: DiagramSpec) =>
  wireframe(
    screen("home", {
      padding: 16,
      gap: 8,
      children: [
        { key: "title", kind: "heading", label: "Hi" },
        { key: "a", kind: "button", label: "A" },
        { key: "x", kind: "button", label: "X" },
        { key: "b", kind: "button", label: "B" },
      ],
    }),
    ...spec.nodes.slice(1),
  );

describe("the stack engine", () => {
  it("stacks elements inside the screen's padding with gaps, stretched across it", async () => {
    const records = applied(BASE, await run(FORM));
    expect(box(records, "home")).toEqual({ x: 48, y: 48, w: 393, h: 852 });
    expect(box(records, "home.title")).toEqual({ x: 16, y: 16, w: 361 });
    expect(box(records, "home.a")).toEqual({ x: 16, y: 48, w: 361, h: 52 });
    expect(box(records, "home.b")).toEqual({ x: 16, y: 108, w: 361, h: 52 });
    expect(shapeOf(records, "home.a").parentId).toBe(shapeOf(records, "home").id);
  });

  it("pushes later elements down when one is inserted, touching no other member's content", async () => {
    const before = applied(BASE, await run(FORM));
    const result = await run(withInserted(FORM), before);
    expect(result.counts).toEqual({ created: 1, updated: 0, kept: 4, removed: 0 });
    const after = applied(before, result);
    expect(box(after, "home.a")).toEqual({ x: 16, y: 48, w: 361, h: 52 });
    expect(box(after, "home.x")).toEqual({ x: 16, y: 108, w: 361, h: 52 });
    expect(box(after, "home.b")).toEqual({ x: 16, y: 168, w: 361, h: 52 });
    expect(readCompositions(after).summaries[0]?.editedCount).toBe(0);
    expect((await run(withInserted(FORM), after)).changes).toBeNull();
  });

  it("gives fill children the space left over and fixed children their size", async () => {
    const records = applied(
      BASE,
      await run(
        wireframe(
          screen("tabs", {
            padding: 0,
            gap: 0,
            children: [
              { key: "top", kind: "navBar", label: "Top" },
              {
                kind: "stack",
                size: "fill",
                padding: 20,
                children: [
                  {
                    kind: "row",
                    gap: 10,
                    children: [
                      { key: "name", kind: "input", label: "Name", size: "fill" },
                      { key: "go", kind: "button", label: "Go", size: 80 },
                    ],
                  },
                ],
              },
              { key: "bottom", kind: "tabBar", label: "Home · Me" },
            ],
          }),
        ),
      ),
    );
    expect(box(records, "tabs.top")).toEqual({ x: 0, y: 0, w: 393, h: 56 });
    expect(box(records, "tabs.name")).toEqual({ x: 20, y: 76, w: 263, h: 52 });
    expect(box(records, "tabs.go")).toEqual({ x: 293, y: 76, w: 80, h: 52 });
    expect(box(records, "tabs.bottom")).toEqual({ x: 0, y: 796, w: 393, h: 56 });
  });

  it("aligns children across a container and pads a card around what it holds", async () => {
    const records = applied(
      BASE,
      await run(
        wireframe(
          screen("profile", {
            children: [
              { key: "me", kind: "avatar" },
              {
                kind: "stack",
                align: "center",
                children: [{ key: "ok", kind: "button", label: "OK" }],
              },
              {
                kind: "stack",
                align: "end",
                children: [{ key: "end", kind: "button", label: "End" }],
              },
              {
                key: "box",
                kind: "card",
                children: [{ key: "hello", kind: "text", label: "Hello" }],
              },
            ],
          }),
        ),
      ),
    );
    expect(box(records, "profile.me")).toEqual({ x: 24, y: 24, w: 48, h: 48 });
    expect(box(records, "profile.ok")).toEqual({ x: 149, y: 88, w: 96, h: 52 });
    expect(box(records, "profile.end")).toEqual({ x: 273, y: 156, w: 96, h: 52 });
    expect(box(records, "profile.box")).toEqual({ x: 24, y: 224, w: 345, h: 52 });
    expect(box(records, "profile.hello")).toEqual({ x: 40, y: 240, w: 313 });
  });

  it("puts chrome on top and a modal's contents in a centered sheet over a backdrop", async () => {
    const records = applied(
      BASE,
      await run(
        wireframe(
          screen("web", {
            device: "web",
            chrome: true,
            children: [{ key: "hero", kind: "image", label: "Hero", size: 300 }],
          }),
          screen("confirm", {
            device: "tablet",
            landscape: true,
            modal: true,
            children: [{ key: "yes", kind: "button", label: "Yes" }],
          }),
        ),
      ),
    );
    expect(box(records, "web")).toEqual({ x: 48, y: 48, w: 1440, h: 900 });
    expect(box(records, "web.chrome")).toEqual({ x: 0, y: 0, w: 1440, h: 44 });
    expect(box(records, "web.hero")).toEqual({ x: 24, y: 68, w: 1392, h: 300 });
    expect(box(records, "confirm")).toEqual({ x: 1536, y: 81, w: 1194, h: 834 });
    expect(box(records, "confirm.backdrop")).toEqual({ x: 0, y: 0, w: 1194, h: 834 });
    expect(box(records, "confirm.sheet")).toEqual({ x: 357, y: 367, w: 480, h: 100 });
    expect(box(records, "confirm.yes")).toEqual({ x: 381, y: 391, w: 432, h: 52 });
    const order = ["confirm.backdrop", "confirm.sheet", "confirm.yes"].map(
      (key) => shapeOf(records, key).index,
    );
    expect([...order].sort()).toEqual(order);
  });
});

describe("regenerating screens", () => {
  it("merges per element: a human edit to one element survives an agent change to another", async () => {
    let records = applied(BASE, await run(FORM));
    records = edit(records, "home.a", { color: "red" });
    const relabeled = wireframe(
      screen("home", {
        padding: 16,
        gap: 8,
        children: [
          { key: "title", kind: "heading", label: "Hi" },
          { key: "a", kind: "button", label: "A" },
          { key: "b", kind: "button", label: "Next step" },
        ],
      }),
    );
    const result = await run(relabeled, records);
    expect(result.counts).toEqual({ created: 0, updated: 1, kept: 3, removed: 0 });
    const after = applied(records, result);
    expect(shapeOf(after, "home.a").props).toMatchObject({ color: "red" });
    expect(shapeOf(after, "home.b").props).toMatchObject({
      richText: { content: [{ content: [{ text: "Next step" }] }] },
    });

    const conflicting = wireframe(
      screen("home", {
        padding: 16,
        gap: 8,
        children: [
          { key: "title", kind: "heading", label: "Hi" },
          { key: "a", kind: "button", label: "Again" },
        ],
      }),
    );
    await expect(run(conflicting, after)).rejects.toMatchObject({
      code: "conflict",
      details: { members: ["home.a"] },
    });
  });

  it("leaves a screen nothing changed alone, including elements a human moved", async () => {
    const two = wireframe(
      ...FORM.nodes,
      screen("other", { children: [{ key: "t", kind: "text" }] }),
    );
    let records = applied(BASE, await run(two));
    const moved = shapeOf(records, "home.a");
    records = records.map((record) => (record.id === moved.id ? { ...moved, x: 200 } : record));
    const changed = wireframe(
      ...FORM.nodes,
      screen("other", { children: [{ key: "t", kind: "text", label: "Changed" }] }),
    );
    const after = applied(records, await run(changed, records));
    expect(box(after, "home.a").x).toBe(200);
    expect(box(after, "other.t")).toEqual({ x: 24, y: 24, w: 345 });
  });

  it("keeps a deleted element deleted, and relays out its screen when the spec drops it", async () => {
    let records = applied(BASE, await run(withInserted(FORM)));
    const x = shapeOf(records, "home.x");
    records = records.filter((record) => record.id !== x.id);
    expect((await run(withInserted(FORM), records)).changes).toBeNull();
    const after = applied(records, await run(FORM, records));
    expect(box(after, "home.b").y).toBe(108);
  });

  it("brings back a deleted screen's elements when its spec changes", async () => {
    let records = applied(BASE, await run(FORM));
    const home = shapeOf(records, "home");
    records = records.filter(
      (record) =>
        record.id !== home.id && !(record.typeName === "shape" && record.parentId === home.id),
    );
    const renamed = wireframe({ ...FORM.nodes[0]!, label: "Home" });
    const after = applied(records, await run(renamed, records));
    expect(box(after, "home.b")).toEqual({ x: 16, y: 108, w: 361, h: 52 });
  });
});

describe("patching screens", () => {
  const patch = (spec: DiagramSpec, records: readonly TLRecord[], removeKeys?: string[]) =>
    compose(
      { spec, mode: "patch", ...(removeKeys ? { removeKeys } : {}) },
      records,
      ports(records),
    );
  const TWO = wireframe(...FORM.nodes, screen("other", { children: [{ key: "t", kind: "text" }] }));

  it("inserts into a listed screen like a replace would, leaving other screens alone", async () => {
    let records = applied(BASE, await run(TWO));
    records = edit(records, "home.a", { color: "red" });
    const result = await patch(withInserted(FORM), records);
    expect(result.counts).toEqual({ created: 1, updated: 0, kept: 6, removed: 0 });
    const after = applied(records, result);
    expect(box(after, "home.x")).toEqual({ x: 16, y: 108, w: 361, h: 52 });
    expect(box(after, "home.b")).toEqual({ x: 16, y: 168, w: 361, h: 52 });
    expect(shapeOf(after, "home.a").props).toMatchObject({ color: "red" });
    expect((await run(withInserted(TWO), after)).changes).toBeNull();
  });

  it("drops elements a listed screen no longer has, and a removed screen's elements", async () => {
    const records = applied(BASE, await run(TWO));
    const dropped = applied(
      records,
      await patch(
        wireframe(
          screen("home", {
            padding: 16,
            gap: 8,
            children: [
              { key: "title", kind: "heading", label: "Hi" },
              { key: "b", kind: "button", label: "B" },
            ],
          }),
        ),
        records,
      ),
    );
    expect(() => shapeOf(dropped, "home.a")).toThrow("no member home.a");
    expect(box(dropped, "home.b").y).toBe(48);
    expect(box(dropped, "other.t")).toEqual(box(records, "other.t"));

    const result = await patch(wireframe(), records, ["home"]);
    expect(result.counts).toEqual({ created: 0, updated: 0, kept: 2, removed: 4 });
  });
});

describe("validating screens", () => {
  it("teaches element kinds, fields and keys, and rejects edges", () => {
    const issues = (spec: DiagramSpec) => {
      try {
        validateComposeRequest({ spec });
        return [];
      } catch (error) {
        return (error as { details?: { issues?: unknown[] } }).details?.issues ?? [];
      }
    };
    expect(
      issues({
        ...wireframe(
          screen("s", {
            device: "watch",
            children: [
              { key: "a", kind: "btn" },
              { key: "d", kind: "image", size: "big" },
              { kind: "row", children: [{ key: "e", kind: "text", colour: "red" }] },
            ],
          }),
        ),
        edges: [["s", "s"]],
      }),
    ).toEqual([
      {
        path: "spec.nodes[0].body.children[2].children[0].colour",
        message:
          'unknown field "colour" for kind "screen"; valid fields: key, kind, label, size, gap, padding, align, children',
      },
      {
        path: "spec.nodes[0].body.device",
        message: 'Expected "phone" | "tablet" | "web"',
      },
      {
        path: "spec.nodes[0].body.children[0].kind",
        message:
          'Expected "navBar" | "tabBar" | "button" | "input" | "text" | "heading" | "image" | "card" | "listItem" | "toggle" | "avatar" | "divider" | "stack" | "row"',
      },
      { path: "spec.nodes[0].body.children[1].size", message: 'Expected "fill" | number' },
      { path: "spec.edges", message: "kit wireframe has no edges" },
    ]);
    expect(
      issues(
        wireframe(
          screen("s", {
            children: [
              { key: "b", kind: "toggle", label: "On" },
              {
                kind: "row",
                children: [
                  { key: "c", kind: "text" },
                  { key: "c", kind: "text" },
                ],
              },
              { key: "chrome", kind: "divider" },
              { kind: "card", children: [] },
              { key: "r", kind: "row" },
            ],
          }),
        ),
      ),
    ).toEqual([
      {
        path: "spec.nodes[0].body.children[0].label",
        message: 'toggle takes no field "label"; valid fields: key, kind, size',
      },
      {
        path: "spec.nodes[0].body.children[1].children[1].key",
        message: 'duplicate element key "c" in screen "s"',
      },
      {
        path: "spec.nodes[0].body.children[2].key",
        message: '"chrome" is reserved for the screen\'s own parts (chrome, backdrop, sheet)',
      },
      {
        path: "spec.nodes[0].body.children[3].key",
        message: "card needs a key, unique within the screen",
      },
      {
        path: "spec.nodes[0].body.children[4].key",
        message:
          'row takes no field "key"; valid fields: kind, size, gap, padding, align, children',
      },
    ]);
  });

  it("reads elements back keyed screen.element", async () => {
    const records = applied(BASE, await run(FORM));
    const page = readCompositions(records).detail({ offset: 0, limit: 10 });
    expect(page.items[0]?.members.map(({ spec }) => spec.key)).toEqual([
      "home",
      "home.title",
      "home.a",
      "home.b",
    ]);
    expect(page.items[0]?.members[2]).toEqual({
      spec: { key: "home.a", kind: "button", label: "A", parent: "home" },
      edited: false,
    });
  });
});
