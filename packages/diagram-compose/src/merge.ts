import { DiagramOperationError } from "@t3tools/contracts";
import type { TLRecord } from "@tldraw/tlschema";

import { compareIndex } from "./canvas.ts";
import { holderOf, isContent, type PartName, specHash, type StoredMember } from "./identity.ts";
import { ATTACH_EDGE_KIND } from "./kit.ts";
import type { CurrentComposition, CurrentMember, Remnant } from "./membership.ts";
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
  /** Parts left over after a human deleted the member's main part. */
  readonly remnant: Remnant | null;
}

/** Records that hold a member's IDs, whose turn it is to be written or removed. */
type Parts = ReadonlyMap<PartName, TLRecord>;

export type Decision =
  /** `clears` holds records at the member's IDs that the new drawing replaces wholesale. */
  | {
      readonly do: "create";
      readonly key: string;
      readonly draft: MemberDraft;
      readonly clears: Parts;
    }
  | {
      readonly do: "overwrite";
      readonly key: string;
      readonly draft: MemberDraft;
      readonly current: CurrentMember;
    }
  /**
   * `hash` is what the ledger keeps; null keeps the member out of it. `restamp` is a new stored
   * spec for the main part, for a change to what is never drawn, such as a node's `ref`.
   */
  | {
      readonly do: "keep";
      readonly key: string;
      readonly hash: string | null;
      readonly current: CurrentMember | null;
      readonly restamp?: StoredMember;
    }
  | { readonly do: "remove"; readonly key: string; readonly parts: Parts }
  | { readonly do: "forget"; readonly key: string }
  | { readonly do: "detach"; readonly key: string; readonly parts: Parts }
  | { readonly do: "conflict"; readonly key: string };

function draftOf(member: StoredMember, within: string | null = null): MemberDraft {
  return { key: member.key, hash: specHash(member), spec: member, within };
}

/** Spec order, each node followed by its contents, then edges, then notes' attach lines. */
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
    remnant: current?.remnants.get(key) ?? null,
  };
}

