import {
  htmlArtifactMigrations,
  htmlArtifactProps,
  type HtmlArtifactShape,
} from "@t3tools/diagram-compose/schema";
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  useEditor,
  useValue,
  getColorValue,
  type Editor,
} from "tldraw";
import { createContext, memo, useContext, useEffect, useRef, useState } from "react";
import * as Schema from "effect/Schema";
import type { createDiagramArtifactApi } from "./diagramApi";

import type { DiagramSocket } from "./diagramSocket";

type ArtifactApi = ReturnType<typeof createDiagramArtifactApi>;
export type HtmlArtifactScope = {
  api: ArtifactApi;
  target: Pick<Parameters<ArtifactApi["read"]>[0], "projectId" | "diagramId">;
  subscribe: (shapeId: string, changed: () => void, failed: (error: unknown) => void) => () => void;
  whenReady: (ready: () => void) => () => void;
  editSource: (shape: HtmlArtifactShape) => void;
  repairSource: (shape: HtmlArtifactShape) => void;
  createSource: (action: import("./HtmlArtifactSourceDialog").HtmlArtifactSourceAction) => void;
};
export const HtmlArtifactScopeContext = createContext<HtmlArtifactScope | null>(null);
const captures = new WeakMap<HtmlArtifactShape, Awaited<ReturnType<ArtifactApi["capture"]>>>();
export async function prepareHtmlArtifactCaptures(
  editor: Editor,
  ids: readonly import("tldraw").TLShapeId[],
) {
  const scope = scopes.get(editor);
  const prepared = await Promise.all(
    ids.map(async (id) => {
      const shape = editor.getShape(id);
      if (!shape || !editor.isShapeOfType<HtmlArtifactShape>(shape, "html-artifact")) return;
      if (!scope) throw new Error("HTML artifact capture is unavailable.");
      const capture = await scope.api.capture({ ...scope.target, shapeId: shape.id });
      return { shape, capture };
    }),
  );
  for (const item of prepared) if (item) captures.set(item.shape, item.capture);
  return () => {
    for (const item of prepared)
      if (item && captures.get(item.shape) === item.capture) captures.delete(item.shape);
  };
}
const scopes = new WeakMap<Editor, HtmlArtifactScope>();
export function registerHtmlArtifactScope(editor: Editor, scope: HtmlArtifactScope) {
  scopes.set(editor, scope);
  return () => {
    if (scopes.get(editor) === scope) scopes.delete(editor);
  };
}

export function subscribeWhenDiagramSaved(
  socket: Pick<DiagramSocket, "getSaveState" | "subscribeSave">,
  subscribe: () => () => void,
) {
  let unsubscribe: (() => void) | undefined;
  const synchronize = () => {
    const state = socket.getSaveState();
    if (state === "offline" || state === "connecting") {
      unsubscribe?.();
      unsubscribe = undefined;
    } else if (state === "saved" && !unsubscribe) {
      unsubscribe = subscribe();
    }
  };
  const stop = socket.subscribeSave(synchronize);
  synchronize();
  return () => {
    stop();
    unsubscribe?.();
  };
}

export class HtmlArtifactShapeUtil extends BaseBoxShapeUtil<HtmlArtifactShape> {
  static override type = "html-artifact" as const;
  static override props = htmlArtifactProps;
  static override migrations = htmlArtifactMigrations;
  override getDefaultProps(): HtmlArtifactShape["props"] {
    return {
      w: 480,
      h: 360,
      title: "HTML artifact",
      source: {
        kind: "inline",
        html: "<!doctype html><html><body><h1>Hello canvas</h1></body></html>",
      },
    };
  }
  override canEdit() {
    return false;
  }
  override canCull() {
    return false;
  }
  component(shape: HtmlArtifactShape) {
    return <HtmlArtifact shape={shape} />;
  }
  override getIndicatorPath(shape: HtmlArtifactShape) {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
  }
  override async toSvg(shape: HtmlArtifactShape) {
    const scope = scopes.get(this.editor);
    if (!scope) throw new Error("HTML artifact capture is unavailable.");
    const capture =
      captures.get(shape) ?? (await scope.api.capture({ ...scope.target, shapeId: shape.id }));
    const colors = this.editor.getCurrentTheme().colors.light;
    return (
      <g>
        <rect
          width={shape.props.w}
          height={shape.props.h}
          fill={getColorValue(colors, "black", "frameFill")}
          stroke={getColorValue(colors, "black", "frameStroke")}
        />
        <text x="10" y="20" fontSize="12" fill={getColorValue(colors, "black", "frameText")}>
          {shape.props.title}
        </text>
        <image
          href={`data:image/png;base64,${capture.base64}`}
          y={28}
          width={shape.props.w}
          height={Math.max(1, shape.props.h - 28)}
          preserveAspectRatio="none"
        />
      </g>
    );
  }
}

