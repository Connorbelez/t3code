import { DiagramOperationError } from "@t3tools/contracts";

import { compareIndex } from "./canvas.ts";
import { specHash, type StoredMember } from "./identity.ts";
import type { CurrentComposition, CurrentMember } from "./membership.ts";
import type { ComposeSpec } from "./spec.ts";

/** The ownership policy. It reads spec hashes and edited flags only; geometry never decides. */

interface MemberDraft {
  readonly key: string;
  readonly hash: string;
  readonly spec: StoredMember;
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

interface Row {
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

export function draftsOf(spec: ComposeSpec): MemberDraft[] {
  return [...spec.nodes, ...spec.edges].map((member) => ({
    key: member.key,
    hash: specHash(member),
    spec: member,
  }));
}

/** Replace mode: spec members in spec order, then everything compose owns that the spec dropped. */
function replaceRows(drafts: readonly MemberDraft[], current: CurrentComposition | null): Row[] {
  const rows: Row[] = drafts.map((draft) => ({
    key: draft.key,
    intent: { want: "upsert", draft },
    last: current?.ledger.get(draft.key) ?? null,
    current: current?.members.get(draft.key) ?? null,
  }));
  if (!current) return rows;
  const wanted = new Set(drafts.map((draft) => draft.key));
  const unlisted = Array.from(current.members.keys())
    .filter((key) => !current.ledger.has(key))
    .sort(compareIndex);
  for (const key of [...current.ledger.keys(), ...unlisted]) {
    if (wanted.has(key)) continue;
    rows.push({
      key,
      intent: { want: "drop" },
      last: current.ledger.get(key) ?? null,
      current: current.members.get(key) ?? null,
    });
  }
  return rows;
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
export function decideReplace(
  drafts: readonly MemberDraft[],
  current: CurrentComposition | null,
): Decision[] {
  const rows = replaceRows(drafts, current);
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
  return decisions.map((decision, i) => {
    if (decision.do !== "create" && decision.do !== "overwrite") return decision;
    const spec = decision.draft.spec;
    if (spec.role !== "edge" || (nodes.has(spec.from) && nodes.has(spec.to))) return decision;
    // An edge to a node that will not exist cannot be bound, so the canvas keeps what it has. The
    // ledger keeps the old hash, so the edge is drawn once both ends exist and its spec changes.
    return {
      do: "keep",
      key: decision.key,
      hash: rows[i]?.last ?? null,
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
