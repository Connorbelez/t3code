import {
  DiagramCompositionsPage,
  type DiagramComposeRequest,
  type DiagramHostComposeResult,
  type DiagramSpec,
} from "@t3tools/contracts";
import type { TLArrowBinding, TLRecord, TLShape } from "@tldraw/tlschema";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { compose, type ComposePorts } from "./compose.ts";
import { kitReference, readCompositions, validateComposeRequest } from "./model.ts";

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

const request = (
  request: DiagramComposeRequest,
  records: readonly TLRecord[] = BASE,
): Promise<DiagramHostComposeResult> => compose(request, records, ports(records));
const run = (spec: DiagramSpec, records: readonly TLRecord[] = BASE) => request({ spec }, records);

const decodePage = Schema.decodeSync(DiagramCompositionsPage);
const putsOf = (result: DiagramHostComposeResult) => (result.changes?.puts ?? []) as TLRecord[];

function applied(records: readonly TLRecord[], result: DiagramHostComposeResult): TLRecord[] {
  return Array.from(rehearse(records)(putsOf(result), result.changes?.deletes ?? []).values());
}

function memberOf(record: TLRecord): string {
  const meta = record.meta["t3Composition"];
  return meta && typeof meta === "object" && "m" in meta ? String(meta.m) : "(frame)";
}

function shapeOf(records: readonly TLRecord[], key: string): TLShape {
  const shape = records.find(
    (record): record is TLShape => record.typeName === "shape" && memberOf(record) === key,
  );
  if (!shape) throw new Error(`no member ${key}`);
  return shape;
}

function issues(run: () => unknown): unknown[] {
  try {
    run();
    return [];
  } catch (error) {
    return (error as { details?: { issues?: unknown[] } }).details?.issues ?? [];
  }
}

const FLOW = {
  kit: "user-flow",
  key: "onboarding",
  nodes: [
    {
      key: "welcome",
      body: {
        children: [
          { key: "title", kind: "heading", label: "Hi" },
          { key: "start", kind: "button", label: "Start" },
        ],
      },
    },
    { key: "hasAccount", kind: "decision", label: "Has account?" },
    {
      key: "login",
      body: {
        children: [
          { key: "email", kind: "input", label: "Email" },
          { key: "submit", kind: "button", label: "Log in" },
        ],
      },
    },
    { key: "signup" },
    { key: "home" },
  ],
  edges: [
    ["welcome.start", "hasAccount", "tap Start"],
    ["hasAccount", "login", "yes"],
    ["hasAccount", "signup", "no"],
    ["login.submit", "home", "tap Log in"],
    ["signup", "home"],
  ],
} satisfies DiagramSpec;

const withEmail = (label: string): DiagramSpec => ({
  ...FLOW,
  nodes: FLOW.nodes.map((node) =>
    node.key === "login"
      ? {
          key: "login",
          body: {
            children: [
              { key: "email", kind: "input", label },
              { key: "submit", kind: "button", label: "Log in" },
            ],
          },
        }
      : node,
  ),
});

describe("user-flow kit", () => {
  it("lists screens and the flow kit's decision, and its example composes", () => {
    const reference = kitReference("user-flow");
    expect({
      defaultKind: reference.defaultKind,
      kinds: reference.nodeKinds.map((row) => row.kind),
      defaultEdgeKind: reference.defaultEdgeKind,
      edgeKinds: reference.edgeKinds.map((row) => row.kind),
    }).toEqual({
      defaultKind: "screen",
      kinds: ["screen", "decision", "note"],
      defaultEdgeKind: "navigate",
      edgeKinds: ["navigate"],
    });
    expect(reference.nodeKinds[1]?.description).toBe(
      kitReference("flow").nodeKinds.find((row) => row.kind === "decision")?.description,
    );
    expect(validateComposeRequest({ spec: reference.example })).toBe("onboarding");
  });

  it("lays screens out left to right as sketched device frames, empty ones as bare frames", async () => {
    const records = applied(BASE, await run(FLOW));
    const boxOf = (key: string) => {
      const shape = shapeOf(records, key);
      const props: Record<string, unknown> = { ...shape.props };
      return { type: shape.type, x: shape.x, y: shape.y, w: props["w"], h: props["h"] };
    };
    expect(["welcome", "hasAccount", "login", "signup", "home"].map(boxOf)).toEqual([
      { type: "frame", x: 48, y: 67, w: 393, h: 852 },
      { type: "geo", x: 681, y: 437, w: 192, h: 112 },
      { type: "frame", x: 1113, y: 48, w: 393, h: 852 },
      { type: "frame", x: 1113, y: 948, w: 393, h: 852 },
      { type: "frame", x: 1746, y: 190, w: 393, h: 852 },
    ]);
    expect(shapeOf(records, "hasAccount").props).toMatchObject({
      geo: "diamond",
      font: "draw",
      dash: "draw",
    });
    const signup = shapeOf(records, "signup");
    expect(
      records.filter((record) => record.typeName === "shape" && record.parentId === signup.id),
    ).toEqual([]);
    expect(shapeOf(records, "signup").props).toMatchObject({ name: "signup" });
  });

  it("binds an arrow to the element that triggers it, labelled with the trigger", async () => {
    const records = applied(BASE, await run(FLOW));
    const arrow = shapeOf(records, "login.submit→home:navigate");
    const ends = records
      .filter(
        (record): record is TLArrowBinding =>
          record.typeName === "binding" && record.fromId === arrow.id,
      )
      .map((binding) => [
        binding.props.terminal,
        memberOf(records.find((record) => record.id === binding.toId)!),
      ]);
    expect(ends.sort()).toEqual([
      ["end", "home"],
      ["start", "login.submit"],
    ]);
    expect(memberOf(records.find((record) => record.id === arrow.parentId)!)).toBe("(frame)");
    expect(arrow.props).toMatchObject({
      kind: "arc",
      dash: "draw",
      font: "draw",
      richText: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "tap Log in" }] }],
      },
    });
  });

  it("teaches the elements of a screen when an edge names one it does not have", () => {
    const edges = (...list: [string, string][]): DiagramSpec => ({ ...FLOW, edges: list });
    expect(
      issues(() =>
        validateComposeRequest({
          spec: edges(["login.sbumit", "home"], ["home.menu", "login"], ["nowhere.x", "home"]),
        }),
      ),
    ).toEqual([
      {
        path: "spec.edges[0][0]",
        message: 'no element "sbumit" in "login"; its elements: email, submit',
      },
      { path: "spec.edges[1][0]", message: 'no element "menu" in "home"; its elements: (none)' },
      {
        path: "spec.edges[2][0]",
        message: 'unknown node "nowhere.x"; valid nodes: welcome, hasAccount, login, signup, home',
      },
    ]);
  });
});

