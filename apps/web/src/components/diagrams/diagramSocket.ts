import { createDiagramSchema } from "./diagramSchema";
import {
  DIAGRAM_SDK_VERSION,
  DiagramBatch,
  DiagramMutationReceipt,
  type DiagramSyncEvent,
  type DiagramTarget,
} from "@t3tools/contracts";
import { type TLPersistentClientSocket, type TLSocketStatusChangeEvent } from "@tldraw/sync";
import { type TLRecord, isEqual } from "tldraw";
import * as Schema from "effect/Schema";
import type { DiagramApi } from "./diagramApi";

type ClientMessage = Record<string, unknown>;
type ServerMessage = Record<string, unknown>;
const pushSchema = Schema.Struct({
  type: Schema.Literal("push"),
  clientClock: Schema.Number,
  diff: Schema.optional(Schema.Unknown),
});
const resultSchema = Schema.Struct({
  type: Schema.Literal("push_result"),
  clientClock: Schema.Number,
  serverClock: Schema.Number,
});
export type DiagramSaveState = "connecting" | "saved" | "pending" | "offline";
const commitSchema = Schema.Struct({
  type: Schema.Literal("diagram-commit"),
  generation: Schema.String,
  fence: Schema.String,
  mutation: Schema.Struct({ ...DiagramBatch.fields, namespace: Schema.String }),
  receipt: Schema.Struct({ ...DiagramMutationReceipt.fields, namespace: Schema.String }),
});
const ackSchema = Schema.Struct({
  type: Schema.Literal("diagram-adoption-ack"),
  clientClock: Schema.Number,
  serverClock: Schema.Number,
  generation: Schema.String,
  fence: Schema.String,
});
const releaseSchema = Schema.Struct({
  type: Schema.Literal("diagram-fence-release"),
  generation: Schema.String,
  requestId: Schema.String,
});
const decodeHeader = Schema.decodeUnknownSync(Schema.Struct({ type: Schema.String }));
const decodeRecordHeader = Schema.decodeUnknownSync(Schema.Struct({ typeName: Schema.String }));
const decodePayload = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Unknown }));
const decodeMessage = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const isRelease = Schema.is(releaseSchema);
const isPush = Schema.is(pushSchema);
const isResult = Schema.is(resultSchema);
const isAck = Schema.is(ackSchema);
const isCommit = Schema.is(commitSchema);
const recordSchema = createDiagramSchema();
export function parseDocumentRecord(raw: unknown): TLRecord {
  const header = decodeRecordHeader(raw);
  switch (header.typeName) {
    case "shape":
      return recordSchema.types.shape.validate(raw);
    case "binding":
      return recordSchema.types.binding.validate(raw);
    case "asset":
      return recordSchema.types.asset.validate(raw);
    case "page":
      return recordSchema.types.page.validate(raw);
    case "document":
      return recordSchema.types.document.validate(raw);
    case "user":
      return recordSchema.types.user.validate(raw);
    default:
      throw new Error("Unsupported diagram record type.");
  }
}
export type DiagramCommit = Omit<typeof commitSchema.Type, "mutation"> & {
  mutation: Omit<(typeof commitSchema.Type)["mutation"], "puts" | "expected"> & {
    puts: readonly TLRecord[];
    expected: readonly { id: string; record: TLRecord | null }[];
  };
};
export class DiagramSocket implements TLPersistentClientSocket<ClientMessage, ServerMessage> {
  connectionStatus: "online" | "offline" | "error" = "offline";
  connectionId: string | null = null;
  revision = 0;
  private sequence = 0;
  private hydrated = false;
  private connecting = true;
  private connectionGeneration = 0;
  private readonly dirty = new Map<
    string,
    { before: TLRecord | null; after: TLRecord | null; version: number }
  >();
  private readonly pushedSequences = new Map<
    number,
    { sequence: number; records: Map<string, TLRecord | null> }
  >();
  private readonly listeners = new Set<(message: ServerMessage) => void>();
  private readonly statusListeners = new Set<(status: TLSocketStatusChangeEvent) => void>();
  private readonly saveListeners = new Set<() => void>();
  private readonly idleWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  private adoption: { generation: string; fence: string } | null = null;
  private pendingAdoption: {
    generation: string;
    fence: string;
    clientClock: number;
    acknowledgedServerClock: number | null;
  } | null = null;
  private disposed = false;
  private unsubscribe: (() => void) | null = null;
  private sendTail = Promise.resolve();
  onCommit: ((commit: DiagramCommit) => void) | null = null;
  onFenceReleased: ((release?: typeof releaseSchema.Type) => void) | null = null;
  onAdoptionLost: (() => void) | null = null;
  constructor(
    readonly options: {
      target: DiagramTarget;
      clientId: string;
      api: Pick<DiagramApi, "syncSend">;
      subscribe: (
        input: DiagramTarget & { clientId: string; sdkVersion: typeof DIAGRAM_SDK_VERSION },
        receive: (event: DiagramSyncEvent) => void,
        disconnected: () => void,
      ) => () => void;
    },
  ) {
    this.connect();
  }
  private connect() {
    const generation = ++this.connectionGeneration;
    this.connecting = true;
    this.changed();
    this.unsubscribe = this.options.subscribe(
      { ...this.options.target, clientId: this.options.clientId, sdkVersion: DIAGRAM_SDK_VERSION },
      (event) => {
        if (this.disposed || generation !== this.connectionGeneration) return;
        try {
          this.receive(event);
        } catch {
          this.disconnect();
        }
      },
      () => {
        if (generation === this.connectionGeneration) this.disconnect();
      },
    );
  }
  getSaveState = (): DiagramSaveState => {
    if (this.connectionStatus !== "online") return this.connecting ? "connecting" : "offline";
    if (!this.hydrated) return "connecting";
    return this.dirty.size > 0 ||
      this.pushedSequences.size > 0 ||
      this.adoption !== null ||
      this.pendingAdoption !== null
      ? "pending"
      : "saved";
  };
  subscribeSave = (listener: () => void) => {
    this.saveListeners.add(listener);
    return () => {
      this.saveListeners.delete(listener);
    };
  };
  recordLocalChange(before: TLRecord | null, after: TLRecord | null) {
    const id = after?.id ?? before?.id;
    if (!id) return;
    this.sequence += 1;
    const dirty = this.dirty.get(id);
    const baseline = dirty ? dirty.before : before;
    const outstandingChange = [...this.pushedSequences.values()].some(
      (push) => push.records.has(id) && !isEqual(push.records.get(id), after),
    );
    if (isEqual(baseline, after) && !outstandingChange) this.dirty.delete(id);
    else this.dirty.set(id, { before: baseline, after, version: this.sequence });
    this.changed();
  }
  private changed() {
    for (const listener of this.saveListeners) listener();
    if (this.getSaveState() === "saved") {
      for (const waiter of this.idleWaiters) waiter.resolve();
      this.idleWaiters.clear();
    }
  }
  waitUntilSaved(signal?: AbortSignal): Promise<void> {
    if (this.getSaveState() === "saved") return Promise.resolve();
    if (this.connectionStatus !== "online")
      return Promise.reject(new Error("Diagram has unsaved offline changes."));
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.idleWaiters.delete(waiter);
        waiter.reject(new Error("Diagram save cancelled."));
      };
      const waiter = {
        resolve: () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        },
        reject: (error: Error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      this.idleWaiters.add(waiter);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  adopt(generation: string, fence: string) {
    if (this.adoption !== null || this.getSaveState() !== "saved")
      throw new Error("Diagram editor is busy.");
    this.adoption = { generation, fence };
  }
  cancelAdoption() {
    if (this.adoption === null && this.pendingAdoption === null) return false;
    this.disconnect();
    return true;
  }
  completeAdoptionAfterRemoteOperation() {
    const adoption = this.pendingAdoption;
    if (!adoption || adoption.acknowledgedServerClock === null) return;
    this.pendingAdoption = null;
    this.acknowledge(adoption.clientClock, adoption.acknowledgedServerClock);
    this.onFenceReleased?.();
  }
  private receive(event: DiagramSyncEvent) {
    if (this.disposed) return;
    const raw: unknown = JSON.parse(event.message);
    const header = decodeHeader(raw);
    if (header.type === "diagram-closed") {
      this.disconnect();
      return;
    }
    if (header.type === "diagram-ready") {
      if (this.connectionId !== event.connectionId || this.connectionStatus !== "online") {
        this.connectionId = event.connectionId;
        this.connectionStatus = "online";
        this.pushedSequences.clear();
        for (const listener of this.statusListeners) listener({ status: "online" });
        this.changed();
      }
      return;
    }
    if (event.connectionId !== this.connectionId) return;
    if (header.type === "custom") {
      const envelope = decodePayload(raw);
      if (isAck(envelope.data)) {
        const ack = envelope.data;
        if (
          !this.pendingAdoption ||
          ack.clientClock !== this.pendingAdoption.clientClock ||
          ack.generation !== this.pendingAdoption.generation ||
          ack.fence !== this.pendingAdoption.fence
        )
          return;
        if (this.pendingAdoption.acknowledgedServerClock !== null) return;
        this.pendingAdoption.acknowledgedServerClock = ack.serverClock;
        for (const listener of this.listeners)
          listener({
            type: "push_result",
            clientClock: ack.clientClock,
            serverClock: ack.serverClock,
            action: "discard",
          });
        return;
      }
      if (isCommit(envelope.data)) {
        const commit = envelope.data;
        this.onCommit?.({
          ...commit,
          mutation: {
            ...commit.mutation,
            puts: commit.mutation.puts.map(parseDocumentRecord),
            expected: commit.mutation.expected.map((entry) => ({
              ...entry,
              record: entry.record === null ? null : parseDocumentRecord(entry.record),
            })),
          },
        });
        return;
      }
      if (isRelease(envelope.data)) {
        this.onFenceReleased?.(envelope.data);
        return;
      }
    }
    // The SDK validates record payloads and schema migrations when applying its protocol.
    const message = decodeMessage(raw);
    if (message.type === "data") {
      if (Array.isArray(message.data))
        for (const item of message.data)
          if (isResult(item)) this.acknowledge(item.clientClock, item.serverClock);
    } else if (isResult(message)) this.acknowledge(message.clientClock, message.serverClock);
    for (const listener of this.listeners) listener(message);
    if (message.type === "connect") {
      this.hydrated = true;
      this.changed();
    }
    if (typeof message.serverClock === "number")
      this.revision = Math.max(this.revision, message.serverClock);
  }
  private acknowledge(clock: number, revision: number) {
    const pushed = this.pushedSequences.get(clock);
    if (pushed)
      for (const [id, entry] of this.dirty) {
        const confirmed = pushed.records.get(id);
        if (confirmed === undefined) continue;
        if (entry.version <= pushed.sequence || isEqual(entry.after, confirmed))
          this.dirty.delete(id);
        else this.dirty.set(id, { ...entry, before: confirmed });
      }
    this.pushedSequences.delete(clock);
    this.revision = Math.max(this.revision, revision);
    this.changed();
  }
  sendMessage(message: ClientMessage) {
    if (this.disposed || this.connectionStatus !== "online" || this.connectionId === null) return;
    let payload: unknown = message;
    if (isPush(message) && message.diff) {
      this.pushedSequences.set(message.clientClock, {
        sequence: this.sequence,
        records: new Map([...this.dirty].map(([id, entry]) => [id, entry.after])),
      });
      if (this.adoption) {
        payload = { type: "diagram-adoption", ...this.adoption, push: message };
        this.pendingAdoption = {
          ...this.adoption,
          clientClock: message.clientClock,
          acknowledgedServerClock: null,
        };
        this.adoption = null;
      }
      this.changed();
    }
    const connectionId = this.connectionId;
    this.sendTail = this.sendTail
      .then(async () => {
        if (
          this.disposed ||
          this.connectionStatus !== "online" ||
          this.connectionId !== connectionId
        )
          return;
        await this.options.api.syncSend({
          ...this.options.target,
          connectionId,
          message: JSON.stringify(payload),
        });
      })
      .catch(() => this.disconnect());
  }
  onReceiveMessage = (listener: (message: ServerMessage) => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  onStatusChange = (listener: (status: TLSocketStatusChangeEvent) => void) => {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  };
  private disconnect() {
    const uncertainAdoption = this.adoption !== null || this.pendingAdoption !== null;
    this.connectionStatus = "offline";
    this.connecting = false;
    this.hydrated = false;
    this.adoption = null;
    this.pendingAdoption = null;
    if (uncertainAdoption && !this.disposed) {
      // A fenced adoption starts with no pending human edits. Rehydrate its durable commit in a
      // fresh SDK client so an unacknowledged speculative echo cannot replay over newer work.
      this.disposed = true;
      this.unsubscribe?.();
      this.onAdoptionLost?.();
    } else this.onFenceReleased?.();
    for (const listener of this.statusListeners) listener({ status: "offline" });
    for (const waiter of this.idleWaiters)
      waiter.reject(new Error("Diagram disconnected before saving."));
    this.idleWaiters.clear();
    this.changed();
  }
  restart() {
    this.unsubscribe?.();
    this.disconnect();
    if (!this.disposed) this.connect();
  }
  close() {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.disconnect();
  }
}
