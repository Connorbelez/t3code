// @vitest-environment jsdom
import { createDiagramSchema } from "../../src/components/diagrams/diagramSchema";
import { HtmlArtifactShapeUtil } from "../../src/components/diagrams/HtmlArtifactShapeUtil";
import {
  TLSyncClient,
  type TLPersistentClientSocket,
  type TLSocketStatusChangeEvent,
} from "@tldraw/sync";
import {
  Editor,
  atom,
  createBindingId,
  createShapeId,
  createTLStore,
  defaultShapeUtils,
  defaultBindingUtils,
  defaultTools,
  defaultShapeTools,
  defaultAddFontsFromNode,
  tipTapDefaultExtensions,
  getArrowInfo,
  isEqual,
  type TLAnyShapeUtilConstructor,
  type TLRecord,
} from "tldraw";
import {
  rehearseDiagramChanges,
  validateDiagramBatch,
} from "../../src/components/diagrams/diagramBatchPreflight";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DiagramDatabase,
  diagramRecordFingerprint,
  type DiagramCommitEnvelope,
  type DiagramMutation,
  type DiagramRoom,
} from "../../../server/src/diagrams/DiagramRoom.ts";

vi.hoisted(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
});

type SDKMessage = {
  type: string;
  clientClock: number;
  diff?: unknown;
  data: { type: string; clientClock: number; serverClock: number };
  serverClock?: number;
  action?: string;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class MemorySocket implements TLPersistentClientSocket<SDKMessage, SDKMessage> {
  connectionStatus: "online" | "offline" | "error" = "online";
  readonly received: SDKMessage[] = [];
  readonly sent: SDKMessage[] = [];
  private listeners = new Set<(message: SDKMessage) => void>();
  private statusListeners = new Set<(status: TLSocketStatusChangeEvent) => void>();
  adoption?: ReturnType<DiagramRoom["fenceHost"]>;
  holdAdoption = false;
  pendingAdoption?: { fence: ReturnType<DiagramRoom["fenceHost"]>; message: SDKMessage };
  readonly adoptionEmitted = deferred<void>();
  readonly adoptionAcknowledged = deferred<void>();
  ignoreCommit = false;
  readonly owner: DiagramRoom;
  readonly sessionId: string;

  constructor(owner: DiagramRoom, sessionId: string) {
    this.owner = owner;
    this.sessionId = sessionId;
    this.attach();
  }

  private attach() {
    this.owner.room.handleSocketConnect({
      sessionId: this.sessionId,
      socket: {
        readyState: 1,
        send: (serialized) => {
          queueMicrotask(() => this.receive(JSON.parse(serialized)));
        },
        close: () => this.close(),
      },
    });
  }

  receive(message: SDKMessage) {
    if (this.connectionStatus !== "online") return;
    this.received.push(message);
    if (message.type === "custom" && message.data.type === "diagram-commit" && this.ignoreCommit)
      return;
    if (message.type === "custom" && message.data.type === "diagram-adoption-ack") {
      const { clientClock, serverClock } = message.data;
      message = {
        type: "push_result",
        clientClock,
        serverClock,
        action: "discard",
        data: message.data,
      };
      this.adoptionAcknowledged.resolve();
    }
    for (const listener of this.listeners) listener(message);
  }

  sendMessage(message: SDKMessage) {
    this.sent.push(message);
    if (message.type === "push" && this.adoption) {
      const fence = this.adoption;
      delete this.adoption;
      this.adoptionEmitted.resolve();
      if (this.holdAdoption) {
        this.pendingAdoption = { fence, message };
        return;
      }
      this.owner.acknowledgeAdoption(fence, message);
      return;
    }
    this.owner.room.handleSocketMessage(this.sessionId, JSON.stringify(message));
  }

  onReceiveMessage = (listener: (message: SDKMessage) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  onStatusChange = (listener: (status: TLSocketStatusChangeEvent) => void) => {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  };
  restart() {
    this.close();
    this.reconnect();
  }
  reconnect() {
    this.connectionStatus = "online";
    this.attach();
    for (const listener of this.statusListeners) listener({ status: "online" });
  }
  close() {
    if (this.connectionStatus === "offline") return;
    this.connectionStatus = "offline";
    this.owner.disconnectHost(this.sessionId);
    this.owner.room.handleSocketClose(this.sessionId);
    for (const listener of this.statusListeners) listener({ status: "offline" });
  }
}

function documentRecords(editor: Editor) {
  return editor.store
    .allRecords()
    .filter((record) => editor.store.schema.types[record.typeName].scope === "document");
}

function shapeAt(editor: Editor, id: ReturnType<typeof createShapeId>, x: number | undefined) {
  const milestone = deferred<void>();
  if (editor.getShape(id)?.x === x) {
    milestone.resolve();
    return milestone.promise;
  }
  const unlisten = editor.store.listen(
    () => {
      if (editor.getShape(id)?.x === x) {
        unlisten();
        milestone.resolve();
      }
    },
    { scope: "document" },
  );
  return milestone.promise;
}

async function sdkFrames() {
  await vi.advanceTimersByTimeAsync(64);
}

function mount(owner: DiagramRoom, sessionId: string, generation: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const editor = new Editor({
    store: createTLStore({ schema: createDiagramSchema() }),
    shapeUtils: [
      ...defaultShapeUtils,
      HtmlArtifactShapeUtil,
    ] as unknown as readonly TLAnyShapeUtilConstructor[],
    bindingUtils: defaultBindingUtils,
    tools: [...defaultTools, ...defaultShapeTools],
    initialState: "select",
    textOptions: {
      addFontsFromNode: defaultAddFontsFromNode,
      tipTapConfig: { extensions: tipTapDefaultExtensions },
    },
    getContainer: () => container,
  });
  const socket = new MemorySocket(owner, sessionId);
  const loaded = deferred<void>();
  const client = new TLSyncClient({
    store: editor.store,
    socket,
    presence: atom<TLRecord | null>("presence", null),
    onLoad: () => loaded.resolve(),
    onSyncError: (reason) => {
      throw new Error(reason);
    },
    onCustomMessageReceived: (raw) => {
      const event = raw as DiagramCommitEnvelope;
      if (event.type !== "diagram-commit") return;
      expect(event.generation).toBe(generation);
      for (const expected of event.mutation.expected)
        expect(editor.store.get(expected.id as TLRecord["id"]) ?? null).toEqual(expected.record);
      socket.adoption = { sessionId, generation, token: event.fence };
      editor.markHistoryStoppingPoint("agent batch");
      editor.run(() => {
        editor.store.put([...event.mutation.puts]);
        editor.store.remove(event.mutation.deletes as TLRecord["id"][]);
      });
      editor.markHistoryStoppingPoint("after agent batch");
    },
  });
  owner.registerHost(sessionId, generation);
  return {
    editor,
    socket,
    loaded: loaded.promise,
    dispose: () => {
      client.close();
      editor.dispose();
      container.remove();
    },
  };
}

const dispose: (() => void)[] = [];
let schedulerTime = Date.now();
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(schedulerTime);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      addEventListener() {},
      removeEventListener() {},
      check: () => true,
      load: () => Promise.resolve([]),
      ready: Promise.resolve(),
    },
  });
});
afterEach(async () => {
  for (const cleanup of dispose.splice(0).toReversed()) cleanup();
  await sdkFrames();
  schedulerTime = Date.now();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SDK diagram commit protocol", () => {
  it("rehearses bound HTML artifact move and resize as one synced Undo step and reconnects", async () => {
    const database = new DiagramDatabase(":memory:");
    dispose.push(() => database.close());
    const owner = database.create("00000000-0000-4000-8000-000000000020", "project");
    const host = mount(owner, "host", "generation");
    const remote = mount(owner, "remote", "remote-generation");
    dispose.push(host.dispose, remote.dispose);
    await Promise.all([host.loaded, remote.loaded]);
    const artifactId = createShapeId("bound-artifact");
    const arrowId = createShapeId("artifact-arrow");
    const bindingId = createBindingId("artifact-binding");
    host.editor.createShapes([
      {
        id: artifactId,
        type: "html-artifact",
        x: 10,
        y: 10,
        props: {
          w: 640,
          h: 480,
          title: "Bound artifact",
          source: { kind: "file", path: "mock.html" },
        },
      },
      { id: arrowId, type: "arrow", x: -200, y: 250, props: { end: { x: 100, y: 0 } } },
    ]);
    host.editor.createBinding({
      id: bindingId,
      type: "arrow",
      fromId: arrowId,
      toId: artifactId,
      props: {
        terminal: "end",
        normalizedAnchor: { x: 0.5, y: 0.5 },
        isExact: true,
        isPrecise: true,
        snap: "none",
      },
    });
    host.editor.markHistoryStoppingPoint("bound artifact created");
    await sdkFrames();
    await shapeAt(remote.editor, artifactId, 10);
    const endpoint = (editor: Editor) => {
      const info = getArrowInfo(editor, arrowId);
      const transform = editor.getShapePageTransform(arrowId);
      if (!info || !transform) throw new Error("Missing arrow geometry");
      const point = transform.applyToPoint(info.end.handle);
      return { x: point.x, y: point.y };
    };
    expect(endpoint(host.editor)).toEqual({ x: 330, y: 250 });
    const records = host.editor.store.serialize("document");
    const before = host.editor.getShape(artifactId);
    if (!before || before.type !== "html-artifact") throw new Error("Missing HTML artifact");
    const after = rehearseDiagramChanges(
      host.editor,
      records,
      [{ ...before, x: 120, y: 240, props: { ...before.props, w: 800, h: 600 } }],
      [],
    );
    const puts = Object.values(after).filter((record) => !isEqual(records[record.id], record));
    const batch = {
      requestId: "bound-artifact-move-resize",
      expected: Object.values(records).map((record) => ({ id: record.id, record })),
      puts,
      deletes: [],
    };
    expect(() => validateDiagramBatch(host.editor, batch)).not.toThrow();
    expect(host.editor.store.serialize("document")).toEqual(records);
    const fence = owner.fenceHost(
      "host",
      "generation",
      diagramRecordFingerprint(documentRecords(host.editor)),
    );
    owner.commit({ ...batch, namespace: "provider" }, fence);
    await sdkFrames();
    await host.socket.adoptionAcknowledged.promise;
    await shapeAt(remote.editor, artifactId, 120);
    for (const editor of [host.editor, remote.editor]) {
      expect(editor.getShape(artifactId)).toMatchObject({ props: { w: 800, h: 600 } });
      expect(editor.getBinding(bindingId)).toMatchObject({ fromId: arrowId, toId: artifactId });
      expect(endpoint(editor)).toEqual({ x: 520, y: 540 });
    }
    remote.socket.restart();
    await sdkFrames();
    expect(endpoint(remote.editor)).toEqual({ x: 520, y: 540 });
    host.editor.undo();
    await sdkFrames();
    await shapeAt(remote.editor, artifactId, 10);
    for (const editor of [host.editor, remote.editor]) {
      expect(editor.getShape(artifactId)).toEqual(before);
      expect(editor.getBinding(bindingId)).toMatchObject({ toId: artifactId });
      expect(endpoint(editor)).toEqual({ x: 330, y: 250 });
    }
  });

  it.each([
    { scheduled: false, artifact: false },
    { scheduled: true, artifact: false },
    { scheduled: false, artifact: true },
    { scheduled: true, artifact: true },
  ])("adopts a durable batch as one host Undo step %j", async ({ scheduled, artifact }) => {
    vi.stubGlobal("__FORCE_RAF_IN_TESTS__", scheduled);
    const database = new DiagramDatabase(":memory:");
    dispose.push(() => database.close());
    const owner = database.create("00000000-0000-4000-8000-000000000001", "project");
    const host = mount(owner, "host", "generation");
    const remote = mount(owner, "remote", "remote-generation");
    dispose.push(host.dispose, remote.dispose);
    await Promise.all([host.loaded, remote.loaded]);
    host.editor.markHistoryStoppingPoint("before human");
    if (artifact) {
      host.editor.createShape({
        id: createShapeId("human"),
        type: "html-artifact",
        x: 10,
        y: 10,
        props: {
          w: 640,
          h: 480,
          title: "Interactive plan",
          source: { kind: "inline", html: "<input value=hello>" },
        },
      });
    } else {
      host.editor.createShape({ id: createShapeId("human"), type: "geo", x: 10, y: 10 });
    }
    host.editor.markHistoryStoppingPoint("after human");
    await sdkFrames();
    await shapeAt(remote.editor, createShapeId("human"), 10);
    remote.editor.markHistoryStoppingPoint("remote human");
    remote.editor.createShape({ id: createShapeId("remote-human"), type: "geo", x: 80 });
    remote.editor.markHistoryStoppingPoint("after remote human");
    await sdkFrames();
    await shapeAt(host.editor, createShapeId("remote-human"), 80);
    const before = host.editor.getShape(createShapeId("human"))!;
    const page = host.editor.getCurrentPage();
    const mutation: DiagramMutation = {
      namespace: "provider",
      requestId: "agent",
      expected: [
        { id: before.id, record: before },
        { id: page.id, record: page },
      ],
      puts: [{ ...before, x: 120, y: 240 }],
      deletes: [],
    };
    const fence = owner.fenceHost(
      "host",
      "generation",
      diagramRecordFingerprint(documentRecords(host.editor)),
    );
    const receipt = owner.commit(mutation, fence);
    await sdkFrames();
    await host.socket.adoptionAcknowledged.promise;
    await Promise.all([
      shapeAt(host.editor, createShapeId("human"), 120),
      shapeAt(remote.editor, createShapeId("human"), 120),
    ]);
    expect(receipt.changedRecordIds).toEqual([createShapeId("human")]);
    expect(host.editor.getShape(createShapeId("human"))?.x).toBe(120);
    expect(remote.editor.getShape(createShapeId("human"))?.x).toBe(120);
    const hostMessages = host.socket.received.map((message) =>
      message.type === "custom" ? message.data.type : message.type,
    );
    expect(hostMessages.indexOf("diagram-commit")).toBeLessThan(
      hostMessages.indexOf("diagram-adoption-ack"),
    );
    host.editor.markHistoryStoppingPoint("later human");
    host.editor.updateShape({ id: createShapeId("human"), type: before.type, x: 400 });
    host.editor.markHistoryStoppingPoint("after later human");
    await sdkFrames();
    await shapeAt(remote.editor, createShapeId("human"), 400);
    host.editor.undo();
    await sdkFrames();
    await shapeAt(remote.editor, createShapeId("human"), 120);
    expect(host.editor.getShape(createShapeId("human"))?.x).toBe(120);
    host.editor.undo();
    await sdkFrames();
    await shapeAt(remote.editor, createShapeId("human"), 10);
    expect(host.editor.getShape(createShapeId("human"))?.x).toBe(10);
    host.editor.undo();
    expect(host.editor.getShape(createShapeId("human"))).toBeUndefined();
    expect(remote.editor.getCanUndo()).toBe(true);
    remote.editor.undo();
    expect(remote.editor.getShape(createShapeId("remote-human"))).toBeUndefined();
    expect(remote.editor.getCanUndo()).toBe(false);
    expect(remote.editor.getShape(createShapeId("human"))?.x).toBe(10);
  });

  it("suppresses the adoption echo while a newer remote target edit commits", async () => {
    vi.stubGlobal("__FORCE_RAF_IN_TESTS__", true);
    const database = new DiagramDatabase(":memory:");
    dispose.push(() => database.close());
    const owner = database.create("00000000-0000-4000-8000-000000000002", "project");
    const host = mount(owner, "host", "generation");
    const remote = mount(owner, "remote", "remote-generation");
    dispose.push(host.dispose, remote.dispose);
    await Promise.all([host.loaded, remote.loaded]);
    host.editor.createShape({ id: createShapeId("target"), type: "geo", x: 10 });
    await sdkFrames();
    await shapeAt(remote.editor, createShapeId("target"), 10);
    const before = host.editor.getShape(createShapeId("target"))!;
    const page = host.editor.getCurrentPage();
    const mutation: DiagramMutation = {
      namespace: "provider",
      requestId: "agent",
      expected: [
        { id: before.id, record: before },
        { id: page.id, record: page },
      ],
      puts: [{ ...before, x: 120 }],
      deletes: [],
    };
    host.socket.holdAdoption = true;
    const receipt = owner.commit(
      mutation,
      owner.fenceHost("host", "generation", diagramRecordFingerprint(documentRecords(host.editor))),
    );
    await sdkFrames();
    expect(host.socket.pendingAdoption).toBeDefined();
    await host.socket.adoptionEmitted.promise;
    expect(remote.editor.getShape(createShapeId("target"))?.x).toBe(120);
    await shapeAt(remote.editor, createShapeId("target"), 120);
    remote.editor.markHistoryStoppingPoint("newer remote edit");
    remote.editor.updateShape({ id: before.id, type: "geo", x: 180 });
    remote.editor.markHistoryStoppingPoint("after newer remote edit");
    await sdkFrames();
    expect(owner.room.getRecord(before.id)).toMatchObject({ x: 180 });
    const adoption = host.socket.pendingAdoption!;
    owner.acknowledgeAdoption(adoption.fence, adoption.message);
    await sdkFrames();
    expect(host.socket.received.at(-1)?.data?.type).toBe("diagram-adoption-ack");
    await host.socket.adoptionAcknowledged.promise;
    expect(host.editor.getShape(before.id)?.x).toBe(180);
    await shapeAt(host.editor, before.id, 180);
    expect(owner.room.getRecord(before.id)).toMatchObject({ x: 180 });
    expect(remote.editor.getShape(before.id)?.x).toBe(180);
    expect(owner.getReceipt("provider", "agent")).toEqual(receipt);
    remote.editor.undo();
    await sdkFrames();
    expect(host.editor.getShape(before.id)?.x).toBe(120);
    await shapeAt(host.editor, before.id, 120);
    expect(remote.editor.getShape(before.id)?.x).toBe(120);
  });

  it("demonstrates that after-patch reverse and local reconstruction corrupts the speculative baseline", async () => {
    const database = new DiagramDatabase(":memory:");
    dispose.push(() => database.close());
    const owner = database.create("00000000-0000-4000-8000-000000000003", "project");
    const host = mount(owner, "host", "generation");
    const remote = mount(owner, "remote", "remote-generation");
    dispose.push(host.dispose, remote.dispose);
    await Promise.all([host.loaded, remote.loaded]);
    host.editor.createShape({ id: createShapeId("target"), type: "geo", x: 10 });
    await sdkFrames();
    const before = host.editor.getShape(createShapeId("target"))!;
    const after = { ...before, x: 120 };
    const page = host.editor.getCurrentPage();
    host.socket.ignoreCommit = true;
    owner.commit(
      {
        namespace: "provider",
        requestId: "agent",
        expected: [
          { id: before.id, record: before },
          { id: page.id, record: page },
        ],
        puts: [after],
        deletes: [],
      },
      owner.fenceHost("host", "generation", diagramRecordFingerprint(documentRecords(host.editor))),
    );
    await sdkFrames();
    await shapeAt(host.editor, before.id, 120);
    host.editor.store.mergeRemoteChanges(() => host.editor.store.put([before]));
    host.editor.markHistoryStoppingPoint("incorrect reconstruction");
    host.editor.run(() => host.editor.store.put([after]));
    await sdkFrames();
    await shapeAt(host.editor, before.id, 10);
    expect(owner.room.getRecord(before.id)).toMatchObject({ x: 120 });
    expect(remote.editor.getShape(before.id)?.x).toBe(120);
    expect(host.editor.getShape(before.id)?.x).toBe(10);
  });

  it("preserves the receipt after host disconnect before adoption and reconnects as remote work", async () => {
    vi.stubGlobal("__FORCE_RAF_IN_TESTS__", true);
    const database = new DiagramDatabase(":memory:");
    dispose.push(() => database.close());
    const owner = database.create("00000000-0000-4000-8000-000000000004", "project");
    const host = mount(owner, "host", "generation");
    const remote = mount(owner, "remote", "remote-generation");
    dispose.push(host.dispose, remote.dispose);
    await Promise.all([host.loaded, remote.loaded]);
    host.editor.createShape({ id: createShapeId("target"), type: "geo", x: 10 });
    host.editor.markHistoryStoppingPoint("before agent");
    await sdkFrames();
    const before = host.editor.getShape(createShapeId("target"))!;
    const page = host.editor.getCurrentPage();
    const mutation: DiagramMutation = {
      namespace: "provider",
      requestId: "agent",
      expected: [
        { id: before.id, record: before },
        { id: page.id, record: page },
      ],
      puts: [{ ...before, x: 120 }],
      deletes: [],
    };
    const fence = owner.fenceHost(
      "host",
      "generation",
      diagramRecordFingerprint(documentRecords(host.editor)),
    );
    const receipt = owner.commit(mutation, fence);
    host.socket.close();
    await sdkFrames();
    await shapeAt(remote.editor, before.id, 120);
    expect(host.editor.getShape(before.id)?.x).toBe(10);
    expect(owner.getReceipt("provider", "agent")).toEqual(receipt);
    host.socket.reconnect();
    await sdkFrames();
    await shapeAt(host.editor, before.id, 120);
    expect(owner.commit(mutation, fence)).toEqual(receipt);
    expect(host.socket.sent.filter((message) => message.type === "push")).toHaveLength(1);
    host.editor.undo();
    expect(host.editor.getShape(before.id)).toBeUndefined();
  });

  it("never replays a canceled agent mutation and saves an unrelated offline human edit", async () => {
    vi.stubGlobal("__FORCE_RAF_IN_TESTS__", true);
    const database = new DiagramDatabase(":memory:");
    dispose.push(() => database.close());
    const owner = database.create("00000000-0000-4000-8000-000000000005", "project");
    const host = mount(owner, "host", "generation");
    const remote = mount(owner, "remote", "remote-generation");
    dispose.push(host.dispose, remote.dispose);
    await Promise.all([host.loaded, remote.loaded]);
    host.editor.createShape({ id: createShapeId("target"), type: "geo", x: 10 });
    await sdkFrames();
    const before = host.editor.getShape(createShapeId("target"))!;
    const page = host.editor.getCurrentPage();
    const mutation: DiagramMutation = {
      namespace: "provider",
      requestId: "agent",
      expected: [
        { id: before.id, record: before },
        { id: page.id, record: page },
      ],
      puts: [{ ...before, x: 120 }],
      deletes: [],
    };
    const fence = owner.fenceHost(
      "host",
      "generation",
      diagramRecordFingerprint(documentRecords(host.editor)),
    );
    owner.releaseFence(fence);
    expect(() => owner.commit(mutation, fence)).toThrow("host-unavailable");
    host.socket.close();
    host.editor.updateShape({ id: before.id, type: "geo", x: 22 });
    remote.editor.createShape({ id: createShapeId("remote"), type: "geo", x: 80 });
    await sdkFrames();
    expect(owner.room.getRecord(before.id)).toMatchObject({ x: 10 });
    host.socket.reconnect();
    await sdkFrames();
    await Promise.all([
      shapeAt(host.editor, before.id, 22),
      shapeAt(remote.editor, before.id, 22),
      shapeAt(host.editor, createShapeId("remote"), 80),
    ]);
    expect(owner.room.getRecord(before.id)).toMatchObject({ x: 22 });
    expect(owner.getReceipt("provider", "agent")).toBeNull();
    expect(
      host.socket.received.filter(
        (message) => message.type === "custom" && message.data.type === "diagram-commit",
      ),
    ).toHaveLength(0);
  });
});
