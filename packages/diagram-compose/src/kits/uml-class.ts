import type { TLDefaultColorStyle } from "@tldraw/tlschema";
import * as Schema from "effect/Schema";

import { type CompartmentsKind, defineKit, endsLabel } from "../kit.ts";

const Visibility = Schema.Literals(["public", "private", "protected", "package"]);
const VISIBILITY_SYMBOLS = { public: "+", private: "-", protected: "#", package: "~" } as const;

const Attribute = Schema.Struct({
  visibility: Schema.optional(Visibility),
  name: Schema.String,
  type: Schema.optional(Schema.String),
  static: Schema.optional(Schema.Boolean),
});
const Method = Schema.Struct({
  visibility: Schema.optional(Visibility),
  name: Schema.String,
  params: Schema.optional(Schema.String),
  returns: Schema.optional(Schema.String),
  static: Schema.optional(Schema.Boolean),
});
const ClassBody = Schema.Struct({
  stereotype: Schema.optional(Schema.String),
  attributes: Schema.optional(Schema.Array(Attribute)),
  methods: Schema.optional(Schema.Array(Method)),
});
const EnumBody = Schema.Struct({
  stereotype: Schema.optional(Schema.String),
  values: Schema.optional(Schema.Array(Schema.String)),
});
const Multiplicities = Schema.Struct({
  from: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String),
});
const AssociationBody = Schema.Struct({
  ...Multiplicities.fields,
  directed: Schema.optional(Schema.Boolean),
});

const decodeClass = Schema.decodeUnknownSync(ClassBody);
const decodeEnum = Schema.decodeUnknownSync(EnumBody);
const decodeMultiplicities = Schema.decodeUnknownSync(Multiplicities);
const decodeAssociation = Schema.decodeUnknownSync(AssociationBody);

/** UML text notation, e.g. `+ static count: int`; static is spelled out instead of underlined. */
function memberLine(
  visibility: typeof Visibility.Type | undefined,
  isStatic: boolean | undefined,
  text: string,
): string {
  const prefix = [visibility && VISIBILITY_SYMBOLS[visibility], isStatic ? "static" : undefined];
  return [...prefix, text].filter((part) => part !== undefined).join(" ");
}

const BODY_HELP =
  "body: { stereotype?, attributes: [{ visibility?, name, type?, static? }], " +
  "methods: [{ visibility?, name, params?, returns?, static? }] }; visibility is public, private, protected or package.";

function classKind(
  description: string,
  color: TLDefaultColorStyle,
  stereotype?: string,
): CompartmentsKind {
  return {
    shape: "compartments",
    description: `${description} ${BODY_HELP}`,
    color,
    body: ClassBody,
    heading: (body) => {
      const shown = decodeClass(body).stereotype ?? stereotype;
      return shown === undefined ? [] : [`«${shown}»`];
    },
    compartments: [
      (body) =>
        (decodeClass(body).attributes ?? []).map((attribute) =>
          memberLine(
            attribute.visibility,
            attribute.static,
            attribute.type === undefined ? attribute.name : `${attribute.name}: ${attribute.type}`,
          ),
        ),
      (body) =>
        (decodeClass(body).methods ?? []).map((method) =>
          memberLine(
            method.visibility,
            method.static,
            `${method.name}(${method.params ?? ""})${method.returns === undefined ? "" : `: ${method.returns}`}`,
          ),
        ),
    ],
  };
}

const MULTIPLICITY_HELP = 'body { from?, to? } sets multiplicities such as "1" or "0..*".';

