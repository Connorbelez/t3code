import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { PageRecordType, createBindingId, createShapeId } from "@tldraw/tlschema";
import { describe, expect, it, vi } from "vite-plus/test";
import { DiagramDatabase, type DiagramMutation, type DiagramRoom } from "./DiagramRoom.ts";

function fixture() {
  const database = new DiagramDatabase(":memory:");
  const room = database.create(NodeCrypto.randomUUID(), "project");
  room.registerHost("host", "generation");
  const page = room.read().find((record) => record.typeName === "page")!;
  const group = room.schema.types.shape.create({
    id: createShapeId("group"),
    type: "group",
    parentId: page.id,
    index: page.index,
    props: {},
  });
  const child = room.schema.types.shape.create({
    id: createShapeId("child"),
    type: "group",
    parentId: group.id,
    index: page.index,
    props: {},
  });
  if (group.typeName !== "shape" || child.typeName !== "shape")
    throw new Error("Expected SDK shape records");
  room.storage.transaction((txn) => {
    txn.set(group.id, group);
    txn.set(child.id, child);
  });
  const mutation: DiagramMutation = {
    namespace: "provider",
    requestId: "agent",
    expected: [
      { id: child.id, record: child },
      { id: group.id, record: group },
      { id: page.id, record: page },
    ],
    puts: [{ ...child, x: 100 }],
    deletes: [],
  };
  return { database, room, page, group, child, mutation };
}

function fence(room: DiagramRoom) {
  return room.fenceHost("host", "generation", room.fingerprint());
}

