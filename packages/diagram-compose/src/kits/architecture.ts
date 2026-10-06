import * as Schema from "effect/Schema";

import { defineKit, type GeoDrawing, type GeoKind } from "../kit.ts";

const Component = Schema.Struct({ technology: Schema.optional(Schema.String) });
const decodeComponent = Schema.decodeUnknownSync(Component);

/** The technology, when given, is a second label line. */
function drawComponent(label: string, body: Schema.JsonObject): GeoDrawing {
  const { technology } = decodeComponent(body);
  return { label: technology ? `${label}\n[${technology}]` : label };
}

const component = (
  description: string,
  look: Pick<GeoKind, "geo" | "color" | "dash" | "minSize" | "labelRoom">,
): GeoKind => ({ description, shape: "geo", body: Component, draw: drawComponent, ...look });

export const architecture = defineKit({
  name: "architecture",
  guidance:
    "System architecture and system design: services, data stores, queues and what connects them. " +
    'Kinds default to service and labels to keys. Every component takes body { "technology"? }, shown as a second label line, e.g. { "technology": "PostgreSQL" }. ' +
    'Label edges with the protocol or what flows, e.g. ["api", "orders", "gRPC"]. ' +
    'Group components by network, region, cluster or trust zone with a zone node and parent: "<zone key>"; zones nest. ' +
    "Add notes with kind note. Layout runs left to right unless direction says otherwise.",
  look: "precise",
  direction: "right",
  arrowKind: "elbow",
  nodeKinds: {
    service: component(
      "A service or application server. The default kind. Drawn as a blue rectangle.",
      { geo: "rectangle", color: "blue", minSize: { w: 160, h: 72 } },
    ),
    datastore: component(
      "A database or other store of records. Drawn as a green pill, like a cylinder on its side.",
      { geo: "oval", color: "green", minSize: { w: 160, h: 72 }, labelRoom: 1.2 },
    ),
    queue: component("A message queue, stream or event bus. Drawn as an orange parallelogram.", {
      geo: "rhombus",
      color: "orange",
      minSize: { w: 160, h: 72 },
      labelRoom: 1.25,
    }),
    cache: component("An in-memory cache. Drawn as a light red hexagon.", {
      geo: "hexagon",
      color: "light-red",
      minSize: { w: 160, h: 80 },
      labelRoom: 1.2,
    }),
    loadBalancer: component("A load balancer or reverse proxy. Drawn as a yellow diamond.", {
      geo: "diamond",
      color: "yellow",
      minSize: { w: 160, h: 112 },
      labelRoom: 1.5,
    }),
    gateway: component("An API gateway or ingress. Drawn as a violet octagon.", {
      geo: "octagon",
      color: "violet",
      minSize: { w: 160, h: 88 },
      labelRoom: 1.2,
    }),
    client: component(
      "Something users run, such as a browser, mobile app or CLI. Drawn as a light violet ellipse.",
      { geo: "ellipse", color: "light-violet", minSize: { w: 160, h: 80 }, labelRoom: 1.4 },
    ),
    function: component(
      "A serverless function or scheduled job. Drawn as a light blue rectangle.",
      { geo: "rectangle", color: "light-blue", minSize: { w: 144, h: 64 } },
    ),
    storage: component(
      "Object or file storage, such as a bucket. Drawn as a light green trapezoid.",
      {
        geo: "trapezoid",
        color: "light-green",
        minSize: { w: 160, h: 72 },
        labelRoom: 1.25,
      },
    ),
    external: component(
      "A third-party service or system outside yours. Drawn as a grey dashed cloud.",
      { geo: "cloud", color: "grey", dash: "dashed", minSize: { w: 176, h: 104 }, labelRoom: 1.4 },
    ),
    zone: {
      description:
        "A network, region, cluster or trust zone, drawn as a frame around the nodes whose parent is this zone.",
      shape: "frame",
    },
  },
  defaultKind: "service",
  edgeKinds: {
    connection: {
      description:
        'A request or data flow, labelled with its protocol, e.g. "HTTPS" or "gRPC". The default edge kind.',
      color: "black",
      arrowheadStart: "none",
      arrowheadEnd: "arrow",
    },
  },
  defaultEdgeKind: "connection",
  example: {
    kit: "architecture",
    key: "shop",
    title: "Shop",
    nodes: [
      { key: "browser", kind: "client", label: "Browser" },
      { key: "vpc", kind: "zone", label: "VPC" },
      { key: "lb", kind: "loadBalancer", label: "Load balancer", parent: "vpc" },
      { key: "api", label: "API", parent: "vpc", body: { technology: "Node.js" } },
      {
        key: "db",
        kind: "datastore",
        label: "Orders",
        parent: "vpc",
        body: { technology: "PostgreSQL" },
      },
      { key: "stripe", kind: "external", label: "Stripe" },
    ],
    edges: [
      ["browser", "lb", "HTTPS"],
      ["lb", "api", "HTTP"],
      ["api", "db", "SQL"],
      ["api", "stripe", "HTTPS"],
    ],
  },
});
