import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DiagramRecordId,
  type DiagramArtifactChange,
  EnvironmentId,
  ProjectId,
  type DiagramHtmlArtifactSource,
} from "@t3tools/contracts";
import { createDiagramSchema } from "@t3tools/diagram-compose/schema";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as AssetAccess from "../assets/AssetAccess.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PreviewBrowser from "../htmlRender/PreviewBrowser.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as DiagramArtifacts from "./DiagramArtifacts.ts";
import * as DiagramService from "./DiagramService.ts";

const projectId = ProjectId.make("project:html-artifact-tests");
const sdkSchema = createDiagramSchema();
const shapeId = DiagramRecordId.make("shape:html-artifact");
const dependencies = (executable?: string) =>
  DiagramArtifacts.layer.pipe(
    Layer.provideMerge(DiagramService.layer),
    Layer.provideMerge(WorkspaceFileSystem.layer),
    Layer.provideMerge(WorkspaceEntries.layer),
    Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
    Layer.provideMerge(
      Layer.mergeAll(
        ProjectStore.layer,
        WorkspacePaths.layer,
        ServerSecretStore.layer,
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:html-artifact-tests")),
        }),
        Layer.succeed(PreviewBrowser.PreviewBrowser, {
          executable: executable
            ? Effect.succeed(executable)
            : Effect.die("No browser configured for this test."),
          installed: Effect.succeed(Option.fromUndefinedOr(executable)),
        }),
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "html-artifact-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
const seed = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const sql = yield* SqlClient.SqlClient;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "html-artifact-workspace-" });
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,default_model_selection_json,scripts_json,created_at,updated_at,deleted_at) VALUES (${projectId},'HTML artifacts',${root},NULL,'[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL)`;
  return root;
});
const importArtifact = Effect.fn(function* (
  source: DiagramHtmlArtifactSource,
  dimensions = { w: 317, h: 228 },
) {
  const diagrams = yield* DiagramService.DiagramService;
  const page = sdkSchema.types.page.validate({
    id: "page:artifacts",
    typeName: "page",
    name: "Artifacts",
    index: "a1",
    meta: {},
  });
  const shape = sdkSchema.types.shape.validate({
    id: shapeId,
    typeName: "shape",
    type: "html-artifact",
    parentId: page.id,
    index: "a1",
    x: 0,
    y: 0,
    rotation: 0,
    opacity: 1,
    isLocked: false,
    meta: {},
    props: { ...dimensions, title: "Test artifact", source },
  });
  const diagram = yield* diagrams.importDocument({
    projectId,
    name: "Artifact",
    document: { tldrawFileFormatVersion: 1, schema: sdkSchema.serialize(), records: [page, shape] },
  });
  return { projectId, diagramId: diagram.id, shapeId };
});

it.live("reads inline source without an editor and reports stylesheet failures", () =>
  Effect.gen(function* () {
    yield* seed;
    const artifacts = yield* DiagramArtifacts.DiagramArtifacts;
    const target = yield* importArtifact({
      kind: "inline",
      html: '<div class="w-[317px]">Hello</div>',
    });
    const read = yield* artifacts.read(target);
    expect(read.html).toBe('<div class="w-[317px]">Hello</div>');
    expect(read.css).toContain("width: 317px");
    expect(read.baseUrl).toBeUndefined();
    expect((yield* artifacts.read(target)).version).toBe(read.version);
    const failed = yield* importArtifact({
      kind: "inline",
      html: '<style type="text/tailwindcss">.broken { @apply unknown-artifact-class; }</style>',
    });
    expect((yield* Effect.flip(artifacts.read(failed))).code).toBe("invalid-records");
    expect((yield* Effect.flip(artifacts.capture(failed))).code).toBe("invalid-records");
  }).pipe(Effect.scoped, Effect.provide(dependencies())),
);

