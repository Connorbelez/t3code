import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  EnvironmentId,
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const DIAGRAM_PROTOCOL_VERSION = 1;
export const DIAGRAM_SDK_VERSION = "5.5.2";
export const DIAGRAM_MAX_BATCH_RECORDS = 500;
export const DIAGRAM_MAX_READ_RECORDS = 200;
export const DIAGRAM_MAX_SELECTED_MEMBERS = 50;
export const DIAGRAM_MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;

export const DiagramId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
).pipe(Schema.brand("DiagramId"));
export type DiagramId = typeof DiagramId.Type;

export const DiagramRecordId = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
export const DiagramRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export const DiagramName = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
export const DiagramRevision = NonNegativeInt;

const boundedJson = (maxBytes: number) =>
  Schema.Unknown.check(
    Schema.makeFilter((value) => {
      try {
        const json = JSON.stringify(value);
        return json !== undefined && new TextEncoder().encode(json).byteLength <= maxBytes;
      } catch {
        return false;
      }
    }),
  );

/** SDK records and schemas are validated and migrated by the pinned SDK at the document boundary. */
export const DiagramRecordData = boundedJson(2 * 1024 * 1024);
export const DiagramDocumentData = boundedJson(DIAGRAM_MAX_DOCUMENT_BYTES);

export const DiagramBounds = Schema.Struct({
  x: Schema.Number.check(Schema.isFinite()),
  y: Schema.Number.check(Schema.isFinite()),
  w: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  h: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
});
export type DiagramBounds = typeof DiagramBounds.Type;

export const DiagramCompositionKey = TrimmedNonEmptyString.check(
  Schema.isMaxLength(120),
  Schema.isPattern(/^\S+$/),
);

/** Scopes addressed by page and area: what clients attach and what an editor host captures. */
export const DiagramPageScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("diagram"), pageId: DiagramRecordId }),
  Schema.Struct({
    kind: Schema.Literal("selection"),
    pageId: DiagramRecordId,
    shapeIds: Schema.Array(DiagramRecordId).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(DIAGRAM_MAX_BATCH_RECORDS),
    ),
    bounds: DiagramBounds,
  }),
  Schema.Struct({
    kind: Schema.Literal("viewport"),
    pageId: DiagramRecordId,
    bounds: DiagramBounds,
  }),
]);
export type DiagramPageScope = typeof DiagramPageScope.Type;

/** A composition scope resolves on the server to its frame's current page and bounds. */
export const DiagramScope = Schema.Union([
  ...DiagramPageScope.members,
  Schema.Struct({ kind: Schema.Literal("composition"), key: DiagramCompositionKey }),
]);
export type DiagramScope = typeof DiagramScope.Type;

export const DiagramMetadata = Schema.Struct({
  id: DiagramId,
  projectId: ProjectId,
  name: DiagramName,
  revision: DiagramRevision,
  archivedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type DiagramMetadata = typeof DiagramMetadata.Type;

export const DiagramShapeSummary = Schema.Struct({
  id: DiagramRecordId,
  pageId: DiagramRecordId,
  parentId: DiagramRecordId,
  type: Schema.String,
  label: Schema.String.check(Schema.isMaxLength(1000)),
  bounds: Schema.NullOr(DiagramBounds),
  locked: Schema.Boolean,
});
export type DiagramShapeSummary = typeof DiagramShapeSummary.Type;

export const DiagramPageSummary = Schema.Struct({
  id: DiagramRecordId,
  name: Schema.String,
  shapeCount: NonNegativeInt,
});
export type DiagramPageSummary = typeof DiagramPageSummary.Type;

export const DiagramSpecRef = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  line: Schema.optional(PositiveInt),
});
export type DiagramSpecRef = typeof DiagramSpecRef.Type;

/**
 * A member the user selected, by the key a patch addresses. `label` is the text the user sees:
 * the spec label, or the member's current text once edited.
 */
export const DiagramSelectedMember = Schema.Union([
  Schema.Struct({
    key: Schema.String,
    kind: Schema.String,
    label: Schema.String.check(Schema.isMaxLength(256)),
    from: Schema.String,
    to: Schema.String,
  }),
  Schema.Struct({
    key: Schema.String,
    kind: Schema.String,
    label: Schema.String.check(Schema.isMaxLength(256)),
    ref: Schema.optional(DiagramSpecRef),
  }),
]);
export type DiagramSelectedMember = typeof DiagramSelectedMember.Type;

