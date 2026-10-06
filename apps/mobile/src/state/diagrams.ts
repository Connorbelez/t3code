import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

const commands = {
  list: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "Load diagrams",
    tag: WS_METHODS.diagramsList,
  }),
  preview: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "Load diagram preview",
    tag: WS_METHODS.diagramsPreview,
  }),
  read: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "Read diagram",
    tag: WS_METHODS.diagramsRead,
  }),
  prepare: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "Prepare diagram context",
    tag: WS_METHODS.diagramsPrepareContext,
  }),
};
export const diagramCommands = commands;
