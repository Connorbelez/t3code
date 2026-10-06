// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";

import { validateComposeRequest } from "@t3tools/diagram-compose/model";

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

describe("Mermaid classDiagram", () => {
  it("maps classes, members, stereotypes, namespaces, notes and every relation", async () => {
    const spec = await toSpec(`classDiagram
  class Animal {
    <<abstract>>
    +String name
    -int age$
    #List~String~ tags
    id: string
    +eat(food: Food) bool
    +sleep()$ void
    +move()*
  }
  class Shape~T~
  class Color {
    <<enumeration>>
    RED
    GREEN
  }
  class Pet {
    <<interface>>
  }
  class Repo {
    <<service>>
  }
  Animal <|-- Dog : extends
  Dog "1" *-- "4" Leg
  Dog o-- Toy
  Dog --> Owner : belongs
  Dog ..> Food
  Dog ..|> Pet
  Owner "1" -- "0..*" Dog : owns
  Dog <-- Cat
  Cat <--> Owner
  note for Dog "good boy"
  namespace Zoo {
    class Keeper
  }
  style Dog fill:#f9f`);
    expect(validateComposeRequest({ spec })).toBe("m");
    expect(spec).toEqual({
      kit: "uml-class",
      key: "m",
      direction: "up",
      nodes: [
        { key: "Zoo", kind: "package" },
        {
          key: "Animal",
          kind: "abstract",
          body: {
            attributes: [
              { visibility: "public", name: "name", type: "String" },
              { visibility: "private", static: true, name: "age", type: "int" },
              { visibility: "protected", name: "tags", type: "List<String>" },
              { name: "id", type: "string" },
            ],
            methods: [
              { visibility: "public", name: "eat", params: "food: Food", returns: "bool" },
              { visibility: "public", static: true, name: "sleep", returns: "void" },
              { visibility: "public", name: "move" },
            ],
          },
        },
        { key: "Shape", label: "Shape<T>" },
        { key: "Color", kind: "enum", body: { values: ["RED", "GREEN"] } },
        { key: "Pet", kind: "interface" },
        { key: "Repo", body: { stereotype: "service" } },
        { key: "Dog" },
        { key: "Leg" },
        { key: "Toy" },
        { key: "Owner" },
        { key: "Food" },
        { key: "Cat" },
        { key: "Keeper", parent: "Zoo" },
        { key: "Dog-note", kind: "note", label: "good boy", body: { on: "Dog" } },
      ],
      edges: [
        { from: "Dog", to: "Animal", kind: "inheritance", label: "extends" },
        { from: "Leg", to: "Dog", kind: "composition", body: { from: "4", to: "1" } },
        { from: "Toy", to: "Dog", kind: "aggregation" },
        { from: "Dog", to: "Owner", label: "belongs", body: { directed: true } },
        { from: "Dog", to: "Food", kind: "dependency" },
        { from: "Dog", to: "Pet", kind: "realization" },
        { from: "Owner", to: "Dog", label: "owns", body: { from: "1", to: "0..*" } },
        { from: "Cat", to: "Dog", body: { directed: true } },
        ["Cat", "Owner"],
      ],
    });
  });

  it.each([
    ["direction TB", "up"],
    ["direction BT", "down"],
    ["direction LR", "left"],
    ["direction RL", "right"],
  ])("lays out %s with superclasses where Mermaid puts them (%s)", async (line, direction) => {
    expect((await toSpec(`classDiagram\n  ${line}\n  A <|-- B`)).direction).toBe(direction);
  });
});

describe("Mermaid erDiagram", () => {
  it("maps entities, aliases, keyed columns and both cardinalities of each relationship", async () => {
    const spec = await toSpec(`erDiagram
  direction LR
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ LINE_ITEM : contains
  CUSTOMER }|..|{ ADDRESS : uses
  PRODUCT |o--o| LINE_ITEM : "is in"
  CUSTOMER {
    string id PK "the id"
    string name
    string orgId FK, UK
  }
  p[Person] {
    string name
  }`);
    expect(validateComposeRequest({ spec })).toBe("m");
    expect(spec).toEqual({
      kit: "er",
      key: "m",
      direction: "right",
      nodes: [
        {
          key: "CUSTOMER",
          body: {
            columns: [
              { name: "id", type: "string", pk: true },
              { name: "name", type: "string" },
              { name: "orgId", type: "string", fk: true },
            ],
          },
        },
        { key: "ORDER" },
        { key: "LINE_ITEM" },
        { key: "ADDRESS" },
        { key: "PRODUCT" },
        { key: "p", label: "Person", body: { columns: [{ name: "name", type: "string" }] } },
      ],
      edges: [
        { from: "CUSTOMER", to: "ORDER", label: "places", body: { from: "one", to: "many" } },
        {
          from: "ORDER",
          to: "LINE_ITEM",
          label: "contains",
          body: { from: "one", to: "oneOrMany" },
        },
        {
          from: "CUSTOMER",
          to: "ADDRESS",
          label: "uses",
          body: { from: "oneOrMany", to: "oneOrMany" },
        },
        {
          from: "PRODUCT",
          to: "LINE_ITEM",
          label: "is in",
          body: { from: "zeroOrOne", to: "zeroOrOne" },
        },
      ],
    });
  });
});

