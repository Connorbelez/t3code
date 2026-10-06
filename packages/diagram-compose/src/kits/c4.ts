import * as Schema from "effect/Schema";

import { defineKit, type GeoDrawing, type GeoKind } from "../kit.ts";

const Element = Schema.Struct({
  external: Schema.optional(Schema.Boolean),
  technology: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});
const decodeElement = Schema.decodeUnknownSync(Element);

/** Name, [technology] and description on separate lines; external elements are grey and dashed. */
function drawElement(label: string, body: Schema.JsonObject): GeoDrawing {
  const { external, technology, description } = decodeElement(body);
  const lines = [label, technology && `[${technology}]`, description].filter(Boolean);
  return {
    label: lines.join("\n"),
    ...(external ? { color: "grey", dash: "dashed" } : {}),
  };
}

const element = (
  description: string,
  look: Pick<GeoKind, "geo" | "color" | "minSize" | "labelRoom">,
): GeoKind => ({ description, shape: "geo", body: Element, draw: drawElement, ...look });

export const c4 = defineKit({
  name: "c4",
  guidance:
    "C4 context, container and component views. Kinds default to container and labels to keys. " +
    'Every element takes body { "technology"?, "description"?, "external"? }: technology and description ' +
    "become extra label lines, and external: true draws an element outside the system in scope grey and dashed. " +
    'Put containers inside their system, or components inside their container, with a boundary node and parent: "<boundary key>"; boundaries nest. ' +
    'Label relationships with what flows and how, e.g. ["web", "api", "Makes API calls [JSON/HTTPS]"]. ' +
    "Add notes with kind note. Layout runs top to bottom unless direction says otherwise.",
  look: "precise",
  direction: "down",
  arrowKind: "elbow",
  nodeKinds: {
    person: element("A person or role who uses the system. Drawn as a violet pill.", {
      geo: "oval",
      color: "violet",
      minSize: { w: 160, h: 80 },
      labelRoom: 1.2,
    }),
    system: element("A software system, in a context view. Drawn as a blue rectangle.", {
      geo: "rectangle",
      color: "blue",
      minSize: { w: 192, h: 96 },
    }),
    container: element(
      "An application or data store inside a system, such as a web app, API or database. The default kind. Drawn as a light blue rectangle.",
      { geo: "rectangle", color: "light-blue", minSize: { w: 192, h: 96 } },
    ),
    component: element(
      "A component inside a container, such as a controller or repository. Drawn as a light violet rectangle.",
      { geo: "rectangle", color: "light-violet", minSize: { w: 176, h: 80 } },
    ),
    boundary: {
      description:
        "A system or container boundary drawn as a frame around the nodes whose parent is this boundary. Label it with the system or container name.",
      shape: "frame",
    },
  },
  defaultKind: "container",
  edgeKinds: {
    relationship: {
      description:
        'A relationship, labelled with what flows and how, e.g. "Reads from [SQL]". The default edge kind.',
      color: "black",
      arrowheadStart: "none",
      arrowheadEnd: "arrow",
    },
  },
  defaultEdgeKind: "relationship",
  example: {
    kit: "c4",
    key: "banking",
    title: "Internet banking: containers",
    nodes: [
      { key: "customer", kind: "person", label: "Customer" },
      { key: "bank", kind: "boundary", label: "Internet Banking" },
      {
        key: "web",
        label: "Web App",
        parent: "bank",
        body: { technology: "React", description: "Lets customers bank online" },
      },
      { key: "api", label: "API", parent: "bank", body: { technology: "Node.js" } },
      { key: "db", label: "Database", parent: "bank", body: { technology: "PostgreSQL" } },
      {
        key: "mail",
        kind: "system",
        label: "Email System",
        body: { external: true, description: "Sends statements" },
      },
    ],
    edges: [
      ["customer", "web", "Uses [HTTPS]"],
      ["web", "api", "Calls [JSON/HTTPS]"],
      ["api", "db", "Reads and writes [SQL]"],
      ["api", "mail", "Sends email [SMTP]"],
    ],
  },
});
