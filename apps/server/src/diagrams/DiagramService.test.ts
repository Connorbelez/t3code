import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  DiagramCapture,
  DiagramScope,
  DiagramOperationError,
  type DiagramMetadata,
} from "@t3tools/contracts";
import { PageRecordType, AssetRecordType, createTLSchema } from "@tldraw/tlschema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as DiagramService from "./DiagramService.ts";
import { diagramRecordFingerprint } from "./DiagramRoom.ts";

const environmentId = EnvironmentId.make("environment:diagram-tests");
const projectId = ProjectId.make("project:diagram-tests");
const otherProjectId = ProjectId.make("project:diagram-other");
const sdkSchema = createTLSchema();
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const dependencies = Layer.mergeAll(
  ProjectStore.layer,
  ServerSecretStore.layer,
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(environmentId),
  }),
).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "diagram-service-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const id of [projectId, otherProjectId])
    yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,default_model_selection_json,scripts_json,created_at,updated_at,deleted_at) VALUES (${id},'Diagrams',${`/test/${id}`},NULL,'[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL)`;
});

function document(name = "Imported page") {
  return {
    tldrawFileFormatVersion: 1,
    schema: sdkSchema.serialize(),
    records: [
      sdkSchema.types.page.validate({
        id: PageRecordType.createId("imported"),
        typeName: "page",
        meta: {},
        name,
        index: "a1",
      }),
    ],
  };
}

const connect = Effect.fn(function* (
  service: DiagramService.DiagramService["Service"],
  diagram: DiagramMetadata,
  control?: { entered: Deferred.Deferred<void>; continue: Deferred.Deferred<void> },
) {
  const ready = yield* Deferred.make<string>();
  const connected = yield* Deferred.make<void>();
  const committed = yield* Deferred.make<{ generation: string; fence: string }>();
  const adopted = yield* Deferred.make<void>();
  const released = yield* Deferred.make<void>();
  const stream = yield* service.syncConnect({
    ...diagram,
    diagramId: diagram.id,
    clientId: "editor",
    sdkVersion: "5.5.2",
  });
  yield* Stream.runForEach(stream, (event) =>
    Effect.gen(function* () {
      const message = decode(event.message);
      if (!message || typeof message !== "object" || !("type" in message)) return;
      if (message.type === "diagram-ready") yield* Deferred.succeed(ready, event.connectionId);
      if (message.type === "connect") yield* Deferred.succeed(connected, undefined);
      if (message.type === "custom" && "data" in message) {
        const data = message.data;
        if (
          Schema.is(
            Schema.Struct({
              type: Schema.Literal("diagram-commit"),
              generation: Schema.String,
              fence: Schema.String,
            }),
          )(data)
        )
          yield* Deferred.succeed(committed, data);
        if (
          Schema.is(
            Schema.Struct({
              type: Schema.Literal("diagram-adoption-ack"),
              generation: Schema.String,
              fence: Schema.String,
            }),
          )(data)
        )
          yield* Deferred.succeed(adopted, undefined);
        if (
          Schema.is(
            Schema.Struct({
              type: Schema.Literal("diagram-fence-release"),
              generation: Schema.String,
              requestId: Schema.String,
            }),
          )(data)
        )
          yield* Deferred.succeed(released, undefined);
      }
    }),
  ).pipe(Effect.forkScoped);
  const connectionId = yield* Deferred.await(ready);
  yield* service.syncSend({
    projectId,
    diagramId: diagram.id,
    connectionId,
    message: encode({
      type: "connect",
      connectRequestId: "initial",
      schema: sdkSchema.serialize(),
      protocolVersion: 8,
      lastServerClock: -1,
    }),
  });
  yield* Deferred.await(connected);
  const hostReady = yield* Deferred.make<void>();
  const hosts = yield* service.hostConnect({
    clientId: "editor",
    environmentId,
    sdkVersion: "5.5.2",
    focused: true,
  });
  yield* Stream.runForEach(hosts, (request) =>
    Effect.gen(function* () {
      if (request.operation === "ready") {
        yield* Deferred.succeed(hostReady, undefined);
        return;
      }
      if (request.operation === "prepare-batch") {
        if (control) {
          yield* Deferred.succeed(control.entered, undefined);
          yield* Deferred.await(control.continue);
        }
        const current = yield* service.read({
          projectId,
          diagramId: diagram.id,
          includeRecords: true,
        });
        yield* service.hostRespond({
          requestId: request.requestId,
          connectionId: request.connectionId,
          result: {
            ok: true,
            value: {
              connectionId,
              fingerprint: diagramRecordFingerprint(
                current.records.map((item) => {
                  const { typeName } = Schema.decodeUnknownSync(
                    Schema.Struct({ typeName: Schema.String }),
                  )(item);
                  const type = Object.values(sdkSchema.types).find(
                    (type) => type.typeName === typeName,
                  );
                  if (!type) throw new Error("Unknown SDK record type");
                  return type.validate(item);
                }),
              ),
            },
          },
        });
      } else {
        const input = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ scope: DiagramScope, revision: Schema.Number }),
        )(request.input);
        const capture: DiagramCapture = {
          diagramId: diagram.id,
          revision: input.revision,
          scope: input.scope,
          bounds: { x: 0, y: 0, w: 1, h: 1 },
          width: 1,
          height: 1,
          mimeType: "image/png",
          base64: "aW1hZ2U=",
        };
        yield* service.hostRespond({
          requestId: request.requestId,
          connectionId: request.connectionId,
          result: { ok: true, value: capture },
        });
      }
    }),
  ).pipe(Effect.forkScoped);
  yield* Deferred.await(hostReady);
  return { connectionId, committed, adopted, released };
});

