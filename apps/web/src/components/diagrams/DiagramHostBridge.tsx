import { RegistryContext } from "@effect/atom-react";
import {
  DIAGRAM_SDK_VERSION,
  DiagramBatch,
  DiagramComposeRequest,
  DiagramOperationError,
  DiagramScope,
  type DiagramHostRequest,
  type DiagramMetadata,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { lazy, Suspense, useContext, useEffect, useMemo, useState } from "react";
import { useServerConfigs } from "~/state/entities";
import { createDiagramApi, diagramHostRequests } from "./diagramApi";
import {
  awaitDiagramHost,
  diagramHostClientId,
  findDiagramHost,
  getVisibleDiagramHostIds,
  subscribeDiagramHosts,
  type MountedDiagramHost,
} from "./diagramHosts";

const DiagramEditor = lazy(() => import("./DiagramEditor"));
const isDiagramError = Schema.is(DiagramOperationError);
const captureInput = Schema.Struct({
  scope: DiagramScope,
  revision: Schema.Number,
  format: Schema.Literals(["png", "svg"]),
});
const decodeCaptureInput = Schema.decodeUnknownSync(captureInput);
const decodeBatch = Schema.decodeUnknownSync(DiagramBatch);
const decodeComposeRequest = Schema.decodeUnknownSync(DiagramComposeRequest);

export default function DiagramHostBridge() {
  const configs = useServerConfigs();
  return (
    <>
      {[...configs]
        .filter(
          ([, config]) =>
            config.environment.capabilities.diagrams?.sdkVersion === DIAGRAM_SDK_VERSION &&
            config.environment.capabilities.diagrams.protocolVersion === 1,
        )
        .map(([environmentId]) => (
          <EnvironmentDiagramHost key={environmentId} environmentId={environmentId} />
        ))}
    </>
  );
}

function EnvironmentDiagramHost({ environmentId }: { environmentId: EnvironmentId }) {
  const registry = useContext(RegistryContext);
  const api = useMemo(() => createDiagramApi(registry, environmentId), [registry, environmentId]);
  const [onDemand, setOnDemand] = useState<DiagramMetadata | null>(null);
  const [focused, setFocused] = useState(() => document.hasFocus());
  const [mountedDiagramIds, setMountedDiagramIds] = useState(() =>
    getVisibleDiagramHostIds(environmentId),
  );
  useEffect(() => {
    const updateFocus = () => {
      setFocused(document.hasFocus());
    };
    const updateMounted = () => {
      const next = getVisibleDiagramHostIds(environmentId);
      setMountedDiagramIds((previous) => (previous.join(",") === next.join(",") ? previous : next));
    };
    updateMounted();
    const unlisten = subscribeDiagramHosts(updateMounted);
    window.addEventListener("focus", updateFocus);
    window.addEventListener("blur", updateFocus);
    return () => {
      unlisten();
      window.removeEventListener("focus", updateFocus);
      window.removeEventListener("blur", updateFocus);
    };
  }, [environmentId]);
  useEffect(() => {
    const controller = new AbortController();
    let connectionController = new AbortController();
    const fencedHosts = new Set<MountedDiagramHost>();
    let generation: string | null = null;
    let temporaryTarget: string | null = null;
    const releaseTemporary = () => {
      temporaryTarget = null;
      setOnDemand(null);
    };
    const disconnect = () => {
      generation = null;
      connectionController.abort();
      for (const host of fencedHosts) host.release();
      fencedHosts.clear();
      releaseTemporary();
    };
    const handle = async (request: Exclude<DiagramHostRequest, { operation: "ready" }>) => {
      if (generation !== request.connectionId || controller.signal.aborted) return;
      const signal = connectionController.signal;
      const connected = () =>
        !signal.aborted && !controller.signal.aborted && generation === request.connectionId;
      const requireConnected = () => {
        if (!connected())
          throw new DiagramOperationError({ code: "disconnected", diagramId: request.diagramId });
      };
      let temporary = false;
      let ownFence = false;
      let host = findDiagramHost(environmentId, request.diagramId);
      try {
        if (!host) {
          if (temporaryTarget !== null)
            throw new DiagramOperationError({ code: "busy", diagramId: request.diagramId });
          temporaryTarget = request.diagramId;
          temporary = true;
          const current = await api.read(request);
          requireConnected();
          setOnDemand(current.diagram);
          host = await awaitDiagramHost(environmentId, request.diagramId, signal);
          requireConnected();
        }
        if (request.operation === "prepare-batch") {
          const result = await host.prepare(
            request.connectionId,
            request.requestId,
            decodeBatch(request.input),
          );
          ownFence = true;
          requireConnected();
          const preparedHost = host;
          const previousRelease = preparedHost.onReleased;
          fencedHosts.add(preparedHost);
          preparedHost.onReleased = () => {
            fencedHosts.delete(preparedHost);
            preparedHost.onReleased = previousRelease;
            previousRelease?.();
            if (temporary) releaseTemporary();
          };
          await api.hostRespond({
            requestId: request.requestId,
            connectionId: request.connectionId,
            result: { ok: true, value: result },
          });
        } else if (request.operation === "compose") {
          const value = await host.compose(decodeComposeRequest(request.input));
          requireConnected();
          await api.hostRespond({
            requestId: request.requestId,
            connectionId: request.connectionId,
            result: { ok: true, value },
          });
          if (temporary) releaseTemporary();
        } else {
          const input = decodeCaptureInput(request.input);
          const value = await host.capture(input.scope, input.format, input.revision);
          requireConnected();
          await api.hostRespond({
            requestId: request.requestId,
            connectionId: request.connectionId,
            result: { ok: true, value },
          });
          if (temporary) releaseTemporary();
        }
      } catch (cause) {
        if (ownFence) host?.release();
        if (temporary && connected()) releaseTemporary();
        if (!connected()) return;
        const error = isDiagramError(cause)
          ? cause
          : new DiagramOperationError({ code: "assets-unavailable", diagramId: request.diagramId });
        await api
          .hostRespond({
            requestId: request.requestId,
            connectionId: request.connectionId,
            result: { ok: false, error },
          })
          .catch(() => {});
      }
    };
    const unsubscribe = diagramHostRequests(registry, {
      environmentId,
      input: {
        environmentId,
        clientId: diagramHostClientId,
        sdkVersion: DIAGRAM_SDK_VERSION,
        focused,
        mountedDiagramIds,
        operations: ["prepare-batch", "capture", "compose"],
      },
      onEvent: (request) => {
        if (request.operation === "ready") {
          if (generation !== request.connectionId) {
            disconnect();
            connectionController = new AbortController();
          }
          generation = request.connectionId;
        } else void handle(request);
      },
      onError: disconnect,
    });
    return () => {
      controller.abort();
      disconnect();
      unsubscribe();
    };
  }, [api, environmentId, focused, mountedDiagramIds, registry]);
  return onDemand ? (
    <div
      className="pointer-events-none fixed -left-[10000px] top-0 h-[768px] w-[1024px] overflow-hidden"
      aria-hidden="true"
    >
      <Suspense fallback={null}>
        <DiagramEditor environmentId={environmentId} diagram={onDemand} visible={false} />
      </Suspense>
    </div>
  ) : null;
}
