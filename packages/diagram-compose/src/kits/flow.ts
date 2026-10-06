import { defineKit } from "../kit.ts";

export const flow = defineKit({
  name: "flow",
  guidance:
    "Flowcharts: steps, decisions, inputs and outputs. Kinds default to process and labels to keys. " +
    'Write edges as [from, to] or [from, to, label]; label decision branches, e.g. "yes" and "no". ' +
    "Layout runs top to bottom unless direction says otherwise.",
  look: "precise",
  direction: "down",
  arrowKind: "elbow",
  nodeKinds: {
    start: {
      description: "Where the flow begins.",
      geo: "oval",
      color: "green",
      minSize: { w: 128, h: 64 },
      labelRoom: 1.2,
    },
    end: {
      description: "Where the flow ends.",
      geo: "oval",
      color: "red",
      minSize: { w: 128, h: 64 },
      labelRoom: 1.2,
    },
    process: {
      description: "A step that does something. The default kind.",
      geo: "rectangle",
      color: "blue",
      minSize: { w: 160, h: 72 },
    },
    decision: {
      description: "A question; label its outgoing edges with the answers.",
      geo: "diamond",
      color: "yellow",
      minSize: { w: 160, h: 112 },
      labelRoom: 1.5,
    },
    io: {
      description: "Input or output, such as reading a file or showing a result.",
      geo: "rhombus",
      color: "violet",
      minSize: { w: 160, h: 72 },
      labelRoom: 1.25,
    },
    subprocess: {
      description: "A step that is its own flow elsewhere.",
      geo: "rectangle",
      color: "light-blue",
      dash: "dashed",
      minSize: { w: 160, h: 72 },
    },
  },
  defaultKind: "process",
  edgeKinds: {
    flow: {
      description: "Control passes from one node to the next. The default edge kind.",
      color: "black",
      arrowheadStart: "none",
      arrowheadEnd: "arrow",
    },
  },
  defaultEdgeKind: "flow",
  example: {
    kit: "flow",
    key: "signup",
    title: "Signup",
    nodes: [
      { key: "start", kind: "start", label: "Start" },
      { key: "form", label: "Fill in form" },
      { key: "valid", kind: "decision", label: "Valid?" },
      { key: "done", kind: "end", label: "Done" },
    ],
    edges: [
      ["start", "form"],
      ["form", "valid"],
      ["valid", "done", "yes"],
      ["valid", "form", "no"],
    ],
  },
});
