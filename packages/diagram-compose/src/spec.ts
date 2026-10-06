import {
  DiagramOperationError,
  type DiagramComposeRequest,
  type DiagramLayoutDirection,
  type DiagramMermaidSource,
  type DiagramSpec,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

import type { StoredEdge, StoredNode } from "./identity.ts";
import { ATTACH_EDGE_KIND, type BodySchema, type Kit, type NodeKind, NOTE_KIND } from "./kit.ts";
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

export interface SpecIssue {
  readonly path: string;
  readonly message: string;
}

/** A compose names its content once: a spec, or Mermaid text the editor host turns into one. */
export type ComposeSource =
  | { readonly spec: DiagramSpec }
  | { readonly mermaid: DiagramMermaidSource };

export function sourceOf(request: DiagramComposeRequest): ComposeSource {
  if (request.spec && request.mermaid) {
    throw invalidSpec([{ path: "mermaid", message: "pass either spec or mermaid, not both" }]);
  }
  if (request.spec) return { spec: request.spec };
  if (request.mermaid) return { mermaid: request.mermaid };
  throw invalidSpec([
    { path: "spec", message: "pass a spec, or Mermaid as mermaid: { key, text, title? }" },
  ]);
}

const MAX_ISSUES = 20;

export function invalidSpec(issues: readonly SpecIssue[]): DiagramOperationError {
  return new DiagramOperationError({
    code: "invalid-spec",
    details: { issues: issues.slice(0, MAX_ISSUES) },
  });
}

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
    const row = kit.nodeKinds[kind];
    if (!row) {
      issues.push({
        path: `${path}.kind`,
        message: `unknown kind "${kind}" for kit ${kit.name}; valid kinds: ${listOf(Object.keys(kit.nodeKinds))}`,
      });
    }
    return {
      role: "node",
      key: node.key,
      kind,
      label: node.label ?? node.key,
      parent: node.parent ?? null,
      ref: node.ref ?? null,
      body: row ? parseBody(row, kind, node.body, `${path}.body`, issues) : null,
    };
  });

  const nodeKeys = nodes.map((node) => node.key);
  const nodeKeySet = new Set(nodeKeys);
  checkParents(kit, nodes, issues);

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

  // A note's `body.on` is its attach line, keyed like any derived edge so it merges like one.
  nodes.forEach((node, i) => {
    const on = node.kind === NOTE_KIND ? node.body?.["on"] : undefined;
    if (typeof on !== "string") return;
    const path = `spec.nodes[${i}].body.on`;
    if (!nodeKeySet.has(on) || on === node.key) {
      const others = nodeKeys.filter((key) => key !== node.key);
      issues.push({ path, message: `unknown node "${on}"; valid nodes: ${listOf(others)}` });
      return;
    }
    const key = derivedKey(`${node.key}→${on}:${ATTACH_EDGE_KIND}`, derivedCounts);
    if (keys.has(key)) issues.push({ path, message: `duplicate key "${key}"` });
    keys.add(key);
    edges.push({ role: "edge", key, from: node.key, to: on, kind: ATTACH_EDGE_KIND, label: "" });
  });

  if (issues.length > 0) throw invalidSpec(issues);
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

const decodeJsonObject = Schema.decodeUnknownSync(Schema.JsonObject);
const bodyDecoders = new WeakMap<BodySchema, ReturnType<typeof compileBodyDecoder>>();
const compileBodyDecoder = (schema: BodySchema) =>
  Schema.decodeUnknownResult(schema, { errors: "all" });
function bodyDecoder(schema: BodySchema) {
  const known = bodyDecoders.get(schema);
  if (known) return known;
  const decoder = compileBodyDecoder(schema);
  bodyDecoders.set(schema, decoder);
  return decoder;
}
const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * Kinds with a body schema always store an object, so an omitted body and `{}` are the same spec.
 * Kinds without one take no body.
 */
function parseBody(
  row: NodeKind,
  kind: string,
  body: unknown,
  path: string,
  issues: SpecIssue[],
): Schema.JsonObject | null {
  if (!row.body) {
    if (body !== undefined) issues.push({ path, message: `kind "${kind}" takes no body fields` });
    return null;
  }
  const fields = Object.keys(row.body.fields);
  const input = body ?? {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    issues.push({ path, message: `body must be an object with fields: ${listOf(fields)}` });
    return null;
  }
  const unknown = Object.keys(input).filter((field) => !fields.includes(field));
  for (const field of unknown) {
    issues.push({
      path: `${path}.${field}`,
      message: `unknown field "${field}" for kind "${kind}"; valid fields: ${listOf(fields)}`,
    });
  }
  const decoded = bodyDecoder(row.body)(input);
  if (Result.isFailure(decoded)) {
    for (const issue of formatIssue(decoded.failure.issue).issues) {
      const at = (issue.path ?? []).map((segment) => {
        const key = typeof segment === "object" ? segment.key : segment;
        return typeof key === "number" ? `[${key}]` : `.${String(key)}`;
      });
      issues.push({ path: `${path}${at.join("")}`, message: issue.message });
    }
    return null;
  }
  return unknown.length > 0 ? null : decodeJsonObject(decoded.success);
}

/** Parents must exist, be a container kind, and never loop back. */
function checkParents(kit: Kit, nodes: readonly StoredNode[], issues: SpecIssue[]): void {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const containerKinds = Object.entries(kit.nodeKinds).flatMap(([kind, row]) =>
    row.shape === "frame" ? [kind] : [],
  );
  const containers = nodes.flatMap((node) =>
    kit.nodeKinds[node.kind]?.shape === "frame" ? [node.key] : [],
  );
  nodes.forEach((node, i) => {
    if (node.parent === null) return;
    const path = `spec.nodes[${i}].parent`;
    if (containerKinds.length === 0) {
      issues.push({
        path,
        message: `kit ${kit.name} has no container kinds, so nodes cannot have a parent`,
      });
      return;
    }
    const parent = byKey.get(node.parent);
    if (!parent) {
      issues.push({
        path,
        message: `unknown parent "${node.parent}"; valid parents are ${listOf(containerKinds)} nodes: ${listOf(containers)}`,
      });
      return;
    }
    if (kit.nodeKinds[parent.kind]?.shape !== "frame") {
      issues.push({
        path,
        message: `"${parent.key}" is a ${parent.kind}, which cannot hold nodes; parents must be ${listOf(containerKinds)} nodes`,
      });
      return;
    }
    const chain = [node.key];
    for (let at = parent; ;) {
      chain.push(at.key);
      if (at.key === node.key) {
        issues.push({ path, message: `parents loop: ${chain.join(" → ")}` });
        return;
      }
      const next = at.parent === null ? undefined : byKey.get(at.parent);
      if (!next || chain.length > nodes.length) return;
      at = next;
    }
  });
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
