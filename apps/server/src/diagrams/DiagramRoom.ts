import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import {
  NodeSqliteWrapper,
  SQLiteSyncStorage,
  TLSocketRoom,
  type TLSyncStorage,
  type TLSyncStorageTransaction,
} from "@tldraw/sync-core";
import { createTLSchema, type TLRecord } from "@tldraw/tlschema";

export type DiagramMutation = {
  namespace: string;
  requestId: string;
  expected: readonly { id: string; record: TLRecord | null }[];
  puts: readonly TLRecord[];
  deletes: readonly string[];
};

export type DiagramReceipt = {
  requestId: string;
  namespace: string;
  revision: number;
  changedRecordIds: readonly string[];
};

const receiptCodec = Schema.fromJsonString(
  Schema.Struct({
    requestId: Schema.String,
    namespace: Schema.String,
    revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    changedRecordIds: Schema.Array(Schema.String).check(Schema.isMaxLength(500)),
  }),
);
const decodeReceipt = Schema.decodeUnknownSync(receiptCodec);
const encodeReceipt = Schema.encodeSync(receiptCodec);

export type DiagramCommitEnvelope = {
  type: "diagram-commit";
  generation: string;
  fence: string;
  mutation: DiagramMutation;
  receipt: DiagramReceipt;
};

export type DiagramHostFence = { sessionId: string; generation: string; token: string };
type Fence = DiagramHostFence;

