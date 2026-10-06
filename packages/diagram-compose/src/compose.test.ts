import {
  type DiagramHostComposeResult,
  type DiagramSpec,
  DiagramSpecEdge,
} from "@t3tools/contracts";
import { toRichText, type TLRecord, type TLShape } from "@tldraw/tlschema";
import * as Schema from "effect/Schema";
import { assert, describe, expect, it } from "vite-plus/test";

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

function portsFor(records: readonly TLRecord[]): ComposePorts {
  return {
    measureText: (text) => {
      const lines = text.split("\n");
      return { w: 8 * Math.max(...lines.map((line) => line.length)), h: 22 * lines.length };
    },
    rehearse: rehearse(records),
    parseMermaid: () => Promise.reject(new Error("not expected")),
  };
}

const run = (spec: DiagramSpec, records: readonly TLRecord[] = BASE) =>
  compose({ spec }, records, portsFor(records));

function applied(records: readonly TLRecord[], result: DiagramHostComposeResult): TLRecord[] {
  const after = rehearse(records)(
    (result.changes?.puts ?? []) as TLRecord[],
    result.changes?.deletes ?? [],
  );
  return Array.from(after.values());
}

function shapes(result: DiagramHostComposeResult): TLShape[] {
  return ((result.changes?.puts ?? []) as TLRecord[]).filter(
    (record): record is TLShape => record.typeName === "shape",
  );
}

function memberKey(record: TLRecord): unknown {
  const meta = record.meta["t3Composition"];
  return meta && typeof meta === "object" && "m" in meta ? meta.m : undefined;
}

const CHECKOUT: DiagramSpec = {
  kit: "flow",
  key: "checkout",
  nodes: [{ key: "start", kind: "start" }, { key: "pay" }, { key: "ok", kind: "decision" }],
  edges: [
    ["start", "pay"],
    ["pay", "ok"],
    ["ok", "pay", "no"],
  ],
};

describe("compose", () => {
  it("is deterministic", async () => {
    expect(await run(CHECKOUT)).toEqual(await run(CHECKOUT));
  });

  it("gives shorthand and full form the same batch", async () => {
    const full: DiagramSpec = {
      kit: "flow",
      key: "checkout",
      title: "checkout",
      direction: "down",
      nodes: [
        { key: "start", kind: "start", label: "start" },
        { key: "pay", kind: "process", label: "pay" },
        { key: "ok", kind: "decision", label: "ok" },
      ],
      edges: [
        { key: "start→pay:flow", from: "start", to: "pay", kind: "flow" },
        { from: "pay", to: "ok", kind: "flow", label: "" },
        { from: "ok", to: "pay", label: "no" },
      ],
    };
    expect(await run(full)).toEqual(await run(CHECKOUT));
  });

  it("derives edge keys from endpoints and kind, numbering repeats in spec order", async () => {
    const result = await run({
      kit: "flow",
      key: "loops",
      nodes: [{ key: "a" }, { key: "b" }],
      edges: [["a", "b"], ["b", "a"], ["a", "b", "again"], { key: "named", from: "a", to: "b" }],
    });
    const arrows = shapes(result).filter((shape) => shape.type === "arrow");
    expect(arrows.map(memberKey)).toEqual(["a→b:flow", "b→a:flow", "a→b:flow#2", "named"]);
  });

  it("creates a frame, geo nodes and bound elbow arrows with every prop tldraw stores", async () => {
    const result = await run(CHECKOUT);
    expect(result.counts).toEqual({ created: 6, updated: 0, kept: 0, removed: 0 });
    const puts = (result.changes?.puts ?? []) as TLRecord[];
    expect(
      puts.map((record) => (record.typeName === "shape" ? record.type : record.typeName)),
    ).toEqual([
      "frame",
      "geo",
      "geo",
      "geo",
      "arrow",
      "arrow",
      "arrow",
      "binding",
      "binding",
      "binding",
      "binding",
      "binding",
      "binding",
    ]);
    const keysOf = (type: string) => {
      const record = puts.find(
        (put) => (put.typeName === "shape" ? put.type : put.typeName) === type,
      );
      return (
        record &&
        "props" in record && {
          record: Object.keys(record).sort(),
          props: Object.keys(record.props).sort(),
        }
      );
    };
    const shapeKeys = [
      "id",
      "index",
      "isLocked",
      "meta",
      "opacity",
      "parentId",
      "props",
      "rotation",
      "type",
      "typeName",
      "x",
      "y",
    ];
    expect(keysOf("frame")).toEqual({ record: shapeKeys, props: ["color", "h", "name", "w"] });
    expect(keysOf("geo")).toEqual({
      record: shapeKeys,
      props: [
        "align",
        "color",
        "dash",
        "fill",
        "flipX",
        "flipY",
        "font",
        "geo",
        "growY",
        "h",
        "labelColor",
        "richText",
        "scale",
        "size",
        "url",
        "verticalAlign",
        "w",
      ],
    });
    expect(keysOf("arrow")).toEqual({
      record: shapeKeys,
      props: [
        "arrowheadEnd",
        "arrowheadStart",
        "bend",
        "color",
        "dash",
        "elbowMidPoint",
        "end",
        "fill",
        "font",
        "kind",
        "labelColor",
        "labelPosition",
        "richText",
        "scale",
        "size",
        "start",
      ],
    });
    expect(keysOf("binding")).toEqual({
      record: ["fromId", "id", "meta", "props", "toId", "type", "typeName"],
      props: ["isExact", "isPrecise", "normalizedAnchor", "snap", "terminal"],
    });

    const decision = shapes(result).find((shape) => memberKey(shape) === "ok");
    expect(decision?.props).toMatchObject({
      geo: "diamond",
      color: "yellow",
      fill: "semi",
      dash: "solid",
      font: "sans",
      richText: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "ok" }] }],
      },
    });
    const branch = shapes(result).find((shape) => memberKey(shape) === "ok→pay:flow");
    expect(branch?.props).toMatchObject({ kind: "elbow", arrowheadEnd: "arrow", font: "sans" });
    expect(
      result.changes?.expected.flatMap((entry) => (entry.record === null ? [] : [entry.id])),
    ).toEqual(["page:main"]);
  });

  it("parents arrows to the frame, above both endpoints and below the next node", async () => {
    const result = await run({
      kit: "flow",
      key: "order",
      nodes: [{ key: "a" }, { key: "b" }, { key: "c" }, { key: "d" }],
      edges: [
        ["c", "a"],
        ["a", "b"],
        ["b", "d"],
        ["d", "a"],
      ],
    });
    const all = shapes(result);
    const frame = all.find((shape) => shape.type === "frame");
    const siblings = all
      .filter((shape) => shape.parentId === frame?.id)
      .sort((x, y) => (x.index < y.index ? -1 : 1))
      .map((shape) => memberKey(shape));
    expect(siblings).toEqual(["a", "b", "a→b:flow", "c", "c→a:flow", "d", "b→d:flow", "d→a:flow"]);
  });

  it("places a new composition right of existing content on the first page", async () => {
    const note = {
      id: "shape:human",
      typeName: "shape",
      type: "geo",
      x: 100,
      y: -40,
      rotation: 0,
      index: "a1",
      parentId: "page:main",
      isLocked: false,
      opacity: 1,
      meta: {},
      props: { w: 200, h: 100, growY: 0 },
    } as unknown as TLRecord;
    const frame = shapes(await run(CHECKOUT, [...BASE, note])).find(
      (shape) => shape.type === "frame",
    );
    expect(frame && { x: frame.x, y: frame.y, index: frame.index }).toEqual({
      x: 460,
      y: -40,
      index: "a2",
    });
  });

  it("changes nothing when the identical spec is composed again, without measuring or rehearsing", async () => {
    const records = applied(BASE, await run(CHECKOUT));
    const fail = () => {
      throw new Error("not expected");
    };
    expect(
      await compose({ spec: CHECKOUT }, records, {
        measureText: fail,
        rehearse: fail,
        parseMermaid: fail,
      }),
    ).toEqual({
      changes: null,
      counts: { created: 0, updated: 0, kept: 6, removed: 0 },
      overlaps: [],
    });
  });

  it("updates an unedited member whose spec changed and removes dropped ones", async () => {
    const records = applied(BASE, await run(CHECKOUT));
    const next: DiagramSpec = {
      ...CHECKOUT,
      nodes: [
        { key: "start", kind: "start" },
        { key: "pay", label: "Pay now" },
      ],
      edges: [["start", "pay"]],
    };
    const result = await run(next, records);
    expect(result.counts).toEqual({ created: 0, updated: 1, kept: 2, removed: 3 });
    expect(result.changes?.deletes).toHaveLength(7);
    const pay = shapes(result).find((shape) => memberKey(shape) === "pay");
    expect(pay?.props).toMatchObject({
      richText: { content: [{ content: [{ text: "Pay now" }] }] },
    });
  });

  it("fails with a conflict naming members the spec and a human both changed", async () => {
    const records = applied(BASE, await run(CHECKOUT)).map((record) =>
      memberKey(record) === "pay" && record.typeName === "shape" && record.type === "geo"
        ? { ...record, props: { ...record.props, color: "red" as const } }
        : record,
    );
    const next: DiagramSpec = {
      ...CHECKOUT,
      nodes: CHECKOUT.nodes.map((node) => ({ ...node, label: "x" })),
    };
    await expect(run(next, records)).rejects.toMatchObject({
      code: "conflict",
      details: { members: ["pay"] },
    });
  });

  it("adds tldraw's rewrites of records it did not write to the batch", async () => {
    const human = {
      id: "shape:human",
      typeName: "shape",
      meta: {},
      props: {},
    } as unknown as TLRecord;
    const records = [...BASE, human];
    const touched = { ...human, x: 5 } as TLRecord;
    const result = await compose({ spec: CHECKOUT }, records, {
      ...portsFor(records),
      rehearse: (puts, deletes) => new Map(rehearse(records)(puts, deletes)).set(human.id, touched),
    });
    expect(result.changes?.puts.at(-1)).toEqual(touched);
    expect(result.changes?.expected.find((entry) => entry.id === human.id)).toEqual({
      id: "shape:human",
      record: human,
    });
  });

  it("fails too-large when the composition exceeds one batch", async () => {
    const nodes = Array.from({ length: 200 }, (_, i) => ({ key: `n${i}` }));
    const edges = Array.from({ length: 100 }, (_, i): [string, string] => [`n${i}`, `n${i + 1}`]);
    await expect(run({ kit: "flow", key: "big", nodes, edges })).rejects.toMatchObject({
      code: "too-large",
    });
  });
});