describe("Mermaid sequenceDiagram", () => {
  it("maps participants, actors, message kinds, activations and nested blocks to derived message keys", async () => {
    const spec = await toSpec(`sequenceDiagram
  autonumber
  participant A as Alice
  actor B
  A->>+B: hi
  B-->>-A: ok
  activate A
  A-)B: async
  A-xB: cross
  deactivate A
  loop Every minute
    A->>B: ping
    opt cached
      B->>B: lookup
    end
  end
  alt is sick
    B->>A: bad
  else is well
    B->>A: good
  end
  par one
    A->>B: x
  and two
    A->>B: y
  end
  rect rgb(0, 0, 0)
    A->>A: self
  end`);
    expect(spec).toEqual({
      kit: "sequence",
      key: "m",
      nodes: [
        { key: "A", label: "Alice" },
        { key: "B", kind: "actor" },
        {
          key: "loop-1",
          kind: "loop",
          label: "Every minute",
          body: { from: "A→B:sync#3", to: "B→B:sync" },
        },
        { key: "opt-1", kind: "opt", label: "cached", body: { from: "B→B:sync" } },
        {
          key: "alt-1",
          kind: "alt",
          label: "is sick",
          body: {
            from: "B→A:sync",
            to: "B→A:sync#2",
            else: [{ from: "B→A:sync#2", label: "is well" }],
          },
        },
        {
          key: "par-1",
          kind: "par",
          label: "one",
          body: {
            from: "A→B:sync#4",
            to: "A→B:sync#5",
            and: [{ from: "A→B:sync#5", label: "two" }],
          },
        },
      ],
      edges: [
        { from: "A", to: "B", label: "hi", body: { activate: true } },
        {
          from: "B",
          to: "A",
          kind: "reply",
          label: "ok",
          body: { activate: true, deactivate: true },
        },
        { from: "A", to: "B", kind: "async", label: "async" },
        { from: "A", to: "B", label: "cross", body: { deactivate: true } },
        ["A", "B", "ping"],
        ["B", "B", "lookup"],
        ["B", "A", "bad"],
        ["B", "A", "good"],
        ["A", "B", "x"],
        ["A", "B", "y"],
        ["A", "A", "self"],
      ],
    });
    // The derived keys the blocks name are the ones the spec gives those messages.
    expect(validateComposeRequest({ spec })).toBe("m");
  });

  it.each([
    [
      "sequenceDiagram\n  A->>B: hi\n  Note right of B: thinks",
      "sequence notes sit at a point in time, which the sequence kit cannot place; leave them out or fold their text into a message label",
    ],
    [
      "sequenceDiagram\n  critical connect\n    A->>B: hi\n  end",
      "this Mermaid construct cannot be drawn; the sequence kit draws participants, actors, ->> -) -->> -> --> -x --x messages, activations, and loop, alt, opt and par blocks",
    ],
    [
      "sequenceDiagram\n  A->>B: hi\n  activate A",
      'activate A must follow a message to A, as in "X->>+A"',
    ],
    [
      "sequenceDiagram\n  A->>B: hi\n  loop never\n  end",
      "a loop block holds no messages; leave it out",
    ],
  ])("fails %j as invalid-spec at the Mermaid text", async (text, message) => {
    await expect(toSpec(text)).rejects.toMatchObject({
      code: "invalid-spec",
      details: { issues: [{ path: "mermaid.text", message }] },
    });
  });
});

describe("Mermaid errors", () => {
  it.each([
    ['pie\n  "a": 1', "pie diagrams are not supported"],
    ["hello world", "this text is not a Mermaid diagram type"],
  ])("rejects %j as unsupported, listing the supported types", async (text, reason) => {
    await expect(toSpec(text)).rejects.toMatchObject({
      code: "unsupported-mermaid",
      details: {
        issues: [
          {
            path: "mermaid.text",
            message: `${reason}; supported types: flowchart, stateDiagram, classDiagram, erDiagram, sequenceDiagram`,
          },
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
      "classDiagram\n  A <|--|> B",
      "the relation between A and B is decorated at both ends; draw it as two relations",
    ],
    [
      "classDiagram\n  A ()-- B",
      "lollipop interfaces (()--) cannot be drawn; declare an <<interface>> class and relate to it with ..|>",
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
