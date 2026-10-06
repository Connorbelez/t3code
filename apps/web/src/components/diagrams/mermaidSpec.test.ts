// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";

import { mermaidToSpec } from "./mermaidSpec";

const toSpec = (text: string) => mermaidToSpec({ key: "m", text });

describe("Mermaid flowchart", () => {
  it("maps nodes, subgraphs, shapes and labelled edges, ignoring styling", async () => {
    expect(
      await toSpec(`flowchart LR
  A([Start]) --> B[Check cart<br/>and stock]
  B -->|yes| C{In stock?}
  C -- no --> B
  C -.-> D[/Save order/]
  D --> E[[Charge]]
  E ~~~ F
  subgraph pay [Payment]
    E --> F((Done))
    subgraph audit
      G
    end
  end
  C --> pay
  style A fill:#f9f
  classDef hot fill:#f00
  class B hot
  click A callback`),
    ).toEqual({
      kit: "flow",
      key: "m",
      direction: "right",
      nodes: [
        { key: "pay", kind: "group", label: "Payment" },
        { key: "audit", kind: "group", parent: "pay" },
        { key: "A", kind: "start", label: "Start" },
        { key: "B", label: "Check cart\nand stock" },
        { key: "C", kind: "decision", label: "In stock?" },
        { key: "D", kind: "io", label: "Save order" },
        { key: "E", kind: "subprocess", label: "Charge", parent: "pay" },
        { key: "F", kind: "end", label: "Done", parent: "pay" },
        { key: "G", parent: "audit" },
      ],
      edges: [
        ["A", "B"],
        ["B", "C", "yes"],
        ["C", "B", "no"],
        ["C", "D"],
        ["D", "E"],
        ["E", "F"],
        ["C", "pay"],
      ],
    });
  });

  it("accepts graph and fan-out syntax", async () => {
    expect(await toSpec("graph TD\n  a --> b & c\n  b --> d\n  c --> d")).toEqual({
      kit: "flow",
      key: "m",
      direction: "down",
      nodes: [{ key: "a" }, { key: "b" }, { key: "c" }, { key: "d" }],
      edges: [
        ["a", "b"],
        ["a", "c"],
        ["b", "d"],
        ["c", "d"],
      ],
    });
  });

  it.each([
    ["flowchart TB", "down"],
    ["flowchart BT", "up"],
    ["flowchart RL", "left"],
    ["stateDiagram-v2\n  direction LR", "right"],
  ])("maps %s to direction %s", async (header, direction) => {
    expect((await toSpec(`${header}\n  a --> b`)).direction).toBe(direction);
  });

  it("uses the given title and key", async () => {
    expect(
      await mermaidToSpec({ key: "signup", title: "Signup", text: "flowchart TD\n  a --> b" }),
    ).toMatchObject({ key: "signup", title: "Signup" });
  });
});

describe("Mermaid stateDiagram", () => {
  it("maps states, composites, markers, choices, notes and transition labels", async () => {
    expect(
      await toSpec(`stateDiagram-v2
  direction LR
  [*] --> Idle
  Idle --> Loading : fetch [online] / spin
  state Loading {
    [*] --> Waiting
    Waiting --> [*]
    note left of Waiting : polls every second
  }
  state "Long name" as Ln
  Loading --> Ln
  state check <<choice>>
  Ln --> check
  check --> [*] : done
  check --> Idle : retry
  note right of Idle : waits for input
  classDef busy fill:#f00
  class Loading busy`),
    ).toEqual({
      kit: "state",
      key: "m",
      direction: "right",
      nodes: [
        { key: "root_start", kind: "initial" },
        { key: "Idle" },
        { key: "Loading", kind: "composite" },
        { key: "Loading_start", kind: "initial", parent: "Loading" },
        { key: "Waiting", parent: "Loading" },
        { key: "Loading_end", kind: "final", parent: "Loading" },
        {
          key: "Waiting-note",
          kind: "note",
          label: "polls every second",
          parent: "Loading",
          body: { on: "Waiting" },
        },
        { key: "Ln", label: "Long name" },
        { key: "check", kind: "choice" },
        { key: "root_end", kind: "final" },
        { key: "Idle-note", kind: "note", label: "waits for input", body: { on: "Idle" } },
      ],
      edges: [
        ["root_start", "Idle"],
        ["Idle", "Loading", "fetch [online] / spin"],
        ["Loading_start", "Waiting"],
        ["Waiting", "Loading_end"],
        ["Loading", "Ln"],
        ["Ln", "check"],
        ["check", "root_end", "done"],
        ["check", "Idle", "retry"],
      ],
    });
  });

  it("shows a state's descriptions as Mermaid does", async () => {
    expect(
      await toSpec("stateDiagram\n  Idle : waiting\n  Idle : for input\n  [*] --> Idle"),
    ).toEqual({
      kit: "state",
      key: "m",
      direction: "down",
      nodes: [
        { key: "Idle", label: "waiting\nfor input" },
        { key: "root_start", kind: "initial" },
      ],
      edges: [["root_start", "Idle"]],
    });
  });
});

describe("Mermaid errors", () => {
  it.each([
    ["sequenceDiagram\n  A->>B: hi", "sequence diagrams are not supported"],
    ['pie\n  "a": 1', "pie diagrams are not supported"],
    ["hello world", "this text is not a Mermaid diagram type"],
  ])("rejects %j as unsupported, listing the supported types", async (text, reason) => {
    await expect(toSpec(text)).rejects.toMatchObject({
      code: "unsupported-mermaid",
      details: {
        issues: [
          { path: "mermaid.text", message: `${reason}; supported types: flowchart, stateDiagram` },
        ],
      },
    });
  });

  it.each([
    [
      "flowchart TD\n  a.b --> c",
      'node ID "a.b" cannot be a member key; use an ID of at most 120 characters without "." or whitespace',
    ],
    [
      "stateDiagram-v2\n  state f <<fork>>\n  [*] --> f",
      'state "f" is a fork, which the state kit cannot draw; valid state types: state, [*], <<choice>>, composite states and notes',
    ],
    [
      "stateDiagram-v2\n  state P {\n    [*] --> A\n    --\n    [*] --> B\n  }",
      "a composite state has concurrent regions (--), which the state kit cannot draw; split them into separate composite states",
    ],
  ])("fails %j as invalid-spec at the Mermaid text", async (text, message) => {
    await expect(toSpec(text)).rejects.toMatchObject({
      code: "invalid-spec",
      details: { issues: [{ path: "mermaid.text", message }] },
    });
  });

  it("reports Mermaid's own syntax error", async () => {
    await expect(toSpec("flowchart TD\n  A -->")).rejects.toMatchObject({
      code: "invalid-spec",
      details: {
        issues: [
          { path: "mermaid.text", message: expect.stringMatching(/^Parse error on line 3:/) },
        ],
      },
    });
  });
});
