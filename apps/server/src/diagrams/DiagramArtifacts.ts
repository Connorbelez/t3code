import * as NodeCrypto from "node:crypto";
import {
  DiagramOperationError,
  DiagramHtmlArtifactSource,
  type DiagramArtifactTarget,
  type DiagramTarget,
  type DiagramArtifactDocument,
  type DiagramArtifactChange,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import { hostPreviewMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import { HostProcessUserId } from "@t3tools/shared/hostProcess";
import * as DiagramService from "./DiagramService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as AssetAccess from "../assets/AssetAccess.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as PreviewBrowser from "../htmlRender/PreviewBrowser.ts";
import * as HeadlessChrome from "../htmlRender/headlessChrome.ts";
import { createArtifactStyling } from "./artifactTailwind.ts";

const RESOURCE_MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".otf": "font/otf",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const Artifact = Schema.Struct({
  typeName: Schema.Literal("shape"),
  type: Schema.Literal("html-artifact"),
  props: Schema.Struct({ w: Schema.Finite, h: Schema.Finite, source: DiagramHtmlArtifactSource }),
});

const decodeArtifact = Schema.decodeUnknownEffect(Artifact);
const version = (html: string) => NodeCrypto.createHash("sha256").update(html).digest("hex");

export class DiagramArtifacts extends Context.Service<
  DiagramArtifacts,
  {
    readonly read: (
      input: DiagramArtifactTarget,
    ) => Effect.Effect<DiagramArtifactDocument, DiagramOperationError>;
    readonly watch: (
      input: DiagramArtifactTarget,
    ) => Effect.Effect<
      Stream.Stream<DiagramArtifactChange, DiagramOperationError>,
      DiagramOperationError
    >;
    readonly css: (input: {
      html: string;
      candidates: readonly string[];
    }) => Effect.Effect<{ css: string }, DiagramOperationError>;
    readonly capture: (
      input: DiagramArtifactTarget,
    ) => Effect.Effect<{ base64: string; width: number; height: number }, DiagramOperationError>;
  }
>()("t3/diagrams/DiagramArtifacts") {}

const make = Effect.gen(function* () {
  const diagrams = yield* DiagramService.DiagramService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const preview = yield* PreviewBrowser.PreviewBrowser;
  const assetServices = yield* Effect.context<
    | FileSystem.FileSystem
    | Path.Path
    | WorkspacePaths.WorkspacePaths
    | ServerSecretStore.ServerSecretStore
  >();
  const captureServices =
    yield* Effect.context<
      Effect.Services<ReturnType<typeof HeadlessChrome.captureHtmlScreenshot>>
    >();
  const compile = createArtifactStyling();
  const permits = yield* Semaphore.make(2);
  let noSandbox = (yield* HostProcessUserId) === 0;
  const css = (input: { html: string; candidates: readonly string[] }) =>
    Effect.tryPromise({
      try: () => compile(input.html, input.candidates),
      catch: () =>
        new DiagramOperationError({
          code: "invalid-records",
          details: {
            issues: [
              { path: "stylesheet", message: "Artifact Tailwind CSS could not be compiled." },
            ],
          },
        }),
    }).pipe(Effect.map((css) => ({ css })));
  const artifact = Effect.fn("DiagramArtifacts.artifact")(function* (input: DiagramArtifactTarget) {
    const result = yield* diagrams.read({
      ...input,
      recordIds: [input.shapeId],
      includeRecords: true,
    });
    const record = result.records[0];
    return yield* decodeArtifact(record).pipe(
      Effect.mapError(() => new DiagramOperationError({ code: "not-found" })),
    );
  });
  const root = Effect.fn("DiagramArtifacts.root")(function* (input: DiagramTarget) {
    const project = yield* projects
      .get(input.projectId)
      .pipe(Effect.mapError(() => new DiagramOperationError({ code: "project-unavailable" })));
    if (Option.isNone(project))
      return yield* new DiagramOperationError({ code: "project-unavailable" });
    return project.value.workspaceRoot;
  });
  const read: DiagramArtifacts["Service"]["read"] = Effect.fn("DiagramArtifacts.read")(function* (
    input: DiagramArtifactTarget,
  ) {
    const shape = yield* artifact(input);
    const source = shape.props.source;
    if (source.kind === "inline")
      return {
        source,
        html: source.html,
        version: version(source.html),
        ...(yield* css({ html: source.html, candidates: [] })),
      };
    const workspaceRoot = yield* root(input);
    const result = yield* files
      .readFile({ cwd: workspaceRoot, relativePath: source.path })
      .pipe(Effect.mapError(() => new DiagramOperationError({ code: "assets-unavailable" })));
    if (result.truncated)
      return yield* new DiagramOperationError({
        code: "too-large",
        details: {
          issues: [
            { path: "source", message: "The artifact source exceeds the supported file size." },
          ],
        },
      });
    const url = yield* AssetAccess.issueWorkspaceFileAssetUrl({
      requestedPath: source.path,
      workspaceRoot,
    }).pipe(
      Effect.provideContext(assetServices),
      Effect.mapError(() => new DiagramOperationError({ code: "assets-unavailable" })),
    );
    return {
      source,
      html: result.contents,
      version: version(result.contents),
      baseUrl: url.relativeUrl,
      ...(yield* css({ html: result.contents, candidates: [] })),
    };
  });
  const watch = Effect.fn("DiagramArtifacts.watch")(function* (input: DiagramArtifactTarget) {
    const shape = yield* artifact(input);
    const source = shape.props.source;
    if (source.kind === "inline")
      return Stream.fromEffect(read(input).pipe(Effect.map(({ version }) => ({ version }))));
    const workspaceRoot = yield* root(input);
    const sourcePath = path.resolve(workspaceRoot, source.path);
    const milestone = read(input).pipe(
      Effect.map(({ version }): DiagramArtifactChange => ({ version })),
      Effect.catchTags({
        DiagramOperationError: () =>
          Effect.succeed({ version: "missing", error: "The artifact source could not be read." }),
      }),
    );
    const changes = fs.watch(path.dirname(sourcePath)).pipe(
      Stream.filter((event) => path.resolve(path.dirname(sourcePath), event.path) === sourcePath),
      Stream.debounce("100 millis"),
      Stream.mapEffect(() => milestone),
      Stream.mapError(() => new DiagramOperationError({ code: "assets-unavailable" })),
    );
    const contentChanges = Stream.merge(Stream.fromEffect(milestone), changes).pipe(
      Stream.changesWith((a, b) => a.version === b.version && a.error === b.error),
    );
    const renewals = Stream.tick("30 minutes").pipe(
      Stream.drop(1),
      Stream.mapEffect(() => milestone),
    );
    return Stream.merge(contentChanges, renewals);
  });
  const capture = Effect.fn("DiagramArtifacts.capture")(function* (input: DiagramArtifactTarget) {
    const shape = yield* artifact(input);
    const document = yield* read(input);
    const executable = yield* preview.executable.pipe(
      Effect.mapError(() => new DiagramOperationError({ code: "assets-unavailable" })),
    );
    const width = Math.max(1, Math.round(shape.props.w));
    const height = Math.max(1, Math.round(shape.props.h - 28));
    const base = document.baseUrl
      ? `<base href="http://t3-page.localhost${document.baseUrl}">`
      : "";
    const markup = `${base}<style id="t3-artifact-tailwind">${document.css.replace(/<\/style/gi, "<\\/style")}</style>`;
    const opening = /<head(?:\s[^>]*)?>/i.exec(document.html);
    const container =
      opening ??
      /<html(?:\s[^>]*)?>/i.exec(document.html) ??
      /^\s*<!doctype[^>]*>/i.exec(document.html);
    const at = container ? container.index + container[0].length : 0;
    const html = opening
      ? document.html.slice(0, at) + markup + document.html.slice(at)
      : `${document.html.slice(0, at)}<head>${markup}</head>${document.html.slice(at)}`;
    const resolveResource = (url: string) =>
      Effect.gen(function* () {
        const parsed = new URL(url);
        const match = /^\/api\/assets\/([^/]+)\/(.+)$/.exec(parsed.pathname);
        if (!match?.[1] || !match[2]) return null;
        const asset = yield* AssetAccess.resolveWorkspaceFileAsset(match[1], match[2]).pipe(
          Effect.provideContext(assetServices),
        );
        if (asset?.kind !== "file") return null;
        const opened = "file" in asset ? asset.file : undefined;
        const bytes = opened
          ? yield* Effect.promise(() => opened.handle.readFile())
          : yield* fs.readFile(asset.path);
        const extension = path.extname(asset.path).toLowerCase();
        const mimeType =
          hostPreviewMimeTypeFromExtension(extension) ??
          RESOURCE_MIME_TYPES[extension] ??
          "application/octet-stream";
        return { bytes, mimeType };
      }).pipe(
        Effect.scoped,
        Effect.orElseSucceed(() => null),
      );
    const launch = () =>
      HeadlessChrome.captureHtmlScreenshot({
        executable,
        noSandbox,
        html,
        width,
        height,
        urlFragment: "",
        resolveResource,
        compileStyles: (candidates) =>
          css({ html: document.html, candidates }).pipe(
            Effect.map(({ css }) => css),
            Effect.mapError(
              (cause) =>
                new HeadlessChrome.HtmlRenderBrowserError({
                  reason: "the artifact stylesheet could not be compiled",
                  cause,
                }),
            ),
          ),
      }).pipe(Effect.provideContext(captureServices));
    const result = yield* permits
      .withPermits(1)(
        Effect.suspend(launch).pipe(
          Effect.catchTags({
            HtmlRenderSandboxUnavailableError: () =>
              Effect.sync(() => {
                noSandbox = true;
              }).pipe(Effect.andThen(launch)),
          }),
        ),
      )
      .pipe(Effect.mapError(() => new DiagramOperationError({ code: "assets-unavailable" })));
    return { base64: result.png, width, height };
  });
  return DiagramArtifacts.of({ read, watch, css, capture });
});
export const layer = Layer.effect(DiagramArtifacts, make);
