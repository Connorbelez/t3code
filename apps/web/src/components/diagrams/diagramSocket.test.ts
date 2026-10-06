// @vitest-environment jsdom
import * as NodeSqlite from "node:sqlite";
import { DiagramId, ProjectId } from "@t3tools/contracts";
import { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom, TLSyncClient } from "@tldraw/sync";
import { Editor, GeoShapeUtil, atom, createShapeId, createTLStore, type TLRecord } from "tldraw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DiagramSocket, parseDocumentRecord } from "./diagramSocket";

vi.hoisted(() =>
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  }),
);
const cleanups: (() => void)[] = [];

it("reads SDK user records from the authoritative document", () => {
  const record = {
    id: "user:canvas-reader",
    typeName: "user",
    name: "Canvas reader",
    color: "#02B1CC",
    imageUrl: "",
    meta: {},
  };
  expect(parseDocumentRecord(record)).toEqual({
    id: "user:canvas-reader",
    typeName: "user",
    name: "Canvas reader",
    color: "#02B1CC",
    imageUrl: "",
    meta: {},
  });
  expect(() => parseDocumentRecord({ ...record, name: 123 })).toThrow();
});

let schedulerTime = Date.now();
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(schedulerTime);
  vi.stubGlobal("__FORCE_RAF_IN_TESTS__", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
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
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  await vi.advanceTimersByTimeAsync(64);
  schedulerTime = Date.now();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fixture() {
  const database = new NodeSqlite.DatabaseSync(":memory:");
  const storage = new SQLiteSyncStorage<TLRecord>({
    sql: Object.assign(new NodeSqliteWrapper(database), { config: {} }),
  });
  const room = new TLSocketRoom<TLRecord>({ storage });
  cleanups.push(() => {
    room.close();
    database.close();
  });
  let adoptionClock: number | null = null;
  let adoptionFence = "";
  let dropAdoptionAck = false;
  function mount(sessionId: string) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const editor = new Editor({
      store: createTLStore(),
      shapeUtils: [GeoShapeUtil],
      bindingUtils: [],
      tools: [],
      getContainer: () => container,
    });
    const loaded = deferred();
    let pausedMessages: string[] | null = null;
    let receive!: (event: { connectionId: string; message: string }) => void;
    const socket = new DiagramSocket({
      target: {
        projectId: ProjectId.make("project"),
        diagramId: DiagramId.make("00000000-0000-4000-8000-000000000001"),
      },
      clientId: sessionId,
      subscribe: (_input, onMessage) => {
        receive = onMessage;
        queueMicrotask(() =>
          onMessage({
            connectionId: sessionId,
            message: JSON.stringify({ type: "diagram-ready" }),
          }),
        );
        room.handleSocketConnect({
          sessionId,
          socket: {
            readyState: 1,
            send: (message) => {
              queueMicrotask(() => {
                if (pausedMessages) pausedMessages.push(message);
                else onMessage({ connectionId: sessionId, message });
              });
            },
            close() {},
          },
        });
        return () => room.handleSocketClose(sessionId);
      },
      api: {
        syncSend: async ({ message }) => {
          const parsed = JSON.parse(message);
          if (parsed.type === "diagram-adoption") {
            adoptionClock = parsed.push.clientClock;
            adoptionFence = parsed.fence;
            if (!dropAdoptionAck)
              queueMicrotask(() =>
                room.sendCustomMessage(sessionId, {
                  type: "diagram-adoption-ack",
                  generation: parsed.generation,
                  fence: parsed.fence,
                  clientClock: parsed.push.clientClock,
                  serverClock: storage.getClock(),
                }),
              );
          } else room.handleSocketMessage(sessionId, message);
        },
      },
    });
    const handlers = (["shape", "binding", "asset", "page", "document"] as const).flatMap(
      (type) => [
        editor.store.sideEffects.registerAfterCreateHandler<typeof type>(type, (record, source) => {
          if (source === "user") socket.recordLocalChange(null, record);
        }),
        editor.store.sideEffects.registerAfterDeleteHandler<typeof type>(type, (record, source) => {
          if (source === "user") socket.recordLocalChange(record, null);
        }),
        editor.store.sideEffects.registerAfterChangeHandler<typeof type>(
          type,
          (before, after, source) => {
            if (source === "user") socket.recordLocalChange(before, after);
          },
        ),
      ],
    );
    handlers.push(
      editor.store.sideEffects.registerOperationCompleteHandler((source) => {
        if (source === "remote") socket.completeAdoptionAfterRemoteOperation();
      }),
    );
    const client = new TLSyncClient({
      store: editor.store,
      socket,
      presence: atom<TLRecord | null>("presence", null),
      onLoad: () => loaded.resolve(),
      onSyncError: (reason) => {
        throw new Error(reason);
      },
    });
    cleanups.push(() => {
      client.close();
      socket.close();
      for (const remove of handlers) remove();
      editor.dispose();
      container.remove();
    });
    return {
      editor,
      socket,
      loaded: loaded.promise,
      receive: (message: unknown) =>
        receive({ connectionId: sessionId, message: JSON.stringify(message) }),
      pause: () => {
        pausedMessages = [];
      },
      resume: () => {
        const messages = pausedMessages ?? [];
        pausedMessages = null;
        for (const message of messages) receive({ connectionId: sessionId, message });
      },
    };
  }
  return {
    room,
    storage,
    mount,
    adoption: () => ({ clock: adoptionClock, fence: adoptionFence }),
    dropAdoptionAck: () => {
      dropAdoptionAck = true;
    },
  };
}

