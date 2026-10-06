import type {
  DiagramCompositionMember,
  DiagramCompositionSummary,
  DiagramCompositionsPage,
} from "@t3tools/contracts";
import type { TLFrameShape, TLParentId, TLRecord } from "@tldraw/tlschema";

import {
  compareIndex,
  pageBox,
  pageIdOf,
  pagesInOrder,
  type RecordIndex,
  unionOf,
} from "./canvas.ts";
import {
  fingerprint,
  type FrameMeta,
  MEMBER_PARTS,
  type PartMeta,
  type PartName,
  readFrameMeta,
  readPartMeta,
  type StoredMember,
} from "./identity.ts";

/** A member whose main part is on the canvas. Members a human deleted live only in the ledger. */
export interface CurrentMember {
  readonly key: string;
  readonly stored: StoredMember;
  readonly parts: ReadonlyMap<PartName, TLRecord>;
  /** Some part's content differs from what compose wrote, or a part is missing. */
  readonly edited: boolean;
}

export interface CurrentComposition {
  readonly key: string;
  readonly epoch: number;
  readonly frame: TLFrameShape;
  readonly meta: FrameMeta;
  readonly pageId: TLParentId;
  readonly ledger: ReadonlyMap<string, string>;
  readonly members: ReadonlyMap<string, CurrentMember>;
}

interface CompositionScan {
  readonly compositions: ReadonlyMap<string, CurrentComposition>;
  /** Composition key of every genuine member record, frames included. */
  readonly owners: ReadonlyMap<string, string>;
}

/**
 * One pass over the document. A composition exists while its frame does; member records whose
 * frame is gone are ordinary shapes, and composing that key again starts over.
 */
export function scanCompositions(index: RecordIndex): CompositionScan {
  const frames = new Map<string, { frame: TLFrameShape; meta: FrameMeta; pageId: TLParentId }>();
  const parts: { record: TLRecord; meta: PartMeta }[] = [];
  for (const record of index.values()) {
    const frameMeta = readFrameMeta(record);
    if (frameMeta && record.typeName === "shape" && record.type === "frame") {
      const pageId = pageIdOf(index, record);
      const known = frames.get(frameMeta.c);
      if (pageId && (!known || known.meta.e > frameMeta.e)) {
        frames.set(frameMeta.c, { frame: record, meta: frameMeta, pageId });
      }
      continue;
    }
    const meta = readPartMeta(record);
    if (meta) parts.push({ record, meta });
  }

  const owners = new Map<string, string>();
  const grouped = new Map<
    string,
    Map<string, Map<PartName, { record: TLRecord; meta: PartMeta }>>
  >();
  for (const [key, { frame }] of frames) owners.set(frame.id, key);
  for (const part of parts) {
    const owner = frames.get(part.meta.c);
    if (!owner || owner.meta.e !== part.meta.e) continue;
    owners.set(part.record.id, part.meta.c);
    const members = grouped.get(part.meta.c) ?? new Map();
    grouped.set(part.meta.c, members);
    const member = members.get(part.meta.m) ?? new Map();
    members.set(part.meta.m, member);
    member.set(part.meta.p, part);
  }

  const compositions = new Map<string, CurrentComposition>();
  for (const [key, { frame, meta, pageId }] of frames) {
    const present = new Map<
      string,
      { stored: StoredMember; parts: Map<PartName, { record: TLRecord; meta: PartMeta }> }
    >();
    for (const [memberKey, memberParts] of grouped.get(key) ?? []) {
      const stored = memberParts.get("main")?.meta.spec;
      if (stored) present.set(memberKey, { stored, parts: memberParts });
    }
    const members = new Map<string, CurrentMember>();
    for (const [memberKey, { stored, parts: memberParts }] of present) {
      const edited = MEMBER_PARTS[stored.role].some((name) => {
        const part = memberParts.get(name);
        if (part) return fingerprint(part.record) !== part.meta.f;
        // tldraw deletes a binding with its target; a deleted endpoint is not an edit of the edge.
        if (stored.role === "edge" && name !== "main") {
          return present.has(name === "start" ? stored.from : stored.to);
        }
        return true;
      });
      const records = new Map(Array.from(memberParts, ([name, part]) => [name, part.record]));
      members.set(memberKey, { key: memberKey, stored, parts: records, edited });
    }
    compositions.set(key, {
      key,
      epoch: meta.e,
      frame,
      meta,
      pageId,
      ledger: new Map(meta.ledger),
      members,
    });
  }
  return { compositions, owners };
}

