import type { DiagramHostComposeResult, DiagramSpec } from "@t3tools/contracts";
import type { TLRecord, TLShape } from "@tldraw/tlschema";
import { describe, expect, it } from "vite-plus/test";

import { compose, type ComposePorts } from "../compose.ts";
import { kitReference, validateComposeRequest } from "../model.ts";

const BASE = [
  { id: "document:document", typeName: "document", gridSize: 10, name: "", meta: {} },
  { id: "page:main", typeName: "page", name: "Page 1", index: "a1", meta: {} },
] as unknown as TLRecord[];

function portsFor(records: readonly TLRecord[]): ComposePorts {
  const rehearse = (puts: readonly TLRecord[], deletes: readonly string[]) => {
    const after = new Map(records.map((record) => [record.id as string, record]));
    for (const record of puts) after.set(record.id, record);
    for (const id of deletes) after.delete(id);
    return after;
  };
  return {
    measureText: (text) => {
      const lines = text.split("\n");
      return { w: 8 * Math.max(...lines.map((line) => line.length)), h: 22 * lines.length };
    },
    rehearse,
    parseMermaid: () => Promise.reject(new Error("not expected")),
  };
}

const run = (spec: DiagramSpec, records: readonly TLRecord[] = BASE) =>
  compose({ spec }, records, portsFor(records));

function applied(records: readonly TLRecord[], result: DiagramHostComposeResult): TLRecord[] {
  const after = portsFor(records).rehearse(
    (result.changes?.puts ?? []) as TLRecord[],
    result.changes?.deletes ?? [],
  );
  return Array.from(after.values());
}

/** Each member's main shape as what a reader sees: parent member, geo, style and label lines. */
function drawn(result: DiagramHostComposeResult) {
  const shapes = ((result.changes?.puts ?? []) as TLRecord[]).filter(
    (record): record is TLShape => record.typeName === "shape",
  );
  const keyOf = new Map(
    shapes.map((shape) => {
      const meta = shape.meta["t3Composition"] as { m?: string } | undefined;
      return [shape.id as string, meta?.m ?? "(frame)"];
    }),
  );
  const seen: Record<string, unknown> = {};
  for (const shape of shapes) {
    const key = keyOf.get(shape.id) ?? "";
    if (key === "(frame)") continue;
    const parent = keyOf.get(shape.parentId);
    if (shape.type === "frame") seen[key] = { frame: shape.props.name, parent };
    else if (shape.type === "arrow") seen[key] = { arrow: lines(shape.props.richText), parent };
    else if (shape.type !== "geo") seen[key] = { type: shape.type, parent };
    else {
      const { geo, color, dash, richText } = shape.props;
      seen[key] = { geo, color, dash, text: lines(richText), parent };
    }
  }
  return seen;
}

function lines(richText: { content: unknown[] }): string[] {
  return richText.content.map((paragraph) => {
    const content = (paragraph as { content?: { text: string }[] }).content ?? [];
    return content.map((node) => node.text).join("");
  });
}

function failure(spec: DiagramSpec): unknown {
  try {
    validateComposeRequest({ spec });
  } catch (cause) {
    return cause;
  }
  return undefined;
}

// A component view: components inside their container, inside their system.
const COMPONENTS: DiagramSpec = {
  kit: "c4",
  key: "banking",
  title: "API components",
  nodes: [
    { key: "spa", label: "Web App", body: { technology: "React" } },
    { key: "bank", kind: "boundary", label: "Internet Banking" },
    { key: "apiBox", kind: "boundary", label: "API", parent: "bank" },
    {
      key: "signin",
      kind: "component",
      label: "Sign In",
      parent: "apiBox",
      body: { technology: "Express", description: "Checks credentials" },
    },
    { key: "accounts", kind: "component", label: "Accounts", parent: "apiBox" },
    { key: "db", label: "Database", parent: "bank", body: { technology: "PostgreSQL" } },
    {
      key: "mainframe",
      kind: "system",
      label: "Mainframe",
      body: { external: true, description: "Core banking" },
    },
    { key: "clerk", kind: "person", label: "Clerk", body: { external: true } },
  ],
  edges: [
    ["spa", "signin", "Signs in [JSON/HTTPS]"],
    ["signin", "db", "Reads users [SQL]"],
    ["accounts", "mainframe", "Gets balances [XML/HTTPS]"],
    ["clerk", "mainframe"],
  ],
};