const failingPorts: ComposePorts = {
  measureText: () => {
    throw new Error("measured");
  },
  parseMermaid: () => Promise.reject(new Error("parsed")),
  rehearse: () => {
    throw new Error("rehearsed");
  },
};

function part(record: TLRecord): unknown {
  const meta = record.meta["t3Composition"];
  return meta && typeof meta === "object" && "p" in meta ? meta.p : undefined;
}

function mainOf(records: readonly TLRecord[], key: string): TLShape {
  const shape = records.find(
    (record): record is TLShape =>
      record.typeName === "shape" && memberKey(record) === key && part(record) === "main",
  );
  if (!shape) throw new Error(`no member ${key}`);
  return shape;
}

/** Replaces a member's main shape, as a human or a raw apply batch would. */
function change(
  records: readonly TLRecord[],
  key: string,
  edit: (shape: TLShape) => TLShape,
): TLRecord[] {
  const target = mainOf(records, key);
  return records.map((record) => (record.id === target.id ? edit(target) : record));
}

/** Deletes a node the way tldraw does: the shape and every binding to it. */
function deleteNode(records: readonly TLRecord[], key: string): TLRecord[] {
  const target = mainOf(records, key);
  return records.filter(
    (record) =>
      record.id !== target.id && !(record.typeName === "binding" && record.toId === target.id),
  );
}

function box(shape: TLShape) {
  const size = "w" in shape.props && "h" in shape.props ? shape.props : { w: 0, h: 0 };
  return { x: shape.x, y: shape.y, w: size.w, h: size.h };
}

function moved(shape: TLShape, x: number, y: number): TLShape {
  return { ...shape, x, y };
}

/** A prop edit; tests only set props the shape type has. */
function withProps(shape: TLShape, props: Record<string, unknown>): TLShape {
  return { ...shape, props: { ...shape.props, ...props } } as TLShape;
}

const recolored = (shape: TLShape) => withProps(shape, { color: "red" });

/** Member keys of the shapes a compose writes, frame excluded, in put order. */
function writtenMembers(result: DiagramHostComposeResult): unknown[] {
  return shapes(result)
    .filter((shape) => shape.type !== "frame")
    .map(memberKey);
}

const frameOf = (records: readonly TLRecord[]) =>
  records.find(
    (record): record is TLShape => record.typeName === "shape" && record.type === "frame",
  );

const WITH_SHIP: DiagramSpec = {
  ...CHECKOUT,
  nodes: [...CHECKOUT.nodes, { key: "ship" }],
  edges: [...(CHECKOUT.edges ?? []), ["ok", "ship", "yes"]],
};

describe("regeneration", () => {
  it("leaves human edits, moves and deletions alone when the spec is unchanged", async () => {
    let records = applied(BASE, await run(CHECKOUT));
    records = change(records, "pay", recolored);
    records = change(records, "start", (shape) => moved(shape, 900, 900));
    records = deleteNode(records, "ok");
    expect(await compose({ spec: CHECKOUT }, records, failingPorts)).toEqual({
      changes: null,
      counts: { created: 0, updated: 0, kept: 6, removed: 0 },
      overlaps: [],
    });
  });

  it("rewrites an unedited member whose spec changed at its moved top-left, sized to the new label", async () => {
    let records = applied(BASE, await run(CHECKOUT));
    records = change(records, "pay", (shape) =>
      withProps(moved(shape, 300, 600), { w: 400, h: 300 }),
    );
    records = change(records, "start", recolored);
    const result = await run(
      {
        ...CHECKOUT,
        nodes: [
          { key: "start", kind: "start" },
          { key: "pay", label: "Take payment by card" },
          { key: "ok", kind: "decision" },
        ],
      },
      records,
    );
    expect(result.counts).toEqual({ created: 0, updated: 1, kept: 5, removed: 0 });
    expect(writtenMembers(result)).toEqual(["pay"]);
    const after = applied(records, result);
    expect(box(mainOf(after, "pay"))).toEqual({ x: 300, y: 600, w: 192, h: 72 });
    expect(mainOf(after, "start").props).toMatchObject({ color: "red" });
    expect(box(frameOf(after)!)).toEqual({ x: 0, y: 0, w: 540, h: 720 });
  });

  it("recreates a deleted member whose spec changed and rebinds its unedited edges", async () => {
    const records = deleteNode(applied(BASE, await run(CHECKOUT)), "ok");
    const result = await run(
      {
        ...CHECKOUT,
        nodes: [
          { key: "start", kind: "start" },
          { key: "pay" },
          { key: "ok", kind: "decision", label: "Paid?" },
        ],
      },
      records,
    );
    expect(result.counts).toEqual({ created: 1, updated: 2, kept: 3, removed: 0 });
    expect(writtenMembers(result)).toEqual(["ok", "pay→ok:flow", "ok→pay:flow"]);
    const after = applied(records, result);
    const ok = mainOf(after, "ok");
    expect(
      after.flatMap((record) =>
        record.typeName === "binding" && record.toId === ok.id ? [memberKey(record)] : [],
      ),
    ).toEqual(["pay→ok:flow", "ok→pay:flow"]);
    expect(readCompositions(after).summaries[0]?.editedCount).toBe(0);
  });

  it("forgets a deleted member the spec dropped and removes its unedited edges", async () => {
    const records = deleteNode(applied(BASE, await run(CHECKOUT)), "ok");
    const reduced: DiagramSpec = {
      ...CHECKOUT,
      nodes: CHECKOUT.nodes.slice(0, 2),
      edges: [["start", "pay"]],
    };
    const result = await run(reduced, records);
    expect(result.counts).toEqual({ created: 0, updated: 0, kept: 3, removed: 2 });
    const byId = new Map(records.map((record) => [record.id as string, record]));
    expect(
      result.changes?.deletes.map((id) => {
        const record = byId.get(id);
        return record && [memberKey(record), part(record)];
      }),
    ).toEqual([
      ["pay→ok:flow", "start"],
      ["pay→ok:flow", "main"],
      ["ok→pay:flow", "end"],
      ["ok→pay:flow", "main"],
    ]);
    expect((await run(reduced, applied(records, result))).changes).toBeNull();
  });

  it("fails atomically naming every node and edge that both the spec and someone else changed", async () => {
    let records = applied(BASE, await run(CHECKOUT));
    records = change(records, "pay", (shape) =>
      withProps(shape, { richText: toRichText("Pay up") }),
    );
    records = change(records, "ok", recolored);
    records = change(records, "start→pay:flow", recolored);
    records = change(records, "ok→pay:flow", (shape) => withProps(shape, { dash: "dotted" }));
    const start = mainOf(records, "start");
    records = records.map((record) =>
      record.typeName === "binding" && memberKey(record) === "pay→ok:flow" && part(record) === "end"
        ? { ...record, toId: start.id }
        : record,
    );
    const next: DiagramSpec = {
      ...CHECKOUT,
      nodes: [
        { key: "start", kind: "start" },
        { key: "pay", label: "Pay" },
      ],
      edges: [["start", "pay", "go"]],
    };
    await expect(compose({ spec: next }, records, failingPorts)).rejects.toMatchObject({
      code: "conflict",
      details: { members: ["pay", "start→pay:flow", "ok", "pay→ok:flow", "ok→pay:flow"] },
    });
  });

  it("places a new member next to its moved neighbor without moving existing members", async () => {
    const records = change(applied(BASE, await run(CHECKOUT)), "ok", (shape) =>
      moved(shape, 448, 336),
    );
    const result = await run(WITH_SHIP, records);
    expect(result.counts).toEqual({ created: 2, updated: 0, kept: 6, removed: 0 });
    expect(writtenMembers(result)).toEqual(["ship", "ok→ship:flow"]);
    const after = applied(records, result);
    expect(box(mainOf(after, "ship"))).toEqual({ x: 448, y: 520, w: 160, h: 72 });
    expect(box(frameOf(after)!)).toEqual({ x: 0, y: 0, w: 656, h: 640 });
    expect(result.overlaps).toEqual([]);
  });

  it("moves a new member across the flow past members in its way", async () => {
    const records = change(applied(BASE, await run(CHECKOUT)), "ok", (shape) =>
      moved(shape, 256, 336),
    );
    const result = await run(
      {
        ...CHECKOUT,
        nodes: [...CHECKOUT.nodes, { key: "refund" }],
        edges: [...(CHECKOUT.edges ?? []), ["pay", "refund"]],
      },
      records,
    );
    // Laid out beside ok's old spot, then past ok (256 + 160) plus the gap.
    expect(box(mainOf(applied(records, result), "refund"))).toEqual({
      x: 464,
      y: 336,
      w: 160,
      h: 72,
    });
    expect(result.overlaps).toEqual([]);
  });

  it("ignores shapes a human drew inside the frame", async () => {
    let records = change(applied(BASE, await run(CHECKOUT)), "ok", (shape) =>
      moved(shape, 448, 336),
    );
    const human = {
      ...mainOf(records, "pay"),
      id: "shape:human",
      x: 448,
      y: 520,
      meta: {},
    } as TLShape;
    records = [...records, human];
    const result = await run(WITH_SHIP, records);
    expect(shapes(result).some((shape) => shape.id === human.id)).toBe(false);
    expect(box(mainOf(applied(records, result), "ship"))).toEqual({
      x: 448,
      y: 520,
      w: 160,
      h: 72,
    });
    expect(result.overlaps).toEqual([]);
  });

  it("relays out every member only on request, deterministically, keeping content and sizes", async () => {
    const fresh = applied(BASE, await run(CHECKOUT));
    let records = change(fresh, "ok", (shape) => moved(shape, 448, 336));
    records = change(records, "pay", (shape) => recolored(moved(shape, 0, 900)));
    expect((await run(CHECKOUT, records)).changes).toBeNull();

    const result = await compose({ spec: CHECKOUT, relayout: true }, records, portsFor(records));
    expect(result.counts).toEqual({ created: 0, updated: 0, kept: 6, removed: 0 });
    expect(writtenMembers(result)).toEqual(["pay", "ok"]);
    const after = applied(records, result);
    for (const key of ["start", "pay", "ok"])
      expect(box(mainOf(after, key))).toEqual(box(mainOf(fresh, key)));
    expect(mainOf(after, "pay").props).toMatchObject({ color: "red" });
    expect(readCompositions(after).summaries[0]?.editedCount).toBe(1);
    expect(
      (await compose({ spec: CHECKOUT, relayout: true }, after, portsFor(after))).changes,
    ).toBeNull();
  });

  it("keeps a human-resized member's size through relayout", async () => {
    const records = change(applied(BASE, await run(CHECKOUT)), "pay", (shape) =>
      withProps(shape, { w: 400 }),
    );
    const result = await compose({ spec: CHECKOUT, relayout: true }, records, portsFor(records));
    expect(box(mainOf(applied(records, result), "pay")).w).toBe(400);
  });

  it("reports node members that overlap, even when nothing changes", async () => {
    let records = applied(BASE, await run(CHECKOUT));
    const start = mainOf(records, "start");
    records = change(records, "pay", (shape) => moved(shape, start.x + 10, start.y + 10));
    expect(await run(CHECKOUT, records)).toEqual({
      changes: null,
      counts: { created: 0, updated: 0, kept: 6, removed: 0 },
      overlaps: [["start", "pay"]],
    });
  });
});

