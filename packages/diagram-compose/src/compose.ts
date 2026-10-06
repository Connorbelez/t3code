import {
  DIAGRAM_MAX_BATCH_RECORDS,
  DiagramOperationError,
  type DiagramComposeCounts,
  type DiagramComposeRequest,
  type DiagramHostComposeResult,
  type DiagramMermaidSource,
  type DiagramSpec,
} from "@t3tools/contracts";
import type { TLRecord, TLShape } from "@tldraw/tlschema";

import { compareIndex, indexRecords, pageBox, type RecordIndex, shapeOf } from "./canvas.ts";
import { emit, emitRelease } from "./emit.ts";
import {
  frameShapeId,
  isContent,
  memberBindingId,
  memberShapeId,
  type StoredEdge,
  type StoredMember,
  type StoredNode,
} from "./identity.ts";
import { indexBetween } from "./indexKeys.ts";
import { type Kit, partsOf } from "./kit.ts";
import { type MeasureText, place } from "./layout.ts";
import {
  type Decision,
  decideRows,
  draftsOf,
  nextLedger,
  patchRows,
  releaseRows,
  replaceRows,
} from "./merge.ts";
import { type CurrentComposition, scanCompositions } from "./membership.ts";
import { type ComposeOperation, type ComposeSpec, parseRequest, parseSpec } from "./spec.ts";

/**
 * Pipeline entry for the editor host. Import lazily; layout loads ELK on first use.
 */

export type { TextFont } from "./layout.ts";

export interface ComposePorts {
  /** Real editor text measurement, unpadded. */
  readonly measureText: MeasureText;
  /** Mermaid's parser needs a DOM, so the editor host converts Mermaid text to a spec. */
  readonly parseMermaid: (source: DiagramMermaidSource) => Promise<DiagramSpec>;
  /**
   * Applies puts and deletes to a scratch editor seeded with the current document and returns
   * every document record afterwards, so tldraw's own rewrites of non-member records are known.
   */
  readonly rehearse: (
    puts: readonly TLRecord[],
    deletes: readonly string[],
  ) => ReadonlyMap<string, TLRecord>;
}

/**
 * Turns a compose request plus the current document into one batch's worth of changes.
 * Throws `DiagramOperationError` (`invalid-spec`, `unsupported-mermaid`, `conflict`, `too-large`,
 * `invalid-records`).
 */
export async function compose(
  request: DiagramComposeRequest,
  records: readonly TLRecord[],
  ports: ComposePorts,
): Promise<DiagramHostComposeResult> {
  const operation = parseRequest(request);
  const index = indexRecords(records);
  const compositions = scanCompositions(index).compositions;
  if (operation.kind === "remove" || operation.kind === "detach") {
    const current = compositions.get(operation.key);
    // Already removed or detached, so repeating either is a no-op.
    if (!current) return { changes: null, counts: countsOf([]), overlaps: [] };
    const decisions = decideRows(
      releaseRows(operation.kind === "remove" ? "purge" : "detach", current),
    );
    const { puts, deletes } = emitRelease(operation.kind, current, decisions);
    return {
      changes: finalize(puts, deletes, index, ports.rehearse),
      counts: countsOf(decisions),
      overlaps: [],
    };
  }

  const { spec, current, decisions } =
    operation.kind === "replace"
      ? planReplace(
          "spec" in operation.source
            ? operation.source.spec
            : await ports.parseMermaid(operation.source.mermaid),
          compositions,
        )
      : planPatch(operation, compositions);
  const drawn = resulting(spec, decisions);
  if (operation.kind === "patch") checkSize(spec.kit, presentMembers(decisions));
  const counts = countsOf(decisions);
  const ledger = nextLedger(decisions);
  const stored = new Map(current?.meta.arrangements ?? []);
  // A patch leaves unlisted screens' arrangements as they were.
  const arrangements = ledger.flatMap(([key]): [string, string][] => {
    const arrangement = spec.contents.get(key)?.arrangement ?? stored.get(key);
    return arrangement === undefined ? [] : [[key, arrangement]];
  });
  const epoch = current?.epoch ?? freeEpoch(spec.kit, spec.key, presentMembers(decisions), index);
  if (
    current &&
    !operation.relayout &&
    decisions.every((decision) => decision.do === "keep") &&
    current.meta.kit === spec.kit.name &&
    current.meta.title === spec.title &&
    current.meta.direction === spec.direction &&
    isEqualJson(current.meta.ledger, ledger) &&
    isEqualJson(current.meta.arrangements ?? [], arrangements)
  ) {
    return { changes: null, counts, overlaps: overlapsOf(drawn, epoch, index) };
  }

  const arranged = arrangedScreens(spec, decisions, current, operation.relayout);
  const placement = await place(
    drawn,
    decisions,
    current,
    index,
    ports.measureText,
    operation.relayout,
    arranged,
  );
  const { puts, deletes } = emit({
    spec: drawn,
    epoch,
    current,
    decisions,
    ledger,
    arrangements,
    arranged,
    placement,
    index,
  });
  const after = new Map(index);
  for (const record of puts) after.set(record.id, record);
  for (const id of deletes) after.delete(id);
  return {
    changes: finalize(puts, deletes, index, ports.rehearse),
    counts,
    overlaps: overlapsOf(drawn, epoch, after),
  };
}