/** One composition listed once in place of its member shapes. */
export const DiagramCompositionSummary = Schema.Struct({
  key: Schema.String,
  kit: Schema.String,
  title: Schema.String,
  pageId: DiagramRecordId,
  frameId: DiagramRecordId,
  memberCount: NonNegativeInt,
  editedCount: NonNegativeInt,
  bounds: Schema.NullOr(DiagramBounds),
  /** Present only for a selection of some members; selecting the frame means all of them. */
  selectedMembers: Schema.optional(
    Schema.Array(DiagramSelectedMember).check(Schema.isMaxLength(DIAGRAM_MAX_SELECTED_MEMBERS)),
  ),
});
export type DiagramCompositionSummary = typeof DiagramCompositionSummary.Type;

export const DiagramStructure = Schema.Struct({
  revision: DiagramRevision,
  pages: Schema.Array(DiagramPageSummary).check(Schema.isMaxLength(100)),
  compositions: Schema.Array(DiagramCompositionSummary)
    .check(Schema.isMaxLength(100))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  shapes: Schema.Array(DiagramShapeSummary).check(Schema.isMaxLength(DIAGRAM_MAX_READ_RECORDS)),
  bindings: Schema.Array(
    Schema.Struct({
      id: DiagramRecordId,
      type: Schema.String,
      fromId: DiagramRecordId,
      toId: DiagramRecordId,
    }),
  ).check(Schema.isMaxLength(DIAGRAM_MAX_READ_RECORDS)),
  totalShapes: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type DiagramStructure = typeof DiagramStructure.Type;

export const DiagramExpectedRecord = Schema.Struct({
  id: DiagramRecordId,
  record: Schema.NullOr(DiagramRecordData),
});
export const DiagramBatch = Schema.Struct({
  requestId: DiagramRequestId,
  expected: Schema.Array(DiagramExpectedRecord).check(Schema.isMaxLength(2000)),
  puts: Schema.Array(DiagramRecordData).check(Schema.isMaxLength(DIAGRAM_MAX_BATCH_RECORDS)),
  deletes: Schema.Array(DiagramRecordId).check(Schema.isMaxLength(DIAGRAM_MAX_BATCH_RECORDS)),
}).check(
  Schema.makeFilter(
    (batch) =>
      batch.puts.length + batch.deletes.length > 0 &&
      batch.puts.length + batch.deletes.length <= DIAGRAM_MAX_BATCH_RECORDS,
  ),
);
export type DiagramBatch = typeof DiagramBatch.Type;

export const DiagramMutationReceipt = Schema.Struct({
  requestId: DiagramRequestId,
  revision: DiagramRevision,
  changedRecordIds: Schema.Array(DiagramRecordId).check(
    Schema.isMaxLength(DIAGRAM_MAX_BATCH_RECORDS),
  ),
});
export type DiagramMutationReceipt = typeof DiagramMutationReceipt.Type;

export const DiagramTarget = Schema.Struct({ projectId: ProjectId, diagramId: DiagramId });
export type DiagramTarget = typeof DiagramTarget.Type;

export const DiagramLifecycleInput = Schema.Union([
  Schema.Struct({
    ...DiagramTarget.fields,
    operation: Schema.Literal("rename"),
    name: DiagramName,
  }),
  Schema.Struct({
    ...DiagramTarget.fields,
    operation: Schema.Literal("duplicate"),
    name: Schema.optional(DiagramName),
  }),
  Schema.Struct({
    ...DiagramTarget.fields,
    operation: Schema.Literals(["archive", "restore", "delete"]),
  }),
]);
export type DiagramLifecycleInput = typeof DiagramLifecycleInput.Type;

export const DiagramCaptureInput = Schema.Struct({
  ...DiagramTarget.fields,
  scope: DiagramScope,
  format: Schema.optional(Schema.Literals(["png", "svg"])),
});
export type DiagramCaptureInput = typeof DiagramCaptureInput.Type;
export const DiagramCapture = Schema.Struct({
  diagramId: DiagramId,
  revision: DiagramRevision,
  scope: DiagramScope,
  bounds: DiagramBounds,
  width: NonNegativeInt,
  height: NonNegativeInt,
  mimeType: Schema.Literals(["image/png", "image/svg+xml"]),
  base64: Schema.String.check(Schema.isMaxLength(24 * 1024 * 1024)),
});
export type DiagramCapture = typeof DiagramCapture.Type;

export const DiagramPreparedContext = Schema.Struct({
  diagram: DiagramMetadata,
  scope: DiagramScope,
  structure: DiagramStructure,
  image: Schema.Union([
    Schema.Struct({ status: Schema.Literal("current"), capture: DiagramCapture }),
    Schema.Struct({
      status: Schema.Literal("unavailable"),
      reason: Schema.Literals(["no-editor", "busy", "assets-unavailable"]),
    }),
  ]),
});
export type DiagramPreparedContext = typeof DiagramPreparedContext.Type;

export const DIAGRAM_ANNOTATIONS_MAX_PER_PAGE = 30;
export const DIAGRAM_ANNOTATION_COMMENT_MAX_CHARS = 2_000;
export const DIAGRAM_ANNOTATION_MAX_TARGET_SHAPES = DIAGRAM_MAX_SELECTED_MEMBERS;
/** Comments are never truncated on their way to the agent, so a page's set must fit every budget. */
export const DIAGRAM_ANNOTATIONS_MAX_JSON_CHARS = 24_000;
/** One overview plus focused captures for targets the overview shrinks below readable size. */
export const DIAGRAM_ANNOTATION_MAX_IMAGES = 5;

export const DiagramAnnotationId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
).pipe(Schema.brand("DiagramAnnotationId"));
export type DiagramAnnotationId = typeof DiagramAnnotationId.Type;

/** The label drawn on a badge. Allocated per message draft, never derived from an array index. */
export const DiagramAnnotationNumber = PositiveInt.check(Schema.isLessThanOrEqualTo(999));

export const DiagramPoint = Schema.Struct({
  x: Schema.Number.check(Schema.isFinite()),
  y: Schema.Number.check(Schema.isFinite()),
});
export type DiagramPoint = typeof DiagramPoint.Type;

/**
 * Shapes follow their records until capture; a region keeps its page rectangle and may cover
 * empty space. Regions are normalized before they reach this schema.
 */
export const DiagramAnnotationTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("shapes"),
    shapeIds: Schema.Array(DiagramRecordId).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(DIAGRAM_ANNOTATION_MAX_TARGET_SHAPES),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("region"),
    bounds: DiagramBounds.check(Schema.makeFilter((bounds) => bounds.w > 0 && bounds.h > 0)),
  }),
]);
export type DiagramAnnotationTarget = typeof DiagramAnnotationTarget.Type;