it.effect("selects the mounted host and refuses a busy context even when images are optional", () =>
  Effect.gen(function* () {
    yield* seed;
    const service = yield* DiagramService.make;
    const diagram = yield* service.create({ projectId, name: "Busy diagram" });
    const pageId = (yield* service.read({ projectId, diagramId: diagram.id })).structure.pages[0]!
      .id;
    for (const mounted of [false, true]) {
      const ready = yield* Deferred.make<void>();
      const stream = yield* service.hostConnect({
        clientId: mounted ? "mounted" : "focused-empty",
        environmentId,
        sdkVersion: "5.5.2",
        focused: !mounted,
        mountedDiagramIds: mounted ? [diagram.id] : [],
      });
      yield* Stream.runForEach(stream, (request) =>
        Effect.gen(function* () {
          if (request.operation === "ready") {
            yield* Deferred.succeed(ready, undefined);
            return;
          }
          yield* service.hostRespond({
            requestId: request.requestId,
            connectionId: request.connectionId,
            result: {
              ok: false,
              error: new DiagramOperationError({ code: mounted ? "busy" : "no-editor" }),
            },
          });
        }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(ready);
    }
    const failure = yield* Effect.flip(
      service.prepareContext({
        projectId,
        diagramId: diagram.id,
        scope: { kind: "diagram", pageId },
        allowImageUnavailable: true,
      }),
    );
    assert.equal(failure.code, "busy");
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("persists native documents across service restart and enforces project ownership", () =>
  Effect.gen(function* () {
    yield* seed;
    const saved = yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DiagramService.make;
        const diagram = yield* service.importDocument({
          projectId,
          name: "Plan",
          document: document(),
        });
        assert.deepEqual(
          (yield* service.read({
            projectId,
            diagramId: diagram.id,
            includeRecords: true,
          })).records.map(
            (item) => Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(item).id,
          ),
          ["page:imported"],
        );
        return diagram;
      }),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DiagramService.make;
        assert.equal(
          (yield* service.read({ projectId, diagramId: saved.id })).structure.pages[0]?.name,
          "Imported page",
        );
        assert.equal(
          (yield* Effect.flip(service.read({ projectId: otherProjectId, diagramId: saved.id })))
            .code,
          "not-found",
        );
        yield* service.lifecycle({ projectId, diagramId: saved.id, operation: "archive" });
        assert.deepEqual(yield* service.count(projectId), { active: 0, archived: 1 });
        assert.deepEqual(yield* service.list({ projectId }), []);
        yield* service.lifecycle({ projectId, diagramId: saved.id, operation: "restore" });
        assert.deepEqual(yield* service.count(projectId), { active: 1, archived: 0 });
      }),
    );
  }).pipe(Effect.provide(dependencies)),
);