export type DiagramMetadataRow = {
  id: string;
  projectId: string;
  name: string;
  revision: number;
  state: "active" | "archived" | "deleted";
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export class DiagramRoomError extends Schema.TaggedError<DiagramRoomError>()("DiagramRoomError", {
  reason: Schema.Literals([
    "stale",
    "locked",
    "dependency",
    "inactive",
    "host-unavailable",
    "request-mismatch",
    "invalid",
  ]),
  message: Schema.String,
}) {
  static new(reason: DiagramRoomError["reason"]) {
    return new DiagramRoomError({ reason, message: `Diagram mutation rejected (${reason})` });
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function equal(a: unknown, b: unknown) {
  return canonical(a) === canonical(b);
}

function applyAdoptionPatch(value: unknown, patch: unknown): unknown {
  if (
    !value ||
    typeof value !== "object" ||
    !patch ||
    typeof patch !== "object" ||
    Array.isArray(patch)
  )
    throw DiagramRoomError.new("invalid");
  const result = structuredClone(value);
  for (const [key, operation] of Object.entries(patch)) {
    if (["__proto__", "prototype", "constructor"].includes(key) || !Array.isArray(operation))
      throw DiagramRoomError.new("invalid");
    const current: unknown = Reflect.get(result, key);
    switch (operation[0]) {
      case "put":
        Reflect.set(result, key, operation[1]);
        break;
      case "delete":
        Reflect.deleteProperty(result, key);
        break;
      case "patch":
        Reflect.set(result, key, applyAdoptionPatch(current, operation[1]));
        break;
      case "append": {
        const addition: unknown = operation[1];
        if (
          typeof current === "string" &&
          typeof addition === "string" &&
          current.length === operation[2]
        )
          Reflect.set(result, key, current + addition);
        else if (
          Array.isArray(current) &&
          Array.isArray(addition) &&
          current.length === operation[2]
        )
          Reflect.set(result, key, [...current, ...addition]);
        else throw DiagramRoomError.new("invalid");
        break;
      }
      default:
        throw DiagramRoomError.new("invalid");
    }
  }
  return result;
}

function validateAdoptionPush(mutation: DiagramMutation, push: { diff?: unknown }) {
  if (!push.diff || typeof push.diff !== "object" || Array.isArray(push.diff))
    throw DiagramRoomError.new("invalid");
  const expected = new Map(mutation.expected.map(({ id, record }) => [id, record]));
  const desired = new Map<string, TLRecord | null>(
    mutation.puts.map((record) => [record.id, record]),
  );
  for (const id of mutation.deletes) desired.set(id, null);
  const actual = new Map<string, unknown>();
  for (const [id, operation] of Object.entries(push.diff)) {
    if (!desired.has(id) || !Array.isArray(operation)) throw DiagramRoomError.new("invalid");
    switch (operation[0]) {
      case "put":
        actual.set(id, operation[1]);
        break;
      case "patch":
        actual.set(id, applyAdoptionPatch(expected.get(id), operation[1]));
        break;
      case "remove":
        actual.set(id, null);
        break;
      default:
        throw DiagramRoomError.new("invalid");
    }
  }
  for (const [id, after] of desired) {
    if (equal(expected.get(id), after)) {
      if (actual.has(id) && !equal(actual.get(id), after)) throw DiagramRoomError.new("invalid");
    } else if (!actual.has(id) || !equal(actual.get(id), after))
      throw DiagramRoomError.new("invalid");
  }
}

export function diagramRecordFingerprint(records: readonly TLRecord[]) {
  return NodeCrypto.createHash("sha256")
    .update(canonical([...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))))
    .digest("hex");
}

export class DiagramDatabase {
  readonly database: NodeSqlite.DatabaseSync;
  private readonly rooms = new Map<string, DiagramRoom>();

  private readonly validateRecord:
    | ((record: TLRecord, projectId: string, database: NodeSqlite.DatabaseSync) => void)
    | undefined;

  constructor(
    path: string,
    validateRecord?: (
      record: TLRecord,
      projectId: string,
      database: NodeSqlite.DatabaseSync,
    ) => void,
  ) {
    this.validateRecord = validateRecord;
    this.database = new NodeSqlite.DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS diagrams (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active', revision INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS diagram_receipts (
        diagram_id TEXT NOT NULL, namespace TEXT NOT NULL, request_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, receipt TEXT NOT NULL,
        PRIMARY KEY (diagram_id, namespace, request_id)
      );
      CREATE TABLE IF NOT EXISTS diagram_removed_projects (project_id TEXT PRIMARY KEY);
    `);
  }

  create(id: string, projectId: string, name = "Untitled diagram") {
    name = name.trim();
    if (!name || name.length > 200) throw DiagramRoomError.new("invalid");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw DiagramRoomError.new("invalid");
    if (
      this.database
        .prepare("SELECT 1 FROM diagram_removed_projects WHERE project_id = ?")
        .get(projectId)
    )
      throw DiagramRoomError.new("inactive");
    const now = DateTime.formatIso(DateTime.nowUnsafe());
    this.database
      .prepare(
        "INSERT INTO diagrams (id, project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, projectId, name, now, now);
    return this.open(id);
  }

  get(id: string): DiagramMetadataRow | null {
    const row = this.database
      .prepare(
        "SELECT id, project_id, name, state, revision, archived_at, created_at, updated_at FROM diagrams WHERE id = ?",
      )
      .get(id);
    if (!row) return null;
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      name: String(row.name),
      state: row.state as DiagramMetadataRow["state"],
      revision: Number(row.revision),
      archivedAt: row.archived_at === null ? null : String(row.archived_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  list(projectId: string, includeArchived = false): DiagramMetadataRow[] {
    const rows = this.database
      .prepare(
        "SELECT id FROM diagrams WHERE project_id = ? AND (state = 'active' OR (? = 1 AND state = 'archived')) ORDER BY updated_at DESC, id",
      )
      .all(projectId, Number(includeArchived));
    return rows.map((row) => this.get(String(row.id))!);
  }

  count(projectId: string) {
    return Number(
      this.database
        .prepare(
          "SELECT COUNT(*) AS count FROM diagrams WHERE project_id = ? AND state <> 'deleted'",
        )
        .get(projectId)?.count ?? 0,
    );
  }

  read(id: string) {
    const row = this.get(id);
    if (!row || row.state === "deleted") throw DiagramRoomError.new("inactive");
    const cached = this.rooms.get(id);
    if (cached) return cached.read();
    const config = { tablePrefix: `d_${id.replaceAll("-", "")}_` };
    const storage = new SQLiteSyncStorage<TLRecord>({
      sql: Object.assign(new NodeSqliteWrapper(this.database, config), { config }),
    });
    return storage.transaction((txn) => Array.from(txn.entries(), ([, record]) => record)).result;
  }

  getReceipt(id: string, namespace: string, requestId: string) {
    const row = this.database
      .prepare(
        "SELECT receipt FROM diagram_receipts WHERE diagram_id = ? AND namespace = ? AND request_id = ?",
      )
      .get(id, namespace, requestId);
    return row ? decodeReceipt(String(row.receipt)) : null;
  }

  releaseIdle(id: string) {
    const room = this.rooms.get(id);
    if (room?.isIdle()) this.closeDocument(id);
  }

  rename(id: string, name: string) {
    if (!name.trim() || name.length > 200) throw DiagramRoomError.new("invalid");
    const row = this.get(id);
    if (!row || row.state === "deleted") throw DiagramRoomError.new("inactive");
    this.database
      .prepare("UPDATE diagrams SET name = ?, updated_at = ? WHERE id = ?")
      .run(name.trim(), DateTime.formatIso(DateTime.nowUnsafe()), id);
    return this.get(id)!;
  }

  setState(id: string, state: DiagramMetadataRow["state"]) {
    const room = this.open(id);
    this.database.exec("BEGIN");
    try {
      room.setState(state);
      if (state === "deleted") this.eraseRecords(id);
      this.database.exec("COMMIT");
    } catch (cause) {
      this.database.exec("ROLLBACK");
      throw cause;
    }
    if (state === "deleted") this.closeDocument(id);
    else this.releaseIdle(id);
    return this.get(id)!;
  }

  private eraseRecords(id: string) {
    const prefix = `d_${id.replaceAll("-", "")}_`;
    for (const suffix of ["documents", "objects", "tombstones"])
      this.database.exec(`DELETE FROM ${prefix}${suffix}`);
    this.database.prepare("DELETE FROM diagram_receipts WHERE diagram_id = ?").run(id);
  }

  private closeDocument(id: string) {
    this.rooms.get(id)?.room.close();
    this.rooms.delete(id);
  }

  open(id: string) {
    const cached = this.rooms.get(id);
    if (cached) return cached;
    if (!this.database.prepare("SELECT 1 FROM diagrams WHERE id = ?").get(id))
      throw DiagramRoomError.new("inactive");
    const room = new DiagramRoom(this.database, id, this.validateRecord);
    this.rooms.set(id, room);
    return room;
  }

  removeProject(projectId: string) {
    const ids = this.database
      .prepare("SELECT id FROM diagrams WHERE project_id = ?")
      .all(projectId)
      .map((row) => String(row.id));
    this.database.exec("BEGIN");
    try {
      this.database
        .prepare("INSERT OR IGNORE INTO diagram_removed_projects VALUES (?)")
        .run(projectId);
      this.database
        .prepare("UPDATE diagrams SET state = 'deleted', updated_at = ? WHERE project_id = ?")
        .run(DateTime.formatIso(DateTime.nowUnsafe()), projectId);
      for (const id of ids) this.eraseRecords(id);
      this.database.exec("COMMIT");
    } catch (cause) {
      this.database.exec("ROLLBACK");
      throw cause;
    }
    for (const room of this.rooms.values()) room.invalidateIfInactive();
    for (const id of ids) this.closeDocument(id);
  }

  close() {
    for (const room of this.rooms.values()) room.room.close();
    this.rooms.clear();
    this.database.close();
  }
}

export class DiagramRoom {
  readonly room: TLSocketRoom<TLRecord>;
  readonly storage: TLSyncStorage<TLRecord>;
  readonly schema = createTLSchema();
  private readonly sdkStorage: SQLiteSyncStorage<TLRecord>;
  private readonly hosts = new Map<
    string,
    {
      generation: string;
      fence?: Fence;
      committed?: { receipt: DiagramReceipt; mutation: DiagramMutation };
      acknowledging?: boolean;
    }
  >();
  private readonly database: NodeSqlite.DatabaseSync;
  readonly id: string;

  private readonly validateRecord:
    | ((record: TLRecord, projectId: string, database: NodeSqlite.DatabaseSync) => void)
    | undefined;

  constructor(
    database: NodeSqlite.DatabaseSync,
    id: string,
    validateRecord?: (
      record: TLRecord,
      projectId: string,
      database: NodeSqlite.DatabaseSync,
    ) => void,
  ) {
    this.validateRecord = validateRecord;
    this.database = database;
    this.id = id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw DiagramRoomError.new("invalid");
    const config = { tablePrefix: `d_${id.replaceAll("-", "")}_` };
    this.sdkStorage = new SQLiteSyncStorage<TLRecord>({
      sql: Object.assign(new NodeSqliteWrapper(database, config), { config }),
    });
    this.storage = {
      getClock: () => this.sdkStorage.getClock(),
      onChange: (callback) => this.sdkStorage.onChange(callback),
      getSnapshot: () => this.sdkStorage.getSnapshot(),
      transaction: (callback, options) =>
        this.sdkStorage.transaction((txn) => {
          const clock = txn.getClock();
          const result = callback(this.guard(txn));
          if (txn.getClock() !== clock)
            this.database
              .prepare("UPDATE diagrams SET revision = ?, updated_at = ? WHERE id = ?")
              .run(txn.getClock(), DateTime.formatIso(DateTime.nowUnsafe()), this.id);
          return result;
        }, options),
    };
    this.room = new TLSocketRoom({
      storage: this.storage,
      schema: this.schema,
      onSessionRemoved: (_room, { sessionId }) => this.disconnectHost(sessionId),
    });
  }

  private guard(txn: TLSyncStorageTransaction<TLRecord>): TLSyncStorageTransaction<TLRecord> {
    return new Proxy(txn, {
      get: (target, property) => {
        const value = Reflect.get(target, property);
        if (property === "set" || property === "delete")
          return (...args: unknown[]) => {
            this.assertActive();
            if (property === "set") {
              const value = args[1];
              const envelope = Schema.decodeUnknownSync(Schema.Struct({ typeName: Schema.String }))(
                value,
              );
              const recordType = Object.values(this.schema.types).find(
                (item) => item.typeName === envelope.typeName,
              );
              if (!recordType || recordType.scope !== "document")
                throw DiagramRoomError.new("invalid");
              const record = recordType.validate(value);
              if (record.id !== args[0]) throw DiagramRoomError.new("invalid");
              const row = this.database
                .prepare("SELECT project_id FROM diagrams WHERE id = ?")
                .get(this.id);
              this.validateRecord?.(record, String(row?.project_id), this.database);
            }
            return Reflect.apply(value, target, args);
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  private assertActive() {
    const row = this.database
      .prepare(
        "SELECT state FROM diagrams WHERE id = ? AND project_id NOT IN (SELECT project_id FROM diagram_removed_projects)",
      )
      .get(this.id);
    if (row?.state !== "active") throw DiagramRoomError.new("inactive");
  }

  invalidateIfInactive() {
    try {
      this.assertActive();
    } catch {
      this.hosts.clear();
      for (const session of this.room.getSessions()) this.room.closeSession(session.sessionId);
    }
  }

  setState(state: "active" | "archived" | "deleted") {
    const current = this.database
      .prepare("SELECT state, project_id FROM diagrams WHERE id = ?")
      .get(this.id);
    if (
      !current ||
      current.state === "deleted" ||
      this.database
        .prepare("SELECT 1 FROM diagram_removed_projects WHERE project_id = ?")
        .get(String(current?.project_id))
    )
      throw DiagramRoomError.new("inactive");
    const now = DateTime.formatIso(DateTime.nowUnsafe());
    this.database
      .prepare("UPDATE diagrams SET state = ?, archived_at = ?, updated_at = ? WHERE id = ?")
      .run(state, state === "archived" ? now : null, now, this.id);
    if (state === "active" && current.state === "archived") {
      this.hosts.clear();
      for (const session of this.room.getSessions()) this.room.closeSession(session.sessionId);
    }
    this.invalidateIfInactive();
  }

  read() {
    return this.sdkStorage.transaction((txn) => Array.from(txn.entries(), ([, record]) => record))
      .result;
  }

  registerHost(sessionId: string, generation: string) {
    this.assertActive();
    this.hosts.set(sessionId, { generation });
  }

  disconnectHost(sessionId: string) {
    this.hosts.delete(sessionId);
  }

  isIdle() {
    return this.hosts.size === 0 && this.room.getSessions().length === 0;
  }

  fingerprint() {
    return diagramRecordFingerprint(this.read());
  }

  fenceHost(sessionId: string, generation: string, fingerprint: string): Fence {
    this.assertActive();
    const host = this.hosts.get(sessionId);
    if (!host || host.generation !== generation || host.fence)
      throw DiagramRoomError.new("host-unavailable");
    if (this.fingerprint() !== fingerprint) throw DiagramRoomError.new("stale");
    const fence = { sessionId, generation, token: NodeCrypto.randomUUID() };
    host.fence = fence;
    return fence;
  }

  releaseFence(fence: Fence) {
    const host = this.hosts.get(fence.sessionId);
    if (host?.fence?.token === fence.token) {
      delete host.fence;
      delete host.committed;
      delete host.acknowledging;
    }
  }

  private receiptRow(namespace: string, requestId: string) {
    return this.database
      .prepare(
        "SELECT fingerprint, receipt FROM diagram_receipts WHERE diagram_id = ? AND namespace = ? AND request_id = ?",
      )
      .get(this.id, namespace, requestId);
  }

  getReceipt(namespace: string, requestId: string): DiagramReceipt | null {
    const row = this.receiptRow(namespace, requestId);
    return row ? decodeReceipt(String(row.receipt)) : null;
  }

  commit(mutation: DiagramMutation, fence: Fence): DiagramReceipt {
    const fingerprint = NodeCrypto.createHash("sha256").update(canonical(mutation)).digest("hex");
    const saved = this.receiptRow(mutation.namespace, mutation.requestId);
    if (saved) {
      if (saved.fingerprint !== fingerprint) throw DiagramRoomError.new("request-mismatch");
      return decodeReceipt(String(saved.receipt));
    }
    if (
      mutation.puts.length + mutation.deletes.length > 500 ||
      Buffer.byteLength(canonical(mutation)) > 1_000_000
    )
      throw DiagramRoomError.new("invalid");
    const { result: receipt } = this.storage.transaction((txn) => {
      this.assertActive();
      const host = this.hosts.get(fence.sessionId);
      if (host?.generation !== fence.generation || host.fence?.token !== fence.token)
        throw DiagramRoomError.new("host-unavailable");
      this.validate(txn, mutation);
      for (const record of mutation.puts) txn.set(record.id, record);
      for (const id of mutation.deletes) txn.delete(id);
      const receipt = {
        namespace: mutation.namespace,
        requestId: mutation.requestId,
        revision: txn.getClock(),
        changedRecordIds: [...mutation.puts.map((record) => record.id), ...mutation.deletes],
      };
      this.database
        .prepare("UPDATE diagrams SET revision = ? WHERE id = ?")
        .run(receipt.revision, this.id);
      this.database
        .prepare("INSERT INTO diagram_receipts VALUES (?, ?, ?, ?, ?)")
        .run(this.id, mutation.namespace, mutation.requestId, fingerprint, encodeReceipt(receipt));
      return receipt;
    });
    this.hosts.get(fence.sessionId)!.committed = { receipt, mutation };
    this.room.sendCustomMessage(fence.sessionId, {
      type: "diagram-commit",
      generation: fence.generation,
      fence: fence.token,
      mutation,
      receipt,
    } satisfies DiagramCommitEnvelope);
    return receipt;
  }

  acknowledgeAdoption(fence: Fence, push: { clientClock: number; diff?: unknown }) {
    const host = this.hosts.get(fence.sessionId);
    if (
      host?.generation !== fence.generation ||
      host.fence?.token !== fence.token ||
      !host.committed ||
      host.acknowledging
    )
      throw DiagramRoomError.new("host-unavailable");
    validateAdoptionPush(host.committed.mutation, push);
    host.acknowledging = true;
    // The storage notification runs first. A custom message then flushes its queued SDK patch.
    queueMicrotask(() => {
      if (this.hosts.get(fence.sessionId) !== host) return;
      this.room.sendCustomMessage(fence.sessionId, {
        type: "diagram-adoption-ack",
        generation: fence.generation,
        fence: fence.token,
        clientClock: push.clientClock,
        serverClock: this.storage.getClock(),
      });
      this.releaseFence(fence);
    });
  }

  private validate(txn: TLSyncStorageTransaction<TLRecord>, mutation: DiagramMutation) {
    const expected = new Map(mutation.expected.map(({ id, record }) => [id, record]));
    const changed = new Set([...mutation.puts.map((record) => record.id), ...mutation.deletes]);
    if (
      expected.size !== mutation.expected.length ||
      changed.size === 0 ||
      changed.size !== mutation.puts.length + mutation.deletes.length
    )
      throw DiagramRoomError.new("invalid");
    for (const { id, record } of mutation.expected)
      if (record && record.id !== id) throw DiagramRoomError.new("invalid");
    for (const { id, record } of mutation.expected)
      if (!equal(txn.get(id) ?? null, record)) throw DiagramRoomError.new("stale");
    if (
      mutation.puts.every((record) => equal(txn.get(record.id), record)) &&
      mutation.deletes.every((id) => !txn.get(id))
    )
      throw DiagramRoomError.new("invalid");
    const after = new Map(mutation.puts.map((record) => [record.id as string, record]));
    const requireExpected = (id: string) => {
      if (!expected.has(id)) throw DiagramRoomError.new("dependency");
    };
    const requireRecord = (id: string, final: boolean) => {
      requireExpected(id);
      const record = final
        ? mutation.deletes.includes(id)
          ? undefined
          : (after.get(id) ?? txn.get(id))
        : txn.get(id);
      if (!record) throw DiagramRoomError.new("dependency");
      return record;
    };
    const check = (record: TLRecord | undefined, final: boolean) => {
      if (!record) return;
      if (record.typeName === "shape") {
        if (record.isLocked) throw DiagramRoomError.new("locked");
        let parentId: string = record.parentId;
        const seen = new Set<string>([record.id]);
        while (parentId) {
          if (seen.has(parentId)) throw DiagramRoomError.new("invalid");
          seen.add(parentId);
          const parent = requireRecord(parentId, final);
          if (parent.typeName !== "shape") {
            if (parent.typeName !== "page") throw DiagramRoomError.new("invalid");
            break;
          }
          if (parent.isLocked) throw DiagramRoomError.new("locked");
          parentId = parent.parentId;
        }
        if (
          (record.type === "image" || record.type === "video") &&
          record.props.assetId &&
          requireRecord(record.props.assetId, final).typeName !== "asset"
        )
          throw DiagramRoomError.new("dependency");
      }
      if (record.typeName === "binding") {
        const from = requireRecord(record.fromId, final);
        const to = requireRecord(record.toId, final);
        if (from.typeName !== "shape" || to.typeName !== "shape")
          throw DiagramRoomError.new("dependency");
        check(from, final);
        check(to, final);
      }
    };
    for (const id of changed) {
      requireExpected(id);
      check(txn.get(id), false);
      check(after.get(id), true);
    }
    for (const record of mutation.puts) {
      const type = this.schema.types[record.typeName];
      if (type.scope !== "document") throw DiagramRoomError.new("invalid");
      type.validate(record);
    }
    const finalRecords = new Map(txn.entries());
    for (const record of mutation.puts) finalRecords.set(record.id, record);
    for (const id of mutation.deletes) finalRecords.delete(id);
    if (
      ![...finalRecords.values()].some((record) => record.typeName === "page") ||
      ![...finalRecords.values()].some((record) => record.typeName === "document")
    )
      throw DiagramRoomError.new("invalid");
    for (const [, record] of txn.entries()) {
      if (
        record.typeName === "binding" &&
        (changed.has(record.fromId) || changed.has(record.toId))
      ) {
        requireExpected(record.id);
        requireExpected(record.fromId);
        requireExpected(record.toId);
        if (
          (mutation.deletes.includes(record.fromId) || mutation.deletes.includes(record.toId)) &&
          !mutation.deletes.includes(record.id)
        )
          throw DiagramRoomError.new("dependency");
      }
      const final = finalRecords.get(record.id);
      if (final?.typeName === "shape" && mutation.deletes.includes(final.parentId))
        throw DiagramRoomError.new("dependency");
      if (record.typeName === "shape" && changed.has(record.parentId)) requireExpected(record.id);
      if (
        record.typeName === "shape" &&
        (record.type === "image" || record.type === "video") &&
        record.props.assetId &&
        mutation.deletes.includes(record.props.assetId) &&
        final?.typeName === "shape" &&
        (final.type === "image" || final.type === "video") &&
        final.props.assetId === record.props.assetId
      )
        throw DiagramRoomError.new("dependency");
    }
  }
}