/** What the user wrote. `id` governs edits and deletion; `number` labels the badge. */
export const DiagramAnnotation = Schema.Struct({
  id: DiagramAnnotationId,
  number: DiagramAnnotationNumber,
  comment: TrimmedNonEmptyString.check(Schema.isMaxLength(DIAGRAM_ANNOTATION_COMMENT_MAX_CHARS)),
  target: DiagramAnnotationTarget,
});
export type DiagramAnnotation = typeof DiagramAnnotation.Type;

const isDistinct = <A>(items: ReadonlyArray<A>, key: (item: A) => unknown) =>
  new Set(items.map(key)).size === items.length;

/** One page's annotations. */
export const DiagramAnnotations = Schema.Array(DiagramAnnotation).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(DIAGRAM_ANNOTATIONS_MAX_PER_PAGE),
  Schema.makeFilter(
    (items) =>
      isDistinct(items, (item) => item.id) &&
      isDistinct(items, (item) => item.number) &&
      JSON.stringify(items).length <= DIAGRAM_ANNOTATIONS_MAX_JSON_CHARS,
  ),
);
export type DiagramAnnotations = typeof DiagramAnnotations.Type;

/** Where a target was at the captured revision, and the page point its badge is centered on. */
export const DiagramResolvedAnnotation = Schema.Struct({
  id: DiagramAnnotationId,
  bounds: DiagramBounds,
  marker: DiagramPoint,
});
export type DiagramResolvedAnnotation = typeof DiagramResolvedAnnotation.Type;

/** One rendered image. The overview comes first and shows every annotation. */
export const DiagramAnnotationImage = Schema.Struct({
  role: Schema.Literals(["overview", "detail"]),
  annotationIds: Schema.Array(DiagramAnnotationId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(DIAGRAM_ANNOTATIONS_MAX_PER_PAGE),
  ),
  bounds: DiagramBounds,
  width: PositiveInt,
  height: PositiveInt,
});
export type DiagramAnnotationImage = typeof DiagramAnnotationImage.Type;