interface Plan {
  readonly spec: ComposeSpec;
  readonly current: CurrentComposition | null;
  readonly decisions: readonly Decision[];
}

function planReplace(
  request: DiagramSpec,
  compositions: ReadonlyMap<string, CurrentComposition>,
): Plan {
  const spec = parseSpec(request);
  checkSize(spec.kit, [
    ...spec.nodes,
    ...Array.from(spec.contents.values()).flatMap(({ members }) => members),
    ...spec.edges,
  ]);
  const current = compositions.get(spec.key) ?? null;
  return { spec, current, decisions: decideRows(replaceRows(draftsOf(spec), current)) };
}

/** Title and direction left out of a patch keep the composition's own. */
function planPatch(
  operation: Extract<ComposeOperation, { kind: "patch" }>,
  compositions: ReadonlyMap<string, CurrentComposition>,
): Plan {
  const { key, kit, title, direction, nodes } = operation.spec;
  const current = compositions.get(key);
  if (!current) {
    throw invalidSpec("spec.key", [
      `no composition "${key}" on this diagram; a patch changes an existing composition, so compose the whole spec without mode "patch" first`,
    ]);
  }
  const removed = new Set(operation.removeKeys);
  const listed = new Map(nodes.map((node) => [node.key, node]));
  // In member order. Members a human deleted map to null: their role is unknown, and a replace
  // spec could still name them.
  const remaining = new Map<string, StoredNode | null>();
  for (const memberKey of new Set([...current.ledger.keys(), ...current.members.keys()])) {
    const stored = current.members.get(memberKey)?.stored;
    if (!stored) remaining.set(memberKey, null);
    else if (stored.role === "node") remaining.set(memberKey, stored);
  }
  for (const memberKey of [...removed, ...listed.keys()]) remaining.delete(memberKey);
  // A listed node brings its whole contents and a removed one takes them along.
  for (const [memberKey, node] of remaining) {
    if (node && isContent(node) && (removed.has(node.parent) || listed.has(node.parent))) {
      remaining.delete(memberKey);
    }
  }
  const spec = parseSpec(operation.spec, remaining);
  // A removed boundary must not leave children behind, as a replace spec could not either.
  const orphaned = Array.from(remaining.values()).flatMap((node) =>
    node?.parent != null && removed.has(node.parent) && !isContent(node) ? [node] : [],
  );
  if (orphaned.length > 0) {
    throw invalidSpec(
      "removeKeys",
      orphaned.map(
        (node) => `"${node.parent}" still holds "${node.key}"; remove it too, or patch its parent`,
      ),
    );
  }
  if (kit !== current.meta.kit) {
    throw invalidSpec("spec.kit", [
      `a patch keeps the composition's kit ${current.meta.kit}; to change kits, compose the whole spec without mode "patch"`,
    ]);
  }
  const both = new Set([...spec.nodes, ...spec.edges].map((member) => member.key));
  const twice = operation.removeKeys.flatMap((memberKey, i) =>
    both.has(memberKey)
      ? [{ path: `removeKeys[${i}]`, message: `"${memberKey}" is also in the spec; list it once` }]
      : [],
  );
  if (twice.length > 0) {
    throw new DiagramOperationError({ code: "invalid-spec", details: { issues: twice } });
  }
  return {
    spec: {
      ...spec,
      title: title ?? current.meta.title,
      direction: direction ?? current.meta.direction,
    },
    current,
    decisions: decideRows(patchRows(draftsOf(spec), operation.removeKeys, current)),
  };
}