const byId = (records: readonly TLRecord[]) =>
  Object.fromEntries(records.map((record) => [record.id, record]));

const metaOf = (record: TLRecord | undefined) => record?.meta["t3Composition"];

describe("patch", () => {
  const patch = (
    spec: Omit<DiagramSpec, "kit" | "key">,
    records: readonly TLRecord[],
    removeKeys?: string[],
  ) =>
    compose(
      {
        mode: "patch",
        spec: { kit: "flow", key: "checkout", ...spec },
        ...(removeKeys ? { removeKeys } : {}),
      },
      records,
      portsFor(records),
    );

  it("upserts listed members and leaves every other member, edit and position alone", async () => {
    let records = applied(BASE, await run(CHECKOUT));
    records = change(records, "start", (shape) => recolored(moved(shape, 900, 900)));
    const result = await patch({ nodes: [{ key: "pay", label: "Pay now" }] }, records);
    expect(result.counts).toEqual({ created: 0, updated: 1, kept: 5, removed: 0 });
    expect(writtenMembers(result)).toEqual(["pay"]);
    const after = applied(records, result);
    expect(mainOf(after, "start")).toEqual(mainOf(records, "start"));
    expect(frameOf(after)?.props).toMatchObject({ name: "checkout" });
    expect((await patch({ nodes: [{ key: "pay", label: "Pay now" }] }, after)).changes).toBeNull();
  });

  it("removes removeKeys with the member edges of removed nodes", async () => {
    const records = applied(BASE, await run(CHECKOUT));
    const result = await patch({ nodes: [] }, records, ["ok"]);
    expect(result.counts).toEqual({ created: 0, updated: 0, kept: 3, removed: 3 });
    const after = applied(records, result);
    expect(readCompositions(after).detail({ offset: 0, limit: 10 }).items[0]?.members).toEqual([
      { spec: { key: "start", kind: "start", label: "start" }, edited: false },
      { spec: { key: "pay", kind: "process", label: "pay" }, edited: false },
      {
        spec: { key: "start→pay:flow", from: "start", to: "pay", kind: "flow", label: "" },
        edited: false,
      },
    ]);
    expect((await patch({ nodes: [] }, after, ["ok"])).changes).toBeNull();
  });

  it("converges with replacing the whole patched spec", async () => {
    let records = applied(BASE, await run(CHECKOUT));
    records = change(records, "pay", (shape) => moved(shape, 400, 40));
    const patched = await patch(
      {
        nodes: [{ key: "pay", label: "Pay now" }, { key: "ship" }],
        edges: [["ok", "ship", "yes"]],
      },
      records,
      ["start"],
    );
    const replaced = await run(
      {
        ...CHECKOUT,
        nodes: [{ key: "pay", label: "Pay now" }, { key: "ok", kind: "decision" }, { key: "ship" }],
        edges: [
          ["pay", "ok"],
          ["ok", "pay", "no"],
          ["ok", "ship", "yes"],
        ],
      },
      records,
    );
    expect(patched.counts).toEqual({ created: 2, updated: 1, kept: 3, removed: 2 });
    expect(replaced.counts).toEqual(patched.counts);
    expect(byId(applied(records, patched))).toEqual(byId(applied(records, replaced)));
  });

  it("rebinds an untouched edge when the patch recreates its deleted endpoint", async () => {
    const records = deleteNode(applied(BASE, await run(CHECKOUT)), "ok");
    const result = await patch(
      { nodes: [{ key: "ok", kind: "decision", label: "Paid?" }] },
      records,
    );
    expect(writtenMembers(result)).toEqual(["ok", "pay→ok:flow", "ok→pay:flow"]);
    expect(readCompositions(applied(records, result)).summaries[0]?.editedCount).toBe(0);
  });

  it("places new nodes in existing boundaries and notes on existing nodes", async () => {
    const grouped: DiagramSpec = {
      kit: "flow",
      key: "checkout",
      nodes: [
        { key: "g", kind: "group" },
        { key: "a", parent: "g" },
      ],
    };
    const records = applied(BASE, await run(grouped));
    const result = await patch(
      {
        nodes: [
          { key: "b", parent: "g" },
          { key: "n", kind: "note", body: { on: "a" } },
        ],
        edges: [["a", "b"]],
      },
      records,
    );
    expect(result.counts).toEqual({ created: 4, updated: 0, kept: 2, removed: 0 });
    const after = applied(records, result);
    expect(mainOf(after, "b").parentId).toBe(mainOf(after, "g").id);
    await expect(patch({ nodes: [{ key: "c", parent: "a" }] }, after)).rejects.toMatchObject({
      details: {
        issues: [
          {
            path: "spec.nodes[0].parent",
            message: '"a" is a process, which cannot hold nodes; parents must be group nodes',
          },
        ],
      },
    });
  });

  it("fails on a missing composition, a kit change, or an edge to a removed node", async () => {
    await expect(patch({ nodes: [{ key: "a" }] }, BASE)).rejects.toMatchObject({
      code: "invalid-spec",
      details: {
        issues: [
          {
            path: "spec.key",
            message:
              'no composition "checkout" on this diagram; a patch changes an existing composition, so compose the whole spec without mode "patch" first',
          },
        ],
      },
    });
    const records = applied(BASE, await run(CHECKOUT));
    await expect(
      patch({ nodes: [{ key: "ship" }], edges: [["ok", "ship"]] }, records, ["ok", "ship"]),
    ).rejects.toMatchObject({
      details: {
        issues: [
          { path: "spec.edges[0][0]", message: 'unknown node "ok"; valid nodes: ship, start, pay' },
        ],
      },
    });
    await expect(patch({ nodes: [{ key: "ship" }] }, records, ["ship"])).rejects.toMatchObject({
      details: {
        issues: [{ path: "removeKeys[0]", message: '"ship" is also in the spec; list it once' }],
      },
    });
  });
});