/** Why resolved geometry and images do not describe exactly these annotations; empty when they do. */
export function diagramAnnotationCaptureIssues(input: {
  readonly annotations: ReadonlyArray<{ readonly id: string }>;
  readonly resolved: ReadonlyArray<{ readonly id: string }>;
  readonly images: ReadonlyArray<{
    readonly role: "overview" | "detail";
    readonly annotationIds: ReadonlyArray<string>;
  }>;
}): string[] {
  const ids = input.annotations.map((annotation) => annotation.id);
  const known = new Set(ids);
  const issues: string[] = [];
  if (input.resolved.map((entry) => entry.id).join("\n") !== ids.join("\n")) {
    issues.push("resolved geometry does not match the annotations");
  }
  const [overview, ...details] = input.images;
  if (!overview || overview.role !== "overview") issues.push("the first image is not the overview");
  else if (!ids.every((id) => overview.annotationIds.includes(id))) {
    issues.push("the overview does not show every annotation");
  }
  if (details.some((image) => image.role !== "detail")) issues.push("only one overview is allowed");
  if (input.images.some((image) => image.annotationIds.some((id) => !known.has(id)))) {
    issues.push("an image names an unknown annotation");
  }
  return issues;
}

/** What the server sends a host with operation `annotate`. */
export const DiagramHostAnnotateInput = Schema.Struct({
  pageId: DiagramRecordId,
  revision: DiagramRevision,
  annotations: DiagramAnnotations,
});
export type DiagramHostAnnotateInput = typeof DiagramHostAnnotateInput.Type;

/** One snapshot: the echoed annotations, their geometry and every image describe `revision`. */
export const DiagramAnnotatedCapture = Schema.Struct({
  diagramId: DiagramId,
  revision: DiagramRevision,
  pageId: DiagramRecordId,
  annotations: DiagramAnnotations,
  resolved: Schema.Array(DiagramResolvedAnnotation),
  images: Schema.Array(
    Schema.Struct({
      ...DiagramAnnotationImage.fields,
      mimeType: Schema.Literal("image/png"),
      base64: Schema.String.check(Schema.isMaxLength(16 * 1024 * 1024)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(DIAGRAM_ANNOTATION_MAX_IMAGES)),
}).check(Schema.makeFilter((capture) => diagramAnnotationCaptureIssues(capture).length === 0));
export type DiagramAnnotatedCapture = typeof DiagramAnnotatedCapture.Type;

export const DiagramPrepareAnnotationsInput = Schema.Struct({
  ...DiagramTarget.fields,
  pageId: DiagramRecordId,
  annotations: DiagramAnnotations,
});
export type DiagramPrepareAnnotationsInput = typeof DiagramPrepareAnnotationsInput.Type;

/** There is no unavailable variant: an annotated send without its numbered image is never valid. */
export const DiagramPreparedAnnotations = Schema.Struct({
  diagram: DiagramMetadata,
  structure: DiagramStructure,
  capture: DiagramAnnotatedCapture,
});
export type DiagramPreparedAnnotations = typeof DiagramPreparedAnnotations.Type;

export const DiagramCapabilities = Schema.Struct({
  protocolVersion: Schema.Literal(DIAGRAM_PROTOCOL_VERSION),
  sdkVersion: Schema.Literal(DIAGRAM_SDK_VERSION),
  /** The server prepares annotated context. Older servers omit it and clients hide annotating. */
  annotations: Schema.optionalKey(Schema.Boolean),
});

/** Bounded detail an agent can act on: path-addressed spec issues or conflicting member keys. */
export const DiagramOperationErrorDetails = Schema.Struct({
  issues: Schema.optional(
    Schema.Array(
      Schema.Struct({
        path: Schema.String.check(Schema.isMaxLength(300)),
        message: Schema.String.check(Schema.isMaxLength(1000)),
      }),
    ).check(Schema.isMaxLength(20)),
  ),
  members: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(300))).check(Schema.isMaxLength(50)),
  ),
});
export type DiagramOperationErrorDetails = typeof DiagramOperationErrorDetails.Type;

export const DiagramOperationErrorCode = Schema.Literals([
  "not-found",
  "project-unavailable",
  "archived",
  "stale",
  "locked",
  "invalid-records",
  "invalid-schema",
  "request-collision",
  "no-editor",
  "busy",
  "unsaved",
  "disconnected",
  "cancelled",
  "storage",
  "scope-unavailable",
  "assets-unavailable",
  "conflict",
  "invalid-spec",
  "too-large",
  "unsupported-mermaid",
]);
export type DiagramOperationErrorCode = typeof DiagramOperationErrorCode.Type;

