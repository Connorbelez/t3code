import type { DiagramHostComposeResult, DiagramSpec, DiagramSpecEdge } from "@t3tools/contracts";
import { toRichText, type TLRecord, type TLShape } from "@tldraw/tlschema";
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

/** 8px per character and 20px per line. */
const ports = (records: readonly TLRecord[]): ComposePorts => ({
  measureText: (text) => ({ w: 8 * text.length, h: 20 }),
  rehearse: rehearse(records),
  parseMermaid: () => Promise.reject(new Error("not expected")),
});

const run = (spec: DiagramSpec, records: readonly TLRecord[] = BASE, relayout?: boolean) =>
  compose({ spec, ...(relayout ? { relayout } : {}) }, records, ports(records));

function applied(records: readonly TLRecord[], result: DiagramHostComposeResult): TLRecord[] {
  const puts = (result.changes?.puts ?? []) as TLRecord[];
  return Array.from(rehearse(records)(puts, result.changes?.deletes ?? []).values());
}

function partOf(record: TLRecord): string {
  const meta = record.meta["t3Composition"];
  if (!meta || typeof meta !== "object" || !("m" in meta)) return "frame";
  return "p" in meta && meta.p !== "main" ? `${String(meta.m)}/${String(meta.p)}` : String(meta.m);
}

function find(records: readonly TLRecord[], part: string): TLRecord {
  const record = records.find((candidate) => partOf(candidate) === part);
  if (!record) throw new Error(`no part ${part}`);
  return record;
}

/** Each record as "part type in parent at x,y size", bindings as their anchor. */
function drawing(records: readonly TLRecord[]): string[] {
  const byId = new Map(records.map((record) => [record.id as string, record]));
  return records.flatMap((record) => {
    if (record.typeName === "binding" && record.type === "arrow") {
      const { normalizedAnchor, isPrecise } = record.props;
      const target = byId.get(record.toId);
      return [
        `${partOf(record)} → ${target ? partOf(target) : "?"} y=${normalizedAnchor.y.toFixed(3)}${isPrecise ? "" : " center"}`,
      ];
    }
    if (record.typeName !== "shape" || partOf(record) === "frame") return [];
    const parent = byId.get(record.parentId);
    const props: Record<string, unknown> = { ...record.props };
    const size =
      record.type === "line"
        ? ` h=${(Object.values(record.props.points)[1]?.y ?? 0).toString()}`
        : "w" in props
          ? ` ${String(props["w"])}x${String(props["h"])}`
          : record.type === "arrow"
            ? ` bend=${String(props["bend"])}`
            : "";
    return [
      `${partOf(record)} ${record.type} in ${parent ? partOf(parent) : "page"} at ${record.x},${record.y}${size}`,
    ];
  });
}

const MESSAGES: DiagramSpecEdge[] = [
  ["user", "web", "Sign in"],
  { key: "check", from: "web", to: "api", label: "POST", body: { activate: true } },
  ["api", "api", "hash"],
  {
    key: "denied",
    from: "api",
    to: "web",
    kind: "reply",
    label: "401",
    body: { deactivate: true },
  },
];
const login = (edges: readonly DiagramSpecEdge[] = MESSAGES): DiagramSpec => ({
  kit: "sequence",
  key: "login",
  nodes: [
    { key: "user", kind: "actor" },
    { key: "web" },
    { key: "api" },
    {
      key: "valid",
      kind: "alt",
      label: "ok",
      body: { from: "check", to: "denied", else: [{ from: "denied", label: "no" }] },
    },
  ],
  edges,
});