/** The members on the canvas once the decisions apply, in member order. */
function presentMembers(decisions: readonly Decision[]): StoredMember[] {
  return decisions.flatMap((decision): StoredMember[] => {
    if (decision.do === "create" || decision.do === "overwrite") return [decision.draft.spec];
    return decision.do === "keep" && decision.current ? [decision.current.stored] : [];
  });
}

/**
 * The nodes and edges on the canvas once the decisions apply. Layout, emit and overlaps see only
 * these; screen contents stay in `contents`.
 */
function resulting(spec: ComposeSpec, decisions: readonly Decision[]): ComposeSpec {
  const members = presentMembers(decisions);
  return {
    ...spec,
    nodes: members.filter(
      (member): member is StoredNode => member.role === "node" && !isContent(member),
    ),
    edges: members.filter((member): member is StoredEdge => member.role === "edge"),
  };
}

/** The frame plus every part of every member, before anything is measured or laid out. */
function checkSize(kit: Kit, members: readonly StoredMember[]): void {
  const recordCount = members.reduce((count, member) => count + partsOf(kit, member).length, 1);
  if (recordCount > DIAGRAM_MAX_BATCH_RECORDS) throw tooLarge(recordCount);
}

function invalidSpec(path: string, messages: readonly string[]): DiagramOperationError {
  return new DiagramOperationError({
    code: "invalid-spec",
    details: { issues: messages.map((message) => ({ path, message })) },
  });
}

/**
 * Screens whose contents lay out again: order is meaning, so any change inside a screen, or to how
 * it is arranged, relays out all of it. Screens nothing touched keep what humans did inside them.
 */
function arrangedScreens(
  spec: ComposeSpec,
  decisions: readonly Decision[],
  current: CurrentComposition | null,
  relayout: boolean,
): Set<string> {
  const byKey = new Map(decisions.map((decision) => [decision.key, decision]));
  const stored = new Map(current?.meta.arrangements ?? []);
  const written = (key: string) => {
    const decision = byKey.get(key);
    return decision?.do === "create" || decision?.do === "overwrite";
  };
  const arranged = new Set<string>();
  for (const [key, contents] of spec.contents) {
    const screen = byKey.get(key);
    const present = written(key) || (screen?.do === "keep" && screen.current !== null);
    // A dropped element changes the arrangement, and dropped screen parts change the screen.
    if (
      present &&
      (relayout ||
        written(key) ||
        stored.get(key) !== contents.arrangement ||
        contents.members.some((member) => written(member.key)))
    ) {
      arranged.add(key);
    }
  }
  return arranged;
}

const MAX_OVERLAPS = 50;

/**
 * Node members whose page boxes intersect, in spec order. Arrows and non-members never count, and
 * neither does a boundary holding its own descendant.
 */
function overlapsOf(spec: ComposeSpec, epoch: number, index: RecordIndex): [string, string][] {
  const parents = new Map(spec.nodes.map((node) => [node.key, node.parent]));
  const encloses = (outer: string, inner: string) => {
    for (let at = parents.get(inner); at; at = parents.get(at)) if (at === outer) return true;
    return false;
  };
  const boxes = spec.nodes.flatMap((node) => {
    const shape = shapeOf(index, memberShapeId(spec.key, epoch, node.key, "main"));
    return shape ? [{ key: node.key, box: pageBox(index, shape) }] : [];
  });
  const pairs: [string, string][] = [];
  for (const [i, a] of boxes.entries()) {
    for (const b of boxes.slice(i + 1)) {
      if (pairs.length === MAX_OVERLAPS) return pairs;
      if (encloses(a.key, b.key) || encloses(b.key, a.key)) continue;
      if (
        a.box.x < b.box.x + b.box.w &&
        b.box.x < a.box.x + a.box.w &&
        a.box.y < b.box.y + b.box.h &&
        b.box.y < a.box.y + a.box.h
      )
        pairs.push([a.key, b.key]);
    }
  }
  return pairs;
}