const SHOP: DiagramSpec = {
  kit: "architecture",
  key: "shop",
  nodes: [
    { key: "app", kind: "client", label: "Mobile app" },
    { key: "aws", kind: "zone", label: "AWS" },
    { key: "vpc", kind: "zone", label: "VPC", parent: "aws" },
    { key: "gw", kind: "gateway", label: "Gateway", parent: "aws" },
    { key: "lb", kind: "loadBalancer", label: "LB", parent: "vpc" },
    { key: "orders", label: "Orders", parent: "vpc", body: { technology: "Go" } },
    { key: "db", kind: "datastore", label: "Orders DB", parent: "vpc" },
    { key: "redis", kind: "cache", label: "Cache", parent: "vpc", body: { technology: "Redis" } },
    { key: "events", kind: "queue", label: "Events", parent: "aws" },
    { key: "mailer", kind: "function", label: "Mailer", parent: "aws" },
    { key: "files", kind: "storage", label: "Receipts", parent: "aws" },
    { key: "stripe", kind: "external", label: "Stripe" },
  ],
  edges: [
    ["app", "gw", "HTTPS"],
    ["gw", "lb", "HTTP"],
    ["lb", "orders"],
    ["orders", "db", "SQL"],
    ["orders", "redis", "RESP"],
    ["orders", "events", "AMQP"],
    ["events", "mailer"],
    ["mailer", "files", "S3 API"],
    ["orders", "stripe", "HTTPS"],
  ],
};

describe("c4 kit", () => {
  it("lists its vocabulary, and its example composes", () => {
    const reference = kitReference("c4");
    expect({
      defaultKind: reference.defaultKind,
      kinds: reference.nodeKinds.map((row) => row.kind),
      defaultEdgeKind: reference.defaultEdgeKind,
      edgeKinds: reference.edgeKinds.map((row) => row.kind),
    }).toEqual({
      defaultKind: "container",
      kinds: ["person", "system", "container", "component", "boundary", "note"],
      defaultEdgeKind: "relationship",
      edgeKinds: ["relationship"],
    });
    expect(reference.nodeKinds[0]?.description).toBe(
      "A person or role who uses the system. Drawn as a violet pill.",
    );
    expect(validateComposeRequest({ spec: reference.example })).toBe("banking");
  });

  it("draws name, technology and description lines, external elements grey and dashed, in nested boundaries", async () => {
    const result = await run(COMPONENTS);
    expect(drawn(result)).toEqual({
      spa: {
        geo: "rectangle",
        color: "light-blue",
        dash: "solid",
        text: ["Web App", "[React]"],
        parent: "(frame)",
      },
      bank: { frame: "Internet Banking", parent: "(frame)" },
      apiBox: { frame: "API", parent: "bank" },
      signin: {
        geo: "rectangle",
        color: "light-violet",
        dash: "solid",
        text: ["Sign In", "[Express]", "Checks credentials"],
        parent: "apiBox",
      },
      accounts: {
        geo: "rectangle",
        color: "light-violet",
        dash: "solid",
        text: ["Accounts"],
        parent: "apiBox",
      },
      db: {
        geo: "rectangle",
        color: "light-blue",
        dash: "solid",
        text: ["Database", "[PostgreSQL]"],
        parent: "bank",
      },
      mainframe: {
        geo: "rectangle",
        color: "grey",
        dash: "dashed",
        text: ["Mainframe", "Core banking"],
        parent: "(frame)",
      },
      clerk: { geo: "oval", color: "grey", dash: "dashed", text: ["Clerk"], parent: "(frame)" },
      "spa→signin:relationship": { arrow: ["Signs in [JSON/HTTPS]"], parent: "(frame)" },
      "signin→db:relationship": { arrow: ["Reads users [SQL]"], parent: "bank" },
      "accounts→mainframe:relationship": {
        arrow: ["Gets balances [XML/HTTPS]"],
        parent: "(frame)",
      },
      "clerk→mainframe:relationship": { arrow: [""], parent: "(frame)" },
    });
    expect(result.overlaps).toEqual([]);
    const after = applied(BASE, result);
    expect((await run(COMPONENTS, after)).changes).toBeNull();
  });

  it("rewrites an element whose technology changed", async () => {
    const records = applied(BASE, await run(COMPONENTS));
    const changed: DiagramSpec = {
      ...COMPONENTS,
      nodes: COMPONENTS.nodes.map((node) =>
        node.key === "db" ? { ...node, body: { technology: "MySQL" } } : node,
      ),
    };
    const result = await run(changed, records);
    expect(result.counts).toEqual({ created: 0, updated: 1, kept: 11, removed: 0 });
    expect(drawn(result)["db"]).toMatchObject({ text: ["Database", "[MySQL]"] });
  });

  it("teaches valid kinds and body fields", () => {
    expect(
      failure({
        kit: "c4",
        key: "bad",
        nodes: [
          { key: "a", kind: "database" },
          { key: "b", body: { tech: "Go" } },
          { key: "c", kind: "person", body: { external: "yes" } },
          { key: "d", parent: "b" },
        ],
      }),
    ).toMatchObject({
      code: "invalid-spec",
      details: {
        issues: [
          {
            path: "spec.nodes[0].kind",
            message:
              'unknown kind "database" for kit c4; valid kinds: person, system, container, component, boundary, note',
          },
          {
            path: "spec.nodes[1].body.tech",
            message:
              'unknown field "tech" for kind "container"; valid fields: external, technology, description',
          },
          { path: "spec.nodes[2].body.external", message: "Expected boolean | undefined" },
          {
            path: "spec.nodes[3].parent",
            message: '"b" is a container, which cannot hold nodes; parents must be boundary nodes',
          },
        ],
      },
    });
  });
});

