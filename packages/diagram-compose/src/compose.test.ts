import type { DiagramHostComposeResult, DiagramSpec } from "@t3tools/contracts";
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

function portsFor(records: readonly TLRecord[]): ComposePorts {
  return {
    measureText: (text) => {
      const lines = text.split("\n");
      return { w: 8 * Math.max(...lines.map((line) => line.length)), h: 22 * lines.length };
    },
    rehearse: rehearse(records),
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
    expect(result.changes?.expected.every((entry) => entry.record === null)).toBe(true);
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
      await compose({ spec: CHECKOUT }, records, { measureText: fail, rehearse: fail }),
    ).toEqual({
      changes: null,
      counts: { created: 0, updated: 0, kept: 6, removed: 0 },
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
    expect(result.changes?.expected.at(-1)).toEqual({ id: "shape:human", record: human });
  });

  it("fails too-large when the composition exceeds one batch", async () => {
    const nodes = Array.from({ length: 200 }, (_, i) => ({ key: `n${i}` }));
    const edges = Array.from({ length: 100 }, (_, i): [string, string] => [`n${i}`, `n${i + 1}`]);
    await expect(run({ kit: "flow", key: "big", nodes, edges })).rejects.toMatchObject({
      code: "too-large",
    });
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
              'unknown kind "proces" for kit flow; valid kinds: start, end, process, decision, io, subprocess',
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
