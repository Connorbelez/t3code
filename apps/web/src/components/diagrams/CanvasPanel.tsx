import { RegistryContext } from "@effect/atom-react";
import {
  type DiagramId,
  type DiagramLifecycleInput,
  type DiagramMetadata,
  type DiagramPageScope,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { Archive, ArrowLeft, Copy, Download, Plus, Trash2, Upload } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { AsyncResult } from "effect/reactivity";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "~/components/ui/alert-dialog";
import { useServerConfigs } from "~/state/entities";
import { createDiagramApi, diagramChanges } from "./diagramApi";
import { findDiagramHost, type DiagramContextReference } from "./diagramHosts";
import type { DiagramSaveState } from "./diagramSocket";

const DiagramEditor = lazy(() => import("./DiagramEditor"));
const saveLabels: Record<DiagramSaveState, string> = {
  saved: "Saved",
  pending: "Waiting to save",
  offline: "Offline, unsaved",
  connecting: "Connecting",
};
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export type CanvasPanelProps = {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  diagramId: DiagramId | null;
  onSelectDiagram: (diagram: DiagramMetadata) => void;
  onAttach: (reference: DiagramContextReference) => void;
};
export default function CanvasPanel(props: CanvasPanelProps) {
  const capabilities = useServerConfigs().get(props.environmentId)?.environment.capabilities
    .diagrams;
  if (capabilities?.protocolVersion !== 1 || capabilities.sdkVersion !== "5.5.2")
    return (
      <div className="p-4 text-sm text-muted-foreground">Canvas is unavailable on this server.</div>
    );
  return <SupportedCanvasPanel {...props} />;
}
function SupportedCanvasPanel(props: CanvasPanelProps) {
  const registry = useContext(RegistryContext);
  const api = useMemo(
    () => createDiagramApi(registry, props.environmentId),
    [registry, props.environmentId],
  );
  const [diagrams, setDiagrams] = useState<readonly DiagramMetadata[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [library, setLibrary] = useState(props.diagramId === null);
  const [archived, setArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DiagramMetadata | null>(null);
  const [scope, setScope] = useState<DiagramPageScope["kind"]>("diagram");
  const [saveState, setSaveState] = useState<DiagramSaveState>("connecting");
  const importRef = useRef<HTMLInputElement>(null);
  const active = diagrams.find((diagram) => diagram.id === props.diagramId) ?? null;
  const refresh = useCallback(async () => {
    setDiagrams(await api.list({ projectId: props.projectId, includeArchived: true }));
    setError(null);
  }, [api, props.projectId]);
  const applyMetadata = useEffectEvent((items: readonly DiagramMetadata[]) => {
    const selected = items.find((diagram) => diagram.id === props.diagramId);
    setDiagrams(items);
    setError(null);
    if (selected && selected.name !== active?.name) props.onSelectDiagram(selected);
  });
  useEffect(() => {
    let live = true;
    const changes = diagramChanges({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    });
    const unsubscribe = registry.subscribe(
      changes,
      (result) => {
        if (AsyncResult.isSuccess(result))
          void api.list({ projectId: props.projectId, includeArchived: true }).then(
            (items) => {
              if (live) applyMetadata(items);
            },
            (cause: unknown) => {
              if (live)
                setError(cause instanceof Error ? cause.message : "Unable to refresh diagrams.");
            },
          );
      },
      { immediate: true },
    );
    return () => {
      live = false;
      unsubscribe();
    };
  }, [api, props.environmentId, props.projectId, registry]);
  useEffect(() => {
    let live = true;
    void api.list({ projectId: props.projectId, includeArchived: true }).then(
      (items) => {
        if (live) {
          setDiagrams(items);
          setError(null);
        }
      },
      (cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : "Unable to load diagrams.");
      },
    );
    return () => {
      live = false;
    };
  }, [api, props.projectId]);
  useEffect(() => {
    setLibrary(props.diagramId === null);
  }, [props.diagramId]);
  const reportSaveState = useCallback(
    (state: DiagramSaveState) => {
      setSaveState(state);
      if (state === "offline") void refresh().catch(() => {});
    },
    [refresh],
  );
  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Diagram operation failed.");
    } finally {
      setBusy(false);
    }
  }, []);
  const select = (diagram: DiagramMetadata) => {
    props.onSelectDiagram(diagram);
    setLibrary(false);
    setSaveState("connecting");
  };
  const lifecycle = (diagram: DiagramMetadata, operation: DiagramLifecycleInput["operation"]) =>
    run(async () => {
      if (operation === "rename") return;
      const result = await api.lifecycle({
        projectId: props.projectId,
        diagramId: diagram.id,
        operation,
      });
      await refresh();
      if (operation === "duplicate" && result) select(result);
      if (operation === "delete" && diagram.id === props.diagramId) setLibrary(true);
    });
  const add = () =>
    run(async () => {
      const diagram = await api.create({ projectId: props.projectId, name: "Untitled diagram" });
      await refresh();
      select(diagram);
    });
  const rename = (diagram: DiagramMetadata, name: string) =>
    run(async () => {
      const renamed = await api.lifecycle({
        projectId: props.projectId,
        diagramId: diagram.id,
        operation: "rename",
        name,
      });
      await refresh();
      if (renamed) props.onSelectDiagram(renamed);
    });
  const attach = (kind: DiagramPageScope["kind"]) =>
    run(async () => {
      if (!active) return;
      const host = findDiagramHost(props.environmentId, active.id);
      if (!host) throw new Error("Canvas is still connecting.");
      await host.flush();
      props.onAttach({
        diagramId: active.id,
        projectId: props.projectId,
        label: active.name,
        scope: host.scope(kind),
      });
    });
  const exportDocument = () =>
    run(async () => {
      if (!active) return;
      await findDiagramHost(props.environmentId, active.id)?.flush();
      download(
        new Blob(
          [JSON.stringify(await api.export({ projectId: props.projectId, diagramId: active.id }))],
          { type: "application/json" },
        ),
        `${active.name}.tldr`,
      );
    });
  const exportImage = (format: "png" | "svg") =>
    run(async () => {
      if (!active) return;
      const host = findDiagramHost(props.environmentId, active.id);
      if (!host) throw new Error("Canvas is still connecting.");
      const capture = await host.capture(host.scope(scope), format);
      const bytes = Uint8Array.from(atob(capture.base64), (char) => char.charCodeAt(0));
      download(new Blob([bytes], { type: capture.mimeType }), `${active.name}.${format}`);
    });
  const onImport = (file: File) =>
    run(async () => {
      const diagram = await api.import({
        projectId: props.projectId,
        name: file.name.replace(/\.tldr$|\.json$/i, "") || "Imported diagram",
        document: JSON.parse(await file.text()),
      });
      await refresh();
      select(diagram);
    });

  return (
    <div className="flex h-full min-h-0 flex-col" data-canvas-panel>
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        {library ? (
          <>
            <span className="flex-1 text-sm font-medium">Project diagrams</span>
            <Button
              variant="ghost"
              size="compact"
              disabled={busy}
              onClick={() => importRef.current?.click()}
            >
              <Upload />
              Import
            </Button>
            <Button size="compact" disabled={busy} onClick={add}>
              <Plus />
              New diagram
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Open diagram library"
              onClick={() => setLibrary(true)}
            >
              <ArrowLeft />
            </Button>
            <div className="min-w-0 flex-1">
              <Input
                size="compact"
                aria-label="Diagram name"
                key={`${active?.id ?? ""}:${active?.name ?? ""}`}
                defaultValue={active?.name ?? "Unavailable diagram"}
                disabled={!active || busy}
                onBlur={(event) => {
                  const name = event.target.value.trim();
                  if (active && name && name !== active.name) void rename(active, name);
                }}
              />
            </div>
            <span className="whitespace-nowrap text-xs text-muted-foreground" role="status">
              {active?.archivedAt ? "Archived" : saveLabels[saveState]}
            </span>
            {active ? (
              <>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Duplicate diagram"
                  disabled={busy}
                  onClick={() => lifecycle(active, "duplicate")}
                >
                  <Copy />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={active.archivedAt ? "Restore diagram" : "Archive diagram"}
                  disabled={busy}
                  onClick={() => lifecycle(active, active.archivedAt ? "restore" : "archive")}
                >
                  <Archive />
                </Button>
              </>
            ) : null}
          </>
        )}
      </div>
      <input
        ref={importRef}
        type="file"
        accept=".tldr,.json,application/json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void onImport(file);
          event.target.value = "";
        }}
      />
      {error ? (
        <div className="border-b bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
          {error}
        </div>
      ) : null}
      {library ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="mb-3">
            <Input
              type="search"
              size="compact"
              placeholder="Search diagrams"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="mb-3 flex gap-2">
            <Button
              variant={archived ? "ghost" : "secondary"}
              size="compact"
              onClick={() => setArchived(false)}
            >
              Active
            </Button>
            <Button
              variant={archived ? "secondary" : "ghost"}
              size="compact"
              onClick={() => setArchived(true)}
            >
              Archived
            </Button>
          </div>
          <div className="flex flex-col gap-1">
            {diagrams
              .filter(
                (diagram) =>
                  Boolean(diagram.archivedAt) === archived &&
                  diagram.name.toLowerCase().includes(search.toLowerCase()),
              )
              .map((diagram) => (
                <div key={diagram.id} className="flex items-center gap-1 rounded-md border p-2">
                  <button
                    className="min-w-0 flex-1 truncate text-left text-sm"
                    onClick={() => select(diagram)}
                  >
                    {diagram.name}
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={diagram.archivedAt ? "Restore diagram" : "Archive diagram"}
                    disabled={busy}
                    onClick={() => lifecycle(diagram, diagram.archivedAt ? "restore" : "archive")}
                  >
                    <Archive />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Delete ${diagram.name}`}
                    disabled={busy}
                    onClick={() => setDeleteTarget(diagram)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
          </div>
          {diagrams.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Create a diagram to start sketching.
            </p>
          ) : null}
        </div>
      ) : active ? (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
            <select
              className="min-w-0 rounded border bg-background px-2 py-1 text-xs"
              aria-label="Diagram context scope"
              value={scope}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "diagram" || value === "selection" || value === "viewport")
                  setScope(value);
              }}
            >
              <option value="diagram">Whole diagram</option>
              <option value="selection">Selection</option>
              <option value="viewport">Visible area</option>
            </select>
            <Button
              size="compact"
              disabled={busy || saveState !== "saved"}
              onClick={() => attach(scope)}
            >
              Add to context
            </Button>
            <div className="ml-auto flex items-center gap-1">
              <Button variant="ghost" size="compact" disabled={busy} onClick={exportDocument}>
                <Download />
                Editable
              </Button>
              <Button
                variant="ghost"
                size="compact"
                disabled={busy}
                onClick={() => exportImage("png")}
              >
                PNG
              </Button>
              <Button
                variant="ghost"
                size="compact"
                disabled={busy}
                onClick={() => exportImage("svg")}
              >
                SVG
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <Suspense
              fallback={<div className="p-4 text-sm text-muted-foreground">Loading Canvas...</div>}
            >
              <DiagramEditor
                key={`${active.id}:${active.archivedAt ?? "active"}`}
                environmentId={props.environmentId}
                diagram={active}
                onSaveState={reportSaveState}
                onAddSelectionToChat={() => void attach("selection")}
              />
            </Suspense>
          </div>
        </>
      ) : (
        <div className="p-4 text-sm text-muted-foreground">This diagram is unavailable.</div>
      )}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete diagram?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.name} will be permanently deleted. Existing chat references will show
              it as unavailable.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                const diagram = deleteTarget;
                if (!diagram) return;
                void lifecycle(diagram, "delete").then(() => setDeleteTarget(null));
              }}
            >
              Delete diagram
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