function countsOf(decisions: readonly Decision[]): DiagramComposeCounts {
  const count = (kind: Decision["do"]) =>
    decisions.filter((decision) => decision.do === kind).length;
  return {
    created: count("create"),
    updated: count("overwrite"),
    kept: count("keep"),
    removed: count("remove"),
  };
}

/**
 * The first epoch none of whose IDs exist. Detached shapes keep their IDs, so composing that key
 * again starts fresh rather than writing over them, even after their frame is deleted.
 */
function freeEpoch(
  kit: Kit,
  key: string,
  members: readonly StoredMember[],
  index: RecordIndex,
): number {
  for (let epoch = 0; ; epoch++) {
    const taken =
      index.has(frameShapeId(key, epoch)) ||
      members.some((member) =>
        partsOf(kit, member).some((part) =>
          index.has(
            part === "start" || part === "end"
              ? memberBindingId(key, epoch, member.key, part)
              : memberShapeId(key, epoch, member.key, part),
          ),
        ),
      );
    if (!taken) return epoch;
  }
}

/**
 * Drops writes the canvas already has, then rehearses the rest in a real editor. tldraw's side
 * effects on records compose did not write (human arrows unbound from a removed node, shapes
 * carried out of a removed frame) join the batch; a rewrite of a record compose did write is an
 * emitter bug.
 */
function finalize(
  emittedPuts: readonly TLRecord[],
  emittedDeletes: readonly string[],
  index: RecordIndex,
  rehearse: ComposePorts["rehearse"],
): DiagramHostComposeResult["changes"] {
  const puts = emittedPuts.filter((record) => !isEqualJson(index.get(record.id), record));
  const deletes = emittedDeletes.filter((id) => index.has(id));
  if (puts.length === 0 && deletes.length === 0) return null;

  const after = rehearse([...puts, ...carryOrphans(index, puts, deletes)], deletes);
  const written = new Set(puts.map((record) => record.id));
  const removed = new Set(deletes);
  const rewritten =
    puts.some((record) => !isEqualJson(after.get(record.id), record)) ||
    deletes.some((id) => after.has(id));
  if (rewritten) throw new DiagramOperationError({ code: "invalid-records" });

  const sideEffects = Array.from(after.values())
    .filter((record) => !written.has(record.id) && !isEqualJson(index.get(record.id), record))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const sideDeletes = Array.from(index.keys())
    .filter((id) => !removed.has(id) && !after.has(id))
    .sort();
  const allPuts = [...puts, ...sideEffects];
  const allDeletes = [...deletes, ...sideDeletes];
  const total = allPuts.length + allDeletes.length;
  if (total > DIAGRAM_MAX_BATCH_RECORDS) throw tooLarge(total);
  const changed = [...allPuts.map((record) => record.id), ...allDeletes];
  const touched = new Set(changed);
  const dependencies = dependenciesOf(
    touched,
    allPuts,
    index,
    (id) => after.get(id) ?? index.get(id),
  );
  return {
    expected: [...changed, ...Array.from(dependencies).filter((id) => !touched.has(id))].map(
      (id) => ({ id, record: index.get(id) ?? null }),
    ),
    puts: allPuts,
    deletes: allDeletes,
  };
}

/**
 * What the server's batch validation requires as expected records besides the changed ones:
 * ancestors up to the page, binding endpoints and image assets of every changed record before and
 * after; and every existing binding to, and child of, a changed shape.
 */