/** Page order, then key order. */
export function summarize(index: RecordIndex, scan: CompositionScan): DiagramCompositionSummary[] {
  const pageOrder = new Map<string, number>(pagesInOrder(index).map((page, i) => [page.id, i]));
  return Array.from(scan.compositions.values())
    .sort(
      (a, b) =>
        (pageOrder.get(a.pageId) ?? 0) - (pageOrder.get(b.pageId) ?? 0) ||
        compareIndex(a.key, b.key),
    )
    .map((composition) => {
      const members = Array.from(composition.members.values());
      const boxes = members.flatMap((member) =>
        Array.from(member.parts.values()).flatMap((record) =>
          record.typeName === "shape" ? [pageBox(index, record)] : [],
        ),
      );
      return {
        key: composition.key,
        kit: composition.meta.kit,
        title: composition.meta.title,
        pageId: composition.pageId,
        frameId: composition.frame.id,
        memberCount: members.length,
        editedCount: members.filter((member) => member.edited).length,
        bounds: unionOf(boxes),
      };
    });
}

export interface DetailPage {
  /** Only this composition; every composition when absent. */
  readonly key?: string | undefined;
  readonly offset: number;
  readonly limit: number;
}

const MAX_TEXT = 2000;

/**
 * Members as compose last wrote them, flattened across the compositions in summary order and
 * paged by member. Members a human deleted are absent; their keys stay in the ledger only.
 */
export function detail(
  summaries: readonly DiagramCompositionSummary[],
  scan: CompositionScan,
  page: DetailPage,
): DiagramCompositionsPage {
  const end = page.offset + page.limit;
  let cursor = 0;
  const items: DiagramCompositionsPage["items"][number][] = [];
  for (const summary of summaries) {
    const composition = scan.compositions.get(summary.key);
    if (!composition || (page.key !== undefined && page.key !== summary.key)) continue;
    const members = memberOrder(composition);
    const from = Math.max(page.offset - cursor, 0);
    const to = Math.max(end - cursor, 0);
    const slice = members.slice(from, to);
    const start = cursor;
    cursor += members.length;
    if (slice.length === 0 && !(members.length === 0 && start >= page.offset && start < end))
      continue;
    items.push({
      key: composition.key,
      kit: composition.meta.kit,
      title: composition.meta.title,
      direction: composition.meta.direction,
      members: slice.map(memberDetail),
    });
  }
  return { items, nextOffset: end < cursor ? end : null };
}

/** Ledger order, which is spec order, then members the ledger lost track of by key. */
export function memberOrder(composition: CurrentComposition): CurrentMember[] {
  const listed = Array.from(composition.ledger.keys()).flatMap((key) => {
    const member = composition.members.get(key);
    return member ? [member] : [];
  });
  const unlisted = Array.from(composition.members.values())
    .filter((member) => !composition.ledger.has(member.key))
    .sort((a, b) => compareIndex(a.key, b.key));
  return [...listed, ...unlisted];
}

function memberDetail(member: CurrentMember): DiagramCompositionMember {
  const { stored } = member;
  const spec =
    stored.role === "node"
      ? {
          key: stored.key,
          kind: stored.kind,
          label: stored.label,
          ...(stored.parent === null ? {} : { parent: stored.parent }),
          ...(stored.ref === null ? {} : { ref: stored.ref }),
        }
      : {
          key: stored.key,
          from: stored.from,
          to: stored.to,
          kind: stored.kind,
          label: stored.label,
        };
  if (!member.edited) return { spec, edited: false };
  const main = member.parts.get("main");
  const text =
    main?.typeName === "shape" && "richText" in main.props ? plainText(main.props.richText) : "";
  return {
    spec,
    edited: true,
    text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text,
  };
}

const INLINE_BLOCKS = new Set(["paragraph", "heading"]);

/** Rich text as plain text: blocks on their own lines, the inverse of `toRichText` for labels. */
function plainText(node: unknown): string {
  if (typeof node !== "object" || node === null) return "";
  if ("text" in node && typeof node.text === "string") return node.text;
  const type = "type" in node ? node.type : null;
  if (type === "hardBreak") return "\n";
  if (!("content" in node) || !Array.isArray(node.content)) return "";
  const separator = typeof type === "string" && INLINE_BLOCKS.has(type) ? "" : "\n";
  return node.content.map(plainText).join(separator);
}