describe("regenerating user flows", () => {
  it("writes only the changed screen's members when one element changes", async () => {
    const records = applied(BASE, await run(FLOW));
    const longer = withEmail("Email or phone number you signed up with");
    const result = await run(longer, records);
    expect(result.counts).toEqual({ created: 0, updated: 1, kept: 13, removed: 0 });
    expect(result.changes?.deletes).toEqual([]);
    expect(putsOf(result).map(memberOf).sort()).toEqual(["(frame)", "login.email", "login.submit"]);
    const after = applied(records, result);
    expect([shapeOf(after, "login.email").props, shapeOf(after, "login.submit").y]).toMatchObject([
      { h: 72 },
      112,
    ]);
    expect((await run(longer, after)).changes).toBeNull();
  });
});

describe("patching user flows", () => {
  const patch = (spec: Partial<DiagramSpec>, records: readonly TLRecord[], removeKeys?: string[]) =>
    request(
      {
        spec: { kit: "user-flow", key: "onboarding", nodes: [], ...spec },
        mode: "patch",
        ...(removeKeys ? { removeKeys } : {}),
      },
      records,
    );

  it("changes an edge from an element like a replace would, and removes it by its key", async () => {
    const records = applied(BASE, await run(FLOW));
    const relabelled = await patch({ edges: [["login.submit", "home", "tap Sign in"]] }, records);
    expect(relabelled.counts).toEqual({ created: 0, updated: 1, kept: 13, removed: 0 });
    const after = applied(records, relabelled);
    const replaced: DiagramSpec = {
      ...FLOW,
      edges: FLOW.edges.map((edge) =>
        edge[0] === "login.submit" ? ["login.submit", "home", "tap Sign in"] : edge,
      ),
    };
    expect((await run(replaced, after)).changes).toBeNull();

    const removed = await patch({}, after, ["login.submit→home:navigate"]);
    expect(removed.counts.removed).toBe(1);
    expect(() => shapeOf(applied(after, removed), "login.submit→home:navigate")).toThrow();
  });

  it("drops edges from elements a listed screen no longer has", async () => {
    const records = applied(BASE, await run(FLOW));
    const result = await patch(
      {
        nodes: [
          { key: "login", body: { children: [{ key: "email", kind: "input", label: "Email" }] } },
        ],
      },
      records,
    );
    expect(result.counts.removed).toBe(2);
    const after = applied(records, result);
    expect(() => shapeOf(after, "login.submit")).toThrow();
    expect(() => shapeOf(after, "login.submit→home:navigate")).toThrow();
  });

  it("teaches element addressing against the canvas, and leaves elements to their screen", async () => {
    const records = applied(BASE, await run(FLOW));
    const failure = (promise: Promise<unknown>) =>
      promise.then(
        () => [],
        (error: { details?: { issues?: unknown[] } }) => error.details?.issues ?? [],
      );
    expect(await failure(patch({ edges: [["login.sbumit", "home"]] }, records))).toEqual([
      {
        path: "spec.edges[0][0]",
        message: 'no element "sbumit" in "login"; its elements: email, submit',
      },
    ]);
    expect(await failure(patch({}, records, ["login.submit"]))).toEqual([
      {
        path: "removeKeys[0]",
        message: '"login.submit" is inside "login"; patch "login" with its whole body instead',
      },
    ]);
  });

  it("reads an edge from an element back under its derived key", async () => {
    const records = applied(BASE, await run(FLOW));
    const page = decodePage(readCompositions(records).detail({ offset: 0, limit: 100 }));
    expect(
      page.items[0]?.members.find(({ spec }) => spec.key === "login.submit→home:navigate"),
    ).toEqual({
      spec: {
        key: "login.submit→home:navigate",
        from: "login.submit",
        to: "home",
        kind: "navigate",
        label: "tap Log in",
      },
      edited: false,
    });
  });
});
