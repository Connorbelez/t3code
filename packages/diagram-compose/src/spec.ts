import {
  DiagramOperationError,
  type DiagramComposeRequest,
  type DiagramLayoutDirection,
  type DiagramMermaidSource,
  type DiagramSpec,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaIssue from "effect/SchemaIssue";

import type { StoredEdge, StoredNode } from "./identity.ts";
import { ATTACH_EDGE_KIND, type BodySchema, type Kit, NOTE_KIND } from "./kit.ts";
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

/** A compose request with its field combinations checked. Mermaid is replace-only. */
export type ComposeOperation =
  | { readonly kind: "replace"; readonly source: ComposeSource; readonly relayout: boolean }
  | {
      readonly kind: "patch";
      readonly spec: DiagramSpec;
      readonly removeKeys: readonly string[];
      readonly relayout: boolean;
    }
  | { readonly kind: "remove"; readonly key: string }
  | { readonly kind: "detach"; readonly key: string };

/** Extra request fields the server handles after the commit; checked here so errors stay in one place. */
export interface ComposeExtras {
  readonly includeMembers?: boolean | undefined;
  readonly capture?: boolean | undefined;
}

/** Checks which fields go together. The spec itself is checked by `parseSpec`. */
export function parseRequest(request: DiagramComposeRequest & ComposeExtras): ComposeOperation {
  const operation = request.operation ?? "compose";
  const issues: SpecIssue[] = [];
  if (operation !== "compose") {
    for (const field of [
      "spec",
      "mermaid",
      "mode",
      "removeKeys",
      "relayout",
      "includeMembers",
      "capture",
    ] as const) {
      if (request[field] !== undefined) {
        issues.push({
          path: field,
          message: `only for operation "compose"; operation "${operation}" takes only key`,
        });
      }
    }
    if (request.key === undefined) {
      issues.push({ path: "key", message: `required: the key of the composition to ${operation}` });
    }
    if (issues.length > 0 || request.key === undefined) throw invalidSpec(issues);
    return { kind: operation, key: request.key };
  }

  if (request.key !== undefined) {
    issues.push({
      path: "key",
      message:
        'only for operation "remove" or "detach"; a compose takes its composition key from spec.key',
    });
  }
  if (request.mode !== "patch" && request.removeKeys !== undefined) {
    issues.push({
      path: "removeKeys",
      message: 'only for mode "patch"; in replace mode, leave members out of the spec instead',
    });
  }
  if (request.spec && request.mermaid) {
    issues.push({ path: "mermaid", message: "pass either spec or mermaid, not both" });
  } else if (request.mode === "patch" && request.mermaid) {
    issues.push({
      path: "mode",
      message: "Mermaid always replaces the whole composition; patch with a spec instead",
    });
  }
  const source: ComposeSource | null = request.spec
    ? { spec: request.spec }
    : request.mermaid
      ? { mermaid: request.mermaid }
      : null;
  if (!source) {
    issues.push({
      path: "spec",
      message:
        "pass a spec, or Mermaid as mermaid: { key, text, title? }; to remove or detach a composition, set operation and key instead",
    });
  }
  if (issues.length > 0 || !source) throw invalidSpec(issues);
  const relayout = request.relayout ?? false;
  if (request.mode === "patch" && "spec" in source) {
    return { kind: "patch", spec: source.spec, removeKeys: request.removeKeys ?? [], relayout };
  }
  return { kind: "replace", source, relayout };
}

const MAX_ISSUES = 20;

export function invalidSpec(issues: readonly SpecIssue[]): DiagramOperationError {
  return new DiagramOperationError({
    code: "invalid-spec",
    details: { issues: issues.slice(0, MAX_ISSUES) },
  });
}

/**
 * Nodes a patch may reference besides its own: the composition's remaining nodes, null for a
 * member a human deleted (its kind is unknown). "any" when they are unknown, as on the server.
 */
export type OutsideNodes = ReadonlyMap<string, StoredNode | null> | "any";

/** Normalizes, then checks the spec against its kit. Issue messages name the valid options. */
export function parseSpec(spec: DiagramSpec, outside: OutsideNodes = new Map()): ComposeSpec {
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
      body: row ? parseBody(row.body, `kind "${kind}"`, node.body, `${path}.body`, issues) : null,
    };
  });

  const nodeKeys = [...nodes.map((node) => node.key), ...(outside === "any" ? [] : outside.keys())];
  const nodeKeySet = new Set(nodeKeys);
  const known = (key: string) => outside === "any" || nodeKeySet.has(key);
  checkParents(kit, nodes, outside, issues);

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
            body: undefined,
            paths: { from: `${path}[0]`, to: `${path}[1]`, kind: `${path}.kind` },
          };
    for (const end of ["from", "to"] as const) {
      if (!known(full[end])) {
        issues.push({
          path: full.paths[end],
          message: `unknown node "${full[end]}"; valid nodes: ${listOf(nodeKeys)}`,
        });
      }
    }
    const kind = full.kind ?? kit.defaultEdgeKind;
    const row = kit.edgeKinds[kind];
    if (!row) {
      issues.push({
        path: full.paths.kind,
        message: `unknown edge kind "${kind}" for kit ${kit.name}; valid edge kinds: ${listOf(Object.keys(kit.edgeKinds))}`,
      });
    }
    const key = full.key ?? derivedKey(`${full.from}→${full.to}:${kind}`, derivedCounts);
    if (keys.has(key)) issues.push({ path: `${path}.key`, message: `duplicate key "${key}"` });
    keys.add(key);
    const body =
      row && parseBody(row.body, `edge kind "${kind}"`, full.body, `${path}.body`, issues);
    return {
      role: "edge",
      key,
      from: full.from,
      to: full.to,
      kind,
      label: full.label ?? "",
      ...(body ? { body } : {}),
    };
  });

  // A note's `body.on` is its attach line, keyed like any derived edge so it merges like one.
  nodes.forEach((node, i) => {
    const on = node.kind === NOTE_KIND ? node.body?.["on"] : undefined;
    if (typeof on !== "string") return;
    const path = `spec.nodes[${i}].body.on`;
    if (!known(on) || on === node.key) {
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
 * Kinds without one take no body. `kind` names the kind in messages, e.g. `edge kind "flow"`.
 */
function parseBody(
  schema: BodySchema | undefined,
  kind: string,
  body: unknown,
  path: string,
  issues: SpecIssue[],
): Schema.JsonObject | null {
  if (!schema) {
    if (body !== undefined) issues.push({ path, message: `${kind} takes no body fields` });
    return null;
  }
  const fields = Object.keys(schema.fields);
  const input = body ?? {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    issues.push({ path, message: `body must be an object with fields: ${listOf(fields)}` });
    return null;
  }
  const unknown = unknownFields(schema.ast, input, path, kind);
  issues.push(...unknown);
  const decoded = bodyDecoder(schema)(input);
  if (Result.isFailure(decoded)) {
    for (const issue of formatIssue(decoded.failure.issue).issues) {
      const at = (issue.path ?? []).map((segment) => {
        const key = typeof segment === "object" ? segment.key : segment;
        return typeof key === "number" ? `[${key}]` : `.${String(key)}`;
      });
      const field = issue.path?.at(-1);
      const message =
        issue.message === "Missing key" && field !== undefined
          ? `missing required field "${String(typeof field === "object" ? field.key : field)}"`
          : issue.message;
      issues.push({ path: `${path}${at.join("")}`, message });
    }
    return null;
  }
  return unknown.length > 0 ? null : decodeJsonObject(decoded.success);
}

/**
 * Fields the schema does not name, at any depth: in the body, in its nested objects and in their
 * array items. Decoding alone would drop them silently, so a typo would lose content.
 */
function unknownFields(
  ast: SchemaAST.AST,
  value: unknown,
  path: string,
  kind: string,
): SpecIssue[] {
  // Optional fields are unions with undefined; nothing else in a body schema is a union.
  if (SchemaAST.isUnion(ast)) {
    return ast.types.flatMap((member) => unknownFields(member, value, path, kind));
  }
  if (SchemaAST.isArrays(ast) && Array.isArray(value)) {
    const item = ast.rest[0];
    return item
      ? value.flatMap((element, i) => unknownFields(item, element, `${path}[${i}]`, kind))
      : [];
  }
  if (!SchemaAST.isObjects(ast) || typeof value !== "object" || value === null) return [];
  const fields = new Map(ast.propertySignatures.map((field) => [String(field.name), field.type]));
  return Object.entries(value).flatMap(([field, item]) => {
    const type = fields.get(field);
    if (type) return unknownFields(type, item, `${path}.${field}`, kind);
    return [
      {
        path: `${path}.${field}`,
        message: `unknown field "${field}" for ${kind}; valid fields: ${listOf(Array.from(fields.keys()))}`,
      },
    ];
  });
}

/** Parents must exist, be a container kind, and never loop back. */
function checkParents(
  kit: Kit,
  nodes: readonly StoredNode[],
  outside: OutsideNodes,
  issues: SpecIssue[],
): void {
  const byKey = new Map<string, StoredNode | null>(outside === "any" ? [] : outside);
  for (const node of nodes) byKey.set(node.key, node);
  const containerKinds = Object.entries(kit.nodeKinds).flatMap(([kind, row]) =>
    row.shape === "frame" ? [kind] : [],
  );
  const containers = Array.from(byKey.values()).flatMap((node) =>
    node && kit.nodeKinds[node.kind]?.shape === "frame" ? [node.key] : [],
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
    // A patch's parent may be a node only the canvas knows, or one a human deleted.
    if (parent === null || (parent === undefined && outside === "any")) return;
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
      if (!next || chain.length > byKey.size) return;
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
