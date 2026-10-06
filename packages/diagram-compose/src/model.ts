import type {
  DiagramComposeRequest,
  DiagramCompositionSummary,
  DiagramKit,
  DiagramKitReference,
} from "@t3tools/contracts";
import type { TLRecord } from "@tldraw/tlschema";

import { indexRecords } from "./canvas.ts";
import { referenceOf } from "./kit.ts";
import { KITS } from "./kits/index.ts";
import { scanCompositions, summarize } from "./membership.ts";
import { parseSpec } from "./spec.ts";

/**
 * Light entry: validation, membership and kit vocabulary. Safe for the server; never loads ELK.
 */

/** Throws `DiagramOperationError` with code `invalid-spec` and path-addressed `details.issues`. */
export function validateComposeRequest(request: DiagramComposeRequest): void {
  parseSpec(request.spec);
}

export interface CompositionsView {
  /** True only for genuine members: the record ID equals the ID derived from its own meta. */
  readonly isMember: (recordId: string) => boolean;
  /** One summary per composition, in page then key order. */
  readonly summaries: readonly DiagramCompositionSummary[];
  /** The composition whose frame is this record, if any. */
  readonly compositionOfFrame: (recordId: string) => DiagramCompositionSummary | undefined;
  /** The composition a genuine member record (or frame) belongs to, wherever it sits on the canvas. */
  readonly compositionOf: (recordId: string) => DiagramCompositionSummary | undefined;
}

/** One pass over a document's records. */
export function readCompositions(records: Iterable<TLRecord>): CompositionsView {
  const index = indexRecords(records);
  const scan = scanCompositions(index);
  const summaries = summarize(index, scan);
  const byKey = new Map(summaries.map((summary) => [summary.key, summary]));
  const byFrame = new Map(summaries.map((summary) => [summary.frameId, summary]));
  return {
    isMember: (recordId) => scan.owners.has(recordId),
    summaries,
    compositionOfFrame: (recordId) => byFrame.get(recordId),
    compositionOf: (recordId) => {
      const key = scan.owners.get(recordId);
      return key === undefined ? undefined : byKey.get(key);
    },
  };
}

export function kitReference(kit: DiagramKit): DiagramKitReference {
  return referenceOf(KITS[kit]);
}