describe("durable diagram transactions", () => {
  it("reads persisted records without retaining idle SDK room timers", () => {
    vi.useFakeTimers();
    const database = new DiagramDatabase(":memory:");
    try {
      const id = NodeCrypto.randomUUID();
      const room = database.create(id, "project");
      const records = room.read();
      database.releaseIdle(id);
      expect(room.room.isClosed()).toBe(true);
      vi.runAllTicks();
      for (let index = 0; index < 3; index++) expect(database.read(id)).toEqual(records);
      expect(vi.getTimerCount()).toBe(0);
      const reopened = database.open(id);
      expect(reopened.room.isClosed()).toBe(false);
      expect(reopened.read()).toEqual(records);
      database.releaseIdle(id);
      vi.runAllTicks();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      database.close();
      vi.useRealTimers();
    }
  });

  effectIt.effect(
    "commits records with a receipt and resolves the same request after restart",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "diagram-room-" });
        const path = paths.join(directory, "diagrams.sqlite");
        const id = NodeCrypto.randomUUID();
        let database = new DiagramDatabase(path);
        try {
          const room = database.create(id, "project-a");
          room.registerHost("host", "generation-a");
          const fence = room.fenceHost("host", "generation-a", room.fingerprint());
          const page = PageRecordType.create({
            id: PageRecordType.createId("agent-page"),
            name: "Agent page",
            index: room.read().find((record) => record.typeName === "page")!.index,
          });
          const mutation: DiagramMutation = {
            namespace: "provider-a",
            requestId: "request-a",
            expected: [{ id: page.id, record: null }],
            puts: [page],
            deletes: [],
          };
          expect(room.commit(mutation, fence)).toEqual({
            namespace: "provider-a",
            requestId: "request-a",
            revision: 1,
            changedRecordIds: ["page:agent-page"],
          });
          expect(room.read().find((record) => record.id === page.id)).toEqual(page);
          database.close();
          database = new DiagramDatabase(path);
          const reopened = database.open(id);
          expect(reopened.commit(mutation, fence)).toEqual({
            namespace: "provider-a",
            requestId: "request-a",
            revision: 1,
            changedRecordIds: ["page:agent-page"],
          });
          expect(reopened.read().find((record) => record.id === page.id)).toEqual(page);
          expect(() =>
            reopened.commit({ ...mutation, puts: [{ ...page, name: "Changed request" }] }, fence),
          ).toThrow("request-mismatch");
        } finally {
          database.close();
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("allows a disjoint durable edit and rejects a changed target atomically", () => {
    const { database, room, child, page, mutation } = fixture();
    try {
      const activeFence = fence(room);
      const unrelated = PageRecordType.create({
        id: PageRecordType.createId("unrelated"),
        name: "Unrelated",
        index: page.index,
      });
      room.storage.transaction((txn) => txn.set(unrelated.id, unrelated));
      expect(room.commit(mutation, activeFence).changedRecordIds).toEqual(["shape:child"]);
      room.releaseFence(activeFence);
      const current = room.room.getRecord(child.id);
      const staleMutation = { ...mutation, requestId: "stale", puts: [{ ...child, x: 400 }] };
      expect(() => room.commit(staleMutation, fence(room))).toThrow("stale");
      expect(room.room.getRecord(child.id)).toEqual(current);
      expect(room.getReceipt("provider", "stale")).toBeNull();
    } finally {
      database.close();
    }
  });

  it("requires the parent and ancestor page and refuses a locked ancestor", () => {
    const { database, room, group, mutation } = fixture();
    try {
      const activeFence = fence(room);
      expect(() =>
        room.commit({ ...mutation, expected: mutation.expected.slice(0, 1) }, activeFence),
      ).toThrow("dependency");
      room.storage.transaction((txn) => txn.set(group.id, { ...group, isLocked: true }));
      expect(() => room.commit(mutation, activeFence)).toThrow("stale");
      const lockedMutation = {
        ...mutation,
        expected: mutation.expected.map((record) =>
          record.id === group.id ? { ...record, record: { ...group, isLocked: true } } : record,
        ),
      };
      expect(() => room.commit(lockedMutation, activeFence)).toThrow("locked");
      expect(room.getReceipt("provider", "agent")).toBeNull();
    } finally {
      database.close();
    }
  });

  it("rejects incomplete parent deletion and schema-invalid writes", () => {
    const { database, room, group, child, mutation } = fixture();
    try {
      const activeFence = fence(room);
      expect(() =>
        room.commit({ ...mutation, puts: [], deletes: [group.id] }, activeFence),
      ).toThrow("dependency");
      expect(() =>
        room.commit({ ...mutation, puts: [{ ...child, x: Number.NaN }] }, activeFence),
      ).toThrow();
      expect(room.getReceipt("provider", "agent")).toBeNull();
    } finally {
      database.close();
    }
  });

  it.each(["diagram_receipts", "diagrams"])(
    "rolls records and revision back when %s persistence fails",
    (table) => {
      const { database, room, child, mutation } = fixture();
      try {
        const activeFence = fence(room);
        const beforeClock = room.storage.getClock();
        database.database.exec(
          `CREATE TRIGGER failed_write BEFORE ${table === "diagrams" ? "UPDATE" : "INSERT"} ON ${table} BEGIN SELECT RAISE(ABORT, 'forced failure'); END;`,
        );
        expect(() => room.commit(mutation, activeFence)).toThrow("forced failure");
        expect(room.room.getRecord(child.id)).toEqual(child);
        expect(room.storage.getClock()).toBe(beforeClock);
        expect(room.getReceipt("provider", "agent")).toBeNull();
        expect(
          database.database.prepare("SELECT revision FROM diagrams WHERE id = ?").get(room.id)
            ?.revision,
        ).toBe(beforeClock);
        database.database.exec("DROP TRIGGER failed_write");
        expect(room.commit(mutation, activeFence).changedRecordIds).toEqual(["shape:child"]);
      } finally {
        database.close();
      }
    },
  );

  it.each(["cancel", "disconnect", "replace"])(
    "rejects %s before commit with no document change or receipt",
    (reason) => {
      const { database, room, child, mutation } = fixture();
      try {
        const activeFence = fence(room);
        if (reason === "cancel") room.releaseFence(activeFence);
        else if (reason === "disconnect") room.disconnectHost("host");
        else room.registerHost("host", "replacement");
        expect(() => room.commit(mutation, activeFence)).toThrow("host-unavailable");
        expect(room.room.getRecord(child.id)).toEqual(child);
        expect(room.getReceipt("provider", "agent")).toBeNull();
      } finally {
        database.close();
      }
    },
  );

  it("preserves committed work after cancellation and disconnect", () => {
    const { database, room, mutation } = fixture();
    try {
      const activeFence = fence(room);
      const receipt = room.commit(mutation, activeFence);
      room.releaseFence(activeFence);
      room.disconnectHost("host");
      expect(room.commit(mutation, activeFence)).toEqual(receipt);
      expect(room.room.getRecord("shape:child")).toMatchObject({ x: 100 });
    } finally {
      database.close();
    }
  });

  it("fences stale agent and SDK writes after archive and project removal", () => {
    const { database, room, child, mutation } = fixture();
    try {
      const activeFence = fence(room);
      room.setState("archived");
      expect(() => room.commit(mutation, activeFence)).toThrow("inactive");
      expect(() =>
        room.storage.transaction((txn) => txn.set(child.id, { ...child, x: 80 })),
      ).toThrow("inactive");
      room.setState("active");
      room.registerHost("host", "generation");
      const replacementFence = fence(room);
      database.removeProject("project");
      database.removeProject("project");
      expect(() => room.commit(mutation, replacementFence)).toThrow("inactive");
      expect(() => database.create(NodeCrypto.randomUUID(), "project")).toThrow("inactive");
      expect(() => room.storage.transaction((txn) => txn.delete(child.id))).toThrow("inactive");
      expect(room.room.getRecord(child.id)).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("requires binding and endpoint records and rejects a nonexistent endpoint", () => {
    const { database, room, child, group, mutation } = fixture();
    try {
      const binding = room.schema.types.binding.create({
        id: createBindingId("binding"),
        type: "arrow",
        fromId: child.id,
        toId: group.id,
        props: {
          terminal: "start",
          normalizedAnchor: { x: 0.5, y: 0.5 },
          isExact: false,
          isPrecise: false,
          snap: "none",
        },
      });
      room.storage.transaction((txn) => txn.set(binding.id, binding));
      const activeFence = fence(room);
      expect(() => room.commit(mutation, activeFence)).toThrow("dependency");
      const complete = {
        ...mutation,
        expected: [...mutation.expected, { id: binding.id, record: binding }],
      };
      expect(room.commit(complete, activeFence).changedRecordIds).toEqual(["shape:child"]);
      room.releaseFence(activeFence);
      if (binding.typeName !== "binding") throw new Error("Expected SDK binding");
      const missing = createShapeId("missing");
      expect(() =>
        room.commit(
          {
            namespace: "provider",
            requestId: "missing",
            expected: [
              { id: binding.id, record: binding },
              { id: child.id, record: room.room.getRecord(child.id) },
              { id: group.id, record: group },
              { id: missing, record: null },
            ],
            puts: [{ ...binding, toId: missing }],
            deletes: [],
          },
          fence(room),
        ),
      ).toThrow("dependency");
      expect(room.getReceipt("provider", "missing")).toBeNull();
    } finally {
      database.close();
    }
  });

  it("rejects binding changes and deletion when an endpoint or its ancestor is locked", () => {
    for (const lockedId of ["shape:child", "shape:group"]) {
      const { database, room, child, group, page } = fixture();
      try {
        const binding = room.schema.types.binding.create({
          id: createBindingId("locked-binding"),
          type: "arrow",
          fromId: child.id,
          toId: group.id,
          props: {
            terminal: "start",
            normalizedAnchor: { x: 0.5, y: 0.5 },
            isExact: false,
            isPrecise: false,
            snap: "none",
          },
        });
        if (binding.typeName !== "binding") throw new Error("Expected SDK binding");
        room.storage.transaction((txn) => {
          txn.set(binding.id, binding);
          const locked = lockedId === child.id ? child : group;
          txn.set(locked.id, { ...locked, isLocked: true });
        });
        for (const remove of [false, true]) {
          const activeFence = fence(room);
          const requestId = `${lockedId}:${remove}`;
          const dependencies = new Set<string>([binding.id, child.id, group.id, page.id]);
          expect(() =>
            room.commit(
              {
                namespace: "provider",
                requestId,
                expected: room
                  .read()
                  .filter((record) => dependencies.has(record.id))
                  .map((record) => ({ id: record.id, record })),
                puts: remove
                  ? []
                  : [
                      {
                        ...binding,
                        props: { ...binding.props, normalizedAnchor: { x: 0.1, y: 0.1 } },
                      },
                    ],
                deletes: remove ? [binding.id] : [],
              },
              activeFence,
            ),
          ).toThrow("locked");
          expect(room.room.getRecord(binding.id)).toEqual(binding);
          expect(room.getReceipt("provider", requestId)).toBeNull();
          room.releaseFence(activeFence);
        }
      } finally {
        database.close();
      }
    }
  });

  it("permits a complete parent-child deletion and rejects deleting the last page", () => {
    const { database, room, group, child, page, mutation } = fixture();
    try {
      const activeFence = fence(room);
      expect(
        room.commit({ ...mutation, puts: [], deletes: [child.id, group.id] }, activeFence)
          .changedRecordIds,
      ).toEqual(["shape:child", "shape:group"]);
      expect(room.room.getRecord(child.id)).toBeUndefined();
      expect(room.room.getRecord(group.id)).toBeUndefined();
      room.releaseFence(activeFence);
      expect(() =>
        room.commit(
          {
            namespace: "provider",
            requestId: "last-page",
            expected: [{ id: page.id, record: page }],
            puts: [],
            deletes: [page.id],
          },
          fence(room),
        ),
      ).toThrow("invalid");
      expect(room.getReceipt("provider", "last-page")).toBeNull();
    } finally {
      database.close();
    }
  });

  it("creates a parent with its child in one atomic batch and rejects a parent cycle", () => {
    const { database, room, page } = fixture();
    try {
      const parent = room.schema.types.shape.create({
        id: createShapeId("new-parent"),
        type: "group",
        parentId: page.id,
        index: page.index,
        props: {},
      });
      const child = room.schema.types.shape.create({
        id: createShapeId("new-child"),
        type: "group",
        parentId: parent.id,
        index: page.index,
        props: {},
      });
      if (parent.typeName !== "shape" || child.typeName !== "shape")
        throw new Error("Expected SDK shapes");
      const activeFence = fence(room);
      const mutation = {
        namespace: "provider",
        requestId: "create",
        expected: [
          { id: parent.id, record: null },
          { id: child.id, record: null },
          { id: page.id, record: page },
        ],
        puts: [parent, child],
        deletes: [],
      };
      expect(room.commit(mutation, activeFence).changedRecordIds).toEqual([
        "shape:new-parent",
        "shape:new-child",
      ]);
      room.releaseFence(activeFence);
      expect(() =>
        room.commit(
          {
            namespace: "provider",
            requestId: "cycle",
            expected: [
              { id: parent.id, record: parent },
              { id: child.id, record: child },
              { id: page.id, record: page },
            ],
            puts: [{ ...parent, parentId: child.id }],
            deletes: [],
          },
          fence(room),
        ),
      ).toThrow("invalid");
    } finally {
      database.close();
    }
  });

  it("rejects a coalesced or incomplete adoption echo without losing the durable batch", () => {
    const { database, room, mutation } = fixture();
    try {
      const activeFence = fence(room);
      const receipt = room.commit(mutation, activeFence);
      expect(() =>
        room.acknowledgeAdoption(activeFence, {
          clientClock: 1,
          diff: {
            "shape:child": ["patch", { x: ["put", 100] }],
            "shape:group": ["patch", { x: ["put", 900] }],
          },
        }),
      ).toThrow("invalid");
      expect(() => room.acknowledgeAdoption(activeFence, { clientClock: 1, diff: {} })).toThrow(
        "invalid",
      );
      expect(room.getReceipt("provider", "agent")).toEqual(receipt);
      expect(room.room.getRecord("shape:child")).toMatchObject({ x: 100 });
    } finally {
      database.close();
    }
  });
});