describe("remove and detach", () => {
  const release = (operation: "remove" | "detach", records: readonly TLRecord[]) =>
    compose({ operation, key: "checkout" }, records, portsFor(records));

  it("removes every member and the frame, carrying shapes a human drew inside to the page", async () => {
    const composed = applied(BASE, await run({ ...CHECKOUT, position: { x: 100, y: 50 } }));
    const frame = frameOf(composed)!;
    const note = {
      ...mainOf(composed, "pay"),
      id: "shape:note",
      parentId: frame.id,
      x: 10,
      y: 20,
      index: "a9",
      meta: {},
    } as TLShape;
    const records = [...composed, note];
    expect(frame.index).toBe("a0");
    const result = await release("remove", records);
    expect(result.counts).toEqual({ created: 0, updated: 0, kept: 0, removed: 6 });
    const after = applied(records, result);
    expect(after.filter((record) => record.typeName === "shape")).toEqual([
      { ...note, parentId: "page:main", x: 110, y: 70, index: "a1" },
    ]);
    expect((await release("remove", after)).changes).toBeNull();
  });

  it("detaches members in place, and composing the key again starts a fresh epoch", async () => {
    const records = applied(BASE, await run(CHECKOUT));
    const result = await release("detach", records);
    const after = applied(records, result);
    expect(after.map((record) => ({ ...record, meta: {} }))).toEqual(
      records.map((record) => ({ ...record, meta: {} })),
    );
    expect(after.some((record) => metaOf(record) !== undefined)).toBe(false);
    expect(readCompositions(after).summaries).toEqual([]);
    expect((await release("detach", after)).changes).toBeNull();

    // The detached frame is gone too; the detached members still hold epoch 0's IDs.
    const withoutFrame = after.filter((record) => record.id !== frameOf(after)?.id);
    const again = await run(CHECKOUT, withoutFrame);
    expect(again.counts.created).toBe(6);
    expect(
      again.changes?.expected.flatMap((entry) => (entry.record === null ? [] : [entry.id])),
    ).toEqual(["page:main"]);
    expect(byId(applied(withoutFrame, again))).toMatchObject(byId(withoutFrame));
  });
});

describe("validateComposeRequest", () => {
  it("lists the valid options in path-addressed issues", () => {
    let error: unknown;
    try {
      validateComposeRequest({
        spec: {
          kit: "flow",
          key: "bad",
          nodes: [{ key: "a", kind: "proces" }, { key: "b", body: { x: 1 } }, { key: "a" }],
          edges: [["a", "zz"], { from: "a", to: "b", kind: "jump" }],
        },
      });
    } catch (cause) {
      error = cause;
    }
    expect(error).toMatchObject({
      code: "invalid-spec",
      details: {
        issues: [
          {
            path: "spec.nodes[0].kind",
            message:
              'unknown kind "proces" for kit flow; valid kinds: start, end, process, decision, io, subprocess, group, note',
          },
          { path: "spec.nodes[1].body", message: 'kind "process" takes no body fields' },
          { path: "spec.nodes[2].key", message: 'duplicate key "a"' },
          { path: "spec.edges[0][1]", message: 'unknown node "zz"; valid nodes: a, b, a' },
          {
            path: "spec.edges[1].kind",
            message: 'unknown edge kind "jump" for kit flow; valid edge kinds: flow',
          },
        ],
      },
    });
  });
});

describe("compose request fields", () => {
  const issuesOf = (request: Parameters<typeof validateComposeRequest>[0]) => {
    try {
      validateComposeRequest(request);
    } catch (cause) {
      return (cause as { details?: unknown }).details;
    }
    return undefined;
  };

  it("publishes shorthand edges as plain string arrays that decode like the tuple", () => {
    const schema = JSON.stringify(Schema.toJsonSchemaDocument(DiagramSpecEdge));
    expect(schema).not.toContain("prefixItems");
    const decode = Schema.decodeUnknownSync(DiagramSpecEdge);
    expect(decode([" a ", "b"])).toEqual(["a", "b"]);
    expect(decode(["a", "b", " yes "])).toEqual(["a", "b", " yes "]);
    for (const invalid of [["a"], ["a", " "], ["a", "b", "c", "d"]]) {
      expect(() => decode(invalid)).toThrow();
    }
  });

  it("teaches which fields go with which operation", () => {
    expect(issuesOf({ operation: "remove", spec: CHECKOUT, capture: true })).toEqual({
      issues: [
        {
          path: "spec",
          message: 'only for operation "compose"; operation "remove" takes only key',
        },
        {
          path: "capture",
          message: 'only for operation "compose"; operation "remove" takes only key',
        },
        { path: "key", message: "required: the key of the composition to remove" },
      ],
    });
    expect(issuesOf({ key: "checkout", removeKeys: ["a"] })).toEqual({
      issues: [
        {
          path: "key",
          message:
            'only for operation "remove" or "detach"; a compose takes its composition key from spec.key',
        },
        {
          path: "removeKeys",
          message: 'only for mode "patch"; in replace mode, leave members out of the spec instead',
        },
        {
          path: "spec",
          message:
            "pass a spec, or Mermaid as mermaid: { key, text, title? }; to remove or detach a composition, set operation and key instead",
        },
      ],
    });
    expect(
      issuesOf({ mode: "patch", spec: { kit: "flow", key: "k", nodes: [], edges: [["a", "b"]] } }),
    ).toBeUndefined();
  });
});

describe("readCompositions", () => {
  it("summarizes each composition once and counts human edits", async () => {
    const records = applied(BASE, await run({ ...CHECKOUT, title: "Checkout" }));
    const edited = records.map((record) =>
      memberKey(record) === "start" && record.typeName === "shape" && record.type === "geo"
        ? { ...record, x: record.x + 500, props: { ...record.props, dash: "dotted" as const } }
        : record,
    );
    const view = readCompositions(edited);
    const frame = records.find((record) => record.typeName === "shape" && record.type === "frame");
    expect(view.summaries).toEqual([
      {
        key: "checkout",
        kit: "flow",
        title: "Checkout",
        pageId: "page:main",
        frameId: frame?.id,
        memberCount: 6,
        editedCount: 1,
        bounds: { x: 48, y: 48, w: 644, h: 400 },
      },
    ]);
    expect(view.compositionOfFrame(frame?.id ?? "")?.key).toBe("checkout");
    expect(records.filter((record) => view.isMember(record.id))).toHaveLength(13);
  });

  it("maps member keys to shape IDs and resolves the frame scope", async () => {
    const records = deleteNode(applied(BASE, await run(CHECKOUT)), "ok");
    const view = readCompositions(records);
    const frame = frameOf(records)!;
    expect(Object.keys(view.memberShapes("checkout") ?? {})).toEqual([
      "start",
      "pay",
      "start→pay:flow",
      "pay→ok:flow",
      "ok→pay:flow",
    ]);
    expect(view.memberShapes("checkout")?.["pay"]).toBe(mainOf(records, "pay").id);
    expect(view.frameScope("checkout")).toEqual({
      kind: "selection",
      pageId: "page:main",
      shapeIds: [frame.id],
      bounds: box(frame),
    });
    expect(view.frameScope("missing")).toBeUndefined();
  });

  it("ignores a pasted copy that carries a member's meta under a new ID", async () => {
    const records = applied(BASE, await run(CHECKOUT));
    const original = records.find((record) => memberKey(record) === "pay");
    const copy = { ...original, id: "shape:pasted" } as TLRecord;
    const view = readCompositions([...records, copy]);
    expect(view.isMember("shape:pasted")).toBe(false);
    expect(view.compositionOf("shape:pasted")).toBeUndefined();
    expect(view.compositionOf(original?.id ?? "")?.key).toBe("checkout");
    expect(view.summaries[0]?.memberCount).toBe(6);
  });
});