function dependenciesOf(
  changed: ReadonlySet<string>,
  puts: readonly TLRecord[],
  index: RecordIndex,
  lookup: (id: string) => TLRecord | undefined,
): Set<string> {
  const ids = new Set<string>();
  const visit = (record: TLRecord) => {
    if (record.typeName === "binding") {
      for (const id of [record.fromId, record.toId]) {
        if (ids.has(id)) continue;
        ids.add(id);
        const endpoint = lookup(id);
        if (endpoint) visit(endpoint);
      }
    }
    if (record.typeName !== "shape") return;
    if ("assetId" in record.props && typeof record.props.assetId === "string")
      ids.add(record.props.assetId);
    for (let parentId: string = record.parentId; !ids.has(parentId);) {
      ids.add(parentId);
      const parent = lookup(parentId);
      if (parent?.typeName !== "shape") break;
      parentId = parent.parentId;
    }
  };
  for (const record of puts) visit(record);
  for (const id of changed) {
    const before = index.get(id);
    if (before) visit(before);
  }
  for (const record of index.values()) {
    if (record.typeName === "binding" && (changed.has(record.fromId) || changed.has(record.toId)))
      for (const id of [record.id, record.fromId, record.toId]) ids.add(id);
    if (record.typeName === "shape" && changed.has(record.parentId)) ids.add(record.id);
  }
  return ids;
}

/**
 * Shapes compose did not write whose parent it deletes, such as a note a human drew inside a
 * removed frame. `store.remove` does not delete descendants, so each moves to its nearest
 * surviving ancestor at the same page position, stacked where the deleted ancestor was.
 */
function carryOrphans(
  index: RecordIndex,
  puts: readonly TLRecord[],
  deletes: readonly string[],
): TLShape[] {
  const gone = new Set(deletes);
  const written = new Set(puts.map((record) => record.id));
  const orphans: { shape: TLShape; top: TLShape; path: string[] }[] = [];
  for (const record of index.values()) {
    if (record.typeName !== "shape" || gone.has(record.id) || written.has(record.id)) continue;
    if (!gone.has(record.parentId)) continue;
    let { x, y, rotation, parentId } = record;
    let top = record;
    const path: string[] = [];
    for (
      let parent = shapeOf(index, record.parentId);
      parent && gone.has(parent.id);
      parent = shapeOf(index, parent.parentId)
    ) {
      const cos = Math.cos(parent.rotation);
      const sin = Math.sin(parent.rotation);
      [x, y] = [parent.x + x * cos - y * sin, parent.y + x * sin + y * cos];
      rotation += parent.rotation;
      parentId = parent.parentId;
      path.unshift(top.index);
      top = parent;
    }
    const shape = { ...record, parentId, x, y, rotation };
    orphans.push({ shape, top, path });
  }
  const byPath = (a: { path: string[] }, b: { path: string[] }) => {
    for (const [i, key] of a.path.entries()) {
      const order = compareIndex(key, b.path[i] ?? "");
      if (order !== 0) return order;
    }
    return a.path.length - b.path.length;
  };
  orphans.sort((a, b) => compareIndex(a.top.id, b.top.id) || byPath(a, b));

  const final = new Map(index);
  for (const record of puts) final.set(record.id, record);
  const carried: TLShape[] = [];
  let low: string | null = null;
  let previousTop: string | null = null;
  for (const { shape, top } of orphans) {
    if (top.id !== previousTop) {
      low = top.index;
      previousTop = top.id;
    }
    // Deleted siblings bound the slot too, so two removed neighbors never hand out one key twice.
    let high: string | null = null;
    for (const sibling of final.values()) {
      if (
        sibling.typeName === "shape" &&
        sibling.parentId === top.parentId &&
        sibling.index > top.index &&
        (high === null || sibling.index < high)
      )
        high = sibling.index;
    }
    const key = indexBetween(low, high);
    low = key;
    carried.push({ ...shape, index: key });
  }
  return carried;
}

function tooLarge(records: number): DiagramOperationError {
  return new DiagramOperationError({
    code: "too-large",
    details: {
      issues: [
        {
          path: "spec",
          message: `needs ${records} records but one compose writes at most ${DIAGRAM_MAX_BATCH_RECORDS}; split it into several compositions`,
        },
      ],
    },
  });
}

function isEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aEntries = Object.entries(a).filter(([, value]) => value !== undefined);
  const bEntries = Object.entries(b).filter(([, value]) => value !== undefined);
  if (aEntries.length !== bEntries.length) return false;
  const bValues = new Map(bEntries);
  return aEntries.every(([key, value]) => bValues.has(key) && isEqualJson(value, bValues.get(key)));
}