describe("production diagram socket", () => {
  it("reports pending before SDK emission and Saved after real SQLite acknowledgment, including a net-zero edit", async () => {
    const { mount, room } = fixture();
    const host = mount("host");
    const remote = mount("remote");
    expect(host.socket.getSaveState()).toBe("connecting");
    await Promise.all([host.loaded, remote.loaded]);
    const id = createShapeId("human");
    host.editor.createShape({ id, type: "geo", x: 10 });
    expect(host.socket.getSaveState()).toBe("pending");
    await vi.advanceTimersByTimeAsync(64);
    expect(host.socket.getSaveState()).toBe("saved");
    expect(room.getRecord(id)).toMatchObject({ x: 10 });
    expect(remote.editor.getShape(id)).toMatchObject({ x: 10 });
    host.editor.run(() => {
      host.editor.updateShape({ id, type: "geo", x: 90 });
      host.editor.updateShape({ id, type: "geo", x: 10 });
    });
    expect(host.socket.getSaveState()).toBe("saved");
    await host.socket.waitUntilSaved();
    expect(room.getRecord(id)).toMatchObject({ x: 10 });
  });

  it("keeps a reverted local edit pending while its earlier write is awaiting acknowledgment", async () => {
    const { mount, room } = fixture();
    const host = mount("host");
    const remote = mount("remote");
    await Promise.all([host.loaded, remote.loaded]);
    const id = createShapeId("reverted");
    host.editor.createShape({ id, type: "geo", x: 10 });
    await vi.advanceTimersByTimeAsync(64);
    host.pause();
    host.editor.updateShape({ id, type: "geo", x: 90 });
    await vi.advanceTimersByTimeAsync(64);
    expect(room.getRecord(id)).toMatchObject({ x: 90 });
    host.editor.updateShape({ id, type: "geo", x: 10 });
    expect(host.socket.getSaveState()).toBe("pending");
    host.resume();
    expect(host.socket.getSaveState()).toBe("pending");
    await vi.advanceTimersByTimeAsync(64);
    expect(room.getRecord(id)).toMatchObject({ x: 10 });
    expect(remote.editor.getShape(id)).toMatchObject({ x: 10 });
    expect(host.socket.getSaveState()).toBe("saved");
  });

  it("adopts a committed batch as local Undo and suppresses its echo while ignoring a foreign ACK", async () => {
    const { mount, room, storage, adoption } = fixture();
    const host = mount("host");
    const remote = mount("remote");
    await Promise.all([host.loaded, remote.loaded]);
    const id = createShapeId("human");
    host.editor.createShape({ id, type: "geo", x: 10 });
    await vi.advanceTimersByTimeAsync(64);
    expect(host.socket.getSaveState()).toBe("saved");
    const before = host.editor.getShape(id)!;
    const after = { ...before, x: 120 };
    let releases = 0;
    host.socket.onFenceReleased = () => {
      releases += 1;
    };
    host.socket.onCommit = (commit) => {
      host.socket.adopt(commit.generation, commit.fence);
      host.editor.markHistoryStoppingPoint("agent");
      host.editor.run(() => host.editor.store.put([...commit.mutation.puts]));
      host.editor.markHistoryStoppingPoint("after agent");
    };
    storage.transaction((txn) => txn.set(id, after));
    room.sendCustomMessage("host", {
      type: "diagram-commit",
      generation: "generation",
      fence: "fence",
      mutation: {
        namespace: "provider",
        requestId: "agent",
        expected: [{ id, record: before }],
        puts: [after],
        deletes: [],
      },
      receipt: {
        namespace: "provider",
        requestId: "agent",
        revision: storage.getClock(),
        changedRecordIds: [id],
      },
    });
    await vi.advanceTimersByTimeAsync(64);
    expect(adoption().fence).toBe("fence");
    expect(releases).toBe(1);
    host.receive({
      type: "custom",
      data: {
        type: "diagram-adoption-ack",
        generation: "other",
        fence: "fence",
        clientClock: adoption().clock,
        serverClock: storage.getClock(),
      },
    });
    expect(releases).toBe(1);
    expect(host.editor.getShape(id)?.x).toBe(120);
    expect(remote.editor.getShape(id)?.x).toBe(120);
    host.editor.undo();
    await vi.advanceTimersByTimeAsync(64);
    expect(room.getRecord(id)).toMatchObject({ x: 10 });
    expect(remote.editor.getShape(id)?.x).toBe(10);
    expect(host.socket.getSaveState()).toBe("saved");
  });

  it("rehydrates a committed adoption after lost acknowledgment without replaying over newer remote work", async () => {
    const { mount, room, storage, dropAdoptionAck } = fixture();
    const host = mount("host");
    const remote = mount("remote");
    await Promise.all([host.loaded, remote.loaded]);
    const id = createShapeId("lost-ack");
    host.editor.createShape({ id, type: "geo", x: 10 });
    await vi.advanceTimersByTimeAsync(64);
    const before = host.editor.getShape(id)!;
    const after = { ...before, x: 120 };
    dropAdoptionAck();
    host.socket.onCommit = (commit) => {
      host.socket.adopt(commit.generation, commit.fence);
      host.editor.run(() => host.editor.store.put([...commit.mutation.puts]));
    };
    storage.transaction((txn) => txn.set(id, after));
    room.sendCustomMessage("host", {
      type: "diagram-commit",
      generation: "generation",
      fence: "fence",
      mutation: {
        namespace: "provider",
        requestId: "agent",
        expected: [{ id, record: before }],
        puts: [after],
        deletes: [],
      },
      receipt: {
        namespace: "provider",
        requestId: "agent",
        revision: storage.getClock(),
        changedRecordIds: [id],
      },
    });
    await vi.advanceTimersByTimeAsync(64);
    expect(host.socket.getSaveState()).toBe("pending");
    remote.editor.updateShape({ id, type: "geo", x: 250 });
    await vi.advanceTimersByTimeAsync(64);
    let adoptionLost = 0;
    host.socket.onAdoptionLost = () => {
      adoptionLost += 1;
    };
    host.receive({ type: "diagram-closed" });
    host.socket.restart();
    expect(adoptionLost).toBe(1);
    const recovered = mount("recovered-host");
    await recovered.loaded;
    await vi.advanceTimersByTimeAsync(64);
    expect(recovered.editor.getShape(id)?.x).toBe(250);
    expect(room.getRecord(id)).toMatchObject({ x: 250 });
    expect(recovered.socket.getSaveState()).toBe("saved");
  });

  it("holds the fence after ACK receipt until actual SDK rebase and safely disconnects before that frame", async () => {
    const { mount, room, storage, adoption, dropAdoptionAck } = fixture();
    const host = mount("host");
    const remote = mount("remote");
    await Promise.all([host.loaded, remote.loaded]);
    const id = createShapeId("ack-before-frame");
    host.editor.createShape({ id, type: "geo", x: 10 });
    await vi.advanceTimersByTimeAsync(64);
    const before = host.editor.getShape(id)!;
    const after = { ...before, x: 120 };
    dropAdoptionAck();
    host.socket.onCommit = (commit) => {
      host.socket.adopt(commit.generation, commit.fence);
      host.editor.run(() => host.editor.store.put([...commit.mutation.puts]));
    };
    storage.transaction((txn) => txn.set(id, after));
    room.sendCustomMessage("host", {
      type: "diagram-commit",
      generation: "generation",
      fence: "fence",
      mutation: {
        namespace: "provider",
        requestId: "agent",
        expected: [{ id, record: before }],
        puts: [after],
        deletes: [],
      },
      receipt: {
        namespace: "provider",
        requestId: "agent",
        revision: storage.getClock(),
        changedRecordIds: [id],
      },
    });
    await vi.advanceTimersByTimeAsync(64);
    let releases = 0;
    let adoptionLost = 0;
    host.socket.onFenceReleased = () => {
      releases += 1;
    };
    host.socket.onAdoptionLost = () => {
      adoptionLost += 1;
    };
    host.receive({
      type: "custom",
      data: {
        type: "diagram-adoption-ack",
        generation: "generation",
        fence: "fence",
        clientClock: adoption().clock,
        serverClock: storage.getClock(),
      },
    });
    expect(releases).toBe(0);
    expect(host.socket.getSaveState()).toBe("pending");
    host.receive({ type: "diagram-closed" });
    expect(adoptionLost).toBe(1);
    remote.editor.updateShape({ id, type: "geo", x: 250 });
    await vi.advanceTimersByTimeAsync(64);
    const recovered = mount("recovered-host");
    await recovered.loaded;
    await vi.advanceTimersByTimeAsync(64);
    expect(room.getRecord(id)).toMatchObject({ x: 250 });
    expect(recovered.editor.getShape(id)?.x).toBe(250);
  });
});