const MACHINE: DiagramSpec = {
  kit: "state",
  key: "machine",
  nodes: [
    { key: "start", kind: "initial" },
    { key: "idle" },
    { key: "busy", kind: "composite", label: "Busy" },
    { key: "loading", parent: "busy" },
    { key: "saving", parent: "busy" },
    { key: "hint", kind: "note", label: "Polls", body: { on: "loading" } },
  ],
  edges: [
    ["start", "idle"],
    ["idle", "loading", "fetch [online] / spin"],
    ["loading", "saving"],
    ["busy", "saving", "save"],
  ],
};

describe("boundaries, notes and the state kit", () => {
  const byKey = (result: DiagramHostComposeResult, key: string) =>
    shapes(result).find((shape) => memberKey(shape) === key);

  it("nests members in boundary frames and parents arrows the way tldraw would", async () => {
    const result = await run(MACHINE);
    const frame = shapes(result).find((shape) => shape.type === "frame" && !memberKey(shape));
    const busy = byKey(result, "busy");
    expect(busy && { type: busy.type, parentId: busy.parentId, props: busy.props }).toEqual({
      type: "frame",
      parentId: frame?.id,
      props: { w: 232, h: 264, name: "Busy", color: "black" },
    });
    expect(byKey(result, "loading")?.parentId).toBe(busy?.id);
    expect(byKey(result, "saving")?.parentId).toBe(busy?.id);
    // Across frames the arrow goes to the common ancestor; into a boundary from that boundary, to it.
    expect(byKey(result, "idle→loading:transition")?.parentId).toBe(frame?.id);
    expect(byKey(result, "loading→saving:transition")?.parentId).toBe(busy?.id);
    expect(byKey(result, "busy→saving:transition")?.parentId).toBe(busy?.id);
    // A boundary always encloses its children, so only genuine collisions are reported.
    expect(result.overlaps).toEqual([]);
  });

  it("draws markers without labels and notes as tldraw notes with a dashed attach line", async () => {
    const result = await run(MACHINE);
    expect(byKey(result, "start")?.props).toMatchObject({
      geo: "ellipse",
      fill: "fill",
      w: 32,
      h: 32,
      richText: { type: "doc", content: [{ type: "paragraph" }] },
    });
    expect(byKey(result, "hint")).toMatchObject({
      type: "note",
      props: {
        color: "yellow",
        growY: 0,
        fontSizeAdjustment: 1,
        textLastEditedBy: null,
        richText: { content: [{ content: [{ text: "Polls" }] }] },
      },
    });
    const line = byKey(result, "hint→loading:attach");
    expect(line?.props).toMatchObject({
      kind: "arc",
      dash: "dashed",
      color: "grey",
      arrowheadStart: "none",
      arrowheadEnd: "none",
    });
    const ends = ((result.changes?.puts ?? []) as TLRecord[]).flatMap((record) =>
      record.typeName === "binding" && record.fromId === line?.id ? [record.toId] : [],
    );
    expect(ends).toEqual([byKey(result, "hint")?.id, byKey(result, "loading")?.id]);
  });

  it("treats an omitted note body like an empty one", async () => {
    const note = (body?: object): DiagramSpec => ({
      kit: "flow",
      key: "notes",
      nodes: [{ key: "n", kind: "note", ...(body ? { body } : {}) }],
    });
    expect(await run(note())).toEqual(await run(note({})));
  });

  it("grows a kept boundary to hold a child added later, without marking it edited", async () => {
    const records = applied(BASE, await run(MACHINE));
    const result = await run(
      {
        ...MACHINE,
        nodes: [...MACHINE.nodes, { key: "retrying", parent: "busy" }],
        edges: [...(MACHINE.edges ?? []), ["saving", "retrying", "failed"]],
      },
      records,
    );
    expect(result.counts).toEqual({ created: 2, updated: 0, kept: 11, removed: 0 });
    const busy = byKey(result, "busy");
    expect(busy?.props).toMatchObject({ w: 232, h: 400 });
    const after = applied(records, result);
    expect(readCompositions(after).summaries[0]?.editedCount).toBe(0);
    expect(byKey(result, "retrying")?.parentId).toBe(busy?.id);
  });

  it("relays out a dragged-out member back into its boundary, and again to no change", async () => {
    const first = await run(MACHINE);
    const frameId = shapes(first).find((shape) => shape.type === "frame" && !memberKey(shape))?.id;
    const loadingId = byKey(first, "loading")?.id;
    const records = applied(BASE, first).map((record) =>
      record.id === loadingId && record.typeName === "shape" && frameId
        ? { ...record, parentId: frameId, x: 600, y: 600 }
        : record,
    );
    const relaid = await compose({ spec: MACHINE, relayout: true }, records, portsFor(records));
    expect(byKey(relaid, "loading")).toMatchObject({ parentId: byKey(first, "busy")?.id });
    const after = applied(records, relaid);
    expect(
      (await compose({ spec: MACHINE, relayout: true }, after, portsFor(after))).changes,
    ).toBeNull();
  });

  it("composes Mermaid through the host's parser into the same batch as the spec", async () => {
    const seen: unknown[] = [];
    const source = { key: "machine", text: "stateDiagram-v2" };
    const result = await compose({ mermaid: source }, BASE, {
      ...portsFor(BASE),
      parseMermaid: (input) => {
        seen.push(input);
        return Promise.resolve(MACHINE);
      },
    });
    expect(seen).toEqual([source]);
    expect(result).toEqual(await run(MACHINE));
  });
});

describe("validating boundaries, notes and sources", () => {
  const issuesOf = (request: Parameters<typeof validateComposeRequest>[0]) => {
    try {
      validateComposeRequest(request);
    } catch (cause) {
      return cause;
    }
    return undefined;
  };

  it("teaches valid parents, note fields and attach targets", () => {
    expect(
      issuesOf({
        spec: {
          kit: "state",
          key: "bad",
          nodes: [
            { key: "a", kind: "composite", parent: "b" },
            { key: "b", kind: "composite", parent: "a" },
            { key: "c", parent: "d" },
            { key: "d" },
            { key: "e", parent: "zz" },
            { key: "n", kind: "note", body: { on: "zz" } },
            { key: "m", kind: "note", body: "a" },
            { key: "k", kind: "note", body: { color: "red" } },
          ],
        },
      }),
    ).toMatchObject({
      code: "invalid-spec",
      details: {
        issues: [
          { path: "spec.nodes[6].body", message: "body must be an object with fields: on" },
          {
            path: "spec.nodes[7].body.color",
            message: 'unknown field "color" for kind "note"; valid fields: on',
          },
          { path: "spec.nodes[0].parent", message: "parents loop: a → b → a" },
          { path: "spec.nodes[1].parent", message: "parents loop: b → a → b" },
          {
            path: "spec.nodes[2].parent",
            message: '"d" is a state, which cannot hold nodes; parents must be composite nodes',
          },
          {
            path: "spec.nodes[4].parent",
            message: 'unknown parent "zz"; valid parents are composite nodes: a, b',
          },
          {
            path: "spec.nodes[5].body.on",
            message: 'unknown node "zz"; valid nodes: a, b, c, d, e, m, k',
          },
        ],
      },
    });
  });

  it("returns the Mermaid key without parsing and needs exactly one source", () => {
    expect(validateComposeRequest({ mermaid: { key: "flow", text: "not parsed here" } })).toBe(
      "flow",
    );
    expect(issuesOf({})).toMatchObject({
      code: "invalid-spec",
      details: {
        issues: [
          {
            path: "spec",
            message:
              "pass a spec, or Mermaid as mermaid: { key, text, title? }; to remove or detach a composition, set operation and key instead",
          },
        ],
      },
    });
    expect(issuesOf({ spec: CHECKOUT, mermaid: { key: "x", text: "" } })).toMatchObject({
      code: "invalid-spec",
      details: { issues: [{ path: "mermaid", message: "pass either spec or mermaid, not both" }] },
    });
  });
});