describe("sequence layout", () => {
  it("draws grouped heads over lifelines, messages bound to them row by row, bars and blocks", async () => {
    const result = await run(login());
    expect(result.counts).toEqual({ created: 8, updated: 0, kept: 0, removed: 0 });
    expect(result.overlaps).toEqual([]);
    expect(drawing((result.changes?.puts ?? []) as TLRecord[])).toEqual([
      "user/group group in frame at 48,48",
      "user geo in user/group at 0,0 128x64",
      "user/lifeline line in user/group at 64,64 h=356",
      "web/group group in frame at 224,48",
      "web geo in web/group at 0,0 128x64",
      "web/lifeline line in web/group at 64,64 h=356",
      "api/group group in frame at 400,48",
      "api geo in api/group at 0,0 128x64",
      "api/lifeline line in api/group at 64,64 h=356",
      "valid geo in frame at 256,180 272x256",
      "valid/c1 geo in frame at 256,328 272x108",
      "check/activation geo in api/group at 58,202 12x148",
      "user→web:sync arrow in frame at 112,158 bend=0",
      "check arrow in frame at 288,250 bend=0",
      "api→api:sync arrow in api/group at 64,236 bend=-16",
      "denied arrow in frame at 464,398 bend=0",
      "user→web:sync/start → user/lifeline y=0.129",
      "user→web:sync/end → web/lifeline y=0.129",
      "check/start → web/lifeline y=0.388",
      "check/end → api/lifeline y=0.388",
      "api→api:sync/start → api/lifeline y=0.483",
      "api→api:sync/end → api/lifeline y=0.573",
      "denied/start → api/lifeline y=0.803",
      "denied/end → web/lifeline y=0.803",
    ]);
    const styles = ["check", "denied"].map((key) => {
      const arrow = find((result.changes?.puts ?? []) as TLRecord[], key);
      return arrow.typeName === "shape" && arrow.type === "arrow"
        ? [arrow.props.dash, arrow.props.arrowheadEnd, arrow.props.fill]
        : null;
    });
    expect(styles).toEqual([
      ["solid", "triangle", "fill"],
      ["dashed", "arrow", "none"],
    ]);
  });

  it("is deterministic and composes the same spec again to no change", async () => {
    const first = await run(login());
    expect(await run(login())).toEqual(first);
    expect((await run(login(), applied(BASE, first))).changes).toBeNull();
  });

  it("pushes later messages down for an inserted one without counting them as changed, keeping a human's text edit", async () => {
    const before = applied(BASE, await run(login()));
    const denied = find(before, "denied");
    const edited = before.map((record) =>
      record.id === denied.id && record.typeName === "shape" && record.type === "arrow"
        ? { ...record, props: { ...record.props, richText: toRichText("401 locked") } }
        : record,
    );
    const inserted = await run(login(MESSAGES.toSpliced(1, 0, ["web", "web", "validate"])), edited);
    expect(inserted.counts).toEqual({ created: 1, updated: 0, kept: 8, removed: 0 });
    const after = applied(edited, inserted);
    expect(drawing(after).filter((line) => line.startsWith("denied"))).toEqual([
      "denied arrow in frame at 464,454 bend=0",
      "denied/start → api/lifeline y=0.830",
      "denied/end → web/lifeline y=0.830",
    ]);
    const kept = find(after, "denied");
    expect(kept.typeName === "shape" && kept.props).toMatchObject({
      richText: toRichText("401 locked"),
    });
    expect(kept.meta).toEqual(denied.meta);
    expect(readCompositions(after).summaries[0]).toMatchObject({ memberCount: 9, editedCount: 1 });
  });

  it("puts a dragged participant back on any change or relayout, never on an identical compose", async () => {
    const before = applied(BASE, await run(login()));
    const group = find(before, "api/group") as TLShape;
    const dragged = before.map((record) =>
      record.id === group.id ? { ...group, x: group.x + 300 } : record,
    );
    expect((await run(login(), dragged)).changes).toBeNull();
    const relaid = applied(dragged, await run(login(), dragged, true));
    expect(find(relaid, "api/group")).toEqual(group);
    expect(readCompositions(relaid).summaries[0]).toMatchObject({ editedCount: 0 });
  });

  it("deletes a bar or a section the spec no longer draws", async () => {
    const before = applied(BASE, await run(login()));
    const plain = login(
      MESSAGES.map((edge) =>
        Array.isArray(edge) ? edge : { ...("from" in edge ? edge : {}), body: {} },
      ) as DiagramSpecEdge[],
    );
    const spec: DiagramSpec = {
      ...plain,
      nodes: plain.nodes.map((node) =>
        node.key === "valid" ? { ...node, body: { from: "check", to: "denied" } } : node,
      ),
    };
    const result = await run(spec, before);
    expect(result.counts).toEqual({ created: 0, updated: 3, kept: 5, removed: 0 });
    expect(result.changes?.deletes).toEqual(
      ["valid/c1", "check/activation"].map((part) => find(before, part).id),
    );
    expect((await run(spec, applied(before, result))).changes).toBeNull();
  });

  it("appends a patched message and lets a patched block span messages only the canvas knows", async () => {
    const before = applied(BASE, await run(login()));
    const patched = await compose(
      {
        mode: "patch",
        spec: {
          kit: "sequence",
          key: "login",
          nodes: [{ key: "again", kind: "loop", body: { from: "check", to: "retry" } }],
          edges: [{ key: "retry", from: "web", to: "api", label: "POST" }],
        },
      },
      before,
      ports(before),
    );
    expect(patched.counts).toEqual({ created: 2, updated: 0, kept: 8, removed: 0 });
    const after = applied(before, patched);
    expect(drawing(after).filter((line) => /^(retry|again) /.test(line))).toEqual([
      "again geo in frame at 244,180 296x364",
      "retry arrow in frame at 288,506 bend=0",
    ]);
  });
});

