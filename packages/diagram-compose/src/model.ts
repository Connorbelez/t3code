import type {
  DiagramComposeRequest,
  DiagramCompositionsPage,
  DiagramCompositionSummary,
  DiagramKit,
  DiagramKitReference,
  DiagramPageScope,
} from "@t3tools/contracts";
import type { TLRecord } from "@tldraw/tlschema";

import { indexRecords, pageBox } from "./canvas.ts";
import { referenceOf } from "./kit.ts";
import { KITS } from "./kits/index.ts";
import { type DetailPage, detail, memberOrder, scanCompositions, summarize } from "./membership.ts";
import { type ComposeExtras, parseRequest, parseSpec } from "./spec.ts";

/**
 * Light entry: validation, membership and kit vocabulary. Safe for the server; never loads ELK.
 */

/**
 * Returns the composition key, or throws `DiagramOperationError` with code `invalid-spec` and
 * path-addressed `details.issues`. Mermaid text is only parsed in the editor host, and patch
 * references to nodes only the canvas knows are checked there too.
 */
export function validateComposeRequest(request: DiagramComposeRequest & ComposeExtras): string {
  const operation = parseRequest(request);
  switch (operation.kind) {
    case "remove":
    case "detach":
      return operation.key;
    case "patch":
      return parseSpec(operation.spec, "any").key;
    case "replace":
      return "mermaid" in operation.source
        ? operation.source.mermaid.key
        : parseSpec(operation.source.spec).key;
  }
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
  /** Each member's last-emitted spec and whether someone edited it, paged by member. */
  readonly detail: (page: DetailPage) => DiagramCompositionsPage;
  /** The composition's frame as a selection scope, at its current page and bounds. */
  readonly frameScope: (key: string) => DiagramPageScope | undefined;
  /** Member key to main shape ID for every member on the canvas, in member order. */
  readonly memberShapes: (key: string) => Record<string, string> | undefined;
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
    detail: (page) => detail(summaries, scan, page),
    frameScope: (key) => {
      const composition = scan.compositions.get(key);
      if (!composition) return undefined;
      return {
        kind: "selection",
        pageId: composition.pageId,
        shapeIds: [composition.frame.id],
        bounds: pageBox(index, composition.frame),
      };
    },
    memberShapes: (key) => {
      const composition = scan.compositions.get(key);
      if (!composition) return undefined;
      return Object.fromEntries(
        memberOrder(composition).flatMap((member) => {
          const main = member.parts.get("main");
          return main ? [[member.key, main.id]] : [];
        }),
      );
    },
  };
}

export function kitReference(kit: DiagramKit): DiagramKitReference {
  return referenceOf(KITS[kit]);
}
