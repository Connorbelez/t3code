import { defineKit } from "../kit.ts";

export const state = defineKit({
  name: "state",
  guidance:
    "State machines: states, transitions, guards and terminal states. Kinds default to state and labels to keys. " +
    'Label transitions "event [guard] / action", each part optional, e.g. ["idle", "loading", "fetch [online] / showSpinner"]. ' +
    "Begin at an initial node and end at final nodes. Nest states inside a composite by giving them " +
    'parent: "<composite key>"; a composite can have its own initial and final nodes. Add notes with kind note. ' +
    "Layout runs top to bottom unless direction says otherwise.",
  look: "precise",
  direction: "down",
  arrowKind: "elbow",
  nodeKinds: {
    state: {
      description: "A state the machine rests in. The default kind.",
      shape: "geo",
      geo: "rectangle",
      color: "blue",
      minSize: { w: 144, h: 64 },
    },
    initial: {
      description:
        "Where the machine, or a composite, starts. Drawn as a filled dot without a label.",
      shape: "geo",
      geo: "ellipse",
      color: "black",
      fill: "fill",
      minSize: { w: 32, h: 32 },
      hideLabel: true,
    },
    final: {
      description:
        "Where the machine, or a composite, ends. Drawn as a hollow dot without a label.",
      shape: "geo",
      geo: "ellipse",
      color: "black",
      fill: "solid",
      minSize: { w: 32, h: 32 },
      hideLabel: true,
    },
    choice: {
      description:
        "A branch on guards. Drawn as a small diamond without a label; put the guards on its outgoing transitions.",
      shape: "geo",
      geo: "diamond",
      color: "yellow",
      minSize: { w: 48, h: 48 },
      hideLabel: true,
    },
    composite: {
      description:
        "A state that contains states, drawn as a frame around the nodes whose parent is this composite.",
      shape: "frame",
    },
  },
  defaultKind: "state",
  edgeKinds: {
    transition: {
      description: "A transition labelled event [guard] / action. The default edge kind.",
      color: "black",
      arrowheadStart: "none",
      arrowheadEnd: "arrow",
    },
  },
  defaultEdgeKind: "transition",
  example: {
    kit: "state",
    key: "fetcher",
    title: "Fetcher",
    nodes: [
      { key: "start", kind: "initial" },
      { key: "idle" },
      { key: "active", kind: "composite", label: "Active" },
      { key: "loading", parent: "active" },
      { key: "ready", parent: "active" },
      { key: "closed", kind: "final" },
      { key: "retry", kind: "note", label: "Retries 3 times", body: { on: "loading" } },
    ],
    edges: [
      ["start", "idle"],
      ["idle", "loading", "fetch [online] / showSpinner"],
      ["loading", "ready", "loaded"],
      ["active", "closed", "close"],
    ],
  },
});