const runtimeClasses = Schema.Struct({
  type: Schema.Literal("t3-artifact-classes"),
  candidates: Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(
    Schema.isMaxLength(5000),
  ),
});
const decodeClasses = Schema.decodeUnknownOption(runtimeClasses);
const bridge = `(() => {
  const seen = new Set();
  let queued = false;
  function scan() {
    queued = false;
    const candidates = [];
    document.querySelectorAll('[class]').forEach(element => {
      element.classList.forEach(token => {
        if (token.length <= 500 && seen.size < 5000 && !seen.has(token)) { seen.add(token); candidates.push(token); }
      });
    });
    if (candidates.length) parent.postMessage({type:'t3-artifact-classes',candidates}, '*');
  }
  const observer = new MutationObserver(() => {
    if (!queued) { queued = true; queueMicrotask(scan); }
  });
  observer.observe(document.documentElement, {subtree:true,childList:true,attributes:true,attributeFilter:['class']});
  window.addEventListener('message', event => {
    if (event.source !== parent) return;
    if (event.data?.type === 't3-artifact-base' && typeof event.data.url === 'string') {
      document.getElementById('t3-artifact-base').href = event.data.url;
      return;
    }
    if (event.data?.type === 't3-artifact-classes-request') { seen.clear(); scan(); return; }
    if (event.data?.type !== 't3-artifact-css' || typeof event.data.css !== 'string') return;
    document.getElementById('t3-artifact-tailwind').textContent = event.data.css;
  });
  scan();
})();`;
export function artifactDocument(html: string, css: string, baseUrl: string | undefined) {
  const document = new DOMParser().parseFromString(html, "text/html");
  if (baseUrl) {
    const base = document.createElement("base");
    base.id = "t3-artifact-base";
    base.href = baseUrl;
    document.head.prepend(base);
  }
  const style = document.createElement("style");
  style.id = "t3-artifact-tailwind";
  style.textContent = css;
  document.head.append(style);
  const script = document.createElement("script");
  script.textContent = bridge;
  document.body.append(script);
  return `<!doctype html>${document.documentElement.outerHTML}`;
}

type ArtifactDocumentState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; sourceKey: string; html: string; version: string; document: string };