export class DiagramOperationError extends Schema.TaggedError<DiagramOperationError>()(
  "DiagramOperationError",
  {
    code: DiagramOperationErrorCode,
    diagramId: Schema.optional(DiagramId),
    details: Schema.optional(DiagramOperationErrorDetails),
  },
) {
  override get message(): string {
    const issues = this.details?.issues?.map((issue) => `${issue.path}: ${issue.message}`) ?? [];
    const members = this.details?.members?.length
      ? [`members: ${this.details.members.join(", ")}`]
      : [];
    const detail = [...issues, ...members].join("; ");
    return `Diagram operation failed (${this.code})${detail ? `: ${detail}` : "."}`;
  }
}

export const DiagramSyncConnectInput = Schema.Struct({
  ...DiagramTarget.fields,
  clientId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  sdkVersion: Schema.Literal(DIAGRAM_SDK_VERSION),
});
export type DiagramSyncConnectInput = typeof DiagramSyncConnectInput.Type;
export const DiagramSyncEvent = Schema.Struct({
  connectionId: Schema.String,
  message: Schema.String.check(Schema.isMaxLength(DIAGRAM_MAX_DOCUMENT_BYTES)),
});
export type DiagramSyncEvent = typeof DiagramSyncEvent.Type;
export const DiagramSyncSendInput = Schema.Struct({
  ...DiagramTarget.fields,
  connectionId: Schema.String,
  message: Schema.String.check(Schema.isMaxLength(DIAGRAM_MAX_DOCUMENT_BYTES)),
});
export type DiagramSyncSendInput = typeof DiagramSyncSendInput.Type;

export const DiagramHostOperation = Schema.Literals([
  "prepare-batch",
  "capture",
  "compose",
  "annotate",
]);
export type DiagramHostOperation = typeof DiagramHostOperation.Type;
/** Operations a host supports when it advertises none, as clients before advertisement did. */
export const DIAGRAM_LEGACY_HOST_OPERATIONS: readonly DiagramHostOperation[] = [
  "prepare-batch",
  "capture",
];

export const DiagramHostConnectInput = Schema.Struct({
  clientId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  sdkVersion: Schema.Literal(DIAGRAM_SDK_VERSION),
  focused: Schema.Boolean,
  mountedDiagramIds: Schema.optional(Schema.Array(DiagramId).check(Schema.isMaxLength(100))),
  /** Operations a newer client knows and this server does not are dropped, not rejected. */
  operations: Schema.optional(
    ForwardCompatibleArray(DiagramHostOperation).check(Schema.isMaxLength(20)),
  ),
});
export const DiagramHostRequest = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("ready"),
    requestId: Schema.String,
    connectionId: Schema.String,
  }),
  Schema.Struct({
    requestId: Schema.String,
    connectionId: Schema.String,
    threadId: Schema.optional(ThreadId),
    ...DiagramTarget.fields,
    operation: DiagramHostOperation,
    input: DiagramDocumentData,
  }),
]);
export type DiagramHostRequest = typeof DiagramHostRequest.Type;
export const DiagramHostResponse = Schema.Struct({
  requestId: Schema.String,
  connectionId: Schema.String,
  result: Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), value: DiagramDocumentData }),
    Schema.Struct({ ok: Schema.Literal(false), error: DiagramOperationError }),
  ]),
});
export type DiagramHostResponse = typeof DiagramHostResponse.Type;

