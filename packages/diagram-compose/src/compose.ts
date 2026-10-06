import {
  DIAGRAM_MAX_BATCH_RECORDS,
  DiagramOperationError,
  type DiagramComposeCounts,
  type DiagramComposeRequest,
  type DiagramHostComposeResult,
} from "@t3tools/contracts";
import type { TLRecord } from "@tldraw/tlschema";

import { indexRecords, pageBox, type RecordIndex, shapeOf } from "./canvas.ts";
import { emit } from "./emit.ts";
import { frameShapeId, memberShapeId } from "./identity.ts";
import { type MeasureText, place } from "./layout.ts";
import { decideReplace, type Decision, draftsOf, nextLedger } from "./merge.ts";
import { scanCompositions } from "./membership.ts";
import { type ComposeSpec, parseSpec } from "./spec.ts";

/**
 * Pipeline entry for the editor host. Import lazily; layout loads ELK on first use.
 */

export type { TextFont } from "./layout.ts";

export interface ComposePorts {
  /** Real editor text measurement, unpadded. */
  readonly measureText: MeasureText;
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
 * Throws `DiagramOperationError` (`invalid-spec`, `conflict`, `too-large`, `invalid-records`).
 */
export async function compose(
  request: DiagramComposeRequest,
  records: readonly TLRecord[],
  ports: ComposePorts,
): Promise<DiagramHostComposeResult> {
  const spec = parseSpec(request.spec);
  // The frame, one shape per node, and an arrow with two bindings per edge.
  const recordCount = 1 + spec.nodes.length + 3 * spec.edges.length;
  if (recordCount > DIAGRAM_MAX_BATCH_RECORDS) throw tooLarge(recordCount);

  const index = indexRecords(records);
  const current = scanCompositions(index).compositions.get(spec.key) ?? null;
  const decisions = decideReplace(draftsOf(spec), current);
  const counts = countsOf(decisions);
  const ledger = nextLedger(decisions);
  const epoch = current?.epoch ?? freeEpoch(spec.key, index);
  if (
    current &&
    !request.relayout &&
    decisions.every((decision) => decision.do === "keep") &&
    current.meta.kit === spec.kit.name &&
    current.meta.title === spec.title &&
    current.meta.direction === spec.direction &&
    isEqualJson(current.meta.ledger, ledger)
  ) {
    return { changes: null, counts, overlaps: overlapsOf(spec, epoch, index) };
  }

  const placement = await place(
    spec,
    decisions,
    current,
    index,
    ports.measureText,
    request.relayout ?? false,
  );
  const { puts, deletes } = emit({ spec, epoch, current, decisions, ledger, placement, index });
  const after = new Map(index);
  for (const record of puts) after.set(record.id, record);
  for (const id of deletes) after.delete(id);
  return {
    changes: finalize(puts, deletes, index, ports.rehearse),
    counts,
    overlaps: overlapsOf(spec, epoch, after),
  };
}

const MAX_OVERLAPS = 50;

/** Node members whose page boxes intersect, in spec order. Arrows and non-members never count. */
function overlapsOf(spec: ComposeSpec, epoch: number, index: RecordIndex): [string, string][] {
  const boxes = spec.nodes.flatMap((node) => {
    const shape = shapeOf(index, memberShapeId(spec.key, epoch, node.key, "main"));
    return shape ? [{ key: node.key, box: pageBox(index, shape) }] : [];
  });
  const pairs: [string, string][] = [];
  for (const [i, a] of boxes.entries()) {
    for (const b of boxes.slice(i + 1)) {
      if (pairs.length === MAX_OVERLAPS) return pairs;
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

/** A detached frame keeps its ID, so composing that key again moves to the next free epoch. */
function freeEpoch(key: string, index: RecordIndex): number {
  let epoch = 0;
  while (index.has(frameShapeId(key, epoch))) epoch++;
  return epoch;
}

/**
 * Drops writes the canvas already has, then rehearses the rest in a real editor. tldraw's side
 * effects on records compose did not write (human arrows unbound from a removed node) join the
 * batch; a rewrite of a record compose did write is an emitter bug.
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

  const after = rehearse(puts, deletes);
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
  return {
    expected: [...allPuts.map((record) => record.id), ...allDeletes].map((id) => ({
      id,
      record: index.get(id) ?? null,
    })),
    puts: allPuts,
    deletes: allDeletes,
  };
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
