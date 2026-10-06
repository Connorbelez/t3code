import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const DIAGRAM_PROTOCOL_VERSION = 1;
export const DIAGRAM_SDK_VERSION = "5.5.2";
export const DIAGRAM_MAX_BATCH_RECORDS = 500;
export const DIAGRAM_MAX_READ_RECORDS = 200;
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

export const DiagramScope = Schema.Union([
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

export const DiagramStructure = Schema.Struct({
  revision: DiagramRevision,
  pages: Schema.Array(DiagramPageSummary).check(Schema.isMaxLength(100)),
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
});
export type DiagramReadInput = typeof DiagramReadInput.Type;
export const DiagramReadResult = Schema.Struct({
  diagram: DiagramMetadata,
  structure: DiagramStructure,
  records: Schema.Array(DiagramRecordData).check(Schema.isMaxLength(DIAGRAM_MAX_READ_RECORDS)),
  schema: DiagramRecordData,
  nextOffset: Schema.NullOr(NonNegativeInt),
});
export type DiagramReadResult = typeof DiagramReadResult.Type;

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

export const DiagramCapabilities = Schema.Struct({
  protocolVersion: Schema.Literal(DIAGRAM_PROTOCOL_VERSION),
  sdkVersion: Schema.Literal(DIAGRAM_SDK_VERSION),
});

export class DiagramOperationError extends Schema.TaggedError<DiagramOperationError>()(
  "DiagramOperationError",
  {
    code: Schema.Literals([
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
    ]),
    diagramId: Schema.optional(DiagramId),
  },
) {
  override get message(): string {
    return `Diagram operation failed (${this.code}).`;
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

export const DiagramHostConnectInput = Schema.Struct({
  clientId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  sdkVersion: Schema.Literal(DIAGRAM_SDK_VERSION),
  focused: Schema.Boolean,
  mountedDiagramIds: Schema.optional(Schema.Array(DiagramId).check(Schema.isMaxLength(100))),
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
    operation: Schema.Literals(["prepare-batch", "capture"]),
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