export const DiagramListInput = Schema.Struct({
  projectId: ProjectId,
  includeArchived: Schema.optional(Schema.Boolean),
});
export const DiagramCreateInput = Schema.Struct({ projectId: ProjectId, name: DiagramName });
export const DiagramApplyInput = Schema.Struct({
  ...DiagramTarget.fields,
  batch: DiagramBatch,
  namespace: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  clientId: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(ThreadId),
});
export const DiagramReceiptInput = Schema.Struct({
  ...DiagramTarget.fields,
  namespace: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  requestId: DiagramRequestId,
});
export const DiagramPrepareContextInput = Schema.Struct({
  ...DiagramCaptureInput.fields,
  allowImageUnavailable: Schema.optional(Schema.Boolean),
});
export const DiagramImportInput = Schema.Struct({
  projectId: ProjectId,
  name: DiagramName,
  document: DiagramDocumentData,
});
export const DiagramProjectInput = Schema.Struct({ projectId: ProjectId });
export const DiagramCounts = Schema.Struct({ active: NonNegativeInt, archived: NonNegativeInt });
export type DiagramCounts = typeof DiagramCounts.Type;
export const DiagramUploadAssetInput = Schema.Struct({
  ...DiagramTarget.fields,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  base64: Schema.String.check(Schema.isMaxLength(24 * 1024 * 1024)),
});
export const DiagramAssetResult = Schema.Struct({
  assetId: Schema.String,
  src: Schema.String,
  url: Schema.String,
});
export const DiagramReadAssetInput = Schema.Struct({
  ...DiagramTarget.fields,
  assetId: Schema.String,
});
export const DiagramAssetData = Schema.Struct({
  mimeType: Schema.String,
  base64: Schema.String.check(Schema.isMaxLength(24 * 1024 * 1024)),
});
export const DiagramPreviewResult = Schema.Struct({
  diagram: DiagramMetadata,
  capture: Schema.NullOr(DiagramCapture),
  stale: Schema.Boolean,
});
export type DiagramPreviewResult = typeof DiagramPreviewResult.Type;

export const DiagramMetadataChange = Schema.Struct({
  projectId: ProjectId,
  diagramId: Schema.NullOr(DiagramId),
});
export type DiagramMetadataChange = typeof DiagramMetadataChange.Type;

export const DIAGRAM_KITS = [
  "flow",
  "state",
  "uml-class",
  "er",
  "c4",
  "architecture",
  "wireframe",
  "sequence",
  "user-flow",
] as const;
export const DiagramKit = Schema.Literals(DIAGRAM_KITS);
export type DiagramKit = typeof DiagramKit.Type;

/** Node keys cannot contain "." because edges address nested elements as `node.element`. */
export const DiagramMemberKey = TrimmedNonEmptyString.check(
  Schema.isMaxLength(120),
  Schema.isPattern(/^[^.\s]+$/),
);
const DiagramEdgeEndpoint = TrimmedNonEmptyString.check(Schema.isMaxLength(241));
/** Derived edge keys are `from→to:kind`, so an edge from `node.element` has a "." in its key. */
const DiagramEdgeKey = TrimmedNonEmptyString.check(Schema.isMaxLength(600));

/** A source location an agent attaches to a node and reads back later. */
/** `kind` defaults to the kit's most common kind and `label` to `key`; `body` is validated per kit. */
export const DiagramSpecNode = Schema.Struct({
  key: DiagramMemberKey,
  kind: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  label: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))),
  parent: Schema.optional(DiagramMemberKey),
  body: Schema.optional(boundedJson(64 * 1024)),
  ref: Schema.optional(DiagramSpecRef),
});
export type DiagramSpecNode = typeof DiagramSpecNode.Type;

export const DiagramSpecEdgeObject = Schema.Struct({
  key: Schema.optional(DiagramEdgeKey),
  from: DiagramEdgeEndpoint,
  to: DiagramEdgeEndpoint,
  kind: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  label: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  /** Validated per kit edge kind, such as multiplicities on a UML association. */
  body: Schema.optional(boundedJson(4 * 1024)),
});
const DiagramEdgeLabel = Schema.String.check(Schema.isMaxLength(500));
const DiagramEdgeTuple = Schema.Union([
  Schema.Tuple([DiagramEdgeEndpoint, DiagramEdgeEndpoint]),
  Schema.Tuple([DiagramEdgeEndpoint, DiagramEdgeEndpoint, DiagramEdgeLabel]),
]);
/**
 * Edges accept `[from, to, label?]` with the kit's default edge kind. The tuple is published as a
 * plain array of strings, because MCP clients that predate JSON Schema 2020-12 reject
 * `prefixItems`; it still decodes, and trims its endpoints, as the tuple.
 */
export const DiagramSpecEdge = Schema.Union([
  DiagramSpecEdgeObject,
  Schema.Array(DiagramEdgeLabel)
    .check(Schema.isMinLength(2), Schema.isMaxLength(3))
    .pipe(
      Schema.decodeTo(
        DiagramEdgeTuple,
        SchemaTransformation.passthroughSupertype<
          typeof DiagramEdgeTuple.Encoded,
          ReadonlyArray<string>
        >(),
      ),
    ),
]);
export type DiagramSpecEdge = typeof DiagramSpecEdge.Type;