/** Ledger order, then members and remnants the ledger lost track of by key. */
function memberKeys(current: CurrentComposition): string[] {
  const unlisted = Array.from(new Set([...current.members.keys(), ...current.remnants.keys()]))
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

type Slot = "node" | "edge" | "attach";

/** Where a member sits in spec order: nodes, then edges, then the attach lines notes lower to. */
function slotOf(member: StoredMember): Slot {
  if (member.role === "node") return "node";
  return member.kind === ATTACH_EDGE_KIND ? "attach" : "edge";
}

/**
 * Patch mode: the composition's members in member order with listed members swapped in, removed
 * keys and the member edges of removed nodes, or of elements gone from a listed screen, dropped,
 * and everything else untouched. Each new member goes after the last of its slot (nodes, edges,
 * attach lines), which is where replacing with the whole patched spec puts it, so both modes write
 * the same ledger. A listed node brings its whole contents, in spec order right after it: contents
 * it no longer lists drop, as do the contents of a removed node.
 */
export function patchRows(
  drafts: readonly MemberDraft[],
  removeKeys: readonly string[],
  current: CurrentComposition,
): Row[] {
  const byKey = new Map(drafts.map((draft) => [draft.key, draft]));
  const removed = new Set(removeKeys);
  /** A removed node, an element of one, or an element its listed screen no longer has. */
  const gone = (end: string) => {
    const holder = holderOf(end);
    return removed.has(holder) || (holder !== end && byKey.has(holder) && !byKey.has(end));
  };
  const endpointRemoved = (member: CurrentMember | undefined) =>
    member?.stored.role === "edge" &&
    !byKey.has(member.key) &&
    (gone(member.stored.from) || gone(member.stored.to));
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
  const slot = (row: Row): Slot | null => {
    const member = row.intent.want === "upsert" ? row.intent.draft.spec : row.current?.stored;
    return member ? slotOf(member) : null;
  };
  // Each slot's new members go where its next slot starts; members a human deleted stay put.
  const known = new Set(rows.map((row) => row.key));
  const ordered = [...rows];
  for (const [i, kind] of (["node", "edge", "attach"] as const).entries()) {
    const later = new Set<Slot>((["node", "edge", "attach"] as const).slice(i + 1));
    const added = drafts
      .filter((draft) => !known.has(draft.key) && slotOf(draft.spec) === kind)
      .map((draft) => rowOf(draft.key, { want: "upsert", draft }, current));
    const next = ordered.findIndex((row) => {
      const at = slot(row);
      return at !== null && later.has(at);
    });
    ordered.splice(next === -1 ? ordered.length : next, 0, ...added);
  }
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

/** Which members have a shape once this compose applies, as decided so far. */
interface Presence {
  readonly nodes: ReadonlySet<string>;
  /** Nodes drawn from scratch, which bring back contents deleted along with them. */
  readonly created: ReadonlySet<string>;
}

/**
 * The ownership truth table for one member. Edges need both endpoints and contents need their
 * node, so `present` holds every node decided before this row.
 */
function decide(row: Row, present: Presence): Decision {
  const { key, intent, last, current, remnant } = row;
  const existing = current ?? remnant;
  switch (intent.want) {
    case "upsert": {
      const { draft } = intent;
      const spec = draft.spec;
      const drawable =
        spec.role === "edge"
          ? present.nodes.has(spec.from) && present.nodes.has(spec.to)
          : draft.within === null || present.nodes.has(draft.within);
      // A member that changes role is a different member under the same key.
      const same = current?.stored.role === spec.role ? current : null;
      if (last === draft.hash) {
        // A node drawn again brings back the contents deleted along with it, and an unedited edge
        // whose endpoint was deleted and drawn again is bound anew.
        if (!current && draft.within !== null && present.created.has(draft.within)) {
          return { do: "create", key, draft, clears: remnant?.parts ?? NO_PARTS };
        }
        if (same && rebinds(same, present)) return { do: "overwrite", key, draft, current: same };
        return { do: "keep", key, hash: last, current };
      }
      if (same && isRestamp(spec, same.stored)) {
        return { do: "keep", key, hash: draft.hash, current: same, restamp: spec };
      }
      if (existing?.edited) return { do: "conflict", key };
      // Without its endpoints or node the canvas keeps what it has; the ledger keeps the old hash,
      // so the member is drawn once they exist and its spec changes. What changed role still goes.
      if (!drawable) {
        if (current && !same) return { do: "remove", key, parts: current.parts };
        return { do: "keep", key, hash: last, current: same };
      }
      if (!same) return { do: "create", key, draft, clears: existing?.parts ?? NO_PARTS };
      return { do: "overwrite", key, draft, current: same };
    }
    case "drop":
      if (!existing) return { do: "forget", key };
      return existing.edited
        ? { do: "conflict", key }
        : { do: "remove", key, parts: existing.parts };
    case "untouched":
      if (current && rebinds(current, present)) {
        return { do: "overwrite", key, draft: draftOf(current.stored), current };
      }
      return { do: "keep", key, hash: last, current };
    case "purge":
      return existing ? { do: "remove", key, parts: existing.parts } : { do: "forget", key };
    case "detach":
      return existing ? { do: "detach", key, parts: existing.parts } : { do: "forget", key };
    default: {
      const _exhaustive: never = intent;
      return _exhaustive;
    }
  }
}

const NO_PARTS: Parts = new Map();

/** An unedited edge that lost its bindings with a deleted endpoint, now that both ends exist. */
function rebinds(member: CurrentMember, present: Presence): boolean {
  const { stored } = member;
  return (
    stored.role === "edge" &&
    !member.edited &&
    !member.complete &&
    present.nodes.has(stored.from) &&
    present.nodes.has(stored.to)
  );
}

/** Only a node's `ref` changed. Nothing draws it, so the canvas, edits included, stays. */
function isRestamp(next: StoredMember, stored: StoredMember): boolean {
  return (
    next.role === "node" &&
    stored.role === "node" &&
    specHash({ ...next, ref: stored.ref }) === specHash(stored)
  );
}

/**
 * Decides every row: nodes first, then contents, which need their node, then edges, which need
 * both endpoints. Returns decisions in row order. Throws one `conflict` naming every member that
 * both the spec and someone else changed.
 */
export function decideRows(rows: readonly Row[]): Decision[] {
  const stage = (row: Row): number => {
    const member = row.intent.want === "upsert" ? row.intent.draft.spec : row.current?.stored;
    if (member?.role === "edge") return 2;
    return member && isContent(member) ? 1 : 0;
  };
  const nodes = new Set<string>();
  const created = new Set<string>();
  const decisions = new Map<Row, Decision>();
  for (const at of [0, 1, 2]) {
    for (const row of rows) {
      if (stage(row) !== at) continue;
      const decision = decide(row, { nodes, created });
      decisions.set(row, decision);
      const present =
        decision.do === "create" || decision.do === "overwrite"
          ? decision.draft.spec.role === "node"
          : decision.do === "keep" && decision.current?.stored.role === "node";
      if (present) nodes.add(decision.key);
      if (decision.do === "create") created.add(decision.key);
    }
  }
  const ordered = rows.flatMap((row) => decisions.get(row) ?? []);
  const conflicts = ordered.flatMap((decision) =>
    decision.do === "conflict" ? [decision.key] : [],
  );
  if (conflicts.length > 0) {
    throw new DiagramOperationError({
      code: "conflict",
      details: { members: conflicts.slice(0, 50) },
    });
  }
  return ordered;
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