it.effect(
  "commits one correlated batch, returns its receipt on retry and releases stale work",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* DiagramService.make;
      const diagram = yield* service.create({ projectId, name: "Agent" });
      const host = yield* connect(service, diagram);
      const page = sdkSchema.types.page.validate({
        id: PageRecordType.createId("agent"),
        typeName: "page",
        meta: {},
        name: "Agent page",
        index: "a2",
      });
      const input = {
        projectId,
        diagramId: diagram.id,
        namespace: "provider-session",
        batch: {
          requestId: "agent-1",
          expected: [{ id: page.id, record: null }],
          puts: [page],
          deletes: [],
        },
      };
      const receipt = yield* service.applyBatch(input);
      assert.deepEqual(receipt, {
        requestId: "agent-1",
        revision: 1,
        changedRecordIds: ["page:agent"],
      });
      const committed = yield* Deferred.await(host.committed);
      yield* service.syncSend({
        projectId,
        diagramId: diagram.id,
        connectionId: host.connectionId,
        message: encode({
          type: "diagram-adoption",
          generation: committed.generation,
          fence: committed.fence,
          push: { type: "push", clientClock: 1, diff: { [page.id]: ["put", page] } },
        }),
      });
      yield* Deferred.await(host.adopted);
      assert.deepEqual(yield* service.applyBatch(input), receipt);
      assert.equal(
        (yield* Effect.flip(
          service.applyBatch({
            ...input,
            batch: { ...input.batch, puts: [{ ...page, name: "Different" }] },
          }),
        )).code,
        "request-collision",
      );
      assert.equal(
        (yield* Effect.flip(
          service.applyBatch({
            ...input,
            batch: { ...input.batch, requestId: "stale", puts: [{ ...page, name: "Overwrite" }] },
          }),
        )).code,
        "stale",
      );
      yield* Deferred.await(host.released);
      assert.equal(
        yield* service.receipt({
          projectId,
          diagramId: diagram.id,
          namespace: "provider-session",
          requestId: "stale",
        }),
        null,
      );
      assert.equal(
        (yield* service.read({ projectId, diagramId: diagram.id })).structure.pages.find(
          (item) => item.id === page.id,
        )?.name,
        "Agent page",
      );
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect(
  "archives and project removal invalidate stale sync writes and preserve other projects",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* DiagramService.make;
      const first = yield* service.create({ projectId, name: "First" });
      const other = yield* service.create({ projectId: otherProjectId, name: "Other" });
      const host = yield* connect(service, first);
      yield* service.lifecycle({ projectId, diagramId: first.id, operation: "archive" });
      assert.equal(
        (yield* Effect.flip(
          service.syncSend({
            projectId,
            diagramId: first.id,
            connectionId: host.connectionId,
            message: encode({ type: "push", clientClock: 1, diff: {} }),
          }),
        )).code,
        "disconnected",
      );
      yield* service.removeProject(projectId);
      assert.deepEqual(yield* service.count(projectId), { active: 0, archived: 0 });
      assert.equal(
        (yield* Effect.flip(service.read({ projectId, diagramId: first.id }))).code,
        "not-found",
      );
      assert.equal(
        (yield* service.read({ projectId: otherProjectId, diagramId: other.id })).diagram.name,
        "Other",
      );
      assert.equal(
        (yield* Effect.flip(service.create({ projectId, name: "Resurrection" }))).code,
        "archived",
      );
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("keeps an archived reader alive while its SDK handshake is pending", () =>
  Effect.gen(function* () {
    yield* seed;
    const service = yield* DiagramService.make;
    const diagram = yield* service.create({ projectId, name: "Archived reader" });
    yield* service.lifecycle({ projectId, diagramId: diagram.id, operation: "archive" });
    const reader = (clientId: string) =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<string>();
        const connected = yield* Deferred.make<unknown>();
        const stream = yield* service.syncConnect({
          projectId,
          diagramId: diagram.id,
          clientId,
          sdkVersion: "5.5.2",
        });
        const fiber = yield* stream.pipe(
          Stream.runForEach((event) => {
            const message = decode(event.message);
            if (!message || typeof message !== "object" || !("type" in message)) return Effect.void;
            if (message.type === "diagram-ready")
              return Deferred.succeed(ready, event.connectionId);
            if (message.type === "connect") return Deferred.succeed(connected, message);
            return Effect.void;
          }),
          Effect.forkScoped,
        );
        return { connectionId: yield* Deferred.await(ready), connected, fiber };
      });
    const handshake = (connectionId: string) =>
      service.syncSend({
        projectId,
        diagramId: diagram.id,
        connectionId,
        message: encode({
          type: "connect",
          connectRequestId: connectionId,
          schema: sdkSchema.serialize(),
          protocolVersion: 8,
          lastServerClock: -1,
        }),
      });
    const first = yield* reader("first-readonly-editor");
    yield* handshake(first.connectionId);
    yield* Deferred.await(first.connected);
    const next = yield* reader("next-readonly-editor");
    const current = yield* service.read({ projectId, diagramId: diagram.id, includeRecords: true });
    assert.isNotNull(current.diagram.archivedAt);
    yield* Fiber.interrupt(first.fiber);
    yield* handshake(next.connectionId);
    assert.isTrue(
      Schema.is(
        Schema.Struct({ type: Schema.Literal("connect"), isReadonly: Schema.Literal(true) }),
      )(yield* Deferred.await(next.connected)),
    );
    assert.deepEqual(
      (yield* service.read({ projectId, diagramId: diagram.id, includeRecords: true })).records,
      current.records,
    );
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("restore closes archived readonly sessions before a writable reconnect", () =>
  Effect.gen(function* () {
    yield* seed;
    const service = yield* DiagramService.make;
    const diagram = yield* service.create({ projectId, name: "Restore" });
    yield* service.lifecycle({ projectId, diagramId: diagram.id, operation: "archive" });
    const readonly = yield* connect(service, diagram);
    yield* service.lifecycle({ projectId, diagramId: diagram.id, operation: "restore" });
    const page = sdkSchema.types.page.validate({
      id: PageRecordType.createId("restored"),
      typeName: "page",
      meta: {},
      name: "Restored page",
      index: "a2",
    });
    const push = encode({ type: "push", clientClock: 1, diff: { [page.id]: ["put", page] } });
    assert.equal(
      (yield* Effect.flip(
        service.syncSend({
          projectId,
          diagramId: diagram.id,
          connectionId: readonly.connectionId,
          message: push,
        }),
      )).code,
      "disconnected",
    );
    const writable = yield* connect(service, diagram);
    yield* service.syncSend({
      projectId,
      diagramId: diagram.id,
      connectionId: writable.connectionId,
      message: push,
    });
    assert.isTrue(
      (yield* service.read({ projectId, diagramId: diagram.id })).structure.pages.some(
        (item) => item.id === page.id,
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect(
  "round trips editable files and retains shared image bytes until the last diagram is removed",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* DiagramService.make;
      const empty = yield* service.create({ projectId, name: "Upload" });
      const upload = yield* service.assetUpload({
        projectId,
        diagramId: empty.id,
        name: "Image",
        mimeType: "image/png",
        base64: "aW1hZ2U=",
      });
      const asset = AssetRecordType.create({
        id: AssetRecordType.createId("image"),
        type: "image",
        props: {
          w: 1,
          h: 1,
          name: "Image",
          isAnimated: false,
          mimeType: "image/png",
          src: upload.src,
        },
      });
      const file = { ...document(), records: [...document().records, asset] };
      const first = yield* service.importDocument({
        projectId,
        name: "First image",
        document: file,
      });
      const second = yield* service.importDocument({
        projectId,
        name: "Shared image",
        document: file,
      });
      const exported = yield* service.exportDocument({ projectId, diagramId: first.id });
      assert.equal(exported.tldrawFileFormatVersion, 1);
      const exportedAsset = exported.records.find((item) => item.typeName === "asset");
      assert.isTrue(
        exportedAsset?.typeName === "asset" &&
          "src" in exportedAsset.props &&
          exportedAsset.props.src === "data:image/png;base64,aW1hZ2U=",
      );
      const imported = yield* service.importDocument({
        projectId,
        name: "Round trip",
        document: exported,
      });
      assert.equal(
        (yield* service.exportDocument({ projectId, diagramId: imported.id })).records.length,
        2,
      );
      assert.equal(
        (yield* Effect.flip(
          service.readAsset({
            projectId: otherProjectId,
            diagramId: (yield* service.create({ projectId: otherProjectId, name: "Foreign" })).id,
            assetId: upload.assetId,
          }),
        )).code,
        "assets-unavailable",
      );
      yield* service.lifecycle({ projectId, diagramId: first.id, operation: "delete" });
      assert.deepEqual(
        yield* service.readAsset({ projectId, diagramId: second.id, assetId: upload.assetId }),
        { mimeType: "image/png", base64: "aW1hZ2U=" },
      );
      yield* service.lifecycle({ projectId, diagramId: second.id, operation: "delete" });
      assert.equal(
        (yield* Effect.flip(
          service.readAsset({ projectId, diagramId: empty.id, assetId: upload.assetId }),
        )).code,
        "assets-unavailable",
      );
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("caches exact revision captures and marks previews stale after a durable edit", () =>
  Effect.gen(function* () {
    yield* seed;
    const service = yield* DiagramService.make;
    const diagram = yield* service.create({ projectId, name: "Capture" });
    const host = yield* connect(service, diagram);
    const read = yield* service.read({ projectId, diagramId: diagram.id });
    const pageId = read.structure.pages[0]?.id;
    if (!pageId) return yield* Effect.die("Missing SDK page");
    const captured = yield* service.capture({
      projectId,
      diagramId: diagram.id,
      scope: { kind: "diagram", pageId },
    });
    assert.equal((yield* service.preview({ projectId, diagramId: diagram.id })).stale, false);
    assert.equal(captured.revision, 0);
    const page = sdkSchema.types.page.validate({
      id: PageRecordType.createId("new"),
      typeName: "page",
      meta: {},
      name: "New",
      index: "a2",
    });
    yield* service.applyBatch({
      projectId,
      diagramId: diagram.id,
      namespace: "provider",
      batch: {
        requestId: "edit",
        expected: [{ id: page.id, record: null }],
        puts: [page],
        deletes: [],
      },
    });
    assert.equal((yield* service.preview({ projectId, diagramId: diagram.id })).stale, true);
    yield* service.syncDisconnect({ connectionId: host.connectionId });
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("fails disconnected visual work promptly without committing or replaying the batch", () =>
  Effect.gen(function* () {
    yield* seed;
    const service = yield* DiagramService.make;
    const diagram = yield* service.create({ projectId, name: "Disconnected" });
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const host = yield* connect(service, diagram, { entered, continue: resume });
    const page = sdkSchema.types.page.validate({
      id: "page:disconnected",
      typeName: "page",
      meta: {},
      name: "Failed page",
      index: "a2",
    });
    const turn = yield* service
      .applyBatch({
        projectId,
        diagramId: diagram.id,
        namespace: "provider",
        batch: {
          requestId: "failed",
          expected: [{ id: page.id, record: null }],
          puts: [page],
          deletes: [],
        },
      })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* service.syncDisconnect({ connectionId: host.connectionId });
    assert.equal((yield* Effect.flip(Fiber.join(turn))).code, "disconnected");
    assert.equal(
      yield* service.receipt({
        projectId,
        diagramId: diagram.id,
        namespace: "provider",
        requestId: "failed",
      }),
      null,
    );
    assert.equal(
      (yield* service.read({ projectId, diagramId: diagram.id })).structure.pages.some(
        (item) => item.id === page.id,
      ),
      false,
    );
    yield* Deferred.succeed(resume, undefined);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect(
  "migrates historical editable records before current SDK validation and returns page-space bounds",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* DiagramService.make;
      const current = sdkSchema.serialize();
      if (current.schemaVersion !== 2) return yield* Effect.die("Expected pinned SDK schema v2");
      const page = document().records[0]!;
      if (page.typeName !== "page") return yield* Effect.die("Expected SDK page");
      const base = sdkSchema.types.shape.create({
        id: "shape:legacy",
        type: "group",
        parentId: page.id,
        index: page.index,
        props: {},
      });
      const old = {
        ...base,
        type: "geo",
        x: 10,
        y: 20,
        props: {
          geo: "rectangle",
          dash: "draw",
          url: "",
          w: 100,
          h: 50,
          growY: 0,
          scale: 1,
          labelColor: "black",
          color: "black",
          fill: "none",
          size: "m",
          font: "draw",
          align: "middle",
          verticalAlign: "middle",
          text: "Legacy label",
        },
      };
      const imported = yield* service.importDocument({
        projectId,
        name: "Legacy",
        document: {
          tldrawFileFormatVersion: 1,
          schema: { ...current, sequences: { ...current.sequences, "com.tldraw.shape.geo": 9 } },
          records: [page, old],
        },
      });
      const result = yield* service.read({
        projectId,
        diagramId: imported.id,
        includeRecords: true,
      });
      assert.deepEqual(result.structure.shapes[0]?.bounds, { x: 10, y: 20, w: 100, h: 50 });
      assert.equal(result.structure.shapes[0]?.label, "Legacy label");
      assert.equal(
        (yield* Effect.flip(
          service.importDocument({
            projectId,
            name: "Unknown format",
            document: { ...document(), tldrawFileFormatVersion: 2 },
          }),
        )).code,
        "invalid-schema",
      );
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("validates names before storage writes and safely duplicates a maximum-length name", () =>
  Effect.gen(function* () {
    yield* seed;
    const service = yield* DiagramService.make;
    const name = "x".repeat(200);
    const original = yield* service.create({ projectId, name });
    const copied = yield* service.lifecycle({
      projectId,
      diagramId: original.id,
      operation: "duplicate",
    });
    assert.equal(copied?.name, `${"x".repeat(195)} copy`);
    for (const invalid of [" ", "x".repeat(201)]) {
      assert.equal(
        (yield* Effect.flip(service.create({ projectId, name: invalid }))).code,
        "invalid-records",
      );
      assert.equal(
        (yield* Effect.flip(
          service.importDocument({ projectId, name: invalid, document: document() }),
        )).code,
        "invalid-records",
      );
      assert.equal(
        (yield* Effect.flip(
          service.lifecycle({
            projectId,
            diagramId: original.id,
            operation: "rename",
            name: invalid,
          }),
        )).code,
        "invalid-records",
      );
      assert.equal(
        (yield* Effect.flip(
          service.lifecycle({
            projectId,
            diagramId: original.id,
            operation: "duplicate",
            name: invalid,
          }),
        )).code,
        "invalid-records",
      );
    }
    assert.equal((yield* service.list({ projectId })).length, 2);
    assert.equal((yield* service.read({ projectId, diagramId: original.id })).diagram.name, name);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("publishes committed lifecycle changes to the owning project", () =>
  Effect.gen(function* () {
    yield* seed;
    const service = yield* DiagramService.make;
    const stream = yield* service.changes({ projectId });
    const events = yield* Stream.runCollect(stream.pipe(Stream.take(6))).pipe(Effect.forkScoped);
    const diagram = yield* service.create({ projectId, name: "Metadata" });
    yield* service.create({ projectId: otherProjectId, name: "Other project" });
    yield* service.lifecycle({
      projectId,
      diagramId: diagram.id,
      operation: "rename",
      name: "Renamed",
    });
    yield* service.lifecycle({ projectId, diagramId: diagram.id, operation: "archive" });
    yield* service.lifecycle({ projectId, diagramId: diagram.id, operation: "restore" });
    yield* service.lifecycle({ projectId, diagramId: diagram.id, operation: "delete" });
    assert.deepEqual(Array.from(yield* Fiber.join(events)), [
      { projectId, diagramId: null },
      ...Array.from({ length: 5 }, () => ({ projectId, diagramId: diagram.id })),
    ]);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("prioritizes selected shapes and the active page in bounded chat structure", () =>
  Effect.gen(function* () {
    yield* seed;
    const service = yield* DiagramService.make;
    const page = document().records[0]!;
    if (page.typeName !== "page") return yield* Effect.die("Expected SDK page");
    const second = {
      ...page,
      id: PageRecordType.createId("second"),
      name: "Active page",
      index: "a2",
    };
    const shapes = Array.from({ length: 80 }, (_, index) =>
      sdkSchema.types.shape.create({
        id: `shape:item-${index}`,
        type: "group",
        parentId: index < 60 ? page.id : second.id,
        index: page.index,
        props: {},
      }),
    );
    const diagram = yield* service.importDocument({
      projectId,
      name: "Scopes",
      document: { ...document(), records: [page, second, ...shapes] },
    });
    const target = { projectId, diagramId: diagram.id, allowImageUnavailable: true };
    const selection = yield* service.prepareContext({
      ...target,
      scope: {
        kind: "selection",
        pageId: second.id,
        shapeIds: ["shape:item-79", "shape:item-78"],
        bounds: { x: 0, y: 0, w: 1, h: 1 },
      },
    });
    assert.deepEqual(
      selection.structure.shapes.map((shape) => shape.id),
      ["shape:item-79", "shape:item-78"],
    );
    const overview = yield* service.prepareContext({
      ...target,
      scope: { kind: "diagram", pageId: second.id },
    });
    assert.equal(overview.structure.shapes[0]?.pageId, second.id);
    assert.equal(overview.structure.pages.length, 2);
    assert.isTrue(overview.structure.truncated);
    assert.isBelow(Buffer.byteLength(encode(overview.structure)), 48 * 1024 + 1);
    const viewport = yield* service.prepareContext({
      ...target,
      scope: { kind: "viewport", pageId: second.id, bounds: { x: 0, y: 0, w: 1, h: 1 } },
    });
    assert.isTrue(viewport.structure.shapes.every((shape) => shape.pageId === second.id));
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);
