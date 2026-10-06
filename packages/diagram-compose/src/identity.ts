import { DiagramKit, DiagramLayoutDirection, DiagramSpecRef } from "@t3tools/contracts";
import {
  createBindingId,
  createShapeId,
  type TLBindingId,
  type TLRecord,
  type TLShape,
  type TLShapeId,
} from "@tldraw/tlschema";
import * as Schema from "effect/Schema";

/**
 * Who a record belongs to, and what it looked like when compose last wrote it. Every encoding of
 * composition identity into record IDs and `meta` lives here, shared by server and host.
 */

export const META_KEY = "t3Composition";

const StoredNode = Schema.Struct({
  role: Schema.Literal("node"),
  key: Schema.String,
  kind: Schema.String,
  label: Schema.String,
  parent: Schema.NullOr(Schema.String),
  ref: Schema.NullOr(DiagramSpecRef),
  body: Schema.NullOr(Schema.JsonObject),
});
const StoredEdge = Schema.Struct({
  role: Schema.Literal("edge"),
  key: Schema.String,
  from: Schema.String,
  to: Schema.String,
  kind: Schema.String,
  label: Schema.String,
  /** Only edge kinds with a body schema store one, so other edges hash as they always have. */
  body: Schema.optional(Schema.JsonObject),
});
/** A member exactly as normalized from the spec. Its hash decides whether the spec changed it. */
const StoredMember = Schema.Union([StoredNode, StoredEdge]);
export type StoredNode = typeof StoredNode.Type;
export type StoredEdge = typeof StoredEdge.Type;
export type StoredMember = typeof StoredMember.Type;

/**
 * Contents of a node, such as a wireframe element, keyed `node.element`. Spec keys cannot contain
 * dots, so only lowering makes these.
 */
export function isContent(
  member: StoredMember,
): member is StoredNode & { readonly parent: string } {
  return (
    member.role === "node" && member.parent !== null && member.key.startsWith(`${member.parent}.`)
  );
}

/**
 * Record roles within a member. `main` carries the stored spec and decides whether the member
 * exists. A compartments node adds its `group` and one `c1`, `c2`, … geo per compartment.
 */
const PartName = Schema.Union([
  Schema.Literals(["main", "start", "end", "group"]),
  Schema.TemplateLiteral(["c", Schema.Int]),
]);
export type PartName = typeof PartName.Type;
export const MEMBER_PARTS = {
  node: ["main"],
  edge: ["main", "start", "end"],
} as const satisfies Record<StoredMember["role"], readonly PartName[]>;

const PartMeta = Schema.Struct({
  v: Schema.Literal(1),
  c: Schema.String,
  e: Schema.Int,
  m: Schema.String,
  p: PartName,
  f: Schema.String,
  spec: Schema.optional(StoredMember),
});
export type PartMeta = typeof PartMeta.Type;

/** Lives on the composition frame. The ledger keeps human-deleted members deleted and holds member order. */
const FrameMeta = Schema.Struct({
  v: Schema.Literal(1),
  c: Schema.String,
  e: Schema.Int,
  kit: DiagramKit,
  title: Schema.String,
  direction: DiagramLayoutDirection,
  ledger: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  /** Arrangement hash per node with laid-out contents, such as a screen; absent when none. */
  arrangements: Schema.optional(Schema.Array(Schema.Tuple([Schema.String, Schema.String]))),
});
export type FrameMeta = typeof FrameMeta.Type;

const isPartMeta = Schema.is(PartMeta);
const isFrameMeta = Schema.is(FrameMeta);

export function memberShapeId(c: string, e: number, m: string, p: PartName): TLShapeId {
  return createShapeId(hash(stableStringify([c, e, m, p])));
}

export function memberBindingId(c: string, e: number, m: string, p: PartName): TLBindingId {
  return createBindingId(hash(stableStringify([c, e, m, p])));
}

export function frameShapeId(c: string, e: number): TLShapeId {
  return createShapeId(hash(stableStringify([c, e])));
}

/** The membership rule: meta decodes and the record's ID is the one that meta derives. Pasted copies fail it. */
export function readPartMeta(record: TLRecord): PartMeta | null {
  if (record.typeName !== "shape" && record.typeName !== "binding") return null;
  const meta = record.meta[META_KEY];
  if (!isPartMeta(meta)) return null;
  const derive = record.typeName === "shape" ? memberShapeId : memberBindingId;
  return record.id === derive(meta.c, meta.e, meta.m, meta.p) ? meta : null;
}

export function readFrameMeta(record: TLRecord): FrameMeta | null {
  if (record.typeName !== "shape" || record.type !== "frame") return null;
  const meta = record.meta[META_KEY];
  if (!isFrameMeta(meta)) return null;
  return record.id === frameShapeId(meta.c, meta.e) ? meta : null;
}

type JsonObject = TLShape["meta"];
type JsonValue = Exclude<JsonObject[string], undefined>;
type ReadonlyJson =
  | string
  | number
  | boolean
  | null
  | readonly ReadonlyJson[]
  | { readonly [key: string]: ReadonlyJson | undefined };

/** Meta as tldraw's mutable JSON type; decoded meta and stored specs are deeply readonly. */
export function encodeMeta(meta: PartMeta | FrameMeta): JsonObject {
  const copy = (value: ReadonlyJson): JsonValue => {
    if (value === null || typeof value !== "object") return value;
    if (isReadonlyArray(value)) return value.map(copy);
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) =>
        item === undefined ? [] : [[key, copy(item)]],
      ),
    );
  };
  return Object.fromEntries(Object.entries(meta).map(([key, item]) => [key, copy(item)]));
}

function isReadonlyArray(value: object): value is readonly ReadonlyJson[] {
  return Array.isArray(value);
}

export function specHash(member: StoredMember): string {
  return hashOf(member);
}

export function hashOf(value: unknown): string {
  return hash(stableStringify(value));
}

const GEOMETRY_PROPS = new Set([
  "w",
  "h",
  "growY",
  "start",
  "end",
  "bend",
  "elbowMidPoint",
  "points",
]);

/** Hash of what a human would call content: text and style change it, moves and resizes do not. */
export function fingerprint(record: TLRecord): string {
  if (record.typeName === "binding") {
    const terminal = "terminal" in record.props ? record.props.terminal : null;
    return hash(stableStringify([record.type, record.fromId, record.toId, terminal]));
  }
  if (record.typeName !== "shape") return hash(stableStringify(record));
  const content = Object.entries(record.props).filter(([key]) => !GEOMETRY_PROPS.has(key));
  return hash(stableStringify([record.type, Object.fromEntries(content)]));
}

/** JSON with sorted object keys, so equal values always hash equally. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const encoder = new TextEncoder();

/** 64-bit FNV-1a over UTF-8, as hex. Sync and identical everywhere; 16-bit limbs keep it in int math. */
function hash(text: string): string {
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;
  for (const byte of encoder.encode(text)) {
    h0 ^= byte;
    // Multiply by the FNV prime 2^40 + 0x1b3.
    const t0 = h0 * 0x1b3;
    let t1 = h1 * 0x1b3;
    let t2 = h2 * 0x1b3 + (h0 << 8);
    const t3 = h3 * 0x1b3 + (h1 << 8);
    t1 += t0 >>> 16;
    h0 = t0 & 0xffff;
    t2 += t1 >>> 16;
    h1 = t1 & 0xffff;
    h3 = (t3 + (t2 >>> 16)) & 0xffff;
    h2 = t2 & 0xffff;
  }
  return [h3, h2, h1, h0].map((limb) => limb.toString(16).padStart(4, "0")).join("");
}
