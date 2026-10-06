import { DiagramOperationError } from "@t3tools/contracts";

import { compareIndex } from "./canvas.ts";
import { isContent, specHash, type StoredMember } from "./identity.ts";
import type { CurrentComposition, CurrentMember } from "./membership.ts";
import type { ComposeSpec } from "./spec.ts";

/** The ownership policy. It reads spec hashes and edited flags only; geometry never decides. */

interface MemberDraft {
  readonly key: string;
  readonly hash: string;
  readonly spec: StoredMember;
  /** The node whose contents this member is, such as a wireframe element's screen. */
  readonly within: string | null;
}

type Intent =
  | { readonly want: "upsert"; readonly draft: MemberDraft }
  /** Replace: in the canvas but not the spec. */
  | { readonly want: "drop" }
  /** Patch: not mentioned. */
  | { readonly want: "untouched" }
  /** Removing the whole composition. */
  | { readonly want: "purge" }
  | { readonly want: "detach" };

export interface Row {
  readonly key: string;
  readonly intent: Intent;
  /** Spec hash in the ledger; null when compose never wrote this member. */
  readonly last: string | null;
  readonly current: CurrentMember | null;
}

export type Decision =
  | { readonly do: "create"; readonly key: string; readonly draft: MemberDraft }
  | {
      readonly do: "overwrite";
      readonly key: string;
      readonly draft: MemberDraft;
      readonly current: CurrentMember;
    }
  /** `hash` is what the ledger keeps; null keeps the member out of it. */
  | {
      readonly do: "keep";
      readonly key: string;
      readonly hash: string | null;
      readonly current: CurrentMember | null;
    }
  | { readonly do: "remove"; readonly key: string; readonly current: CurrentMember }
  | { readonly do: "forget"; readonly key: string }
  | { readonly do: "detach"; readonly key: string; readonly current: CurrentMember }
  | { readonly do: "conflict"; readonly key: string };

function draftOf(member: StoredMember, within: string | null = null): MemberDraft {
  return { key: member.key, hash: specHash(member), spec: member, within };
}

/** Spec order, each node followed by its contents, then edges. */
export function draftsOf(spec: ComposeSpec): MemberDraft[] {
  return [
    ...spec.nodes.flatMap((node) => [
      draftOf(node),
      ...(spec.contents.get(node.key)?.members ?? []).map((member) => draftOf(member, node.key)),
    ]),
    ...spec.edges.map((edge) => draftOf(edge)),
  ];
}

function rowOf(key: string, intent: Intent, current: CurrentComposition | null): Row {
  return {
    key,
    intent,
    last: current?.ledger.get(key) ?? null,
    current: current?.members.get(key) ?? null,
  };
}

/** Ledger order, then members the ledger lost track of by key. */
function memberKeys(current: CurrentComposition): string[] {
  const unlisted = Array.from(current.members.keys())
    .filter((key) => !current.ledger.has(key))
    .sort(compareIndex);
  return [...current.ledger.keys(), ...unlisted];
}

/** Replace mode: spec members in spec order, then everything compose owns that the spec dropped. */
export function replaceRows(
  drafts: readonly MemberDraft[],
  current: CurrentComposition | null,
): Row[] {
  const rows = drafts.map((draft) => rowOf(draft.key, { want: "upsert", draft }, current));
  if (!current) return rows;
  const wanted = new Set(drafts.map((draft) => draft.key));
  for (const key of memberKeys(current)) {
    if (!wanted.has(key)) rows.push(rowOf(key, { want: "drop" }, current));
  }
  return rows;
}

/**
 * Patch mode: the composition's members in member order with listed members swapped in, removed
 * keys and the member edges of removed nodes dropped, and everything else untouched. New nodes go
 * before the first edge and new edges last, which is where replacing with the whole patched spec
 * (nodes, then edges) puts them, so both modes write the same ledger. A listed node brings its
 * whole contents, in spec order right after it: contents it no longer lists drop, as do the
 * contents of a removed node.
 */
export function patchRows(
  drafts: readonly MemberDraft[],
  removeKeys: readonly string[],
  current: CurrentComposition,
): Row[] {
  const byKey = new Map(drafts.map((draft) => [draft.key, draft]));
  const removed = new Set(removeKeys);
  const endpointRemoved = (member: CurrentMember | undefined) =>
    member?.stored.role === "edge" &&
    !byKey.has(member.key) &&
    (removed.has(member.stored.from) || removed.has(member.stored.to));
  const holderReplaced = (member: CurrentMember | undefined) =>
    member !== undefined &&
    isContent(member.stored) &&
    (removed.has(member.stored.parent) || byKey.has(member.stored.parent));
  const rows = memberKeys(current).map((key): Row => {
    const draft = byKey.get(key);
    if (draft) return rowOf(key, { want: "upsert", draft }, current);
    const member = current.members.get(key);
    if (removed.has(key) || endpointRemoved(member) || holderReplaced(member))
      return rowOf(key, { want: "drop" }, current);
    return rowOf(key, { want: "untouched" }, current);
  });
  const isEdge = (row: Row) =>
    row.intent.want === "upsert"
      ? row.intent.draft.spec.role === "edge"
      : row.current?.stored.role === "edge";
  const firstEdge = rows.findIndex(isEdge);
  const known = new Set(rows.map((row) => row.key));
  const added = drafts
    .filter((draft) => !known.has(draft.key))
    .map((draft) => rowOf(draft.key, { want: "upsert", draft }, current));
  const nodes = added.filter((row) => !isEdge(row));
  const edges = added.filter(isEdge);
  const at = firstEdge === -1 ? rows.length : firstEdge;
  const ordered = [...rows.slice(0, at), ...nodes, ...rows.slice(at), ...edges];
  const rank = new Map(drafts.map((draft, i) => [draft.key, i]));
  const contentsOf = (key: string) =>
    ordered
      .filter((row) => row.intent.want === "upsert" && row.intent.draft.within === key)
      .sort((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0));
  return ordered.flatMap((row) => {
    if (row.intent.want !== "upsert") return [row];
    if (row.intent.draft.within !== null) return [];
    return [row, ...contentsOf(row.key)];
  });
}