describe("architecture kit", () => {
  it("lists its vocabulary, and its example composes", () => {
    const reference = kitReference("architecture");
    expect({
      defaultKind: reference.defaultKind,
      kinds: reference.nodeKinds.map((row) => row.kind),
      defaultEdgeKind: reference.defaultEdgeKind,
      edgeKinds: reference.edgeKinds.map((row) => row.kind),
    }).toEqual({
      defaultKind: "service",
      kinds: [
        "service",
        "datastore",
        "queue",
        "cache",
        "loadBalancer",
        "gateway",
        "client",
        "function",
        "storage",
        "external",
        "zone",
        "note",
      ],
      defaultEdgeKind: "connection",
      edgeKinds: ["connection"],
    });
    expect(reference.nodeKinds.find((row) => row.kind === "external")?.description).toBe(
      "A third-party service or system outside yours. Drawn as a grey dashed cloud.",
    );
    expect(validateComposeRequest({ spec: reference.example })).toBe("shop");
  });

  it("distinguishes kinds by geo and color, shows technology and protocols, and nests zones", async () => {
    const result = await run(SHOP);
    expect(drawn(result)).toEqual({
      app: {
        geo: "ellipse",
        color: "light-violet",
        dash: "solid",
        text: ["Mobile app"],
        parent: "(frame)",
      },
      aws: { frame: "AWS", parent: "(frame)" },
      vpc: { frame: "VPC", parent: "aws" },
      gw: { geo: "octagon", color: "violet", dash: "solid", text: ["Gateway"], parent: "aws" },
      lb: { geo: "diamond", color: "yellow", dash: "solid", text: ["LB"], parent: "vpc" },
      orders: {
        geo: "rectangle",
        color: "blue",
        dash: "solid",
        text: ["Orders", "[Go]"],
        parent: "vpc",
      },
      db: { geo: "oval", color: "green", dash: "solid", text: ["Orders DB"], parent: "vpc" },
      redis: {
        geo: "hexagon",
        color: "light-red",
        dash: "solid",
        text: ["Cache", "[Redis]"],
        parent: "vpc",
      },
      events: { geo: "rhombus", color: "orange", dash: "solid", text: ["Events"], parent: "aws" },
      mailer: {
        geo: "rectangle",
        color: "light-blue",
        dash: "solid",
        text: ["Mailer"],
        parent: "aws",
      },
      files: {
        geo: "trapezoid",
        color: "light-green",
        dash: "solid",
        text: ["Receipts"],
        parent: "aws",
      },
      stripe: { geo: "cloud", color: "grey", dash: "dashed", text: ["Stripe"], parent: "(frame)" },
      "app→gw:connection": { arrow: ["HTTPS"], parent: "(frame)" },
      "gw→lb:connection": { arrow: ["HTTP"], parent: "aws" },
      "lb→orders:connection": { arrow: [""], parent: "vpc" },
      "orders→db:connection": { arrow: ["SQL"], parent: "vpc" },
      "orders→redis:connection": { arrow: ["RESP"], parent: "vpc" },
      "orders→events:connection": { arrow: ["AMQP"], parent: "aws" },
      "events→mailer:connection": { arrow: [""], parent: "aws" },
      "mailer→files:connection": { arrow: ["S3 API"], parent: "aws" },
      "orders→stripe:connection": { arrow: ["HTTPS"], parent: "(frame)" },
    });
    expect(result.overlaps).toEqual([]);
    const after = applied(BASE, result);
    expect((await run(SHOP, after)).changes).toBeNull();
  });

  it("teaches valid body fields and zone parents", () => {
    expect(
      failure({
        kit: "architecture",
        key: "bad",
        nodes: [
          { key: "a", kind: "datastore", body: { technology: 5 } },
          { key: "b", kind: "external", body: { protocol: "HTTPS" } },
          { key: "c", parent: "zz" },
          { key: "z", kind: "zone", body: {} },
        ],
      }),
    ).toMatchObject({
      code: "invalid-spec",
      details: {
        issues: [
          { path: "spec.nodes[0].body.technology", message: "Expected string | undefined" },
          {
            path: "spec.nodes[1].body.protocol",
            message: 'unknown field "protocol" for kind "external"; valid fields: technology',
          },
          { path: "spec.nodes[3].body", message: 'kind "zone" takes no body fields' },
          {
            path: "spec.nodes[2].parent",
            message: 'unknown parent "zz"; valid parents are zone nodes: z',
          },
        ],
      },
    });
  });
});