describe("class and ER kits", () => {
  const ORDERS: DiagramSpec = {
    kit: "uml-class",
    key: "orders",
    nodes: [
      {
        key: "Order",
        body: {
          attributes: [
            { visibility: "private", name: "id", type: "string" },
            { visibility: "public", name: "count", type: "int", static: true },
          ],
          methods: [
            { visibility: "public", name: "total", params: "tax: number", returns: "number" },
          ],
        },
      },
      { key: "Payable", kind: "interface" },
      { key: "Status", kind: "enum", body: { values: ["OPEN", "PAID"] } },
    ],
    edges: [
      { from: "Order", to: "Payable", kind: "realization" },
      { from: "Order", to: "Status", body: { from: "*", to: "1", directed: true } },
    ],
  };

  const issuesOf = (request: Parameters<typeof validateComposeRequest>[0]) => {
    try {
      validateComposeRequest(request);
    } catch (cause) {
      return cause;
    }
    return undefined;
  };

  /** A member's shapes in put order: part, type, parent part, local box and text. */
  function drawn(records: readonly TLRecord[], key: string) {
    const byId = new Map(records.map((record) => [record.id as string, record]));
    return records.flatMap((record) => {
      if (record.typeName !== "shape" || memberKey(record) !== key) return [];
      const parent = byId.get(record.parentId);
      const props = record.props as Record<string, unknown>;
      return [
        {
          part: part(record),
          type: record.type,
          parent: parent && (part(parent) ?? "frame"),
          ...box(record),
          ...("richText" in props ? { text: plain(props["richText"]) } : {}),
        },
      ];
    });
  }

  const plain = (richText: unknown): string =>
    ((richText as { content: { content?: { text: string }[] }[] }).content ?? [])
      .map((paragraph) => (paragraph.content ?? []).map((run) => run.text).join(""))
      .join("\n");

  it("draws a class as a group holding a header box that spans it and one band per compartment", async () => {
    const puts = ((await run(ORDERS)).changes?.puts ?? []) as TLRecord[];
    expect(drawn(puts, "Order")).toEqual([
      { part: "group", type: "group", parent: "frame", x: 48, y: 280, w: 0, h: 0 },
      { part: "main", type: "geo", parent: "group", x: 0, y: 0, w: 256, h: 192, text: "Order" },
      {
        part: "c1",
        type: "geo",
        parent: "group",
        x: 0,
        y: 56,
        w: 256,
        h: 80,
        text: "- id: string\n+ static count: int",
      },
      {
        part: "c2",
        type: "geo",
        parent: "group",
        x: 0,
        y: 136,
        w: 256,
        h: 56,
        text: "+ total(tax: number): number",
      },
    ]);
    expect(drawn(puts, "Payable").map((shape) => shape.text)).toEqual([
      undefined,
      "«interface»\nPayable",
      "",
      "",
    ]);
    expect(drawn(puts, "Status").map((shape) => shape.text)).toEqual([
      undefined,
      "«enumeration»\nStatus",
      "OPEN\nPAID",
    ]);
    const [, main, attributes] = puts.filter((record) => memberKey(record) === "Order");
    const geo = {
      geo: "rectangle",
      dash: "solid",
      url: "",
      growY: 0,
      scale: 1,
      flipX: false,
      flipY: false,
      labelColor: "black",
      color: "blue",
      font: "sans",
      verticalAlign: "start",
    };
    expect(main?.typeName === "shape" && main.props).toEqual({
      ...geo,
      w: 256,
      h: 192,
      fill: "semi",
      size: "m",
      align: "middle",
      richText: toRichText("Order"),
    });
    expect(attributes?.typeName === "shape" && attributes.props).toEqual({
      ...geo,
      w: 256,
      h: 80,
      fill: "none",
      size: "s",
      align: "start",
      richText: toRichText("- id: string\n+ static count: int"),
    });
  });

  it("binds arrows to header boxes and parents them to the frame above both groups", async () => {
    const puts = ((await run(ORDERS)).changes?.puts ?? []) as TLRecord[];
    const find = (key: string, name: string) =>
      puts.find((record) => memberKey(record) === key && part(record) === name);
    const arrow = find("Order→Payable:realization", "main");
    const frame = puts.find((record) => record.typeName === "shape" && record.type === "frame");
    assert(arrow?.typeName === "shape", "the arrow is drawn");
    expect(arrow.parentId).toBe(frame?.id);
    expect(
      ["start", "end"].map((terminal) => {
        const binding = find("Order→Payable:realization", terminal);
        return binding?.typeName === "binding" ? binding.toId : null;
      }),
    ).toEqual([find("Order", "main")?.id, find("Payable", "main")?.id]);
    for (const key of ["Order", "Payable"]) {
      const group = find(key, "group");
      assert(group?.typeName === "shape", "the group is drawn");
      expect(arrow.index > group.index).toBe(true);
    }
  });

  it("maps UML relationships to arrowheads, dashes and fills, with multiplicities in one label", async () => {
    const result = await run({
      kit: "uml-class",
      key: "links",
      nodes: [{ key: "A" }, { key: "B" }],
      edges: [
        { from: "A", to: "B", kind: "inheritance" },
        { from: "A", to: "B", kind: "realization" },
        ["A", "B"],
        { from: "A", to: "B", label: "owns", body: { from: "1", to: "0..*", directed: true } },
        { from: "A", to: "B", kind: "aggregation", body: { to: "1" } },
        { from: "A", to: "B", kind: "composition", label: "has", body: { from: "4", to: "1" } },
        { from: "A", to: "B", kind: "dependency" },
      ],
    });
    expect(
      shapes(result).flatMap((shape) =>
        shape.type === "arrow"
          ? [
              [
                shape.props.arrowheadStart,
                shape.props.arrowheadEnd,
                shape.props.dash,
                shape.props.fill,
                plain(shape.props.richText),
              ],
            ]
          : [],
      ),
    ).toEqual([
      ["none", "triangle", "solid", "none", ""],
      ["none", "triangle", "dashed", "none", ""],
      ["none", "none", "solid", "none", ""],
      ["none", "arrow", "solid", "none", "1 ── owns ── 0..*"],
      ["none", "diamond", "solid", "none", "1"],
      ["none", "diamond", "solid", "fill", "4 ── has ── 1"],
      ["none", "arrow", "dashed", "none", ""],
    ]);
  });

  it("gives a shorthand association and its full form with an empty body the same batch", async () => {
    const spec = (edge: NonNullable<DiagramSpec["edges"]>[number]): DiagramSpec => ({
      kit: "uml-class",
      key: "pair",
      nodes: [{ key: "A" }, { key: "B" }],
      edges: [edge],
    });
    expect(await run(spec(["A", "B"]))).toEqual(
      await run(spec({ from: "A", to: "B", kind: "association", label: "", body: {} })),
    );
  });

  it("lists ER columns with key and nullable markers and labels relationships with both cardinalities", async () => {
    const result = await run({
      kit: "er",
      key: "shop",
      nodes: [
        {
          key: "users",
          body: {
            columns: [
              { name: "id", type: "uuid", pk: true },
              { name: "nickname", type: "text", nullable: true },
            ],
          },
        },
        {
          key: "orders",
          label: "Orders",
          body: {
            columns: [
              { name: "id", type: "uuid", pk: true },
              { name: "user_id", type: "uuid", pk: true, fk: true },
              { name: "memo", nullable: true },
            ],
          },
        },
      ],
      edges: [
        { from: "users", to: "orders", label: "places", body: { from: "one", to: "many" } },
        { from: "orders", to: "users", body: { from: "zeroOrOne", to: "oneOrMany" } },
      ],
    });
    const puts = (result.changes?.puts ?? []) as TLRecord[];
    expect(drawn(puts, "users").map((shape) => shape.text)).toEqual([
      undefined,
      "users",
      "id: uuid {PK}\nnickname: text?",
    ]);
    expect(drawn(puts, "orders").map((shape) => shape.text)).toEqual([
      undefined,
      "Orders",
      "id: uuid {PK}\nuser_id: uuid {PK, FK}\nmemo?",
    ]);
    expect(
      shapes(result).flatMap((shape) =>
        shape.type === "arrow"
          ? [[shape.props.arrowheadStart, shape.props.arrowheadEnd, plain(shape.props.richText)]]
          : [],
      ),
    ).toEqual([
      ["none", "none", "1 ── places ── 0..*"],
      ["none", "none", "0..1 ── 1..*"],
    ]);
  });

  it("fits a 40-class, 60-association model in one batch", async () => {
    const result = await run({
      kit: "uml-class",
      key: "model",
      nodes: Array.from({ length: 40 }, (_, i) => ({
        key: `C${i}`,
        body: { attributes: [{ name: "id", type: "string" }], methods: [{ name: "save" }] },
      })),
      edges: Array.from({ length: 60 }, (_, i) => ({
        from: `C${i % 40}`,
        to: `C${(7 * i + 1) % 40}`,
        body: { from: "1", to: "*" },
      })),
    });
    expect(result.counts).toEqual({ created: 100, updated: 0, kept: 0, removed: 0 });
    // The frame, four parts per class, and an arrow with two bindings per association.
    expect(result.changes?.puts).toHaveLength(1 + 40 * 4 + 60 * 3);
    expect(result.changes?.deletes).toEqual([]);
  });

  it("fails too-large counting every part of every class before measuring", async () => {
    const nodes = Array.from({ length: 125 }, (_, i) => ({ key: `C${i}` }));
    await expect(
      compose({ spec: { kit: "uml-class", key: "big", nodes } }, BASE, failingPorts),
    ).rejects.toMatchObject({
      code: "too-large",
      details: {
        issues: [
          {
            path: "spec",
            message:
              "needs 501 records but one compose writes at most 500; split it into several compositions",
          },
        ],
      },
    });
  });

  it("treats a compartment edit as a human edit and rewrites an unedited class at its moved group", async () => {
    let records = applied(BASE, await run(ORDERS));
    expect((await compose({ spec: ORDERS }, records, failingPorts)).changes).toBeNull();

    records = records.map((record) =>
      record.typeName === "shape" && memberKey(record) === "Order" && part(record) === "c1"
        ? withProps(record, { richText: toRichText("- id: uuid") })
        : record.typeName === "shape" && memberKey(record) === "Payable" && part(record) === "group"
          ? moved(record, 600, 40)
          : record,
    );
    expect(readCompositions(records).summaries[0]?.editedCount).toBe(1);
    const withMethods = (key: string): DiagramSpec => ({
      ...ORDERS,
      nodes: ORDERS.nodes.map((node) =>
        node.key === key ? { ...node, body: { methods: [{ name: "pay" }] } } : node,
      ),
    });
    await expect(run(withMethods("Order"), records)).rejects.toMatchObject({
      code: "conflict",
      details: { members: ["Order"] },
    });

    const result = await run(withMethods("Payable"), records);
    expect(result.counts).toEqual({ created: 0, updated: 1, kept: 4, removed: 0 });
    expect(drawn(applied(records, result), "Payable")).toEqual([
      { part: "group", type: "group", parent: "frame", x: 600, y: 40, w: 0, h: 0 },
      {
        part: "main",
        type: "geo",
        parent: "group",
        x: 0,
        y: 0,
        w: 160,
        h: 160,
        text: "«interface»\nPayable",
      },
      { part: "c1", type: "geo", parent: "group", x: 0, y: 80, w: 160, h: 24, text: "" },
      { part: "c2", type: "geo", parent: "group", x: 0, y: 104, w: 160, h: 56, text: "pay()" },
    ]);
  });

  it("reads bodies back in composition detail, so a rebuilt spec keeps members and multiplicities", async () => {
    const records = applied(BASE, await run(ORDERS));
    const members = readCompositions(records).detail({ key: "orders", offset: 0, limit: 10 })
      .items[0]?.members;
    expect(members?.map((member) => member.spec)).toEqual([
      { key: "Order", kind: "class", label: "Order", body: ORDERS.nodes[0]?.body },
      { key: "Payable", kind: "interface", label: "Payable" },
      { key: "Status", kind: "enum", label: "Status", body: { values: ["OPEN", "PAID"] } },
      {
        key: "Order→Payable:realization",
        from: "Order",
        to: "Payable",
        kind: "realization",
        label: "",
      },
      {
        key: "Order→Status:association",
        from: "Order",
        to: "Status",
        kind: "association",
        label: "",
        body: { from: "*", to: "1", directed: true },
      },
    ]);
  });

  it("fails a typo anywhere inside a body, listing the valid fields at that level", () => {
    expect(
      issuesOf({
        spec: {
          kit: "uml-class",
          key: "typo",
          nodes: [
            {
              key: "A",
              body: {
                attributes: [{ name: "id" }, { nmae: "count", type: "int" }],
                methods: [{ name: "save", return: "void" }],
              },
            },
          ],
        },
      }),
    ).toMatchObject({
      code: "invalid-spec",
      details: {
        issues: [
          {
            path: "spec.nodes[0].body.attributes[1].nmae",
            message:
              'unknown field "nmae" for kind "class"; valid fields: visibility, name, type, static',
          },
          {
            path: "spec.nodes[0].body.methods[0].return",
            message:
              'unknown field "return" for kind "class"; valid fields: visibility, name, params, returns, static',
          },
          {
            path: "spec.nodes[0].body.attributes[1].name",
            message: 'missing required field "name"',
          },
        ],
      },
    });
    expect(
      issuesOf({
        spec: {
          kit: "er",
          key: "typo",
          nodes: [{ key: "u", body: { columns: [{ name: "id", primary: true }] } }, { key: "o" }],
          edges: [{ from: "u", to: "o", body: { from: "one", too: "many" } }],
        },
      }),
    ).toMatchObject({
      code: "invalid-spec",
      details: {
        issues: [
          {
            path: "spec.nodes[0].body.columns[0].primary",
            message:
              'unknown field "primary" for kind "entity"; valid fields: name, type, pk, fk, nullable',
          },
          {
            path: "spec.edges[0].body.too",
            message: 'unknown field "too" for edge kind "relationship"; valid fields: from, to',
          },
        ],
      },
    });
  });

  it("teaches class and ER body fields", () => {
    expect(
      issuesOf({
        spec: {
          kit: "uml-class",
          key: "bad",
          nodes: [
            { key: "A", body: { fields: [] } },
            { key: "B", body: { attributes: [{ name: "id", visibility: "privat" }] } },
            { key: "C", kind: "table" },
          ],
          edges: [{ from: "A", to: "B", kind: "inheritance", body: { from: "1" } }],
        },
      }),
    ).toMatchObject({
      code: "invalid-spec",
      details: {
        issues: [
          {
            path: "spec.nodes[0].body.fields",
            message:
              'unknown field "fields" for kind "class"; valid fields: stereotype, attributes, methods',
          },
          {
            path: "spec.nodes[1].body.attributes[0].visibility",
            message: 'Expected "public" | "private" | "protected" | "package"',
          },
          {
            path: "spec.nodes[2].kind",
            message:
              'unknown kind "table" for kit uml-class; valid kinds: class, interface, abstract, enum, package, note',
          },
          { path: "spec.edges[0].body", message: 'edge kind "inheritance" takes no body fields' },
        ],
      },
    });
    expect(
      issuesOf({
        spec: {
          kit: "er",
          key: "bad",
          nodes: [{ key: "u" }, { key: "o", parent: "u" }],
          edges: [{ from: "u", to: "o", body: { from: "1" } }],
        },
      }),
    ).toMatchObject({
      code: "invalid-spec",
      details: {
        issues: [
          {
            path: "spec.nodes[1].parent",
            message: "kit er has no container kinds, so nodes cannot have a parent",
          },
          {
            path: "spec.edges[0].body.from",
            message: 'Expected "one" | "zeroOrOne" | "many" | "oneOrMany"',
          },
        ],
      },
    });
  });
});

