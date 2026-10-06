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
 * Mermaid flowchart, stateDiagram, classDiagram and erDiagram text to a composition spec. Mermaid's parsed databases are
 * semi-internal API, so mermaid is pinned exactly and each supported type has fixtures. Import
 * this module lazily: mermaid is large and needs a DOM.
 */

const SUPPORTED = "flowchart, stateDiagram, classDiagram, erDiagram";
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
    class: { kit: "uml-class", map: classDiagram },
    classDiagram: { kit: "uml-class", map: classDiagram },
    er: { kit: "er", map: erDiagram },
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

const ClassMember = Schema.Struct({
  id: Schema.String,
  visibility: Schema.String,
  classifier: Schema.String,
  parameters: Schema.optional(Schema.String),
  returnType: Schema.optional(Schema.String),
});
const ClassNode = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  label: Schema.String,
  members: Schema.Array(ClassMember),
  methods: Schema.Array(ClassMember),
  annotations: Schema.Array(Schema.String),
  parent: Schema.optional(Schema.String),
});
const End = Schema.Union([Schema.Number, Schema.String]);
const ClassRelation = Schema.Struct({
  id1: Schema.String,
  id2: Schema.String,
  relationTitle1: Schema.String,
  relationTitle2: Schema.String,
  title: Schema.optional(Schema.String),
  relation: Schema.Struct({ type1: End, type2: End, lineType: Schema.Number }),
});
const ClassNote = Schema.Struct({
  id: Schema.String,
  class: Schema.optional(Schema.String),
  text: Schema.String,
});
const Namespace = Schema.Struct({ id: Schema.String, parent: Schema.optional(Schema.String) });
const decodeClassNodes = Schema.decodeUnknownSync(Schema.Array(ClassNode));
const decodeClassRelations = Schema.decodeUnknownSync(Schema.Array(ClassRelation));
const decodeClassNotes = Schema.decodeUnknownSync(Schema.Array(ClassNote));
const decodeNamespaces = Schema.decodeUnknownSync(Schema.Array(Namespace));

const VISIBILITIES: Record<string, string> = {
  "+": "public",
  "-": "private",
  "#": "protected",
  "~": "package",
};
const CLASS_KINDS: Record<string, string> = {
  interface: "interface",
  abstract: "abstract",
  enumeration: "enum",
  enum: "enum",
};
/** Mermaid's relation end types; "none" is a plain end. */
const RELATION_ENDS: Record<number, string> = {
  0: "aggregation",
  1: "extension",
  2: "composition",
  3: "arrow",
  4: "lollipop",
};
const DOTTED = 1;
/**
 * Mermaid ranks a relation's first class higher, as in `Animal <|-- Dog`, while the kit lays out
 * subclass-to-superclass edges bottom to top; so Mermaid's TB is the kit's up.
 */
const CLASS_DIRECTIONS: Record<string, DiagramLayoutDirection> = {
  TB: "up",
  TD: "up",
  BT: "down",
  LR: "left",
  RL: "right",
};