it.live("delivers file source and signed sibling resources for a remote origin", () =>
  Effect.gen(function* () {
    const root = yield* seed;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const artifacts = yield* DiagramArtifacts.DiagramArtifacts;
    yield* fs.makeDirectory(path.join(root, "report"));
    yield* fs.writeFileString(
      path.join(root, "report/index.html"),
      '<link rel="stylesheet" href="theme.css"><script src="runtime.js"></script>',
    );
    yield* fs.writeFileString(path.join(root, "report/theme.css"), "body { background: red; }");
    yield* fs.writeFileString(
      path.join(root, "report/runtime.js"),
      "document.body.classList.add('flex');",
    );
    const target = yield* importArtifact({ kind: "file", path: "report/index.html" });
    const document = yield* artifacts.read(target);
    expect(document.html).toContain("theme.css");
    expect(document.baseUrl).toMatch(/^\/api\/assets\//);
    const base = new URL(document.baseUrl ?? "", "https://remote.t3.codes");
    expect(base.origin).toBe("https://remote.t3.codes");
    for (const name of ["index.html", "theme.css", "runtime.js"]) {
      const url = new URL(name, base);
      const [, , , token, resourcePath] = url.pathname.split("/");
      const resolved = yield* AssetAccess.resolveWorkspaceFileAsset(
        token ?? "",
        resourcePath ?? "",
      );
      expect(resolved?.path).toBe(path.join(root, "report", name));
    }
    const absoluteTarget = yield* importArtifact({
      kind: "file",
      path: path.join(root, "report/index.html"),
    });
    const absoluteRead = yield* artifacts.read(absoluteTarget);
    const absoluteBase = new URL(absoluteRead.baseUrl ?? "", "https://remote.t3.codes");
    const absoluteSibling = new URL("runtime.js", absoluteBase);
    expect(
      (yield* AssetAccess.resolveWorkspaceFileAsset(
        absoluteSibling.pathname.split("/")[3] ?? "",
        "runtime.js",
      ))?.path,
    ).toBe(path.join(root, "report/runtime.js"));
    const token = base.pathname.split("/")[3] ?? "";
    expect(yield* AssetAccess.resolveWorkspaceFileAsset(token, "../secret.html")).toBeNull();
    expect(
      yield* AssetAccess.resolveWorkspaceFileAsset(`${token}tampered`, "theme.css"),
    ).toBeNull();
  }).pipe(Effect.scoped, Effect.provide(dependencies())),
);

it.live("refuses a truncated file source rather than rendering partial HTML", () =>
  Effect.gen(function* () {
    const root = yield* seed;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const artifacts = yield* DiagramArtifacts.DiagramArtifacts;
    yield* fs.writeFileString(path.join(root, "large.html"), "x".repeat(1024 * 1024 + 1));
    const target = yield* importArtifact({ kind: "file", path: "large.html" });
    expect((yield* Effect.flip(artifacts.read(target))).code).toBe("too-large");
  }).pipe(Effect.scoped, Effect.provide(dependencies())),
);

it.live("reports real external edits, atomic replacement, missing source, and restoration", () =>
  Effect.gen(function* () {
    const root = yield* seed;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const artifacts = yield* DiagramArtifacts.DiagramArtifacts;
    const sourcePath = path.join(root, "report.html");
    yield* fs.writeFileString(sourcePath, "<h1>First</h1>");
    const target = yield* importArtifact({ kind: "file", path: "report.html" });
    const changes = yield* artifacts.watch(target);
    const milestones = yield* Queue.unbounded<DiagramArtifactChange>();
    const watcher = yield* Stream.runForEach(changes, (change) =>
      Queue.offer(milestones, change),
    ).pipe(Effect.forkScoped);
    const initial = yield* Queue.take(milestones);
    expect(initial.error).toBeUndefined();
    yield* fs.writeFileString(sourcePath, "<h1>External edit</h1>");
    const edited = yield* Queue.take(milestones);
    expect(edited.version).not.toBe(initial.version);
    expect((yield* artifacts.read(target)).html).toBe("<h1>External edit</h1>");
    yield* fs.writeFileString(path.join(root, "replacement.html"), "<h1>Atomic save</h1>");
    yield* fs.rename(path.join(root, "replacement.html"), sourcePath);
    const replaced = yield* Queue.take(milestones);
    expect(replaced.version).not.toBe(edited.version);
    yield* fs.remove(sourcePath);
    const missing = yield* Queue.take(milestones);
    expect(missing.error).toBe("The artifact source could not be read.");
    expect((yield* Effect.flip(artifacts.read(target))).code).toBe("assets-unavailable");
    yield* fs.writeFileString(sourcePath, "<h1>Restored</h1>");
    const restored = yield* Queue.take(milestones);
    expect(restored.error).toBeUndefined();
    expect(restored.version).not.toBe(replaced.version);
    expect((yield* artifacts.read(target)).html).toBe("<h1>Restored</h1>");
    yield* Fiber.interrupt(watcher);
  }).pipe(Effect.scoped, Effect.provide(dependencies())),
);

it.live(
  "captures the exact artifact viewport with signed CSS, JavaScript and runtime Tailwind",
  (ctx) =>
    Effect.gen(function* () {
      const executable = (yield* HostProcessEnvironment)["T3CODE_TEST_HEADLESS_SHELL"];
      if (!executable) return ctx.skip("Set T3CODE_TEST_HEADLESS_SHELL to run the capture test.");
      yield* Effect.gen(function* () {
        const root = yield* seed;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const artifacts = yield* DiagramArtifacts.DiagramArtifacts;
        yield* fs.writeFileString(
          path.join(root, "report.html"),
          '<!doctype html><html><head><link rel="stylesheet" href="theme.css"></head><body><script src="runtime.js"></script></body></html>',
        );
        yield* fs.writeFileString(
          path.join(root, "theme.css"),
          "html, body { margin: 0; width: 100%; height: 100%; }",
        );
        yield* fs.writeFileString(
          path.join(root, "runtime.js"),
          "document.body.className = 'bg-[#123456]';",
        );
        const target = yield* importArtifact({ kind: "file", path: "report.html" });
        const captured = yield* artifacts.capture(target);
        const expected = yield* importArtifact({
          kind: "inline",
          html: "<!doctype html><html><head><style>html, body { margin: 0; width: 100%; height: 100%; background: #123456; }</style></head><body></body></html>",
        });
        const reference = yield* artifacts.capture(expected);
        const png = Buffer.from(captured.base64, "base64");
        expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([317, 200]);
        expect([captured.width, captured.height]).toEqual([317, 200]);
        expect(captured.base64).toBe(reference.base64);
      }).pipe(Effect.scoped, Effect.provide(dependencies(executable)));
    }),
);

it.effect("renews signed resource delivery without changing the source version", () =>
  Effect.gen(function* () {
    const root = yield* seed;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const artifacts = yield* DiagramArtifacts.DiagramArtifacts;
    yield* fs.writeFileString(path.join(root, "report.html"), "<h1>Stable</h1>");
    const target = yield* importArtifact({ kind: "file", path: "report.html" });
    const changes = yield* artifacts.watch(target);
    const milestones = yield* Queue.unbounded<DiagramArtifactChange>();
    yield* Stream.runForEach(changes, (change) => Queue.offer(milestones, change)).pipe(
      Effect.forkScoped,
    );
    const initial = yield* Queue.take(milestones);
    const first = yield* artifacts.read(target);
    yield* TestClock.adjust("30 minutes");
    const renewal = yield* Queue.take(milestones);
    const refreshed = yield* artifacts.read(target);
    expect(renewal.version).toBe(initial.version);
    expect(refreshed.version).toBe(first.version);
    expect(refreshed.baseUrl).not.toBe(first.baseUrl);
  }).pipe(Effect.scoped, Effect.provide(dependencies())),
);

it.live("captures large artifact dimensions without changing their viewport", (ctx) =>
  Effect.gen(function* () {
    const executable = (yield* HostProcessEnvironment)["T3CODE_TEST_HEADLESS_SHELL"];
    if (!executable) return ctx.skip("Set T3CODE_TEST_HEADLESS_SHELL to run the capture test.");
    yield* Effect.gen(function* () {
      yield* seed;
      const artifacts = yield* DiagramArtifacts.DiagramArtifacts;
      for (const dimensions of [
        { w: 4100, h: 93 },
        { w: 65, h: 4128 },
      ]) {
        const target = yield* importArtifact(
          { kind: "inline", html: "<!doctype html><html><body></body></html>" },
          dimensions,
        );
        const captured = yield* artifacts.capture(target);
        const png = Buffer.from(captured.base64, "base64");
        expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([
          dimensions.w,
          dimensions.h - 28,
        ]);
      }
    }).pipe(Effect.scoped, Effect.provide(dependencies(executable)));
  }),
);
