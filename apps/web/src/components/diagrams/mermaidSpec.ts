import {
  DiagramMemberKey,
  DiagramOperationError,
  type DiagramKit,
  type DiagramLayoutDirection,
  type DiagramMermaidSource,
  type DiagramSpec,
  type DiagramSpecEdge,
  type DiagramSpecNode,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import mermaid from "mermaid";

/**
 * Mermaid flowchart and stateDiagram text to a composition spec. Mermaid's parsed databases are
 * semi-internal API, so mermaid is pinned exactly and each supported type has fixtures. Import
 * this module lazily: mermaid is large and needs a DOM.
 */

const SUPPORTED = "flowchart, stateDiagram";
const TEXT_PATH = "mermaid.text";

interface Content {
  readonly direction: DiagramLayoutDirection | undefined;
  readonly nodes: readonly DiagramSpecNode[];
  readonly edges: readonly DiagramSpecEdge[];
}

const MAPPERS: Record<string, { readonly kit: DiagramKit; readonly map: (db: object) => Content }> =
  {
    flowchart: { kit: "flow", map: flowchart },
    "flowchart-v2": { kit: "flow", map: flowchart },
    "flowchart-elk": { kit: "flow", map: flowchart },
    stateDiagram: { kit: "state", map: stateDiagram },
    state: { kit: "state", map: stateDiagram },
  };

export async function mermaidToSpec(source: DiagramMermaidSource): Promise<DiagramSpec> {
  // Registers the diagram detectors without touching the global config chat renders use.
  await mermaid.registerExternalDiagrams([]);
  let type: string;
  try {
    type = mermaid.detectType(source.text);
  } catch {
    throw unsupported("this text is not a Mermaid diagram type");
  }
  const mapper = MAPPERS[type];
  if (!mapper) throw unsupported(`${type} diagrams are not supported`);
  let db: object;
  try {
    db = (await mermaid.mermaidAPI.getDiagramFromText(source.text)).db;
  } catch (cause) {
    throw unmappable(cause instanceof Error ? cause.message : String(cause));
  }
  const { direction, nodes, edges } = mapper.map(db);
  return {
    kit: mapper.kit,
    key: source.key,
    ...(source.title === undefined ? {} : { title: source.title }),
    ...(direction === undefined ? {} : { direction }),
    nodes,
    edges,
  };
}

const DIRECTIONS: Record<string, DiagramLayoutDirection> = {
  TB: "down",
  TD: "down",
  BT: "up",
  LR: "right",
  RL: "left",
};

const FLOW_KINDS: Record<string, string> = {
  diamond: "decision",
  diam: "decision",
  decision: "decision",
  question: "decision",
  rhombus: "decision",
  lean_right: "io",
  lean_left: "io",
  "lean-r": "io",
  "lean-l": "io",
  "in-out": "io",
  "out-in": "io",
  subroutine: "subprocess",
  subproc: "subprocess",
  "fr-rect": "subprocess",
};
/** Rounded terminals start the flow when nothing enters them and end it when nothing leaves. */
const FLOW_TERMINALS = new Set([
  "stadium",
  "pill",
  "terminal",
  "circle",
  "circ",
  "doublecircle",
  "dbl-circ",
  "sm-circ",
  "small-circle",
  "start",
  "stop",
]);

const FlowVertex = Schema.Struct({
  id: Schema.String,
  text: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
});
const FlowEdge = Schema.Struct({
  start: Schema.String,
  end: Schema.String,
  text: Schema.optional(Schema.String),
  stroke: Schema.optional(Schema.String),
});
const FlowSubgraph = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  nodes: Schema.Array(Schema.String),
});
const decodeVertices = Schema.decodeUnknownSync(Schema.Array(FlowVertex));
const decodeFlowEdges = Schema.decodeUnknownSync(Schema.Array(FlowEdge));
const decodeSubgraphs = Schema.decodeUnknownSync(Schema.Array(FlowSubgraph));

function flowchart(db: object): Content {
  const vertexMap = call(db, "getVertices");
  const vertices = decodeVertices(vertexMap instanceof Map ? Array.from(vertexMap.values()) : []);
  const edges = decodeFlowEdges(call(db, "getEdges")).filter((edge) => edge.stroke !== "invisible");
  // Inner subgraphs come first, so a node's first listing is its innermost subgraph.
  const subgraphs = decodeSubgraphs(call(db, "getSubGraphs"));
  const parents = new Map<string, string>();
  for (const subgraph of subgraphs)
    for (const id of subgraph.nodes) if (!parents.has(id)) parents.set(id, subgraph.id);
  const groups = new Set(subgraphs.map((subgraph) => subgraph.id));

  const incoming = new Set(edges.map((edge) => edge.end));
  const outgoing = new Set(edges.map((edge) => edge.start));
  const kindOf = (vertex: typeof FlowVertex.Type) => {
    const type = vertex.type ?? "";
    if (FLOW_TERMINALS.has(type))
      return !incoming.has(vertex.id) ? "start" : !outgoing.has(vertex.id) ? "end" : undefined;
    return FLOW_KINDS[type];
  };
  // Subgraphs listed outermost first, so each sits after its parent like nodes in the spec.
  const nodes = [
    ...subgraphs.toReversed().map((subgraph) =>
      node(subgraph.id, {
        kind: "group",
        label: subgraph.title,
        parent: parents.get(subgraph.id),
      }),
    ),
    ...vertices
      .filter((vertex) => !groups.has(vertex.id))
      .map((vertex) =>
        node(vertex.id, {
          kind: kindOf(vertex),
          label: vertex.text,
          parent: parents.get(vertex.id),
        }),
      ),
  ];
  return {
    direction: DIRECTIONS[stringOrEmpty(call(db, "getDirection"))],
    nodes,
    edges: edges.map((edge) => link(edge.start, edge.end, edge.text)),
  };
}