/** Removing or detaching the whole composition: every member it knows of. */
export function releaseRows(want: "purge" | "detach", current: CurrentComposition): Row[] {
  return memberKeys(current).map((key) => rowOf(key, { want }, current));
}

function decide(row: Row): Decision {
  const { key, intent, last, current } = row;
  switch (intent.want) {
    case "upsert": {
      const { draft } = intent;
      if (last === draft.hash) return { do: "keep", key, hash: last, current };
      if (!current) return { do: "create", key, draft };
      return current.edited ? { do: "conflict", key } : { do: "overwrite", key, draft, current };
    }
    case "drop":
      if (!current) return { do: "forget", key };
      return current.edited ? { do: "conflict", key } : { do: "remove", key, current };
    case "untouched":
      return { do: "keep", key, hash: last, current };
    case "purge":
      return current ? { do: "remove", key, current } : { do: "forget", key };
    case "detach":
      return current ? { do: "detach", key, current } : { do: "forget", key };
    default: {
      const _exhaustive: never = intent;
      return _exhaustive;
    }
  }
}

/** Throws one `conflict` naming every member that both the spec and someone else changed. */
export function decideRows(rows: readonly Row[]): Decision[] {
  const decisions = rows.map(decide);
  const conflicts = decisions.flatMap((decision) =>
    decision.do === "conflict" ? [decision.key] : [],
  );
  if (conflicts.length > 0) {
    throw new DiagramOperationError({
      code: "conflict",
      details: { members: conflicts.slice(0, 50) },
    });
  }
  const nodes = presentNodes(decisions);
  const created = new Set(
    decisions.flatMap((decision) => (decision.do === "create" ? [decision.key] : [])),
  );
  return decisions.map((decision, i) => {
    const row = rows[i];
    const within = row?.intent.want === "upsert" ? row.intent.draft.within : null;
    if (within !== null && row?.intent.want === "upsert") {
      // Contents need their node. Without it the canvas keeps what it has, like an edge without
      // an endpoint; a node drawn again brings back the contents deleted along with it.
      if (!nodes.has(within) && (decision.do === "create" || decision.do === "overwrite")) {
        return {
          do: "keep",
          key: decision.key,
          hash: row.last,
          current: decision.do === "overwrite" ? decision.current : null,
        };
      }
      if (created.has(within) && decision.do === "keep" && decision.current === null) {
        return { do: "create", key: decision.key, draft: row.intent.draft };
      }
      return decision;
    }
    if (
      decision.do === "keep" &&
      decision.current?.stored.role === "edge" &&
      !decision.current.edited &&
      !decision.current.complete &&
      (row?.intent.want === "upsert" || row?.intent.want === "untouched") &&
      nodes.has(decision.current.stored.from) &&
      nodes.has(decision.current.stored.to)
    ) {
      // An unedited edge lost its bindings (or bar) with a deleted endpoint this compose recreates.
      return {
        do: "overwrite",
        key: decision.key,
        draft: row.intent.want === "upsert" ? row.intent.draft : draftOf(decision.current.stored),
        current: decision.current,
      };
    }
    if (decision.do !== "create" && decision.do !== "overwrite") return decision;
    const spec = decision.draft.spec;
    if (spec.role !== "edge" || (nodes.has(spec.from) && nodes.has(spec.to))) return decision;
    // An edge to a node that will not exist cannot be bound, so the canvas keeps what it has. The
    // ledger keeps the old hash, so the edge is drawn once both ends exist and its spec changes.
    return {
      do: "keep",
      key: decision.key,
      hash: row?.last ?? null,
      current: decision.do === "overwrite" ? decision.current : null,
    };
  });
}

/** Node keys that have a shape once this compose is applied. */
function presentNodes(decisions: readonly Decision[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const decision of decisions) {
    const present =
      decision.do === "create" || decision.do === "overwrite"
        ? decision.draft.spec.role === "node"
        : decision.do === "keep" && decision.current?.stored.role === "node";
    if (present) keys.add(decision.key);
  }
  return keys;
}

/** Ledger after this compose, in member order. */
export function nextLedger(decisions: readonly Decision[]): [string, string][] {
  return decisions.flatMap((decision): [string, string][] => {
    switch (decision.do) {
      case "create":
      case "overwrite":
        return [[decision.key, decision.draft.hash]];
      case "keep":
        return decision.hash === null ? [] : [[decision.key, decision.hash]];
      default:
        return [];
    }
  });
}
