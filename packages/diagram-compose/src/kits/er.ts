import * as Schema from "effect/Schema";

import { defineKit, endsLabel } from "../kit.ts";

const Column = Schema.Struct({
  name: Schema.String,
  type: Schema.optional(Schema.String),
  pk: Schema.optional(Schema.Boolean),
  fk: Schema.optional(Schema.Boolean),
  nullable: Schema.optional(Schema.Boolean),
});
const EntityBody = Schema.Struct({ columns: Schema.optional(Schema.Array(Column)) });
const Cardinality = Schema.Literals(["one", "zeroOrOne", "many", "oneOrMany"]);
const CARDINALITY_LABELS = {
  one: "1",
  zeroOrOne: "0..1",
  many: "0..*",
  oneOrMany: "1..*",
} as const;
const RelationshipBody = Schema.Struct({
  from: Schema.optional(Cardinality),
  to: Schema.optional(Cardinality),
});

const decodeEntity = Schema.decodeUnknownSync(EntityBody);
const decodeRelationship = Schema.decodeUnknownSync(RelationshipBody);

/** `name: type?` with `?` for nullable, then key markers, e.g. `user_id: uuid {PK, FK}`. */
function columnLine(column: typeof Column.Type): string {
  const keys = [column.pk ? "PK" : undefined, column.fk ? "FK" : undefined].filter(
    (key) => key !== undefined,
  );
  const typed = column.type === undefined ? column.name : `${column.name}: ${column.type}`;
  return `${typed}${column.nullable ? "?" : ""}${keys.length > 0 ? ` {${keys.join(", ")}}` : ""}`;
}

export const er = defineKit({
  name: "er",
  guidance:
    "Entity-relationship diagrams: tables with their columns and the relationships between them. " +
    "Kinds default to entity and labels to keys. List columns in body, e.g. " +
    '{ "columns": [{ "name": "id", "type": "uuid", "pk": true }, { "name": "user_id", "type": "uuid", "fk": true }, { "name": "note", "type": "text", "nullable": true }] }. ' +
    'Give each relationship its cardinality at both ends in the edge body, e.g. { "from": "one", "to": "many" }, and a verb label such as "places". ' +
    "Add notes with kind note. Layout runs left to right unless direction says otherwise.",
  look: "precise",
  direction: "right",
  arrowKind: "elbow",
  nodeKinds: {
    entity: {
      shape: "compartments",
      description:
        "A table, with one column per line. The default kind. body: { columns: [{ name, type?, pk?, fk?, nullable? }] }.",
      color: "blue",
      body: EntityBody,
      heading: () => [],
      compartments: [(body) => (decodeEntity(body).columns ?? []).map(columnLine)],
    },
  },
  defaultKind: "entity",
  edgeKinds: {
    relationship: {
      description:
        "A relationship between two entities. The default edge kind. body { from?, to? } sets the cardinality at each end: one, zeroOrOne, many or oneOrMany.",
      color: "black",
      arrowheadStart: "none",
      arrowheadEnd: "none",
      body: RelationshipBody,
      draw: (label, body) => {
        const { from, to } = decodeRelationship(body);
        return {
          label: endsLabel(from && CARDINALITY_LABELS[from], label, to && CARDINALITY_LABELS[to]),
        };
      },
    },
  },
  defaultEdgeKind: "relationship",
  example: {
    kit: "er",
    key: "shop",
    title: "Shop",
    nodes: [
      {
        key: "users",
        body: {
          columns: [
            { name: "id", type: "uuid", pk: true },
            { name: "email", type: "text" },
          ],
        },
      },
      {
        key: "orders",
        body: {
          columns: [
            { name: "id", type: "uuid", pk: true },
            { name: "user_id", type: "uuid", fk: true },
            { name: "note", type: "text", nullable: true },
          ],
        },
      },
    ],
    edges: [{ from: "users", to: "orders", label: "places", body: { from: "one", to: "many" } }],
  },
});