const StateNode = Schema.Struct({
  id: Schema.String,
  shape: Schema.String,
  label: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  description: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  parentId: Schema.optional(Schema.String),
});
const StateEdge = Schema.Struct({
  start: Schema.String,
  end: Schema.String,
  label: Schema.optional(Schema.String),
  classes: Schema.optional(Schema.String),
});
const decodeStateData = Schema.decodeUnknownSync(
  Schema.Struct({
    nodes: Schema.Array(StateNode),
    edges: Schema.Array(StateEdge),
    direction: Schema.optional(Schema.String),
  }),
);

const STATE_KINDS: Record<string, string | undefined> = {
  rect: undefined,
  rectWithTitle: undefined,
  roundedWithTitle: "composite",
  stateStart: "initial",
  stateEnd: "final",
  choice: "choice",
  note: "note",
};

function stateDiagram(db: object): Content {
  const data = decodeStateData(call(db, "getData"));
  const noteEdges = data.edges.filter((edge) => edge.classes?.includes("note-edge"));
  const byId = new Map(data.nodes.map((state) => [state.id, state]));
  const nodes = data.nodes.flatMap((state): DiagramSpecNode[] => {
    // Mermaid wraps each note and its state in a layout-only group.
    if (state.shape === "noteGroup") return [];
    if (state.shape === "note") {
      const edge = noteEdges.find((link) => link.start === state.id || link.end === state.id);
      const on = edge?.start === state.id ? edge.end : edge?.start;
      if (on === undefined) return [];
      return [
        node(`${on}-note`, {
          kind: "note",
          label: textOf(state.label),
          parent: byId.get(on)?.parentId,
          body: { on },
        }),
      ];
    }
    if (!(state.shape in STATE_KINDS)) {
      throw unmappable(
        state.shape === "divider"
          ? `a composite state has concurrent regions (--), which the state kit cannot draw; split them into separate composite states`
          : `state "${state.id}" is a ${state.shape}, which the state kit cannot draw; valid state types: state, [*], <<choice>>, composite states and notes`,
      );
    }
    const kind = STATE_KINDS[state.shape];
    const marker = kind === "initial" || kind === "final";
    const description = textOf(state.description);
    const label = textOf(state.label);
    return [
      node(state.id, {
        kind,
        label: marker ? undefined : description ? `${label}\n${description}` : label,
        parent: state.parentId,
      }),
    ];
  });
  return {
    direction: DIRECTIONS[data.direction ?? ""],
    nodes,
    edges: data.edges
      .filter((edge) => !edge.classes?.includes("note-edge"))
      .map((edge) => link(edge.start, edge.end, edge.label)),
  };
}

/** Spec defaults keep the output as short as the Mermaid: labels equal to keys are dropped. */
function node(
  id: string,
  fields: {
    readonly kind?: string | undefined;
    readonly label?: string | undefined;
    readonly parent?: string | undefined;
    readonly body?: { readonly on: string };
  },
): DiagramSpecNode {
  const key = memberKey(id);
  const label = fields.label === undefined ? undefined : cleanLabel(fields.label);
  return {
    key,
    ...(fields.kind === undefined ? {} : { kind: fields.kind }),
    ...(label === undefined || label === key ? {} : { label }),
    ...(fields.parent === undefined ? {} : { parent: memberKey(fields.parent) }),
    ...(fields.body === undefined ? {} : { body: fields.body }),
  };
}

function link(from: string, to: string, label: string | undefined): DiagramSpecEdge {
  const text = cleanLabel(label ?? "");
  return text === "" ? [memberKey(from), memberKey(to)] : [memberKey(from), memberKey(to), text];
}

const isMemberKey = Schema.is(DiagramMemberKey);

/** Member keys are the Mermaid IDs, so the same Mermaid composed again updates in place. */
function memberKey(id: string): string {
  if (isMemberKey(id)) return id;
  throw unmappable(
    `node ID "${id}" cannot be a member key; use an ID of at most 120 characters without "." or whitespace`,
  );
}

function cleanLabel(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

function textOf(value: string | readonly string[] | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : value.join("\n");
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Reads a parsed diagram database method; its result is decoded by the caller. */
function call(db: object, method: string): unknown {
  const fn: unknown = Reflect.get(db, method);
  if (typeof fn !== "function") throw unmappable(`this Mermaid version has no ${method}`);
  const result: unknown = Reflect.apply(fn, db, []);
  return result;
}

function unsupported(message: string): DiagramOperationError {
  return new DiagramOperationError({
    code: "unsupported-mermaid",
    details: {
      issues: [{ path: TEXT_PATH, message: `${message}; supported types: ${SUPPORTED}` }],
    },
  });
}

function unmappable(message: string): DiagramOperationError {
  return new DiagramOperationError({
    code: "invalid-spec",
    details: { issues: [{ path: TEXT_PATH, message: message.slice(0, 1000) }] },
  });
}