describe("ownership edge cases", () => {
  const records = (result: DiagramHostComposeResult, before: readonly TLRecord[] = BASE) =>
    applied(before, result);
  const errorOf = async (pending: Promise<unknown>) => {
    try {
      await pending;
    } catch (cause) {
      return cause;
    }
    return undefined;
  };
  const parts = (all: readonly TLRecord[], key: string) =>
    all.flatMap((record) => (memberKey(record) === key ? [part(record)] : []));

  it("never adopts records left with a composition's meta after its frame is deleted", async () => {
    let all = records(
      await run({
        kit: "flow",
        key: "k",
        nodes: [{ key: "kept" }, { key: "x" }],
        edges: [["kept", "x"]],
      }),
    );
    // A human drags "kept" out of the frame, then deletes the frame with everything still in it.
    const kept = mainOf(all, "kept");
    all = all.flatMap((record): TLRecord[] => {
      if (record.id === kept.id) return [{ ...kept, parentId: "page:main" } as TLShape];
      return record.typeName === "document" || record.typeName === "page" ? [record] : [];
    });
    const fresh: DiagramSpec = { kit: "flow", key: "k", nodes: [{ key: "fresh" }] };
    all = records(await run(fresh, all), all);
    const view = readCompositions(all);
    expect(view.summaries.map(({ key, memberCount }) => ({ key, memberCount }))).toEqual([
      { key: "k", memberCount: 1 },
    ]);
    expect(view.isMember(kept.id)).toBe(false);
    const renamed = await run({ ...fresh, title: "Renamed" }, all);
    expect(renamed.counts).toEqual({ created: 0, updated: 0, kept: 1, removed: 0 });
    expect(renamed.changes?.deletes).toEqual([]);
  });

  it("rejects kind names inherited from Object.prototype", () => {
    for (const kind of ["constructor", "toString", "__proto__"]) {
      expect(() =>
        validateComposeRequest({ spec: { kit: "flow", key: "k", nodes: [{ key: "a", kind }] } }),
      ).toThrow(
        expect.objectContaining({
          code: "invalid-spec",
          details: {
            issues: [
              {
                path: "spec.nodes[0].kind",
                message: `unknown kind "${kind}" for kit flow; valid kinds: start, end, process, decision, io, subprocess, group, note`,
              },
            ],
          },
        }),
      );
    }
    expect(() =>
      validateComposeRequest({
        spec: {
          kit: "flow",
          key: "k",
          nodes: [{ key: "a" }, { key: "b" }],
          edges: [{ from: "a", to: "b", kind: "constructor" }],
        },
      }),
    ).toThrow(
      expect.objectContaining({
        details: {
          issues: [
            {
              path: "spec.edges[0].kind",
              message: 'unknown edge kind "constructor" for kit flow; valid edge kinds: flow',
            },
          ],
        },
      }),
    );
  });

  it("checks a patched message's endpoints against the composition's own nodes", async () => {
    const login: DiagramSpec = {
      kit: "sequence",
      key: "login",
      nodes: [
        { key: "web" },
        { key: "api" },
        { key: "retry", kind: "loop", body: { from: "call" } },
      ],
      edges: [{ key: "call", from: "web", to: "api" }],
    };
    const all = records(await run(login));
    const patched = compose(
      {
        mode: "patch",
        spec: { kit: "sequence", key: "login", nodes: [], edges: [["web", "retry", "x"]] },
      },
      all,
      portsFor(all),
    );
    expect(await errorOf(patched)).toMatchObject({
      code: "invalid-spec",
      details: {
        issues: [
          {
            path: "spec.edges[0].to",
            message:
              '"retry" is not a participant or actor; messages connect participants and actors',
          },
        ],
      },
    });
  });

  it("checks a patch's kit before validating its members against it", async () => {
    const all = records(await run(CHECKOUT));
    const patched = compose(
      {
        mode: "patch",
        spec: { kit: "sequence", key: "checkout", nodes: [{ key: "pay", kind: "process" }] },
      },
      all,
      portsFor(all),
    );
    expect(await errorOf(patched)).toMatchObject({
      code: "invalid-spec",
      details: {
        issues: [
          {
            path: "spec.kit",
            message:
              'a patch keeps the composition\'s kit flow; to change kits, compose the whole spec without mode "patch"',
          },
        ],
      },
    });
  });

  it("writes the same ledger patching in a node and edge as replacing with the whole spec, notes included", async () => {
    const noted: DiagramSpec = {
      kit: "flow",
      key: "k",
      nodes: [{ key: "a" }, { key: "b" }, { key: "n", kind: "note", body: { on: "a" } }],
      edges: [["a", "b"]],
    };
    const all = records(await run(noted));
    const patched = await compose(
      {
        mode: "patch",
        spec: { kit: "flow", key: "k", nodes: [{ key: "c" }], edges: [["b", "c"]] },
      },
      all,
      portsFor(all),
    );
    const after = records(patched, all);
    const ledger = frameOf(after)?.meta["t3Composition"] as { ledger: [string, string][] };
    expect(ledger.ledger.map(([key]) => key)).toEqual([
      "a",
      "b",
      "n",
      "c",
      "a→b:flow",
      "b→c:flow",
      "n→a:attach",
    ]);
    const whole = {
      ...noted,
      nodes: [...noted.nodes, { key: "c" }],
      edges: [...(noted.edges ?? []), ["b", "c"]],
    } satisfies DiagramSpec;
    expect((await run(whole, after)).changes).toBeNull();
  });

  it("leaves notes' attach lines out of detail, so a spec rebuilt from it composes to no change", async () => {
    const noted: DiagramSpec = {
      kit: "flow",
      key: "k",
      nodes: [{ key: "a" }, { key: "n", kind: "note", label: "hi", body: { on: "a" } }],
    };
    const all = records(await run(noted));
    const [item] = readCompositions(all).detail({ offset: 0, limit: 20 }).items;
    assert(item, "the composition has detail");
    expect(item.members.map((member) => member.spec.key)).toEqual(["a", "n"]);
    const nodes = item.members.flatMap(({ spec }) => ("from" in spec ? [] : [spec]));
    const rebuilt = await run({ kit: item.kit, key: item.key, title: item.title, nodes }, all);
    expect(rebuilt.changes).toBeNull();
  });

  it("keeps a human's frame name until the spec's title changes", async () => {
    const spec: DiagramSpec = { kit: "flow", key: "k", title: "Checkout", nodes: [{ key: "a" }] };
    const first = records(await run(spec));
    const frame = frameOf(first);
    assert(frame?.type === "frame", "the composition has a frame");
    const all = first.map((record) =>
      record.id === frame.id ? { ...frame, props: { ...frame.props, name: "Mine" } } : record,
    );
    const grown = await run({ ...spec, nodes: [{ key: "a" }, { key: "b" }] }, all);
    expect(frameOf(shapes(grown))?.props).toMatchObject({ name: "Mine" });
    const retitled = await run({ ...spec, title: "Payments" }, all);
    expect(frameOf(shapes(retitled))?.props).toMatchObject({ name: "Payments" });
  });

  it("does not count resizing text or sliding an arrow's label as an edit", async () => {
    let all = records(await run(CHECKOUT));
    all = change(all, "pay", (shape) => withProps(shape, { scale: 2 }));
    all = change(all, "pay→ok:flow", (shape) => withProps(shape, { labelPosition: 0.2 }));
    expect(readCompositions(all).summaries[0]?.editedCount).toBe(0);
    const relabeled = await run(
      {
        ...CHECKOUT,
        nodes: CHECKOUT.nodes.map((node) =>
          node.key === "pay" ? { ...node, label: "Pay" } : node,
        ),
      },
      all,
    );
    expect(relabeled.counts).toEqual({ created: 0, updated: 1, kept: 5, removed: 0 });
  });

  it("restamps an edited node whose ref alone changed, without touching what the human drew", async () => {
    const withRef = (path: string): DiagramSpec => ({
      ...CHECKOUT,
      nodes: CHECKOUT.nodes.map((node) => (node.key === "pay" ? { ...node, ref: { path } } : node)),
    });
    let all = records(await run(withRef("pay.ts")));
    all = change(all, "pay", recolored);
    const result = await run(withRef("billing/pay.ts"), all);
    expect(result.counts).toEqual({ created: 0, updated: 0, kept: 6, removed: 0 });
    expect(writtenMembers(result)).toEqual(["pay"]);
    all = records(result, all);
    expect(mainOf(all, "pay").props).toMatchObject({ color: "red" });
    const pay = readCompositions(all)
      .detail({ offset: 0, limit: 20 })
      .items[0]?.members.find((member) => member.spec.key === "pay");
    expect(pay).toMatchObject({ spec: { ref: { path: "billing/pay.ts" } }, edited: true });
    expect((await run(withRef("billing/pay.ts"), all)).changes).toBeNull();
  });

  it("drops the arrow and creates a node when a key changes from edge to node", async () => {
    const edge: DiagramSpec = {
      kit: "flow",
      key: "k",
      nodes: [{ key: "a" }, { key: "b" }],
      edges: [{ key: "x", from: "a", to: "b" }],
    };
    const all = records(await run(edge));
    const arrow = mainOf(all, "x");
    const result = await run(
      { kit: "flow", key: "k", nodes: [{ key: "a" }, { key: "b" }, { key: "x" }] },
      all,
    );
    expect(result.counts).toEqual({ created: 1, updated: 0, kept: 2, removed: 0 });
    const after = records(result, all);
    expect(parts(after, "x")).toEqual(["main"]);
    const node = mainOf(after, "x");
    expect(node.type).toBe("geo");
    // Placed as a new node, not at the arrow's start.
    expect({ x: node.x, y: node.y }).not.toEqual({ x: arrow.x, y: arrow.y });
  });
});