function classDiagram(db: object): Content {
  const classes = decodeClassNodes(Array.from(mapValues(call(db, "getClasses"))));
  const namespaces = decodeNamespaces(Array.from(mapValues(call(db, "getNamespaces"))));
  const notes = decodeClassNotes(Array.from(mapValues(call(db, "getNotes"))));
  const parentOf = new Map(classes.map((item) => [item.id, item.parent]));
  const noteCounts = new Map<string, number>();
  const nodes = [
    ...namespaces.map((namespace) =>
      node(namespace.id, { kind: "package", parent: namespace.parent }),
    ),
    ...classes.map((item) => {
      const annotation = item.annotations[0]?.toLowerCase();
      const kind = annotation === undefined ? undefined : CLASS_KINDS[annotation];
      const stereotype =
        annotation !== undefined && kind === undefined ? item.annotations[0] : undefined;
      const body =
        kind === "enum"
          ? { values: item.members.map((member) => generics(member.id)) }
          : {
              ...(stereotype === undefined ? {} : { stereotype }),
              attributes: item.members.flatMap((member) => attribute(member) ?? []),
              methods: item.methods.flatMap((member) => method(member) ?? []),
            };
      const label = item.type === "" ? item.label : `${item.label}<${generics(item.type)}>`;
      return node(item.id, { kind, label, parent: item.parent, body: compact(body) });
    }),
    ...notes.map((note) => {
      if (note.class === undefined) return node(note.id, { kind: "note", label: note.text });
      const count = (noteCounts.get(note.class) ?? 0) + 1;
      noteCounts.set(note.class, count);
      return node(`${note.class}-note${count === 1 ? "" : count}`, {
        kind: "note",
        label: note.text,
        parent: parentOf.get(note.class),
        body: { on: memberKey(note.class) },
      });
    }),
  ];
  return {
    direction: CLASS_DIRECTIONS[stringOrEmpty(call(db, "getDirection"))],
    nodes,
    edges: decodeClassRelations(call(db, "getRelations")).map(relation),
  };
}

/** `name: Type` or Mermaid's Java-style `Type name`. */
function attribute(member: typeof ClassMember.Type) {
  const text = generics(member.id).trim();
  const colon = text.indexOf(":");
  const space = text.lastIndexOf(" ");
  const [name, type] =
    colon > 0
      ? [text.slice(0, colon), text.slice(colon + 1)]
      : space > 0
        ? [text.slice(space + 1), text.slice(0, space)]
        : [text, ""];
  return compact({
    ...memberFlags(member),
    name: name.trim(),
    type: type.trim(),
  });
}

function method(member: typeof ClassMember.Type) {
  return compact({
    ...memberFlags(member),
    name: member.id,
    params: generics(member.parameters ?? ""),
    returns: generics(member.returnType ?? ""),
  });
}

/** Mermaid's `$` classifier is static; `*` (abstract) has no field and is dropped. */
function memberFlags(member: typeof ClassMember.Type) {
  const visibility = VISIBILITIES[member.visibility];
  return {
    ...(visibility === undefined ? {} : { visibility }),
    ...(member.classifier === "$" ? { static: true } : {}),
  };
}

/** The decorated end becomes `to`, so `Animal <|-- Dog` is Dog's inheritance of Animal. */
function relation(item: typeof ClassRelation.Type): DiagramSpecEdge {
  const [start, end] = [item.relation.type1, item.relation.type2].map((type) =>
    typeof type === "number" ? RELATION_ENDS[type] : undefined,
  );
  const between = `the relation between ${item.id1} and ${item.id2}`;
  // `<-->` is navigable both ways, which UML draws as a plain association.
  const bothArrows = start === "arrow" && end === "arrow";
  if (start !== undefined && end !== undefined && !bothArrows) {
    throw unmappable(`${between} is decorated at both ends; draw it as two relations`);
  }
  const reversed = start !== undefined && end === undefined;
  const decoration = bothArrows ? undefined : reversed ? start : end;
  const [from, to] = reversed ? [item.id2, item.id1] : [item.id1, item.id2];
  const titles = [item.relationTitle1, item.relationTitle2].map((title) =>
    title === "none" || title.trim() === "" ? undefined : title.trim(),
  );
  const [fromTitle, toTitle] = reversed ? titles.toReversed() : titles;
  const dotted = item.relation.lineType === DOTTED;
  const kind = ((): string | undefined => {
    switch (decoration) {
      case undefined:
        return undefined;
      case "arrow":
        return dotted ? "dependency" : undefined;
      case "extension":
        return dotted ? "realization" : "inheritance";
      case "aggregation":
      case "composition":
        return decoration;
      default:
        throw unmappable(
          "lollipop interfaces (()--) cannot be drawn; declare an <<interface>> class and relate to it with ..|>",
        );
    }
  })();
  const multiplicities = kind === undefined || kind === "aggregation" || kind === "composition";
  const body = compact({
    ...(multiplicities ? { from: fromTitle, to: toTitle } : {}),
    ...(kind === undefined && decoration === "arrow" ? { directed: true } : {}),
  });
  const label = cleanLabel(item.title ?? "");
  if (kind === undefined && body === undefined) return link(from, to, label);
  return {
    from: memberKey(from),
    to: memberKey(to),
    ...(kind === undefined ? {} : { kind }),
    ...(label === "" ? {} : { label }),
    ...(body === undefined ? {} : { body }),
  };
}

