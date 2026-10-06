import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentEventSubscription,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { AtomRegistry } from "effect/reactivity";
import { subscribe } from "@t3tools/client-runtime/rpc";
import type { EnvironmentRpcInput } from "@t3tools/client-runtime/rpc";

import { connectionAtomRuntime } from "~/connection/runtime";

export const diagramCommands = {
  count: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "Count diagrams",
    tag: WS_METHODS.diagramsCount,
  }),
  preview: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "Read diagram preview",
    tag: WS_METHODS.diagramsPreview,
  }),
  capture: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "Capture diagram",
    tag: WS_METHODS.diagramsCapture,
  }),
  prepareContext: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "Prepare diagram context",
    tag: WS_METHODS.diagramsPrepareContext,
  }),
  list: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "Load diagrams",
    tag: WS_METHODS.diagramsList,
  }),
  create: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "Create diagram",
    tag: WS_METHODS.diagramsCreate,
  }),
  read: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "Read diagram",
    tag: WS_METHODS.diagramsRead,
  }),
  lifecycle: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "Update diagram",
    tag: WS_METHODS.diagramsLifecycle,
  }),
  import: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "Import diagram",
    tag: WS_METHODS.diagramsImport,
  }),
  export: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "Export diagram",
    tag: WS_METHODS.diagramsExport,
  }),
  syncSend: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "Save diagram",
    tag: WS_METHODS.diagramsSyncSend,
  }),
  hostRespond: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "Respond to diagram request",
    tag: WS_METHODS.diagramsHostRespond,
  }),
  uploadAsset: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "Upload diagram image",
    tag: WS_METHODS.diagramsUploadAsset,
  }),
  readAsset: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "Load diagram image",
    tag: WS_METHODS.diagramsReadAsset,
  }),
};

export const diagramSyncEvents = createEnvironmentEventSubscription(connectionAtomRuntime, {
  label: "Diagram synchronization",
  subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.diagramsSyncConnect>) =>
    subscribe(WS_METHODS.diagramsSyncConnect, input),
});
export const diagramHostRequests = createEnvironmentEventSubscription(connectionAtomRuntime, {
  label: "Diagram editor host",
  subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.diagramsHostConnect>) =>
    subscribe(WS_METHODS.diagramsHostConnect, input),
});
export const diagramChanges = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "Diagram library changes",
  tag: WS_METHODS.diagramsChanges,
  idleTtlMs: 0,
});

export function createDiagramApi(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
) {
  const bind =
    <I, A, E>(
      command: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: I }, A, E>,
    ) =>
    async (input: I): Promise<A> => {
      const result = await runAtomCommand(
        registry,
        command,
        { environmentId, input },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value;
    };
  return {
    count: bind(diagramCommands.count),
    preview: bind(diagramCommands.preview),
    capture: bind(diagramCommands.capture),
    prepareContext: bind(diagramCommands.prepareContext),
    list: bind(diagramCommands.list),
    create: bind(diagramCommands.create),
    read: bind(diagramCommands.read),
    lifecycle: bind(diagramCommands.lifecycle),
    import: bind(diagramCommands.import),
    export: bind(diagramCommands.export),
    syncSend: bind(diagramCommands.syncSend),
    hostRespond: bind(diagramCommands.hostRespond),
    uploadAsset: bind(diagramCommands.uploadAsset),
    readAsset: bind(diagramCommands.readAsset),
  };
}
export type DiagramApi = ReturnType<typeof createDiagramApi>;

export const diagramArtifactCommands = {
  read: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "Read HTML artifact",
    tag: WS_METHODS.diagramsArtifactRead,
  }),
  css: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "Style HTML artifact",
    tag: WS_METHODS.diagramsArtifactCss,
  }),
  capture: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "Capture HTML artifact",
    tag: WS_METHODS.diagramsArtifactCapture,
  }),
};

export const diagramArtifactEvents = createEnvironmentEventSubscription(connectionAtomRuntime, {
  label: "HTML artifact source changes",
  subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.diagramsArtifactWatch>) =>
    subscribe(WS_METHODS.diagramsArtifactWatch, input),
});

export function createDiagramArtifactApi(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
) {
  const bind =
    <I, A, E>(
      command: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: I }, A, E>,
    ) =>
    async (input: I): Promise<A> => {
      const result = await runAtomCommand(
        registry,
        command,
        { environmentId, input },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value;
    };
  return {
    read: bind(diagramArtifactCommands.read),
    css: bind(diagramArtifactCommands.css),
    capture: bind(diagramArtifactCommands.capture),
  };
}
export type DiagramArtifactApi = ReturnType<typeof createDiagramArtifactApi>;