describe("member remnants", () => {
  // The header box is the class's main part; deleting it leaves the group and compartments.
  const CLASSES: DiagramSpec = {
    kit: "uml-class",
    key: "model",
    nodes: [
      { key: "Order", body: { attributes: [{ name: "id", type: "string" }] } },
      { key: "Item" },
    ],
  };
  const renamed: DiagramSpec = {
    ...CLASSES,
    nodes: CLASSES.nodes.map((node) =>
      node.key === "Order" ? { ...node, label: "Purchase" } : node,
    ),
  };
  const withoutHeader = (all: readonly TLRecord[]) => {
    const header = mainOf(all, "Order");
    return all.filter((record) => record.id !== header.id);
  };
  const orderParts = (all: readonly TLRecord[]) =>
    all.flatMap((record) => (memberKey(record) === "Order" ? [part(record)] : []));

  it("fails with a conflict rather than overwrite compartments a human kept and edited", async () => {
    let all = withoutHeader(applied(BASE, await run(CLASSES)));
    all = all.map((record) =>
      record.typeName === "shape" && memberKey(record) === "Order" && part(record) === "c1"
        ? withProps(record, { richText: toRichText("my notes") })
        : record,
    );
    await expect(run(renamed, all)).rejects.toMatchObject({
      code: "conflict",
      details: { members: ["Order"] },
    });
  });

  it("redraws over unedited leftovers, and removes or detaches them with the member", async () => {
    const all = withoutHeader(applied(BASE, await run(CLASSES)));
    expect(orderParts(all)).toEqual(["group", "c1", "c2"]);
    const redrawn = await run(renamed, all);
    expect(redrawn.counts).toEqual({ created: 1, updated: 0, kept: 1, removed: 0 });
    expect(orderParts(applied(all, redrawn))).toEqual(["group", "c1", "c2", "main"]);

    const dropped = await run({ ...CLASSES, nodes: [{ key: "Item" }] }, all);
    expect(dropped.counts).toEqual({ created: 0, updated: 0, kept: 1, removed: 1 });
    expect(orderParts(applied(all, dropped))).toEqual([]);

    const detached = applied(
      all,
      await compose({ operation: "detach", key: "model" }, all, portsFor(all)),
    );
    expect(detached.filter((record) => metaOf(record) !== undefined)).toEqual([]);
  });
});
