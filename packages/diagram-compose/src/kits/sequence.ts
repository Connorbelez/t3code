import { DiagramMemberKey } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  ATTACH_EDGE_KIND,
  type BlockKind,
  type BlockSpan,
  defineKit,
  type EdgeKind,
  type Kit,
  type LifelineKind,
  nodeKindOf,
} from "../kit.ts";
import { listOf, type SpecIssue } from "../spec.ts";

const Message = Schema.Struct({
  activate: Schema.optional(Schema.Boolean),
  deactivate: Schema.optional(Schema.Boolean),
});

const MESSAGE_HELP =
  "body { activate: true } starts an activation bar on the receiver at this message; " +
  "body { deactivate: true } ends the sender's latest bar at this message.";

const message = (
  description: string,
  look: Pick<EdgeKind, "arrowheadEnd" | "dash" | "fill">,
): EdgeKind => ({
  description: `${description} ${MESSAGE_HELP}`,
  color: "black",
  arrowheadStart: "none",
  arrowKind: "arc",
  body: Message,
  activation: (body) => ({
    activate: body["activate"] === true,
    deactivate: body["deactivate"] === true,
  }),
  ...look,
});

const Section = Schema.Struct({
  from: DiagramMemberKey,
  label: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
const Span = Schema.Struct({
  from: DiagramMemberKey,
  to: Schema.optional(DiagramMemberKey),
  else: Schema.optional(Schema.Array(Section).check(Schema.isMaxLength(20))),
  and: Schema.optional(Schema.Array(Section).check(Schema.isMaxLength(20))),
});
const decodeSpan = Schema.decodeUnknownOption(Span);

/** `sections` names the body field that splits the block, such as alt's else. */
function block(description: string, sections?: "else" | "and"): BlockKind {
  const { from, to } = Span.fields;
  const fields = sections ? { from, to, [sections]: Span.fields[sections] } : { from, to };
  return {
    description,
    shape: "block",
    color: "grey",
    body: Schema.Struct(fields),
    span: (body): BlockSpan =>
      Option.match(decodeSpan(body), {
        onNone: () => ({ from: "", to: "", sections: [] }),
        onSome: (span) => ({
          from: span.from,
          to: span.to ?? span.from,
          sections: (sections ? (span[sections] ?? []) : []).map((section) => ({
            from: section.from,
            label: section.label ?? "",
          })),
        }),
      }),
  };
}

const lifeline = (
  description: string,
  look: Pick<LifelineKind, "geo" | "color" | "labelRoom">,
): LifelineKind => ({
  description,
  shape: "lifeline",
  minSize: { w: 128, h: 56 },
  ...look,
});

const BLOCK_HELP =
  'body { "from": "<first message key>", "to"?: "<last message key>" } spans those messages, in message order.';

export const sequence = defineKit({
  name: "sequence",
  guidance:
    "Sequence diagrams: participants as columns and messages in order, top to bottom. Kinds default to participant and labels to keys. " +
    'Edges are messages, drawn in spec order: ["web", "api", "POST /login"]; a message from a participant to itself is a self call. ' +
    "Messages are keyed from→to:kind (#2, #3 for repeats) unless you give them a key; give short keys to messages that blocks name. " +
    "Set kind reply for answers and async for messages the sender does not wait on. " +
    "body { activate: true } on a message starts the receiver's activation bar there, and body { deactivate: true } on a later message from that participant ends it. " +
    'Draw alt, opt, loop and par blocks as nodes, e.g. { "key": "valid", "kind": "alt", "label": "card valid", "body": { "from": "charge", "to": "declined", "else": [{ "from": "declined", "label": "declined" }] } }. ' +
    "Insert a message anywhere in a full spec and later messages move down; a patch appends new messages at the end. Notes sit below the diagram.",
  look: "precise",
  direction: "down",
  arrowKind: "arc",
  layout: "sequence",
  nodeKinds: {
    participant: lifeline(
      "A system or component that sends and receives messages. The default kind. Drawn as a box over a dashed lifeline.",
      { geo: "rectangle", color: "blue" },
    ),
    actor: lifeline("A person or external party. Drawn as an ellipse over a dashed lifeline.", {
      geo: "ellipse",
      color: "violet",
      labelRoom: 1.2,
    }),
    alt: block(
      `Alternatives: the first branch runs when its label holds. ${BLOCK_HELP} body.else lists the later branches as [{ "from": "<message key>", "label"?: "<condition>" }].`,
      "else",
    ),
    opt: block(`Messages that run only when the label holds. ${BLOCK_HELP}`),
    loop: block(`Messages that repeat; label the condition, e.g. "every 5s". ${BLOCK_HELP}`),
    par: block(
      `Branches that run in parallel. ${BLOCK_HELP} body.and lists the later branches as [{ "from": "<message key>", "label"?: "<name>" }].`,
      "and",
    ),
  },
  defaultKind: "participant",
  edgeKinds: {
    sync: message(
      "A call the sender waits on, drawn with a filled arrowhead. The default edge kind.",
      { arrowheadEnd: "triangle", fill: "fill" },
    ),
    async: message("A message the sender does not wait on, drawn with an open arrowhead.", {
      arrowheadEnd: "arrow",
    }),
    reply: message("An answer to an earlier call, drawn dashed with an open arrowhead.", {
      arrowheadEnd: "arrow",
      dash: "dashed",
    }),
  },
  defaultEdgeKind: "sync",
  check: checkReferences,
  example: {
    kit: "sequence",
    key: "login",
    title: "Login",
    nodes: [
      { key: "user", kind: "actor", label: "User" },
      { key: "web", label: "Web app" },
      { key: "api", label: "API" },
      {
        key: "valid",
        kind: "alt",
        label: "password valid",
        body: { from: "ok", to: "denied", else: [{ from: "denied", label: "wrong password" }] },
      },
    ],
    edges: [
      ["user", "web", "Sign in"],
      { key: "check", from: "web", to: "api", label: "POST /login", body: { activate: true } },
      ["api", "api", "Verify password"],
      { key: "ok", from: "api", to: "web", kind: "reply", label: "200 token" },
      {
        key: "denied",
        from: "api",
        to: "web",
        kind: "reply",
        label: "401",
        body: { deactivate: true },
      },
    ],
  },
});

/** Messages connect participants, and blocks name messages, in order when the spec holds both. */
function checkReferences({
  nodes,
  edges,
  outside,
}: Parameters<NonNullable<Kit["check"]>>[0]): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const isLifeline = (key: string) => {
    const node = nodes.find((candidate) => candidate.key === key) ?? outside?.nodes.get(key);
    // Unknown on the server, and a participant a human deleted may come back.
    if (node === undefined) return outside === null;
    if (node === null) return true;
    return nodeKindOf(sequence, node.kind)?.shape === "lifeline";
  };
  const messages = edges.filter((edge) => edge.kind !== ATTACH_EDGE_KIND);
  const order = new Map(messages.map((edge, i) => [edge.key, i]));
  messages.forEach((edge, i) => {
    for (const end of ["from", "to"] as const) {
      if (!isLifeline(edge[end])) {
        issues.push({
          path: `spec.edges[${i}].${end}`,
          message: `"${edge[end]}" is not a participant or actor; messages connect participants and actors`,
        });
      }
    }
  });

  const keys = messages.map((edge) => edge.key);
  // A patch's messages may sit anywhere in the composition's order, so only a whole spec is ordered.
  const ordered = outside !== null && outside.nodes.size === 0 && outside.edges.size === 0;
  nodes.forEach((node, i) => {
    const kind = nodeKindOf(sequence, node.kind);
    const body = node.body;
    if (kind?.shape !== "block" || !body) return;
    const path = `spec.nodes[${i}].body`;
    const span = kind.span(body);
    const field = "else" in body ? "else" : "and";
    const ends = [
      { at: `${path}.from`, key: span.from },
      ...("to" in body ? [{ at: `${path}.to`, key: span.to }] : []),
    ];
    const sections = span.sections.map((section, j) => ({
      at: `${path}.${field}[${j}].from`,
      key: section.from,
    }));
    const unknown = [...ends, ...sections].filter(
      (ref) => !order.has(ref.key) && outside !== null && !outside.edges.has(ref.key),
    );
    for (const ref of unknown) {
      issues.push({
        path: ref.at,
        message: `unknown message "${ref.key}"; valid messages: ${listOf(keys)}`,
      });
    }
    if (unknown.length > 0 || !ordered) return;
    const first = order.get(span.from) ?? 0;
    const last = order.get(span.to) ?? 0;
    if (last < first) {
      issues.push({ path: `${path}.to`, message: `"${span.to}" comes before "${span.from}"` });
    }
    for (const section of sections) {
      const at = order.get(section.key) ?? 0;
      if (at <= first || at > last) {
        issues.push({
          path: section.at,
          message: `"${section.key}" is outside the block; a branch starts after "${span.from}", at or before "${span.to}"`,
        });
      }
    }
  });
  return issues;
}
