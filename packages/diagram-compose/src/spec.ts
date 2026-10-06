import {
  DiagramOperationError,
  type DiagramLayoutDirection,
  type DiagramSpec,
} from "@t3tools/contracts";

import type { StoredEdge, StoredNode } from "./identity.ts";
import type { Kit } from "./kit.ts";
import { KITS } from "./kits/index.ts";

/** The spec in full form: every default applied and every edge keyed. Nothing downstream sees shorthand. */
export interface ComposeSpec {
  readonly kit: Kit;
  readonly key: string;
  readonly title: string;
  readonly direction: DiagramLayoutDirection;
  readonly pageId: string | null;
  readonly position: { readonly x: number; readonly y: number } | null;
  readonly nodes: readonly StoredNode[];
  readonly edges: readonly StoredEdge[];
}

interface SpecIssue {
  readonly path: string;
  readonly message: string;
}

const MAX_ISSUES = 20;

/** Normalizes, then checks the spec against its kit. Issue messages name the valid options. */
export function parseSpec(spec: DiagramSpec): ComposeSpec {
  const kit = KITS[spec.kit];
  const issues: SpecIssue[] = [];
  const keys = new Set<string>();

  const nodes = spec.nodes.map((node, i): StoredNode => {
    const path = `spec.nodes[${i}]`;
    if (keys.has(node.key))
      issues.push({ path: `${path}.key`, message: `duplicate key "${node.key}"` });
    keys.add(node.key);
    const kind = node.kind ?? kit.defaultKind;
    if (!(kind in kit.nodeKinds)) {
      issues.push({
        path: `${path}.kind`,
        message: `unknown kind "${kind}" for kit ${kit.name}; valid kinds: ${listOf(Object.keys(kit.nodeKinds))}`,
      });
    }
    if (node.body !== undefined) {
      issues.push({ path: `${path}.body`, message: `kind "${kind}" takes no body fields` });
    }
    if (node.parent !== undefined) {
      issues.push({
        path: `${path}.parent`,
        message: `kit ${kit.name} has no container kinds, so nodes cannot have a parent`,
      });
    }
    return {
      role: "node",
      key: node.key,
      kind,
      label: node.label ?? node.key,
      parent: null,
      ref: node.ref ?? null,
      body: null,
    };
  });

  const nodeKeys = nodes.map((node) => node.key);
  const nodeKeySet = new Set(nodeKeys);
  const derivedCounts = new Map<string, number>();
  const edges = (spec.edges ?? []).map((edge, i): StoredEdge => {
    const path = `spec.edges[${i}]`;
    const full =
      "from" in edge
        ? { ...edge, paths: { from: `${path}.from`, to: `${path}.to`, kind: `${path}.kind` } }
        : {
            from: edge[0],
            to: edge[1],
            label: edge[2],
            key: undefined,
            kind: undefined,
            paths: { from: `${path}[0]`, to: `${path}[1]`, kind: `${path}.kind` },
          };
    for (const end of ["from", "to"] as const) {
      if (!nodeKeySet.has(full[end])) {
        issues.push({
          path: full.paths[end],
          message: `unknown node "${full[end]}"; valid nodes: ${listOf(nodeKeys)}`,
        });
      }
    }
    const kind = full.kind ?? kit.defaultEdgeKind;
    if (!(kind in kit.edgeKinds)) {
      issues.push({
        path: full.paths.kind,
        message: `unknown edge kind "${kind}" for kit ${kit.name}; valid edge kinds: ${listOf(Object.keys(kit.edgeKinds))}`,
      });
    }
    const key = full.key ?? derivedKey(`${full.from}→${full.to}:${kind}`, derivedCounts);
    if (keys.has(key)) issues.push({ path: `${path}.key`, message: `duplicate key "${key}"` });
    keys.add(key);
    return { role: "edge", key, from: full.from, to: full.to, kind, label: full.label ?? "" };
  });

  if (issues.length > 0) {
    throw new DiagramOperationError({
      code: "invalid-spec",
      details: { issues: issues.slice(0, MAX_ISSUES) },
    });
  }
  return {
    kit,
    key: spec.key,
    title: spec.title ?? spec.key,
    direction: spec.direction ?? kit.direction,
    pageId: spec.pageId ?? null,
    position: spec.position ?? null,
    nodes,
    edges,
  };
}

/** Repeated pairs get `#2`, `#3` in spec order, so keys stay stable while earlier edges stay put. */
function derivedKey(base: string, counts: Map<string, number>): string {
  const count = (counts.get(base) ?? 0) + 1;
  counts.set(base, count);
  return count === 1 ? base : `${base}#${count}`;
}

export function listOf(values: readonly string[]): string {
  const shown = values.slice(0, 20).join(", ");
  return values.length > 20 ? `${shown}, …` : shown || "(none)";
}
