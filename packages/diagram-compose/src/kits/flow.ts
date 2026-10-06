import { defineKit } from "../kit.ts";

export const flow = defineKit({
  name: "flow",
  guidance:
    "Flowcharts: steps, decisions, inputs and outputs. Kinds default to process and labels to keys. " +
    'Write edges as [from, to] or [from, to, label]; label decision branches, e.g. "yes" and "no". ' +
    'Group nodes by giving them parent: "<group key>". Add notes with kind note. ' +
    "Layout runs top to bottom unless direction says otherwise.",
  look: "precise",
  direction: "down",
  arrowKind: "elbow",
  nodeKinds: {
    start: {
      description: "Where the flow begins.",
      shape: "geo",
      geo: "oval",
      color: "green",
      minSize: { w: 128, h: 64 },
      labelRoom: 1.2,
    },
    end: {
      description: "Where the flow ends.",
      shape: "geo",
      geo: "oval",
      color: "red",
      minSize: { w: 128, h: 64 },
      labelRoom: 1.2,
    },
    process: {
      description: "A step that does something. The default kind.",
      shape: "geo",
      geo: "rectangle",
      color: "blue",
      minSize: { w: 160, h: 72 },
    },
    decision: {
      description: "A question; label its outgoing edges with the answers.",
      shape: "geo",
      geo: "diamond",
      color: "yellow",
      minSize: { w: 160, h: 112 },
      labelRoom: 1.5,
    },
    io: {
      description: "Input or output, such as reading a file or showing a result.",
      shape: "geo",
      geo: "rhombus",
      color: "violet",
      minSize: { w: 160, h: 72 },
      labelRoom: 1.25,
    },
    subprocess: {
      description: "A step that is its own flow elsewhere.",
      shape: "geo",
      geo: "rectangle",
      color: "light-blue",
      dash: "dashed",
      minSize: { w: 160, h: 72 },
    },
    group: {
      description:
        "A boundary drawn as a frame around the nodes whose parent is this group, such as a subsystem or a phase.",
      shape: "frame",
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