const ErAttribute = Schema.Struct({
  type: Schema.String,
  name: Schema.String,
  keys: Schema.Array(Schema.String),
});
const ErEntity = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  alias: Schema.String,
  attributes: Schema.Array(ErAttribute),
});
const ErRelationship = Schema.Struct({
  entityA: Schema.String,
  entityB: Schema.String,
  roleA: Schema.String,
  relSpec: Schema.Struct({ cardA: Schema.String, cardB: Schema.String }),
});
const decodeEntities = Schema.decodeUnknownSync(Schema.Array(ErEntity));
const decodeRelationships = Schema.decodeUnknownSync(Schema.Array(ErRelationship));

const CARDINALITIES: Record<string, string> = {
  ONLY_ONE: "one",
  ZERO_OR_ONE: "zeroOrOne",
  ZERO_OR_MORE: "many",
  ONE_OR_MORE: "oneOrMany",
};

function erDiagram(db: object): Content {
  const entities = decodeEntities(Array.from(mapValues(call(db, "getEntities"))));
  const names = new Map(entities.map((entity) => [entity.id, entity.label]));
  const nameOf = (id: string) => names.get(id) ?? id;
  const cardinality = (value: string, entity: string) => {
    const mapped = CARDINALITIES[value];
    if (mapped) return mapped;
    throw unmappable(
      `a relationship of ${nameOf(entity)} has cardinality ${value}, which the er kit cannot draw; valid cardinalities: ||, |o, }o, }|`,
    );
  };
  return {
    direction: DIRECTIONS[stringOrEmpty(call(db, "getDirection"))],
    nodes: entities.map((entity) =>
      node(entity.label, {
        label: entity.alias === "" ? undefined : entity.alias,
        body: compact({
          columns: entity.attributes.flatMap((column) =>
            compact({
              name: column.name,
              type: column.type,
              ...(column.keys.includes("PK") ? { pk: true } : {}),
              ...(column.keys.includes("FK") ? { fk: true } : {}),
            }),
          ),
        }),
      }),
    ),
    // Mermaid stores each end's cardinality on the opposite side: cardB belongs to entityA.
    edges: decodeRelationships(call(db, "getRelationships")).map((item) => {
      const label = cleanLabel(item.roleA);
      return {
        from: memberKey(nameOf(item.entityA)),
        to: memberKey(nameOf(item.entityB)),
        ...(label === "" ? {} : { label }),
        body: {
          from: cardinality(item.relSpec.cardB, item.entityA),
          to: cardinality(item.relSpec.cardA, item.entityB),
        },
      };
    }),
  };
}

/** Mermaid writes generics as `List~String~`. */
function generics(text: string): string {
  return text.replace(/~([^~]*)~/g, "<$1>");
}

/** Drops empty fields, and returns undefined when none are left, so specs stay as short as the Mermaid. */
function compact<T extends Record<string, unknown>>(fields: T): Partial<T> | undefined {
  const kept = Object.entries(fields).filter(
    ([, value]) =>
      value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0),
  );
  return kept.length === 0 ? undefined : (Object.fromEntries(kept) as Partial<T>);
}

function mapValues(value: unknown): Iterable<unknown> {
  return value instanceof Map ? value.values() : [];
}

/** Spec defaults keep the output as short as the Mermaid: labels equal to keys are dropped. */
function node(
  id: string,
  fields: {
    readonly kind?: string | undefined;
    readonly label?: string | undefined;
    readonly parent?: string | undefined;
    readonly body?: DiagramSpecNode["body"];
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
