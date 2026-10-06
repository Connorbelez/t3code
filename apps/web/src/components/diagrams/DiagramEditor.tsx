import { RegistryContext } from "@effect/atom-react";
import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";
import { sha256 } from "@noble/hashes/sha2";
import { useSync } from "@tldraw/sync";
import {
  DiagramOperationError,
  DiagramPageScope,
  type DiagramAnnotatedCapture,
  type DiagramCapture,
  type DiagramMetadata,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  Box,
  DefaultContextMenu,
  DefaultContextMenuContent,
  EmbedShapeUtil,
  Tldraw,
  TldrawUiMenuGroup,
  TldrawUiMenuItem,
  getFontFamily,
  getSvgAsImage,
  react,
  useEditor,
  useValue,
  type Editor,
  type TLAssetStore,
  type TLComponents,
  type TLRecord,
  type TLShapeId,
  type TLUiContextMenuProps,
} from "tldraw";
import * as Schema from "effect/Schema";
import {
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTheme } from "~/hooks/useTheme";
import { createDiagramApi, diagramSyncEvents } from "./diagramApi";
import { DiagramSocket, parseDocumentRecord, type DiagramSaveState } from "./diagramSocket";
import { diagramHostClientId, registerDiagramHost, type MountedDiagramHost } from "./diagramHosts";
import { rehearseDiagramChanges, validateDiagramBatch } from "./diagramBatchPreflight";
import { composeOnHost } from "./diagramHostCompose";
import { renderAnnotatedCapture, resolveAnnotationTargets } from "./diagramAnnotationHost";
import { blankExportSvg } from "./diagramAnnotationRender";
import { addCanvasSelectionToChat, registerCanvasSelectionChat } from "./canvasSelectionChat";
import "tldraw/tldraw.css";

const assetUrls = getAssetUrlsByImport();
const shapeUtils = [EmbedShapeUtil.configure({ embedDefinitions: [] })];
const decodeScope = Schema.decodeSync(DiagramPageScope);
function ChatContextMenu(props: TLUiContextMenuProps) {
  const editor = useEditor();
  const hasSelection = useValue("has selection", () => editor.getSelectedShapeIds().length > 0, [
    editor,
  ]);
  return (
    <DefaultContextMenu {...props}>
      {hasSelection ? (
        <TldrawUiMenuGroup id="t3-chat">
          <TldrawUiMenuItem
            id="add-selection-to-chat"
            label="Add selection to chat"
            readonlyOk
            onSelect={() => {
              addCanvasSelectionToChat();
            }}
          />
        </TldrawUiMenuGroup>
      ) : null}
      <DefaultContextMenuContent />
    </DefaultContextMenu>
  );
}
const hiddenComponents: TLComponents = { SharePanel: null };
const panelComponents: TLComponents = { SharePanel: null, ContextMenu: ChatContextMenu };
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
};
const recordFingerprint = (records: readonly TLRecord[]) =>
  canonical(Object.fromEntries(records.map((record) => [record.id, record])));
const documentRecords = (editor: Editor) =>
  editor.store
    .allRecords()
    .filter((record) => editor.store.schema.types[record.typeName].scope === "document");
const blobBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string")
        resolve(reader.result.slice(reader.result.indexOf(",") + 1));
      else reject(new Error("Unable to read diagram image."));
    });
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(blob);
  });