export function artifactStyleSession(input: {
  html: string;
  css: ArtifactApi["css"];
  apply: (css: string) => void;
  whenReady: HtmlArtifactScope["whenReady"];
}) {
  const candidates = new Set<string>();
  let cancelled = false;
  let compiling = false;
  let changed = false;
  const compile = async () => {
    if (compiling) {
      changed = true;
      return;
    }
    compiling = true;
    try {
      do {
        changed = false;
        const result = await input.css({ html: input.html, candidates: [...candidates] });
        if (cancelled) return;
        input.apply(result.css);
      } while (changed);
    } catch {
      // A disconnected styling request must leave the live document intact; reconnect retries it.
    } finally {
      compiling = false;
      if (changed && !cancelled) void compile();
    }
  };
  const stop = input.whenReady(() => {
    if (candidates.size) void compile();
  });
  return {
    add: (tokens: readonly string[]) => {
      let added = false;
      for (const token of tokens) {
        if (token.length > 500 || candidates.size >= 5000 || candidates.has(token)) continue;
        candidates.add(token);
        added = true;
      }
      if (added) return compile();
      return Promise.resolve();
    },
    dispose: () => {
      cancelled = true;
      stop();
    },
  };
}
const HtmlArtifact = memo(function HtmlArtifact({ shape }: { shape: HtmlArtifactShape }) {
  const scope = useContext(HtmlArtifactScopeContext);
  const editor = useEditor();
  const iframe = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<ArtifactDocumentState>({ kind: "loading" });
  const drawingConnector = useValue(
    "artifact connector input",
    () => editor.getCurrentToolId() === "arrow",
    [editor],
  );
  const readonly = useValue(
    "artifact source readonly",
    () => editor.getInstanceState().isReadonly,
    [editor],
  );
  const inlineHtml = shape.props.source.kind === "inline" ? shape.props.source.html : null;
  const filePath = shape.props.source.kind === "file" ? shape.props.source.path : null;
  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    let request = 0;
    const failed = (error: unknown) => {
      if (!cancelled)
        setState({
          kind: "error",
          message: error instanceof Error ? error.message : "Unable to load HTML artifact.",
        });
    };
    if (inlineHtml !== null) {
      const html = inlineHtml;
      const load = () =>
        void scope.api.css({ html, candidates: [] }).then(
          (result) => {
            if (!cancelled)
              setState((previous) =>
                previous.kind === "ready" &&
                previous.sourceKey === "inline" &&
                previous.html === html
                  ? previous
                  : {
                      kind: "ready",
                      sourceKey: "inline",
                      html,
                      version: html,
                      document: artifactDocument(html, result.css, undefined),
                    },
              );
          },
          (error: unknown) => {
            if (!cancelled)
              setState((previous) =>
                previous.kind === "ready" &&
                previous.sourceKey === "inline" &&
                previous.html === html
                  ? previous
                  : {
                      kind: "error",
                      message:
                        error instanceof Error ? error.message : "Unable to load HTML artifact.",
                    },
              );
          },
        );
      const stop = scope.whenReady(load);
      return () => {
        cancelled = true;
        stop();
      };
    }
    if (filePath === null) return;
    const read = async () => {
      const current = ++request;
      try {
        const result = await scope.api.read({ ...scope.target, shapeId: shape.id });
        if (cancelled || request !== current) return;
        if (result.baseUrl)
          iframe.current?.contentWindow?.postMessage(
            { type: "t3-artifact-base", url: result.baseUrl },
            "*",
          );
        setState((previous) =>
          previous.kind === "ready" &&
          previous.sourceKey === `file:${filePath}` &&
          previous.version === result.version
            ? previous
            : {
                kind: "ready",
                sourceKey: `file:${filePath}`,
                html: result.html,
                version: result.version,
                document: artifactDocument(result.html, result.css, result.baseUrl),
              },
        );
      } catch (error) {
        if (request === current) failed(error);
      }
    };
    void read();
    const unsubscribe = scope.subscribe(shape.id, () => void read(), failed);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [scope, shape.id, inlineHtml, filePath]);
  useEffect(() => {
    if (!scope || state.kind !== "ready") return;
    const session = artifactStyleSession({
      html: state.html,
      css: scope.api.css,
      whenReady: scope.whenReady,
      apply: (css) =>
        iframe.current?.contentWindow?.postMessage({ type: "t3-artifact-css", css }, "*"),
    });
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== iframe.current?.contentWindow) return;
      const decoded = decodeClasses(event.data);
      if (decoded._tag !== "Some" || decoded.value.candidates.length > 5000) return;
      void session.add(decoded.value.candidates);
    };
    window.addEventListener("message", receive);
    iframe.current?.contentWindow?.postMessage({ type: "t3-artifact-classes-request" }, "*");
    return () => {
      window.removeEventListener("message", receive);
      session.dispose();
    };
  }, [scope, state]);
  return (
    <HTMLContainer
      style={{
        width: shape.props.w,
        height: shape.props.h,
        border: "1px solid #cbd5e1",
        borderRadius: 6,
        overflow: "hidden",
        background: "white",
        pointerEvents: "auto",
      }}
    >
      <div
        style={{
          height: 28,
          display: "flex",
          alignItems: "center",
          padding: "0 8px",
          gap: 8,
          background: "#f1f5f9",
          color: "#334155",
          fontSize: 12,
          cursor: "move",
        }}
      >
        <span
          style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {shape.props.title}
        </span>
        <button
          type="button"
          disabled={readonly}
          aria-label={`Edit source for ${shape.props.title}`}
          style={{ cursor: "pointer", border: 0, background: "transparent", color: "inherit" }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            scope?.editSource(shape);
          }}
        >
          Source
        </button>
      </div>
      {state.kind === "ready" ? (
        <iframe
          ref={iframe}
          title={shape.props.title}
          sandbox="allow-scripts allow-forms"
          srcDoc={state.document}
          onLoad={() =>
            iframe.current?.contentWindow?.postMessage({ type: "t3-artifact-classes-request" }, "*")
          }
          style={{
            display: "block",
            width: "100%",
            height: "calc(100% - 28px)",
            border: 0,
            pointerEvents: drawingConnector ? "none" : "auto",
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        />
      ) : (
        <div
          role={state.kind === "error" ? "alert" : "status"}
          style={{ padding: 16, color: "#475569", fontSize: 14 }}
        >
          {state.kind === "error" ? (
            <>
              {state.message}
              {shape.props.source.kind === "file" && !readonly ? (
                <button
                  type="button"
                  style={{ display: "block", marginTop: 12, cursor: "pointer" }}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => scope?.repairSource(shape)}
                >
                  Repair file reference
                </button>
              ) : null}
            </>
          ) : (
            "Loading HTML artifact..."
          )}
        </div>
      )}
    </HTMLContainer>
  );
});
