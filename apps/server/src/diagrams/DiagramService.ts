import * as NodeCrypto from "node:crypto";
import { createTLSchema, type TLRecord } from "@tldraw/tlschema";
import {
  DiagramId,
  DiagramName,
  DiagramRecordId,
  DiagramMetadata,
  DiagramOperationError,
  DiagramCapture,
  DiagramMutationReceipt,
  DiagramHostResponse,
  DiagramBatch,
  DiagramHostComposeResult,
  DIAGRAM_LEGACY_HOST_OPERATIONS,
  DIAGRAM_MAX_READ_RECORDS,
  DIAGRAM_MAX_DOCUMENT_BYTES,
  type DiagramTarget,
  type DiagramReadInput,
  type DiagramReadResult,
  type DiagramLifecycleInput,
  type DiagramCaptureInput,
  type DiagramPreparedContext,
  type DiagramSyncConnectInput,
  type DiagramSyncEvent,
  type DiagramSyncSendInput,
  type DiagramHostRequest,
  type DiagramHostConnectInput,
  type DiagramHostOperation,
  type DiagramComposeInput,
  type DiagramComposeResult,
  type ProjectId,
  type ThreadId,
  type DiagramCounts,
  type DiagramPreviewResult,
  type DiagramMetadataChange,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Exit from "effect/Exit";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { readCompositions, validateComposeRequest } from "@t3tools/diagram-compose/model";
import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { diagramStructure } from "./diagramStructure.ts";
import {
  DiagramDatabase,
  DiagramRoomError,
  type DiagramRoom,
  type DiagramHostFence,
} from "./DiagramRoom.ts";

type HostInput = typeof DiagramHostConnectInput.Type;
type ApplyInput = DiagramTarget & {
  batch: DiagramBatch;
  namespace: string;
  clientId?: string;
  threadId?: ThreadId;
};
type AssetInput = DiagramTarget & { name: string; mimeType: string; base64: string };
type AssetResult = { assetId: string; src: string; url: string };
type ExportResult = {
  tldrawFileFormatVersion: number;
  schema: unknown;
  records: readonly TLRecord[];
};

export const DiagramProjectCleanup = Context.Reference<{
  removeProject: (projectId: ProjectId) => Effect.Effect<void, DiagramOperationError>;
}>("t3/diagrams/DiagramProjectCleanup", {
  defaultValue: () => ({ removeProject: () => Effect.void }),
});

export class DiagramService extends Context.Service<
  DiagramService,
  {
    readonly list: (input: {
      projectId: ProjectId;
      includeArchived?: boolean;
    }) => Effect.Effect<readonly DiagramMetadata[], DiagramOperationError>;
    readonly changes: (input: {
      projectId: ProjectId;
    }) => Effect.Effect<Stream.Stream<DiagramMetadataChange>, DiagramOperationError>;
    readonly create: (input: {
      projectId: ProjectId;
      name: string;
    }) => Effect.Effect<DiagramMetadata, DiagramOperationError>;
    readonly read: (
      input: DiagramReadInput,
    ) => Effect.Effect<DiagramReadResult, DiagramOperationError>;
    readonly lifecycle: (
      input: DiagramLifecycleInput,
    ) => Effect.Effect<DiagramMetadata | null, DiagramOperationError>;
    readonly applyBatch: (
      input: ApplyInput,
    ) => Effect.Effect<DiagramMutationReceipt, DiagramOperationError>;
    readonly compose: (
      input: DiagramComposeInput & { namespace: string; threadId?: ThreadId },
    ) => Effect.Effect<DiagramComposeResult, DiagramOperationError>;
    readonly receipt: (
      input: DiagramTarget & { namespace: string; requestId: string },
    ) => Effect.Effect<DiagramMutationReceipt | null, DiagramOperationError>;
    readonly capture: (
      input: DiagramCaptureInput,
    ) => Effect.Effect<DiagramCapture, DiagramOperationError>;
    readonly prepareContext: (
      input: DiagramCaptureInput & { allowImageUnavailable?: boolean },
    ) => Effect.Effect<DiagramPreparedContext, DiagramOperationError>;
    readonly cachedPreview: (
      input: DiagramCaptureInput,
    ) => Effect.Effect<DiagramCapture | null, DiagramOperationError>;
    readonly importDocument: (input: {
      projectId: ProjectId;
      name: string;
      document: unknown;
    }) => Effect.Effect<DiagramMetadata, DiagramOperationError>;
    readonly exportDocument: (
      input: DiagramTarget,
    ) => Effect.Effect<ExportResult, DiagramOperationError>;
    readonly removeProject: (projectId: ProjectId) => Effect.Effect<void, DiagramOperationError>;
    readonly count: (projectId: ProjectId) => Effect.Effect<DiagramCounts, DiagramOperationError>;
    readonly preview: (
      input: DiagramTarget,
    ) => Effect.Effect<DiagramPreviewResult, DiagramOperationError>;
    readonly readAsset: (
      input: DiagramTarget & { assetId: string },
    ) => Effect.Effect<{ base64: string; mimeType: string }, DiagramOperationError>;
    readonly syncConnect: (
      input: DiagramSyncConnectInput,
    ) => Effect.Effect<Stream.Stream<DiagramSyncEvent>, DiagramOperationError>;
    readonly syncSend: (input: DiagramSyncSendInput) => Effect.Effect<void, DiagramOperationError>;
    readonly syncDisconnect: (input: { connectionId: string }) => Effect.Effect<void>;
    readonly hostConnect: (
      input: HostInput,
    ) => Effect.Effect<Stream.Stream<DiagramHostRequest>, DiagramOperationError>;
    readonly hostRespond: (
      input: DiagramHostResponse,
    ) => Effect.Effect<void, DiagramOperationError>;
    readonly assetUpload: (input: AssetInput) => Effect.Effect<AssetResult, DiagramOperationError>;
    readonly assetUrl: (
      input: DiagramTarget & { assetId: string },
    ) => Effect.Effect<string, DiagramOperationError>;
    readonly assetRead: (input: {
      assetId: string;
      token: string;
    }) => Effect.Effect<{ bytes: Uint8Array; mimeType: string }, DiagramOperationError>;
  }
>()("t3/diagrams/DiagramService") {}

const schema = createTLSchema();
const decodeMetadata = Schema.decodeUnknownSync(DiagramMetadata);
const recordEnvelope = Schema.Struct({ typeName: Schema.String });
const prepareResult = Schema.Struct({
  connectionId: Schema.String,
  fingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
const adoptionMessage = Schema.Struct({
  type: Schema.Literal("diagram-adoption"),
  generation: Schema.String,
  fence: Schema.String,
  push: Schema.Struct({
    type: Schema.Literal("push"),
    clientClock: Schema.Number,
    diff: Schema.optional(Schema.Unknown),
  }),
});
const serializedSchema = Schema.Union([
  Schema.Struct({
    schemaVersion: Schema.Literal(2),
    sequences: Schema.Record(Schema.String, Schema.Number),
  }),
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    storeVersion: Schema.Number,
    recordVersions: Schema.Record(
      Schema.String,
      Schema.Union([
        Schema.Struct({
          version: Schema.Number,
          subTypeVersions: Schema.Record(Schema.String, Schema.Number),
          subTypeKey: Schema.String,
        }),
        Schema.Struct({ version: Schema.Number }),
      ]),
    ),
  }),
]);
const importEnvelope = Schema.Struct({
  tldrawFileFormatVersion: Schema.Literal(1),
  schema: serializedSchema,
  records: Schema.Array(Schema.Unknown),
  assets: Schema.optional(
    Schema.Array(
      Schema.Struct({ id: Schema.String, mimeType: Schema.String, base64: Schema.String }),
    ),
  ),
});
const assetClaim = Schema.Struct({
  assetId: Schema.String,
  projectId: Schema.String,
  diagramId: Schema.String,
  expires: Schema.Number,
});
const decodeHostComposeResult = Schema.decodeUnknownSync(DiagramHostComposeResult);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function record(value: unknown, embeddedAsset = false): TLRecord {
  try {
    const { typeName } = Schema.decodeUnknownSync(recordEnvelope)(value);
    const type = Object.values(schema.types).find((item) => item.typeName === typeName);
    if (!type || type.scope !== "document")
      throw new DiagramOperationError({ code: "invalid-records" });
    const result = type.validate(value);
    Schema.decodeUnknownSync(DiagramRecordId)(result.id);
    if (
      !embeddedAsset &&
      result.typeName === "asset" &&
      "src" in result.props &&
      result.props.src !== null &&
      !result.props.src.startsWith("asset:t3-diagram/")
    ) {
      throw new DiagramOperationError({ code: "invalid-records" });
    }
    return result;
  } catch (cause) {
    if (Schema.is(DiagramOperationError)(cause)) throw cause;
    throw new DiagramOperationError({ code: "invalid-records" });
  }
}

function importData(value: unknown) {
  try {
    return Schema.decodeUnknownSync(importEnvelope)(value);
  } catch {
    throw new DiagramOperationError({ code: "invalid-schema" });
  }
}

function diagramName(value: unknown) {
  try {
    return Schema.decodeUnknownSync(DiagramName)(value);
  } catch {
    throw new DiagramOperationError({ code: "invalid-records" });
  }
}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const clock = yield* Clock.Clock;
  const now = () => clock.currentTimeMillisUnsafe();
  const nowIso = () => DateTime.formatIso(DateTime.makeUnsafe(now()));
  const config = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* identity.getEnvironmentId;
  const signingKey = yield* secrets
    .getOrCreateRandom("diagram-asset-signing-key", 32)
    .pipe(Effect.mapError(() => new DiagramOperationError({ code: "storage" })));
  yield* fs
    .makeDirectory(config.stateDir, { recursive: true })
    .pipe(Effect.mapError(() => new DiagramOperationError({ code: "storage" })));
  const database = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        new DiagramDatabase(
          path.join(config.stateDir, "diagrams.sqlite"),
          (value, projectId, owner) => {
            record(value);
            if (value.typeName !== "asset" || !("src" in value.props) || value.props.src === null)
              return;
            const prefix = "asset:t3-diagram/";
            if (!value.props.src.startsWith(prefix))
              throw new DiagramOperationError({ code: "invalid-records" });
            const assetId = value.props.src.slice(prefix.length);
            if (
              !owner
                .prepare("SELECT 1 FROM diagram_assets WHERE id = ? AND project_id = ?")
                .get(assetId, projectId)
            )
              throw new DiagramOperationError({ code: "assets-unavailable" });
          },
        ),
      catch: () => new DiagramOperationError({ code: "storage" }),
    }),
    (value) => Effect.sync(() => value.close()),
  );
  const sql = database.database;
  yield* Effect.try({
    try: () =>
      sql.exec(
        `CREATE TABLE IF NOT EXISTS diagram_assets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, mime_type TEXT NOT NULL, bytes BLOB NOT NULL, created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS diagram_previews (diagram_id TEXT NOT NULL, scope TEXT NOT NULL, capture TEXT NOT NULL, PRIMARY KEY (diagram_id, scope));`,
      ),
    catch: () => new DiagramOperationError({ code: "storage" }),
  });
  const sync = new Map<
    string,
    {
      clientId: string;
      target: DiagramTarget;
      room: DiagramRoom;
      queue: Queue.Queue<DiagramSyncEvent, Cause.Done>;
      fence?: DiagramHostFence;
    }
  >();
  const hosts = new Map<
    string,
    {
      clientId: string;
      connectionId: string;
      focused: boolean;
      mountedDiagramIds: readonly DiagramId[];
      operations: readonly DiagramHostOperation[];
      queue: Queue.Queue<DiagramHostRequest, Cause.Done>;
    }
  >();
  const pending = new Map<
    string,
    {
      owner: string;
      diagramId: DiagramId;
      result: Deferred.Deferred<unknown, DiagramOperationError>;
    }
  >();
  const subscriptions = new Map<Queue.Queue<DiagramMetadataChange, Cause.Done>, ProjectId>();
  const publish = (projectId: ProjectId, diagramId: DiagramId | null) => {
    for (const [queue, owner] of subscriptions)
      if (owner === projectId) Queue.offerUnsafe(queue, { projectId, diagramId });
  };

  const attempt = <A>(operation: () => A) =>
    Effect.try({
      try: operation,
      catch: (cause) => {
        if (Schema.is(DiagramOperationError)(cause)) return cause;
        if (Schema.is(DiagramRoomError)(cause))
          return new DiagramOperationError({
            code:
              cause.reason === "stale"
                ? "stale"
                : cause.reason === "locked"
                  ? "locked"
                  : cause.reason === "inactive"
                    ? "archived"
                    : cause.reason === "request-mismatch"
                      ? "request-collision"
                      : cause.reason === "host-unavailable"
                        ? "disconnected"
                        : "invalid-records",
          });
        return new DiagramOperationError({ code: "storage" });
      },
    });
  const projectLive = (projectId: ProjectId) =>
    projects.get(projectId).pipe(
      Effect.mapError(() => new DiagramOperationError({ code: "project-unavailable" })),
      Effect.flatMap((value) =>
        Option.isSome(value)
          ? Effect.void
          : Effect.fail(new DiagramOperationError({ code: "project-unavailable" })),
      ),
    );
  const metadata = (target: DiagramTarget) => {
    const row = database.get(target.diagramId);
    if (!row || row.state === "deleted" || row.projectId !== target.projectId)
      throw new DiagramOperationError({ code: "not-found", diagramId: target.diagramId });
    return decodeMetadata(row);
  };
  const target = (input: DiagramTarget) =>
    projectLive(input.projectId).pipe(
      Effect.andThen(
        attempt(() => ({ diagram: metadata(input), room: database.open(input.diagramId) })),
      ),
    );
  const targetMetadata = (input: DiagramTarget) =>
    projectLive(input.projectId).pipe(Effect.andThen(attempt(() => metadata(input))));
  const count = (projectId: ProjectId) =>
    attempt(() => {
      const values = database.list(projectId, true);
      return {
        active: values.filter((item) => item.state === "active").length,
        archived: values.filter((item) => item.state === "archived").length,
      };
    });
  const list = (input: { projectId: ProjectId; includeArchived?: boolean }) =>
    projectLive(input.projectId).pipe(
      Effect.andThen(
        attempt(() =>
          database
            .list(input.projectId, input.includeArchived)
            .map((value) => decodeMetadata(value)),
        ),
      ),
    );
  const changes = Effect.fn("DiagramService.changes")(function* (input: { projectId: ProjectId }) {
    yield* projectLive(input.projectId);
    const queue = yield* Queue.unbounded<DiagramMetadataChange, Cause.Done>();
    subscriptions.set(queue, input.projectId);
    yield* Queue.offer(queue, { projectId: input.projectId, diagramId: null });
    return Stream.fromQueue(queue).pipe(
      Stream.ensuring(
        Effect.gen(function* () {
          subscriptions.delete(queue);
          yield* Queue.end(queue);
        }),
      ),
    );
  });
  const create = (input: { projectId: ProjectId; name: string }) =>
    projectLive(input.projectId).pipe(
      Effect.andThen(
        attempt(() => {
          const name = diagramName(input.name);
          const id = Schema.decodeUnknownSync(DiagramId)(NodeCrypto.randomUUID());
          try {
            database.create(id, input.projectId, name);
            const diagram = metadata({ projectId: input.projectId, diagramId: id });
            publish(input.projectId, id);
            return diagram;
          } finally {
            database.releaseIdle(id);
          }
        }),
      ),
    );
  const read = Effect.fn("DiagramService.read")(function* (input: DiagramReadInput) {
    yield* targetMetadata(input);
    return yield* attempt(() => {
      const diagram = metadata(input);
      const records = database.read(input.diagramId);
      const selected = records.filter(
        (item) => !input.recordIds || input.recordIds.includes(item.id),
      );
      const offset = input.offset ?? 0;
      const limit = input.limit ?? DIAGRAM_MAX_READ_RECORDS;
      return {
        diagram,
        structure: diagramStructure(records, diagram.revision, input),
        records:
          input.includeRecords || input.recordIds ? selected.slice(offset, offset + limit) : [],
        schema: schema.serialize(),
        nextOffset:
          (input.includeRecords || input.recordIds) && offset + limit < selected.length
            ? offset + limit
            : null,
      } satisfies DiagramReadResult;
    });
  });

  const assetIds = (records: readonly TLRecord[]) =>
    records.flatMap((item) =>
      item.typeName === "asset" &&
      "src" in item.props &&
      item.props.src?.startsWith("asset:t3-diagram/")
        ? [item.props.src.slice("asset:t3-diagram/".length)]
        : [],
    );
  const cleanup = (removed: ReadonlySet<string> = new Set()) => {
    const retained = sql.prepare("SELECT id FROM diagrams WHERE state != 'deleted'").all();
    const referenced = new Set(
      retained.flatMap((item) => assetIds(database.read(String(item.id)))),
    );
    for (const item of sql.prepare("SELECT id, created_at FROM diagram_assets").all())
      if (
        !referenced.has(String(item.id)) &&
        (removed.has(String(item.id)) || Date.parse(String(item.created_at)) < now() - 86_400_000)
      )
        sql.prepare("DELETE FROM diagram_assets WHERE id = ?").run(String(item.id));
  };
  const exportDocument = Effect.fn("DiagramService.exportDocument")(function* (
    input: DiagramTarget,
  ) {
    yield* targetMetadata(input);
    return yield* attempt(() => {
      const records = database.read(input.diagramId);
      const assets = [...new Set(assetIds(records))].map((id) => {
        const row = sql
          .prepare("SELECT bytes, mime_type FROM diagram_assets WHERE id = ? AND project_id = ?")
          .get(id, input.projectId);
        if (!(row?.bytes instanceof Uint8Array))
          throw new DiagramOperationError({ code: "assets-unavailable" });
        return {
          id,
          mimeType: String(row.mime_type),
          base64: Buffer.from(row.bytes).toString("base64"),
        };
      });
      const embedded = records.map((item) => {
        if (
          item.typeName !== "asset" ||
          !("src" in item.props) ||
          !item.props.src?.startsWith("asset:t3-diagram/")
        )
          return item;
        const asset = assets.find(
          (candidate) => candidate.id === item.props.src?.slice("asset:t3-diagram/".length),
        );
        if (!asset) throw new DiagramOperationError({ code: "assets-unavailable" });
        return record(
          {
            ...item,
            props: { ...item.props, src: `data:${asset.mimeType};base64,${asset.base64}` },
          },
          true,
        );
      });
      return { tldrawFileFormatVersion: 1, schema: schema.serialize(), records: embedded };
    });
  });
  const importDocument = Effect.fn("DiagramService.importDocument")(function* (input: {
    projectId: ProjectId;
    name: string;
    document: unknown;
  }) {
    yield* projectLive(input.projectId);
    return yield* attempt(() => {
      const name = diagramName(input.name);
      if (Buffer.byteLength(encodeJson(input.document)) > DIAGRAM_MAX_DOCUMENT_BYTES)
        throw new DiagramOperationError({ code: "invalid-records" });
      const imported = importData(input.document);
      const envelope = Schema.Struct({ id: Schema.String, typeName: Schema.String });
      const raw = Object.fromEntries(
        imported.records.map((value) => {
          const decoded = Schema.decodeUnknownSync(envelope)(value);
          return [decoded.id, value];
        }),
      );
      // SDK migration accepts historical records before current record validation.
      const migrated = schema.migrateStoreSnapshot({
        schema: imported.schema,
        store: raw as Parameters<typeof schema.migrateStoreSnapshot>[0]["store"],
      });
      if (migrated.type === "error") throw new DiagramOperationError({ code: "invalid-schema" });
      const migratedRecords = Object.values(migrated.value).map((value) => record(value, true));
      if (new Set(migratedRecords.map((value) => value.id)).size !== imported.records.length)
        throw new DiagramOperationError({ code: "invalid-records" });
      const recordsById = new Map(migratedRecords.map((value) => [value.id as string, value]));
      const pages = migratedRecords.filter((value) => value.typeName === "page");
      if (pages.length === 0 || pages.length > 100)
        throw new DiagramOperationError({ code: "invalid-records" });
      for (const value of migratedRecords) {
        if (
          value.typeName === "binding" &&
          (recordsById.get(value.fromId)?.typeName !== "shape" ||
            recordsById.get(value.toId)?.typeName !== "shape")
        )
          throw new DiagramOperationError({ code: "invalid-records" });
        if (value.typeName === "shape") {
          const seen = new Set<string>([value.id]);
          let parentId: string = value.parentId;
          while (parentId) {
            const parent = recordsById.get(parentId);
            if (
              !parent ||
              seen.has(parentId) ||
              (parent.typeName !== "shape" && parent.typeName !== "page")
            )
              throw new DiagramOperationError({ code: "invalid-records" });
            if (parent.typeName === "page") break;
            seen.add(parentId);
            parentId = parent.parentId;
          }
          if (
            (value.type === "image" || value.type === "video") &&
            value.props.assetId &&
            recordsById.get(value.props.assetId)?.typeName !== "asset"
          )
            throw new DiagramOperationError({ code: "invalid-records" });
        }
      }
      const id = Schema.decodeUnknownSync(DiagramId)(NodeCrypto.randomUUID());
      const room = database.create(id, input.projectId, name);
      try {
        room.storage.transaction((txn) => {
          for (const item of imported.assets ?? []) {
            const bytes = Buffer.from(item.base64, "base64");
            const existing = sql
              .prepare("SELECT project_id, bytes FROM diagram_assets WHERE id = ?")
              .get(item.id);
            if (
              existing &&
              (existing.project_id !== input.projectId ||
                !(existing.bytes instanceof Uint8Array) ||
                !Buffer.from(existing.bytes).equals(bytes))
            )
              throw new DiagramOperationError({ code: "invalid-records" });
            sql
              .prepare("INSERT OR IGNORE INTO diagram_assets VALUES (?, ?, ?, ?, ?)")
              .run(item.id, input.projectId, item.mimeType, bytes, nowIso());
          }
          const records = migratedRecords.map((item) => {
            if (item.typeName !== "asset" || !("src" in item.props) || !item.props.src) return item;
            const embedded =
              /^data:(image\/(?:png|jpeg|webp|gif|svg\+xml));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(
                item.props.src,
              );
            if (!embedded) return record(item);
            const assetId = NodeCrypto.randomUUID();
            const bytes = Buffer.from(embedded[2]!, "base64");
            if (bytes.byteLength > DIAGRAM_MAX_DOCUMENT_BYTES)
              throw new DiagramOperationError({ code: "invalid-records" });
            sql
              .prepare("INSERT INTO diagram_assets VALUES (?, ?, ?, ?, ?)")
              .run(assetId, input.projectId, embedded[1]!, bytes, nowIso());
            return record({
              ...item,
              props: { ...item.props, src: `asset:t3-diagram/${assetId}` },
            });
          });
          for (const assetId of assetIds(records))
            if (
              !sql
                .prepare("SELECT 1 FROM diagram_assets WHERE id = ? AND project_id = ?")
                .get(assetId, input.projectId)
            )
              throw new DiagramOperationError({ code: "assets-unavailable" });
          const ids = new Set<string>(records.map((item) => item.id));
          for (const existing of Array.from(txn.keys()))
            if (!ids.has(existing)) txn.delete(existing);
          for (const item of records) txn.set(item.id, item);
        });
      } catch (cause) {
        database.setState(id, "deleted");
        throw cause;
      } finally {
        database.releaseIdle(id);
      }
      const diagram = metadata({ diagramId: id, projectId: input.projectId });
      publish(input.projectId, id);
      return diagram;
    });
  });
  const lifecycle = Effect.fn("DiagramService.lifecycle")(function* (input: DiagramLifecycleInput) {
    const previous = yield* targetMetadata(input);
    if (previous.archivedAt && input.operation === "rename")
      return yield* new DiagramOperationError({ code: "archived" });
    if (previous.archivedAt && input.operation === "archive") return previous;
    const removedAssetIds = new Set(assetIds(database.read(input.diagramId)));
    if (input.operation === "duplicate") {
      const exported = yield* exportDocument(input);
      const original = yield* attempt(() => metadata(input));
      return yield* importDocument({
        projectId: input.projectId,
        name: input.name ?? `${original.name.slice(0, 195)} copy`,
        document: exported,
      });
    }
    return yield* attempt(() => {
      if (input.operation === "rename") database.rename(input.diagramId, diagramName(input.name));
      else
        database.setState(
          input.diagramId,
          input.operation === "archive"
            ? "archived"
            : input.operation === "restore"
              ? "active"
              : "deleted",
        );
      publish(input.projectId, input.diagramId);
      if (input.operation === "delete") {
        sql.prepare("DELETE FROM diagram_previews WHERE diagram_id = ?").run(input.diagramId);
        cleanup(removedAssetIds);
        return null;
      }
      return metadata(input);
    });
  });
  const removeProject = (projectId: ProjectId) =>
    attempt(() => {
      const removedAssets = new Set(
        database.list(projectId, true).flatMap((item) => assetIds(database.read(item.id))),
      );
      database.removeProject(projectId);
      publish(projectId, null);
      sql
        .prepare(
          "DELETE FROM diagram_previews WHERE diagram_id IN (SELECT id FROM diagrams WHERE project_id = ?)",
        )
        .run(projectId);
      cleanup(removedAssets);
    });

  const disconnectHost = Effect.fn("DiagramService.disconnectHost")(function* (
    connectionId: string,
  ) {
    const host = hosts.get(connectionId);
    if (!host) return;
    hosts.delete(connectionId);
    for (const [requestId, value] of pending)
      if (value.owner === connectionId) {
        pending.delete(requestId);
        yield* Deferred.fail(value.result, new DiagramOperationError({ code: "disconnected" }));
      }
    for (const [sessionId, entry] of sync)
      if (entry.clientId === host.clientId) entry.room.disconnectHost(sessionId);
    yield* Queue.end(host.queue);
  });
  const hostConnect = Effect.fn("DiagramService.hostConnect")(function* (input: HostInput) {
    if (input.environmentId !== environmentId)
      return yield* new DiagramOperationError({ code: "project-unavailable" });
    for (const host of hosts.values())
      if (host.clientId === input.clientId) yield* disconnectHost(host.connectionId);
    const connectionId = NodeCrypto.randomUUID();
    const queue = yield* Queue.unbounded<DiagramHostRequest, Cause.Done>();
    const host = {
      clientId: input.clientId,
      connectionId,
      focused: input.focused,
      mountedDiagramIds: input.mountedDiagramIds ?? [],
      operations: input.operations ?? DIAGRAM_LEGACY_HOST_OPERATIONS,
      queue,
    };
    hosts.set(connectionId, host);
    for (const [sessionId, entry] of sync)
      if (entry.clientId === input.clientId && !metadata(entry.target).archivedAt)
        yield* attempt(() => entry.room.registerHost(sessionId, connectionId));
    yield* Queue.offer(queue, { requestId: connectionId, connectionId, operation: "ready" });
    return Stream.fromQueue(queue).pipe(Stream.ensuring(disconnectHost(connectionId)));
  });
  const hostRespond = Effect.fn("DiagramService.hostRespond")(function* (
    input: DiagramHostResponse,
  ) {
    const response = yield* attempt(() => Schema.decodeUnknownSync(DiagramHostResponse)(input));
    const request = pending.get(response.requestId);
    if (!request || request.owner !== response.connectionId || !hosts.has(response.connectionId))
      return;
    pending.delete(response.requestId);
    if (response.result.ok) yield* Deferred.succeed(request.result, response.result.value);
    else yield* Deferred.fail(request.result, response.result.error);
  });
  const invoke = Effect.fn("DiagramService.invoke")(function* (
    input: DiagramTarget & {
      operation: DiagramHostOperation;
      value: unknown;
      clientId?: string;
      threadId?: ThreadId;
    },
  ) {
    const host = [...hosts.values()]
      .sort(
        (a, b) =>
          Number(b.mountedDiagramIds.includes(input.diagramId)) -
            Number(a.mountedDiagramIds.includes(input.diagramId)) ||
          Number(b.focused) - Number(a.focused),
      )
      .find(
        (item) =>
          item.operations.includes(input.operation) &&
          (!input.clientId || item.clientId === input.clientId),
      );
    if (!host) return yield* new DiagramOperationError({ code: "no-editor" });
    const requestId = NodeCrypto.randomUUID();
    const result = yield* Deferred.make<unknown, DiagramOperationError>();
    pending.set(requestId, { owner: host.connectionId, diagramId: input.diagramId, result });
    yield* Queue.offer(host.queue, {
      requestId,
      connectionId: host.connectionId,
      projectId: input.projectId,
      diagramId: input.diagramId,
      operation: input.operation,
      input: input.value,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    });
    const release = () => {
      if (input.operation === "prepare-batch")
        for (const [sessionId, entry] of sync)
          if (entry.clientId === host.clientId && entry.target.diagramId === input.diagramId)
            entry.room.room.sendCustomMessage(sessionId, {
              type: "diagram-fence-release",
              generation: host.connectionId,
              requestId,
            });
    };
    const response = yield* Deferred.await(result).pipe(
      Effect.timeoutOption(20_000),
      Effect.ensuring(Effect.sync(() => pending.delete(requestId))),
      Effect.onExit((exit) => (Exit.isFailure(exit) ? Effect.sync(release) : Effect.void)),
    );
    if (Option.isNone(response)) {
      release();
      yield* disconnectHost(host.connectionId);
      return yield* new DiagramOperationError({ code: "disconnected" });
    }
    return { host, value: response.value, requestId, release };
  });
  const receipt = Effect.fn("DiagramService.receipt")(function* (
    input: DiagramTarget & { namespace: string; requestId: string },
  ) {
    yield* targetMetadata(input);
    return yield* attempt(() => {
      const value = database.getReceipt(input.diagramId, input.namespace, input.requestId);
      return value ? Schema.decodeUnknownSync(DiagramMutationReceipt)(value) : null;
    });
  });
  const applyBatchCore = Effect.fn("DiagramService.applyBatch")(function* (input: ApplyInput) {
    const { room, diagram } = yield* target(input);
    const batch = yield* attempt(() => Schema.decodeUnknownSync(DiagramBatch)(input.batch));
    const mutation = yield* attempt(() => ({
      ...batch,
      namespace: input.namespace,
      puts: batch.puts.map((value) => record(value)),
      expected: batch.expected.map((item) => ({
        id: item.id,
        record: item.record === null ? null : record(item.record),
      })),
    }));
    const known = room.getReceipt(input.namespace, batch.requestId);
    if (known)
      return yield* attempt(() =>
        Schema.decodeUnknownSync(DiagramMutationReceipt)(
          room.commit(mutation, { sessionId: "", generation: "", token: "" }),
        ),
      );
    if (diagram.archivedAt) return yield* new DiagramOperationError({ code: "archived" });
    const prepared = yield* invoke({ ...input, operation: "prepare-batch", value: batch });
    return yield* Effect.gen(function* () {
      const value = yield* attempt(() => Schema.decodeUnknownSync(prepareResult)(prepared.value));
      const connection = sync.get(value.connectionId);
      if (
        !connection ||
        connection.clientId !== prepared.host.clientId ||
        connection.target.diagramId !== input.diagramId
      )
        return yield* new DiagramOperationError({ code: "disconnected" });
      return yield* attempt(() => {
        const fence = room.fenceHost(
          value.connectionId,
          prepared.host.connectionId,
          value.fingerprint,
        );
        connection.fence = fence;
        try {
          return Schema.decodeUnknownSync(DiagramMutationReceipt)(room.commit(mutation, fence));
        } catch (cause) {
          room.releaseFence(fence);
          delete connection.fence;
          throw cause;
        }
      });
    }).pipe(
      Effect.onExit((exit) => (Exit.isFailure(exit) ? Effect.sync(prepared.release) : Effect.void)),
    );
  });
  const applyBatch = (input: ApplyInput) =>
    applyBatchCore(input).pipe(
      Effect.ensuring(Effect.sync(() => database.releaseIdle(input.diagramId))),
    );

  const compose = Effect.fn("DiagramService.compose")(function* (
    input: DiagramComposeInput & { namespace: string; threadId?: ThreadId },
  ) {
    const diagram = yield* targetMetadata(input);
    if (diagram.archivedAt) return yield* new DiagramOperationError({ code: "archived" });
    const request = { spec: input.spec };
    yield* attempt(() => validateComposeRequest(request));
    const composed = yield* invoke({ ...input, operation: "compose", value: request });
    const result = yield* attempt(() => decodeHostComposeResult(composed.value));
    const compositionKey = input.spec.key;
    if (!result.changes)
      return {
        requestId: null,
        revision: (yield* attempt(() => metadata(input))).revision,
        compositionKey,
        counts: result.counts,
      } satisfies DiagramComposeResult;
    // Prepare on the host that composed: it measured against the records it is about to fence.
    const receipt = yield* applyBatchCore({
      projectId: input.projectId,
      diagramId: input.diagramId,
      namespace: input.namespace,
      clientId: composed.host.clientId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      batch: { requestId: input.requestId ?? NodeCrypto.randomUUID(), ...result.changes },
    });
    return {
      requestId: receipt.requestId,
      revision: receipt.revision,
      compositionKey,
      counts: result.counts,
    } satisfies DiagramComposeResult;
  });

  const failSyncRequests = Effect.fn(function* (clientId: string, diagramId: DiagramId) {
    for (const [requestId, entry] of pending)
      if (entry.diagramId === diagramId && hosts.get(entry.owner)?.clientId === clientId) {
        pending.delete(requestId);
        yield* Deferred.fail(entry.result, new DiagramOperationError({ code: "disconnected" }));
      }
  });
  const syncDisconnect = Effect.fn("DiagramService.syncDisconnect")(function* ({
    connectionId,
  }: {
    connectionId: string;
  }) {
    const connection = sync.get(connectionId);
    if (!connection) return;
    sync.delete(connectionId);
    yield* failSyncRequests(connection.clientId, connection.target.diagramId);
    connection.room.room.closeSession(connectionId);
    connection.room.disconnectHost(connectionId);
    database.releaseIdle(connection.target.diagramId);
    yield* Queue.end(connection.queue);
  });
  const syncConnect = Effect.fn("DiagramService.syncConnect")(function* (
    input: DiagramSyncConnectInput,
  ) {
    const { room, diagram } = yield* target(input);
    const connectionId = NodeCrypto.randomUUID();
    const queue = yield* Queue.unbounded<DiagramSyncEvent, Cause.Done>();
    sync.set(connectionId, { clientId: input.clientId, target: input, room, queue });
    yield* Queue.offer(queue, { connectionId, message: encodeJson({ type: "diagram-ready" }) });
    const host = [...hosts.values()].find((item) => item.clientId === input.clientId);
    if (host && !diagram.archivedAt)
      yield* attempt(() => room.registerHost(connectionId, host.connectionId));
    const socket = {
      readyState: 1,
      send: (message: string) => {
        Effect.runSync(Queue.offer(queue, { connectionId, message }));
      },
      close: () => {
        if (socket.readyState === 3) return;
        socket.readyState = 3;
        room.room.closeSession(connectionId);
        sync.delete(connectionId);
        room.disconnectHost(connectionId);
        queueMicrotask(() => database.releaseIdle(input.diagramId));
        Effect.runSync(failSyncRequests(input.clientId, input.diagramId));
        Effect.runSync(
          Queue.offer(queue, { connectionId, message: encodeJson({ type: "diagram-closed" }) }),
        );
        Effect.runSync(Queue.end(queue));
      },
    };
    room.room.handleSocketConnect({
      sessionId: connectionId,
      isReadonly: diagram.archivedAt !== null,
      socket,
    });
    return Stream.fromQueue(queue).pipe(Stream.ensuring(syncDisconnect({ connectionId })));
  });
  const syncSend = Effect.fn("DiagramService.syncSend")(function* (input: DiagramSyncSendInput) {
    const entry = sync.get(input.connectionId);
    if (
      !entry ||
      entry.target.diagramId !== input.diagramId ||
      entry.target.projectId !== input.projectId
    )
      return yield* new DiagramOperationError({ code: "disconnected" });
    yield* target(input);
    yield* attempt(() => {
      const message: unknown = decodeJson(input.message);
      if (Schema.is(adoptionMessage)(message)) {
        if (
          !entry.fence ||
          entry.fence.generation !== message.generation ||
          entry.fence.token !== message.fence
        )
          throw new DiagramOperationError({ code: "disconnected" });
        entry.room.acknowledgeAdoption(entry.fence, message.push);
        delete entry.fence;
      } else entry.room.room.handleSocketMessage(input.connectionId, input.message);
    });
  });

  const capture = Effect.fn("DiagramService.capture")(function* (input: DiagramCaptureInput) {
    yield* targetMetadata(input);
    const response = yield* invoke({
      ...input,
      operation: "capture",
      value: {
        scope: input.scope,
        revision: metadata(input).revision,
        format: input.format ?? "png",
      },
    });
    const captured = yield* attempt(() => Schema.decodeUnknownSync(DiagramCapture)(response.value));
    return yield* attempt(() => {
      const current = metadata(input);
      if (
        captured.diagramId !== input.diagramId ||
        captured.revision !== current.revision ||
        encodeJson(captured.scope) !== encodeJson(input.scope)
      )
        throw new DiagramOperationError({ code: "stale" });
      sql
        .prepare("INSERT OR REPLACE INTO diagram_previews VALUES (?, ?, ?)")
        .run(input.diagramId, encodeJson(input.scope), encodeJson(captured));
      return captured;
    });
  });
  const cachedPreview = Effect.fn("DiagramService.cachedPreview")(function* (
    input: DiagramCaptureInput,
  ) {
    yield* targetMetadata(input);
    return yield* attempt(() => {
      const row = sql
        .prepare("SELECT capture FROM diagram_previews WHERE diagram_id = ? AND scope = ?")
        .get(input.diagramId, encodeJson(input.scope));
      return row ? Schema.decodeUnknownSync(DiagramCapture)(decodeJson(String(row.capture))) : null;
    });
  });
  const preview = Effect.fn("DiagramService.preview")(function* (input: DiagramTarget) {
    const diagram = yield* targetMetadata(input);
    return yield* attempt(() => {
      const rows = sql
        .prepare("SELECT capture FROM diagram_previews WHERE diagram_id = ?")
        .all(input.diagramId);
      const captures = rows
        .map((row) => Schema.decodeUnknownSync(DiagramCapture)(decodeJson(String(row.capture))))
        .filter((item) => item.scope.kind === "diagram");
      const capture = captures.sort((a, b) => b.revision - a.revision)[0] ?? null;
      return { diagram, capture, stale: capture !== null && capture.revision !== diagram.revision };
    });
  });
  const prepareContext = Effect.fn("DiagramService.prepareContext")(function* (
    input: DiagramCaptureInput & { allowImageUnavailable?: boolean },
  ) {
    const scoped = () =>
      targetMetadata(input).pipe(
        Effect.andThen(
          attempt(() => {
            const diagram = metadata(input);
            const records = database.read(input.diagramId);
            if (!records.some((item) => item.id === input.scope.pageId && item.typeName === "page"))
              throw new DiagramOperationError({ code: "scope-unavailable" });
            if (
              input.scope.kind === "selection" &&
              input.scope.shapeIds.some(
                (id) => !records.some((item) => item.id === id && item.typeName === "shape"),
              )
            )
              throw new DiagramOperationError({ code: "scope-unavailable" });
            const compositions = readCompositions(records);
            const structure = diagramStructure(
              records,
              diagram.revision,
              {
                limit: 40,
                ...(input.scope.kind === "selection"
                  ? { recordIds: input.scope.shapeIds, pageId: input.scope.pageId }
                  : input.scope.kind === "viewport"
                    ? { pageId: input.scope.pageId, viewport: input.scope.bounds }
                    : { priorityPageId: input.scope.pageId }),
              },
              compositions,
            );
            if (
              input.scope.kind === "selection" &&
              structure.shapes.length !==
                Math.min(
                  40,
                  input.scope.shapeIds.filter(
                    (id) => !compositions.isMember(id) && !compositions.compositionOf(id),
                  ).length,
                )
            )
              throw new DiagramOperationError({ code: "scope-unavailable" });
            const structureBudget = Math.min(
              48 * 1024,
              60 * 1024 - Buffer.byteLength(encodeJson({ diagram, scope: input.scope })),
            );
            if (structureBudget < 1024)
              throw new DiagramOperationError({ code: "scope-unavailable" });
            while (Buffer.byteLength(encodeJson(structure)) > structureBudget) {
              if (structure.bindings.length) structure.bindings.pop();
              else if (structure.shapes.length) structure.shapes.pop();
              else if (structure.pages.length) structure.pages.pop();
              else structure.compositions.pop();
              structure.truncated = true;
            }
            return { diagram, structure };
          }),
        ),
      );
    const current = yield* scoped();
    const captured = yield* capture(input).pipe(
      Effect.map((value) => ({ status: "current" as const, capture: value })),
      Effect.catchTag("DiagramOperationError", (error) => {
        if (
          !input.allowImageUnavailable ||
          !["no-editor", "assets-unavailable"].includes(error.code)
        )
          return Effect.fail(error);
        return Effect.gen(function* () {
          const cached = yield* cachedPreview(input);
          if (cached?.revision === current.diagram.revision)
            return { status: "current" as const, capture: cached };
          return {
            status: "unavailable" as const,
            reason:
              error.code === "assets-unavailable"
                ? ("assets-unavailable" as const)
                : ("no-editor" as const),
          };
        });
      }),
    );
    const after = yield* scoped();
    if (captured.status === "current" && captured.capture.revision !== after.diagram.revision)
      return yield* new DiagramOperationError({ code: "stale" });
    if (captured.status === "unavailable" && current.diagram.revision !== after.diagram.revision)
      return yield* new DiagramOperationError({ code: "stale" });
    return {
      diagram: after.diagram,
      scope: input.scope,
      structure: after.structure,
      image: captured,
    } satisfies DiagramPreparedContext;
  });
  const signAsset = (input: DiagramTarget & { assetId: string }) => {
    const payload = Buffer.from(encodeJson({ ...input, expires: now() + 3_600_000 })).toString(
      "base64url",
    );
    const signature = NodeCrypto.createHmac("sha256", signingKey)
      .update(payload)
      .digest("base64url");
    return `/api/diagrams/assets/${encodeURIComponent(input.assetId)}?token=${payload}.${signature}`;
  };
  const assetUrl = Effect.fn("DiagramService.assetUrl")(function* (
    input: DiagramTarget & { assetId: string },
  ) {
    yield* targetMetadata(input);
    return yield* attempt(() => {
      if (
        !sql
          .prepare("SELECT 1 FROM diagram_assets WHERE id = ? AND project_id = ?")
          .get(input.assetId, input.projectId)
      )
        throw new DiagramOperationError({ code: "assets-unavailable" });
      return signAsset(input);
    });
  });
  const readAsset = Effect.fn("DiagramService.readAsset")(function* (
    input: DiagramTarget & { assetId: string },
  ) {
    yield* targetMetadata(input);
    return yield* attempt(() => {
      const row = sql
        .prepare("SELECT bytes,mime_type FROM diagram_assets WHERE id = ? AND project_id = ?")
        .get(input.assetId, input.projectId);
      if (!(row?.bytes instanceof Uint8Array))
        throw new DiagramOperationError({ code: "assets-unavailable" });
      return { base64: Buffer.from(row.bytes).toString("base64"), mimeType: String(row.mime_type) };
    });
  });
  const assetUpload = Effect.fn("DiagramService.assetUpload")(function* (input: AssetInput) {
    const diagram = yield* targetMetadata(input);
    if (diagram.archivedAt) return yield* new DiagramOperationError({ code: "archived" });
    return yield* attempt(() => {
      const bytes = Buffer.from(input.base64, "base64");
      if (
        !/^image\/(png|jpeg|webp|gif|svg\+xml)$/.test(input.mimeType) ||
        bytes.byteLength > DIAGRAM_MAX_DOCUMENT_BYTES ||
        bytes.byteLength === 0
      )
        throw new DiagramOperationError({ code: "invalid-records" });
      const assetId = NodeCrypto.randomUUID();
      sql
        .prepare("INSERT INTO diagram_assets VALUES (?, ?, ?, ?, ?)")
        .run(assetId, input.projectId, input.mimeType, bytes, nowIso());
      return { assetId, src: `asset:t3-diagram/${assetId}`, url: signAsset({ ...input, assetId }) };
    });
  });
  const assetRead = (input: { assetId: string; token: string }) =>
    attempt(() => {
      const [payload, signature] = input.token.split(".");
      if (!payload || !signature) throw new DiagramOperationError({ code: "assets-unavailable" });
      const expected = NodeCrypto.createHmac("sha256", signingKey).update(payload).digest();
      const actual = Buffer.from(signature, "base64url");
      if (
        actual.byteLength !== expected.byteLength ||
        !NodeCrypto.timingSafeEqual(actual, expected)
      )
        throw new DiagramOperationError({ code: "assets-unavailable" });
      const claim = Schema.decodeUnknownSync(assetClaim)(
        decodeJson(Buffer.from(payload, "base64url").toString()),
      );
      const diagram = database.get(claim.diagramId);
      if (
        claim.assetId !== input.assetId ||
        claim.expires < now() ||
        !diagram ||
        diagram.state === "deleted" ||
        diagram.projectId !== claim.projectId
      )
        throw new DiagramOperationError({ code: "assets-unavailable" });
      const row = sql
        .prepare("SELECT bytes, mime_type FROM diagram_assets WHERE id = ? AND project_id = ?")
        .get(input.assetId, claim.projectId);
      if (!(row?.bytes instanceof Uint8Array))
        throw new DiagramOperationError({ code: "assets-unavailable" });
      return { bytes: row.bytes, mimeType: String(row.mime_type) };
    });
  return DiagramService.of({
    list,
    changes,
    create,
    read,
    lifecycle,
    applyBatch,
    compose: (input) =>
      compose(input).pipe(
        Effect.ensuring(Effect.sync(() => database.releaseIdle(input.diagramId))),
      ),
    receipt,
    capture,
    prepareContext,
    cachedPreview,
    preview,
    importDocument,
    exportDocument,
    removeProject,
    count,
    syncConnect,
    syncSend,
    syncDisconnect,
    hostConnect,
    hostRespond,
    assetUpload,
    assetUrl,
    assetRead,
    readAsset,
  });
});

export const layer = Layer.effect(DiagramService, make);

export const projectCleanupLayer = Layer.effect(
  DiagramProjectCleanup,
  Effect.map(DiagramService, (diagrams) => ({ removeProject: diagrams.removeProject })),
);
