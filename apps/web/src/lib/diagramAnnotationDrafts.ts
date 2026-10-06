import {
  DIAGRAM_ANNOTATIONS_MAX_PER_PAGE,
  DiagramAnnotationId,
  DiagramAnnotationNumber,
  DiagramAnnotations,
  type ComposerContextId,
  type DiagramAnnotation,
  type DiagramAnnotationTarget,
  type DiagramAnnotationsContextRecord,
  type DiagramId,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import {
  copyDiagramAnnotation,
  mergeDiagramAnnotationDrafts,
} from "@t3tools/client-runtime/diagram-annotations";
import { sanitizeComposerContextLabel } from "@t3tools/shared/composerContextReferences";
import * as Schema from "effect/Schema";

import { toKindScopedComposerContextId } from "./composerContextReferences";

/**
 * Canvas comments in a message draft: one record per diagram page, numbered across the whole
 * message. Ids govern edits and deletion; numbers label badges and never move once shown.
 */

export interface DiagramAnnotationPage {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly diagramId: DiagramId;
  readonly pageId: string;
  /** Chip label for the page's comment set, such as the diagram and page name. */
  readonly label: string;
}

export interface DiagramAnnotationEdit {
  /** A comment on this page to edit or retarget; it keeps its id and number. */
  readonly id?: DiagramAnnotationId;
  readonly comment: string;
  readonly target: DiagramAnnotationTarget;
}

export type DiagramAnnotationSaveResult =
  | {
      ok: true;
      annotation: DiagramAnnotation;
      contextId: ComposerContextId;
      createdRecord: boolean;
    }
  | { ok: false; reason: "empty" | "too-large" | "too-many" | "numbers-exhausted" };

export interface DiagramAnnotationDraftState {
  readonly records: ReadonlyArray<DiagramAnnotationsContextRecord>;
  /** Greater than every number in `records`. It only grows, so a deleted number stays unused. */
  readonly nextNumber: number;
}

const isAnnotationNumber = Schema.is(DiagramAnnotationNumber);
const isPageAnnotations = Schema.is(DiagramAnnotations);

type PageIdentity = Pick<DiagramAnnotationPage, "environmentId" | "diagramId" | "pageId">;

/** One set per page, so saving on a page always finds the chip already in the prompt. */
export function diagramAnnotationsContextId(page: PageIdentity): ComposerContextId {
  return toKindScopedComposerContextId(
    "diagram-annotations",
    `${page.environmentId}:${page.diagramId}:${page.pageId}`,
  );
}

/** A fresh comment id. getRandomValues, unlike crypto.randomUUID, also works on plain-http origins. */
export function mintDiagramAnnotationId(): DiagramAnnotationId {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return DiagramAnnotationId.make(
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}

function isSamePage(left: PageIdentity, right: PageIdentity): boolean {
  return (
    left.environmentId === right.environmentId &&
    left.diagramId === right.diagramId &&
    left.pageId === right.pageId
  );
}

function withAnnotations(
  record: DiagramAnnotationsContextRecord,
  annotations: ReadonlyArray<DiagramAnnotation>,
): DiagramAnnotationsContextRecord {
  return { ...record, payload: { ...record.payload, annotations } };
}

function newPageRecord(
  page: DiagramAnnotationPage,
  annotations: ReadonlyArray<DiagramAnnotation>,
): DiagramAnnotationsContextRecord {
  return {
    version: 1,
    kind: "diagram-annotations",
    contextId: diagramAnnotationsContextId(page),
    label: sanitizeComposerContextLabel(page.label, "diagram-annotations"),
    payload: {
      environmentId: page.environmentId,
      projectId: page.projectId,
      diagramId: page.diagramId,
      pageId: page.pageId,
      annotations,
    },
  };
}

/**
 * Saves a new comment under the next number, or edits one already on this page in place. An
 * `id` this page does not hold saves a new comment. Nothing changes unless the page's set still
 * satisfies the contract.
 */
export function saveDiagramAnnotation(
  state: DiagramAnnotationDraftState,
  page: DiagramAnnotationPage,
  edit: DiagramAnnotationEdit,
  mintId: () => DiagramAnnotationId,
): { state: DiagramAnnotationDraftState; result: DiagramAnnotationSaveResult } {
  const fail = (
    reason: Extract<DiagramAnnotationSaveResult, { ok: false }>["reason"],
  ): { state: DiagramAnnotationDraftState; result: DiagramAnnotationSaveResult } => ({
    state,
    result: { ok: false, reason },
  });
  const comment = edit.comment.trim();
  if (comment.length === 0) return fail("empty");
  const pageIndex = state.records.findIndex((record) => isSamePage(record.payload, page));
  const existing = pageIndex === -1 ? undefined : state.records[pageIndex];
  const previous =
    edit.id === undefined
      ? undefined
      : existing?.payload.annotations.find((annotation) => annotation.id === edit.id);
  const number = previous?.number ?? state.nextNumber;
  if (!isAnnotationNumber(number)) return fail("numbers-exhausted");
  const annotation = copyDiagramAnnotation({
    id: previous?.id ?? mintId(),
    number,
    comment,
    target: edit.target,
  });
  const annotations =
    existing && previous
      ? existing.payload.annotations.map((entry) => (entry.id === previous.id ? annotation : entry))
      : [...(existing?.payload.annotations ?? []), annotation];
  if (annotations.length > DIAGRAM_ANNOTATIONS_MAX_PER_PAGE) return fail("too-many");
  // Past the count, the contract can only reject size: a long comment, the page's JSON budget,
  // or a target outside its bounds.
  if (!isPageAnnotations(annotations)) return fail("too-large");
  const record = existing
    ? withAnnotations(existing, annotations)
    : newPageRecord(page, annotations);
  return {
    state: {
      records: existing
        ? state.records.map((entry, index) => (index === pageIndex ? record : entry))
        : [...state.records, record],
      nextNumber: previous ? state.nextNumber : number + 1,
    },
    result: { ok: true, annotation, contextId: record.contextId, createdRecord: !existing },
  };
}

/** Deletes one comment and its page's set once empty. Its number is not handed out again. */
export function removeDiagramAnnotation(
  state: DiagramAnnotationDraftState,
  annotationId: DiagramAnnotationId,
): { state: DiagramAnnotationDraftState; removedRecordId: ComposerContextId | null } {
  const index = state.records.findIndex((record) =>
    record.payload.annotations.some((annotation) => annotation.id === annotationId),
  );
  const record = state.records[index];
  if (!record) return { state, removedRecordId: null };
  const annotations = record.payload.annotations.filter(
    (annotation) => annotation.id !== annotationId,
  );
  if (annotations.length === 0) {
    return {
      state: { ...state, records: state.records.filter((_, position) => position !== index) },
      removedRecordId: record.contextId,
    };
  }
  return {
    state: {
      ...state,
      records: state.records.map((entry, position) =>
        position === index ? withAnnotations(record, annotations) : entry,
      ),
    },
    removedRecordId: null,
  };
}

/**
 * Brings sets from a paste, stash or queued message into the draft as fresh work: captures are
 * dropped, and a comment whose id the draft already holds is skipped, so importing twice adds
 * nothing. In number order, a comment keeps its number when it is at least the draft's next
 * number and otherwise takes the next one, so no displayed number changes afterwards. Comments a
 * page cannot fit, or that run past the last number, count as `dropped`.
 *
 * `rewritten` maps each incoming set to the draft set its links should now name.
 */
export function importDiagramAnnotations(
  state: DiagramAnnotationDraftState,
  incoming: ReadonlyArray<DiagramAnnotationsContextRecord>,
) {
  const imported = mergeDiagramAnnotationDrafts(
    state,
    incoming.map((record) => ({
      ...record,
      contextId: diagramAnnotationsContextId(record.payload),
    })),
  );
  const rewritten = new Map<ComposerContextId, ComposerContextId>();
  for (const record of incoming) {
    const target = imported.rewritten.get(diagramAnnotationsContextId(record.payload));
    if (target) rewritten.set(record.contextId, target);
  }
  return { ...imported, rewritten };
}