export const DiagramLayoutDirection = Schema.Literals(["right", "down", "left", "up"]);
export type DiagramLayoutDirection = typeof DiagramLayoutDirection.Type;

export const DiagramSpec = Schema.Struct({
  kit: DiagramKit,
  key: DiagramCompositionKey,
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  pageId: Schema.optional(DiagramRecordId),
  position: Schema.optional(
    Schema.Struct({
      x: Schema.Number.check(Schema.isFinite()),
      y: Schema.Number.check(Schema.isFinite()),
    }),
  ),
  direction: Schema.optional(DiagramLayoutDirection),
  nodes: Schema.Array(DiagramSpecNode).check(Schema.isMaxLength(DIAGRAM_MAX_BATCH_RECORDS)),
  edges: Schema.optional(
    Schema.Array(DiagramSpecEdge).check(Schema.isMaxLength(DIAGRAM_MAX_BATCH_RECORDS)),
  ),
});
export type DiagramSpec = typeof DiagramSpec.Type;

/** Mermaid text the editor host converts to a spec; its node IDs become member keys. */
export const DiagramMermaidSource = Schema.Struct({
  key: DiagramCompositionKey,
  text: Schema.String.check(Schema.isMaxLength(64 * 1024)),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
});
export type DiagramMermaidSource = typeof DiagramMermaidSource.Type;

export const DiagramComposeOperation = Schema.Literals(["compose", "remove", "detach"]);
export type DiagramComposeOperation = typeof DiagramComposeOperation.Type;

/**
 * What the editor host needs; the server adds the target and request ID. `compose` (the default)
 * takes exactly one of `spec` or `mermaid`; `remove` and `detach` take only the composition `key`.
 * One flat struct keeps the MCP tool's input a single JSON object; the pipeline's validation
 * enforces the combinations.
 */
export const DiagramComposeRequest = Schema.Struct({
  operation: Schema.optional(DiagramComposeOperation),
  key: Schema.optional(DiagramCompositionKey),
  spec: Schema.optional(DiagramSpec),
  mermaid: Schema.optional(DiagramMermaidSource),
  /** `replace` (default): the spec is the whole composition. `patch`: only the listed members. */
  mode: Schema.optional(Schema.Literals(["replace", "patch"])),
  /** Patch only: node and edge keys to delete, with the member edges of any node among them. */
  removeKeys: Schema.optional(
    Schema.Array(DiagramEdgeKey).check(Schema.isMaxLength(DIAGRAM_MAX_BATCH_RECORDS)),
  ),
  /** Repositions every member; otherwise existing members stay where they are. */
  relayout: Schema.optional(Schema.Boolean),
});
export type DiagramComposeRequest = typeof DiagramComposeRequest.Type;

export const DiagramComposeInput = Schema.Struct({
  ...DiagramTarget.fields,
  requestId: Schema.optional(DiagramRequestId),
  ...DiagramComposeRequest.fields,
  /** Return the member key to shape ID map. */
  includeMembers: Schema.optional(Schema.Boolean),
  /** Return a PNG of the composition frame at the committed revision. */
  capture: Schema.optional(Schema.Boolean),
});
export type DiagramComposeInput = typeof DiagramComposeInput.Type;

export const DiagramComposeCounts = Schema.Struct({
  created: NonNegativeInt,
  updated: NonNegativeInt,
  kept: NonNegativeInt,
  removed: NonNegativeInt,
});
export type DiagramComposeCounts = typeof DiagramComposeCounts.Type;

/** Node member pairs whose boxes overlap after the compose, in spec order. */
export const DiagramComposeOverlaps = Schema.Array(
  Schema.Tuple([DiagramMemberKey, DiagramMemberKey]),
).check(Schema.isMaxLength(50));

/**
 * A no-op compose commits nothing, so it has no request ID. Counts describe what this call wrote:
 * a retry of a committed request ID is answered from its receipt, so its counts are all zero.
 */
export const DiagramComposeResult = Schema.Struct({
  requestId: Schema.NullOr(DiagramRequestId),
  revision: DiagramRevision,
  compositionKey: DiagramCompositionKey,
  counts: DiagramComposeCounts,
  overlaps: DiagramComposeOverlaps,
  /** Member key to main shape ID, only with `includeMembers`. */
  members: Schema.optional(Schema.Record(Schema.String, DiagramRecordId)),
  capture: Schema.optional(DiagramCapture),
  /** Why the requested capture is missing; the compose itself succeeded. */
  captureError: Schema.optional(DiagramOperationErrorCode),
});
export type DiagramComposeResult = typeof DiagramComposeResult.Type;