type DiagramEditorProps = {
  environmentId: EnvironmentId;
  diagram: DiagramMetadata;
  onSaveState?: (state: DiagramSaveState) => void;
  onHostReady?: (host: MountedDiagramHost) => void;
  /** Set by the Canvas panel: its selection can then be added to chat from the canvas. */
  onAddSelectionToChat?: () => void;
  visible?: boolean;
};
export default function DiagramEditor(props: DiagramEditorProps) {
  const [generation, setGeneration] = useState(0);
  const restartCommittedAdoption = useCallback(() => {
    setGeneration((value) => value + 1);
  }, []);
  return (
    <MountedDiagramEditor key={generation} {...props} onAdoptionLost={restartCommittedAdoption} />
  );
}
function MountedDiagramEditor(props: DiagramEditorProps & { onAdoptionLost: () => void }) {
  const registry = useContext(RegistryContext);
  const api = useMemo(
    () => createDiagramApi(registry, props.environmentId),
    [registry, props.environmentId],
  );
  const target = useMemo(
    () => ({ projectId: props.diagram.projectId, diagramId: props.diagram.id }),
    [props.diagram.projectId, props.diagram.id],
  );
  const [editor, setEditor] = useState<Editor | null>(null);
  const socketRef = useRef<DiagramSocket | null>(null);
  const composing = useRef(false);
  const heldRef = useRef(false);
  const uploads = useRef(0);
  const [fenced, setFenced] = useState(false);
  const { resolvedTheme } = useTheme();
  const assets = useMemo<TLAssetStore>(
    () => ({
      upload: async (_asset, file, signal) => {
        if (signal?.aborted) throw new Error("Image upload cancelled.");
        uploads.current += 1;
        try {
          const result = await api.uploadAsset({
            ...target,
            name: file.name,
            mimeType: file.type,
            base64: await blobBase64(file),
          });
          if (signal?.aborted) throw new Error("Image upload cancelled.");
          return { src: result.src };
        } finally {
          uploads.current -= 1;
        }
      },
      resolve: async (asset) => {
        if (!("src" in asset.props) || !asset.props.src) return null;
        if (!asset.props.src.startsWith("asset:t3-diagram/")) return null;
        const result = await api.readAsset({
          ...target,
          assetId: asset.props.src.slice("asset:t3-diagram/".length),
        });
        return `data:${result.mimeType};base64,${result.base64}`;
      },
    }),
    [api, target],
  );
  const connect = useCallback(() => {
    const socket = new DiagramSocket({
      target,
      clientId: diagramHostClientId,
      api,
      subscribe: (input, receive, disconnected) =>
        diagramSyncEvents(registry, {
          environmentId: props.environmentId,
          input,
          onEvent: receive,
          onError: disconnected,
        }),
    });
    socket.onAdoptionLost = props.onAdoptionLost;
    socketRef.current = socket;
    return socket;
  }, [api, props.environmentId, props.onAdoptionLost, registry, target]);
  const synced = useSync({ connect, assets });

  const mount = useCallback(
    (mountedEditor: Editor) => {
      setEditor(mountedEditor);
      mountedEditor.user.updateUserPreferences({ colorScheme: resolvedTheme });
      mountedEditor.updateInstanceState({ isReadonly: props.diagram.archivedAt !== null });
    },
    [props.diagram.archivedAt, resolvedTheme],
  );

  useEffect(() => {
    if (!editor) return;
    editor.user.updateUserPreferences({ colorScheme: resolvedTheme });
    editor.updateInstanceState({
      isReadonly: heldRef.current || props.diagram.archivedAt !== null,
    });
  }, [editor, props.diagram.archivedAt, resolvedTheme, synced.status]);

  const addSelectionToChat = useEffectEvent(() => props.onAddSelectionToChat?.());
  const chatAttachable = props.onAddSelectionToChat !== undefined;
  useEffect(() => {
    if (!editor || !chatAttachable) return;
    const registration = registerCanvasSelectionChat(addSelectionToChat);
    const stop = react("canvas selection for chat", () =>
      registration.setHasSelection(editor.getSelectedShapeIds().length > 0),
    );
    return () => {
      stop();
      registration.unregister();
    };
  }, [chatAttachable, editor]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!editor || !socket || synced.status !== "synced-remote") return;
    let generation: string | null = null;
    let pendingRequestId: string | null = null;
    let held = false;
    const releaseWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
    const release = () => {
      if (!held || socket.cancelAdoption()) return;
      held = false;
      for (const waiter of releaseWaiters) waiter.resolve();
      releaseWaiters.clear();
      heldRef.current = false;
      generation = null;
      pendingRequestId = null;
      editor.updateInstanceState({ isReadonly: props.diagram.archivedAt !== null });
      setFenced(false);
      host.onReleased?.();
    };
    const safe = () =>
      !held &&
      uploads.current === 0 &&
      !composing.current &&
      !editor.inputs.isPointing &&
      !editor.inputs.isDragging &&
      editor.getEditingShapeId() === null;
    const requireSafe = () => {
      if (!safe()) throw new DiagramOperationError({ code: "busy", diagramId: target.diagramId });
    };
    const currentScope = (kind: DiagramPageScope["kind"]): DiagramPageScope => {
      const pageId = editor.getCurrentPageId();
      if (kind === "diagram") return { kind, pageId };
      if (kind === "viewport")
        return { kind, pageId, bounds: editor.getViewportPageBounds().toJson() };
      const shapeIds = editor.getSelectedShapeIds();
      const bounds = editor.getSelectionPageBounds();
      if (shapeIds.length === 0 || !bounds)
        throw new DiagramOperationError({ code: "scope-unavailable" });
      return { kind, pageId, shapeIds: [...shapeIds], bounds: bounds.toJson() };
    };
    /**
     * Runs `work` on `pageId` while this editor matches the saved document at `expectedRevision`,
     * and fails stale if the document moved or this editor changed before `work` finished.
     */
    const withCommittedSnapshot = async <A,>(
      pageId: string,
      expectedRevision: number | undefined,
      work: (revision: number) => Promise<A>,
    ): Promise<A> => {
      // A compose with capture asks as soon as it commits, before this editor adopts the commit.
      if (held)
        await new Promise<void>((resolve, reject) => releaseWaiters.add({ resolve, reject }));
      requireSafe();
      await socket.waitUntilSaved();
      requireSafe();
      const page = editor.store.get(pageId as TLRecord["id"]);
      if (!page || page.typeName !== "page")
        throw new DiagramOperationError({ code: "scope-unavailable" });
      const before = await api.read({ ...target, includeRecords: true, limit: 200 });
      if (expectedRevision !== undefined && before.diagram.revision !== expectedRevision)
        throw new DiagramOperationError({ code: "stale" });
      const authoritative = before.records.map(parseDocumentRecord);
      let nextOffset = before.nextOffset;
      while (nextOffset !== null) {
        const next = await api.read({
          ...target,
          includeRecords: true,
          limit: 200,
          offset: nextOffset,
        });
        if (next.diagram.revision !== before.diagram.revision)
          throw new DiagramOperationError({ code: "stale" });
        authoritative.push(...next.records.map(parseDocumentRecord));
        nextOffset = next.nextOffset;
      }
      const baseline = recordFingerprint(documentRecords(editor));
      if (recordFingerprint(authoritative) !== baseline)
        throw new DiagramOperationError({ code: "stale" });
      await document.fonts.ready;
      const result = await work(before.diagram.revision);
      const after = await api.read(target);
      if (
        before.diagram.revision !== after.diagram.revision ||
        recordFingerprint(documentRecords(editor)) !== baseline ||
        socket.getSaveState() !== "saved"
      )
        throw new DiagramOperationError({ code: "stale" });
      return result;
    };
    const pageShapeIds = (pageId: string) =>
      editor.store
        .allRecords()
        .flatMap((record) =>
          record.typeName === "shape" && editor.getAncestorPageId(record) === pageId
            ? [record.id]
            : [],
        );
    const requireImageAssets = (ids: readonly TLShapeId[]) =>
      Promise.all(
        ids.map(async (id) => {
          const shape = editor.getShape(id);
          if (shape?.type !== "image") return;
          const url = await editor.resolveAssetUrl(shape.props.assetId, {
            shouldResolveToOriginal: true,
          });
          if (!url) throw new DiagramOperationError({ code: "assets-unavailable" });
          const image = new Image();
          image.src = url;
          try {
            await image.decode();
          } catch {
            throw new DiagramOperationError({ code: "assets-unavailable" });
          }
        }),
      );
    const host: MountedDiagramHost = {
      onReleased: null,
      saveState: socket.getSaveState,
      scope: currentScope,
      flush: () => socket.waitUntilSaved(),
      release,
      prepare: async (nextGeneration, requestId, batch) => {
        requireSafe();
        await socket.waitUntilSaved();
        requireSafe();
        if (!socket.connectionId) throw new DiagramOperationError({ code: "disconnected" });
        validateDiagramBatch(editor, batch);
        held = true;
        heldRef.current = true;
        generation = nextGeneration;
        pendingRequestId = requestId;
        editor.updateInstanceState({ isReadonly: true });
        setFenced(true);
        try {
          const bytes = new TextEncoder().encode(
            canonical(
              documentRecords(editor).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
            ),
          );
          const hash = crypto.subtle
            ? new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
            : sha256(bytes);
          const fingerprint = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(
            "",
          );
          return { connectionId: socket.connectionId, fingerprint };
        } catch (cause) {
          release();
          throw cause;
        }
      },
      capture: async (rawScope, format, expectedRevision) => {
        const scope = decodeScope(rawScope);
        return withCommittedSnapshot(scope.pageId, expectedRevision, async (revision) => {
          const ids =
            scope.kind === "selection"
              ? scope.shapeIds.map((id) => id as TLShapeId)
              : pageShapeIds(scope.pageId);
          if (
            scope.kind === "selection" &&
            ids.some((id) => {
              const shape = editor.getShape(id);
              return !shape || editor.getAncestorPageId(shape) !== scope.pageId;
            })
          )
            throw new DiagramOperationError({ code: "scope-unavailable" });
          await requireImageAssets(ids);
          const exportBounds =
            scope.kind === "diagram"
              ? ids.length > 0
                ? Box.Common(
                    ids.flatMap((id) => {
                      const box = editor.getShapePageBounds(id);
                      return box ? [box] : [];
                    }),
                  )
                : new Box(0, 0, 512, 320)
              : Box.From(scope.bounds);
          let image:
            | { blob: Blob; width: number; height: number }
            | { svg: string; width: number; height: number }
            | undefined;
          if (ids.length === 0) {
            const scale = Math.min(1, 2048 / Math.max(exportBounds.w, exportBounds.h, 1));
            const width = Math.max(1, Math.round(exportBounds.w * scale));
            const height = Math.max(1, Math.round(exportBounds.h * scale));
            if (format === "svg")
              image = {
                svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/></svg>`,
                width,
                height,
              };
            else {
              const canvas = document.createElement("canvas");
              canvas.width = width;
              canvas.height = height;
              const context = canvas.getContext("2d");
              if (!context) throw new DiagramOperationError({ code: "assets-unavailable" });
              context.fillStyle = "white";
              context.fillRect(0, 0, width, height);
              const blob = await new Promise<Blob>((resolve, reject) =>
                canvas.toBlob(
                  (result) =>
                    result
                      ? resolve(result)
                      : reject(new DiagramOperationError({ code: "assets-unavailable" })),
                  "image/png",
                ),
              );
              image = { blob, width, height };
            }
          } else
            image =
              format === "svg"
                ? await editor.getSvgString(ids, {
                    ...(exportBounds ? { bounds: exportBounds } : {}),
                    padding: 0,
                  })
                : await editor.toImage(ids, {
                    format: "png",
                    pixelRatio: 1,
                    scale: Math.min(1, 2048 / Math.max(exportBounds.w, exportBounds.h, 1)),
                    bounds: exportBounds,
                    padding: 0,
                  });
          if (!image) throw new DiagramOperationError({ code: "assets-unavailable" });
          const blob =
            "blob" in image ? image.blob : new Blob([image.svg], { type: "image/svg+xml" });
          const base64 = await blobBase64(blob);
          return {
            diagramId: target.diagramId,
            revision,
            scope,
            bounds: (exportBounds ?? new Box(0, 0, image.width, image.height)).toJson(),
            width: Math.round(image.width),
            height: Math.round(image.height),
            mimeType: format === "svg" ? "image/svg+xml" : "image/png",
            base64,
          } satisfies DiagramCapture;
        });
      },
      annotate: (input) =>
        withCommittedSnapshot(input.pageId, input.revision, async (revision) => {
          const targets = resolveAnnotationTargets(editor, input.pageId, input.annotations);
          const ids = pageShapeIds(input.pageId);
          await requireImageAssets(ids);
          const rendered = await renderAnnotatedCapture(targets, {
            exportSvg: async (image) => {
              // An empty id list would export the current page instead of this one.
              const exported =
                ids.length > 0
                  ? await editor.getSvgString(ids, {
                      bounds: Box.From(image.bounds),
                      scale: image.scale,
                      padding: 0,
                      background: true,
                      darkMode: false,
                    })
                  : undefined;
              return exported?.svg ?? blankExportSvg(image.bounds, image.width, image.height);
            },
            rasterize: async (svg, width, height) => {
              const blob = await getSvgAsImage(svg, { type: "png", width, height, pixelRatio: 1 });
              if (!blob) throw new DiagramOperationError({ code: "assets-unavailable" });
              return blobBase64(blob);
            },
          });
          return {
            diagramId: target.diagramId,
            revision,
            pageId: input.pageId,
            annotations: input.annotations,
            ...rendered,
          } satisfies DiagramAnnotatedCapture;
        }),
      compose: async (request) => {
        requireSafe();
        await socket.waitUntilSaved();
        requireSafe();
        const records = editor.store.serialize("document");
        const theme = editor.getCurrentTheme();
        return composeOnHost(request, Object.values(records), {
          fontsReady: async () => {
            const faces = [theme.fonts.sans?.faces, theme.fonts.draw?.faces].flatMap(
              (items) => items ?? [],
            );
            await Promise.all(faces.map((face) => editor.fonts.ensureFontIsLoaded(face)));
          },
          measureText: (text, font) => {
            const { w, h } = editor.textMeasure.measureText(text, {
              fontStyle: "normal",
              fontWeight: "normal",
              fontFamily: getFontFamily(theme, font.family),
              fontSize: font.fontSize,
              lineHeight: theme.lineHeight,
              maxWidth: font.maxWidth,
              padding: "0px",
            });
            return { w, h };
          },
          rehearse: (puts, deletes) =>
            new Map(Object.entries(rehearseDiagramChanges(editor, records, puts, deletes))),
        });
      },
    };
    socket.onFenceReleased = (event) => {
      if (!event || (event.generation === generation && event.requestId === pendingRequestId))
        release();
    };
    socket.onCommit = (commit) => {
      if (!held || generation !== commit.generation)
        throw new DiagramOperationError({ code: "disconnected" });
      for (const expected of commit.mutation.expected) {
        const record = editor.store.get(expected.id as TLRecord["id"]) ?? null;
        if (canonical(record) !== canonical(expected.record)) {
          release();
          throw new DiagramOperationError({ code: "stale" });
        }
      }
      socket.adopt(commit.generation, commit.fence);
      editor.markHistoryStoppingPoint("agent batch");
      editor.run(
        () => {
          editor.store.put([...commit.mutation.puts]);
          editor.store.remove(commit.mutation.deletes as TLRecord["id"][]);
        },
        { ignoreShapeLock: true },
      );
      editor.markHistoryStoppingPoint("after agent batch");
    };
    const cleanups = (["shape", "binding", "asset", "page", "document", "user"] as const).flatMap(
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
    cleanups.push(
      editor.store.sideEffects.registerOperationCompleteHandler((source) => {
        if (source === "remote") socket.completeAdoptionAfterRemoteOperation();
      }),
    );
    const blockFencedInput = (event: Event) => {
      if (!heldRef.current || !editor.getInstanceState().isFocused) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const ownerDocument = editor.getContainer().ownerDocument;
    for (const type of ["keydown", "paste", "drop"] as const)
      ownerDocument.addEventListener(type, blockFencedInput, true);
    cleanups.push(() => {
      for (const type of ["keydown", "paste", "drop"] as const)
        ownerDocument.removeEventListener(type, blockFencedInput, true);
    });
    cleanups.push(socket.subscribeSave(() => props.onSaveState?.(socket.getSaveState())));
    props.onSaveState?.(socket.getSaveState());
    const unregister = registerDiagramHost(
      props.environmentId,
      target.diagramId,
      host,
      props.visible !== false,
    );
    props.onHostReady?.(host);
    return () => {
      unregister();
      for (const cleanup of cleanups) cleanup();
      for (const waiter of releaseWaiters)
        waiter.reject(new DiagramOperationError({ code: "disconnected" }));
      releaseWaiters.clear();
      socket.onCommit = null;
      socket.onFenceReleased = null;
    };
  }, [
    api,
    editor,
    props.diagram.archivedAt,
    props.environmentId,
    props.onHostReady,
    props.onSaveState,
    props.visible,
    synced.status,
    target,
  ]);

  return (
    <div
      className="relative h-full min-h-0 w-full"
      data-diagram-editor
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
      onPointerDownCapture={(event) => {
        if (heldRef.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onPasteCapture={(event) => {
        if (heldRef.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onDropCapture={(event) => {
        if (heldRef.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onKeyDownCapture={(event) => {
        if (heldRef.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <Tldraw
        shapeUtils={shapeUtils}
        store={synced}
        assetUrls={assetUrls}
        onMount={mount}
        licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY}
        options={{ maxPages: 100 }}
        components={chatAttachable ? panelComponents : hiddenComponents}
      />
      {fenced ? (
        <div className="absolute inset-0 z-50 cursor-wait" aria-label="Applying diagram changes" />
      ) : null}
    </div>
  );
}