export const umlClass = defineKit({
  name: "uml-class",
  guidance:
    "UML class diagrams: classes, interfaces, abstract classes and enums with their members, and how they relate. " +
    "Kinds default to class and labels to keys. Put members in body, e.g. " +
    '{ "attributes": [{ "visibility": "private", "name": "id", "type": "string" }], "methods": [{ "visibility": "public", "name": "save", "params": "force: boolean", "returns": "void" }] }; ' +
    "enums list body.values. Edges point at the decorated end: subclass to superclass, class to interface, part to whole. " +
    'Multiplicities go in the edge body, e.g. { "from": "1", "to": "0..*" }. Group classes into packages with parent. ' +
    "Add notes with kind note. Layout runs bottom to top, so superclasses and wholes sit above, unless direction says otherwise.",
  look: "precise",
  direction: "up",
  arrowKind: "elbow",
  nodeKinds: {
    class: classKind("A class with attribute and method compartments. The default kind.", "blue"),
    interface: classKind("An interface, headed «interface».", "violet", "interface"),
    abstract: classKind("An abstract class, headed «abstract».", "light-blue", "abstract"),
    enum: {
      shape: "compartments",
      description:
        "An enumeration, headed «enumeration», with one value per line. body: { stereotype?, values: [string] }.",
      color: "green",
      body: EnumBody,
      heading: (body) => [`«${decodeEnum(body).stereotype ?? "enumeration"}»`],
      compartments: [(body) => decodeEnum(body).values ?? []],
    },
    package: {
      description: "A package drawn as a frame around the classes whose parent is this package.",
      shape: "frame",
    },
  },
  defaultKind: "class",
  edgeKinds: {
    association: {
      description: `A relationship between two classes. The default edge kind. ${MULTIPLICITY_HELP} body { directed: true } adds an arrowhead at to.`,
      color: "black",
      arrowheadStart: "none",
      arrowheadEnd: "none",
      body: AssociationBody,
      draw: (label, body) => {
        const { from, to, directed } = decodeAssociation(body);
        return {
          label: endsLabel(from, label, to),
          ...(directed ? { arrowheadEnd: "arrow" } : {}),
        };
      },
    },
    inheritance: {
      description: "From a subclass to its superclass, with a hollow triangle at the superclass.",
      color: "black",
      arrowheadStart: "none",
      arrowheadEnd: "triangle",
    },
    realization: {
      description: "From a class to an interface it implements: dashed, with a hollow triangle.",
      color: "black",
      arrowheadStart: "none",
      arrowheadEnd: "triangle",
      dash: "dashed",
    },
    aggregation: {
      description: `From a part to the whole that holds it, with a hollow diamond at the whole. ${MULTIPLICITY_HELP}`,
      color: "black",
      arrowheadStart: "none",
      arrowheadEnd: "diamond",
      body: Multiplicities,
      draw: (label, body) => {
        const { from, to } = decodeMultiplicities(body);
        return { label: endsLabel(from, label, to) };
      },
    },
    composition: {
      description: `From a part to the whole that owns it, with a filled diamond at the whole. ${MULTIPLICITY_HELP}`,
      color: "black",
      arrowheadStart: "none",
      arrowheadEnd: "diamond",
      fill: "fill",
      body: Multiplicities,
      draw: (label, body) => {
        const { from, to } = decodeMultiplicities(body);
        return { label: endsLabel(from, label, to) };
      },
    },
    dependency: {
      description: "From a class to one it uses: a dashed arrow.",
      color: "black",
      arrowheadStart: "none",
      arrowheadEnd: "arrow",
      dash: "dashed",
    },
  },
  defaultEdgeKind: "association",
  example: {
    kit: "uml-class",
    key: "accounts",
    title: "Accounts",
    nodes: [
      {
        key: "Account",
        kind: "abstract",
        body: {
          attributes: [{ visibility: "protected", name: "id", type: "string" }],
          methods: [{ visibility: "public", name: "close", returns: "void" }],
        },
      },
      {
        key: "Savings",
        body: { attributes: [{ visibility: "private", name: "rate", type: "number" }] },
      },
      {
        key: "Auditable",
        kind: "interface",
        body: { methods: [{ name: "audit", returns: "Report" }] },
      },
      {
        key: "Owner",
        body: { attributes: [{ visibility: "public", name: "name", type: "string" }] },
      },
    ],
    edges: [
      { from: "Savings", to: "Account", kind: "inheritance" },
      { from: "Account", to: "Auditable", kind: "realization" },
      { from: "Owner", to: "Account", label: "holds", body: { from: "1", to: "0..*" } },
    ],
  },
});