describe("validating sequences", () => {
  const issuesOf = (spec: DiagramSpec) => {
    try {
      validateComposeRequest({ spec });
      return [];
    } catch (error) {
      return (error as { details?: { issues?: unknown } }).details?.issues;
    }
  };

  it("teaches message endpoints, block messages and their order", () => {
    expect(
      issuesOf({
        ...login(),
        nodes: [
          ...login().nodes.filter((node) => node.key !== "valid"),
          { key: "bad", kind: "opt", body: { from: "nope", to: "check" } },
          {
            key: "late",
            kind: "alt",
            body: { from: "denied", to: "check", else: [{ from: "user→web:sync" }] },
          },
          {
            key: "both",
            kind: "par",
            body: { from: "check", to: "denied", and: [{ from: "check" }] },
          },
        ],
        edges: [...MESSAGES, ["user", "bad", "?"]],
      }),
    ).toEqual([
      {
        path: "spec.edges[4].to",
        message: '"bad" is not a participant or actor; messages connect participants and actors',
      },
      {
        path: "spec.nodes[3].body.from",
        message:
          'unknown message "nope"; valid messages: user→web:sync, check, api→api:sync, denied, user→bad:sync',
      },
      { path: "spec.nodes[4].body.to", message: '"check" comes before "denied"' },
      {
        path: "spec.nodes[4].body.else[0].from",
        message:
          '"user→web:sync" is outside the block; a branch starts after "denied", at or before "check"',
      },
      {
        path: "spec.nodes[5].body.and[0].from",
        message:
          '"check" is outside the block; a branch starts after "check", at or before "denied"',
      },
    ]);
  });

  it("names the block fields and message fields each kind takes", () => {
    expect(
      issuesOf({
        ...login(),
        nodes: [{ key: "web" }, { key: "o", kind: "opt", body: { from: "m", else: [] } }],
        edges: [{ key: "m", from: "web", to: "web", body: { activate: "yes" } }],
      }),
    ).toEqual([
      {
        path: "spec.nodes[1].body.else",
        message: 'unknown field "else" for kind "opt"; valid fields: from, to',
      },
      { path: "spec.edges[0].body.activate", message: "Expected boolean | undefined" },
    ]);
  });
});