/** The host's compose answer; `changes` is null when the canvas already matches. */
export const DiagramHostComposeResult = Schema.Struct({
  changes: Schema.NullOr(
    Schema.Struct({
      expected: DiagramBatch.fields.expected,
      puts: DiagramBatch.fields.puts,
      deletes: DiagramBatch.fields.deletes,
    }),
  ),
  counts: DiagramComposeCounts,
  overlaps: DiagramComposeOverlaps,
});
export type DiagramHostComposeResult = typeof DiagramHostComposeResult.Type;

export const DiagramKitReference = Schema.Struct({
  kit: DiagramKit,
  defaultKind: Schema.String,
  nodeKinds: Schema.Array(Schema.Struct({ kind: Schema.String, description: Schema.String })),
  /** Null for kits without edges, such as wireframes. */
  defaultEdgeKind: Schema.NullOr(Schema.String),
  edgeKinds: Schema.Array(Schema.Struct({ kind: Schema.String, description: Schema.String })),
  guidance: Schema.String,
  example: DiagramSpec,
});
export type DiagramKitReference = typeof DiagramKitReference.Type;

/**
 * A member as compose last wrote it, in full spec form. Members inside a node, such as wireframe
 * elements, read back keyed `node.element`. `text` is its current text once edited.
 */
export const DiagramCompositionMember = Schema.Struct({
  spec: Schema.Union([
    DiagramSpecEdgeObject,
    Schema.Struct({ ...DiagramSpecNode.fields, key: DiagramEdgeEndpoint }),
  ]),
  edited: Schema.Boolean,
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))),
});
export type DiagramCompositionMember = typeof DiagramCompositionMember.Type;

export const DiagramCompositionDetail = Schema.Struct({
  key: DiagramCompositionKey,
  kit: DiagramKit,
  title: Schema.String,
  direction: DiagramLayoutDirection,
  members: Schema.Array(DiagramCompositionMember).check(
    Schema.isMaxLength(DIAGRAM_MAX_READ_RECORDS),
  ),
});
export type DiagramCompositionDetail = typeof DiagramCompositionDetail.Type;

/** One page of members across the requested compositions, in summary then member order. */
export const DiagramCompositionsPage = Schema.Struct({
  items: Schema.Array(DiagramCompositionDetail).check(Schema.isMaxLength(100)),
  nextOffset: Schema.NullOr(NonNegativeInt),
});
export type DiagramCompositionsPage = typeof DiagramCompositionsPage.Type;

export const DiagramReadInput = Schema.Struct({
  ...DiagramTarget.fields,
  recordIds: Schema.optional(
    Schema.Array(DiagramRecordId).check(Schema.isMaxLength(DIAGRAM_MAX_READ_RECORDS)),
  ),
  pageId: Schema.optional(DiagramRecordId),
  includeRecords: Schema.optional(Schema.Boolean),
  offset: Schema.optional(NonNegativeInt),
  limit: Schema.optional(
    NonNegativeInt.check(Schema.isBetween({ minimum: 1, maximum: DIAGRAM_MAX_READ_RECORDS })),
  ),
  /** Composition detail is returned only for this key, or for every composition with `includeCompositions`. */
  compositionKey: Schema.optional(DiagramCompositionKey),
  includeCompositions: Schema.optional(Schema.Boolean),
  /** Pages through composition members, independently of record pagination. */
  compositionOffset: Schema.optional(NonNegativeInt),
  compositionLimit: Schema.optional(
    NonNegativeInt.check(Schema.isBetween({ minimum: 1, maximum: DIAGRAM_MAX_READ_RECORDS })),
  ),
});
export type DiagramReadInput = typeof DiagramReadInput.Type;
export const DiagramReadResult = Schema.Struct({
  diagram: DiagramMetadata,
  structure: DiagramStructure,
  records: Schema.Array(DiagramRecordData).check(Schema.isMaxLength(DIAGRAM_MAX_READ_RECORDS)),
  schema: DiagramRecordData,
  nextOffset: Schema.NullOr(NonNegativeInt),
  compositions: Schema.optional(DiagramCompositionsPage),
});
export type DiagramReadResult = typeof DiagramReadResult.Type;
