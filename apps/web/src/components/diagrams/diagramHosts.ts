import type {
  DiagramBatch,
  DiagramCapture,
  DiagramId,
  DiagramMetadata,
  DiagramScope,
  EnvironmentId,
} from "@t3tools/contracts";
import type { DiagramSaveState } from "./diagramSocket";

const identityBytes = crypto.getRandomValues(new Uint8Array(16));
export const diagramHostClientId = `diagram-${Array.from(identityBytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
export type DiagramContextReference = {
  diagramId: DiagramId;
  projectId: DiagramMetadata["projectId"];
  label: string;
  scope: DiagramScope;
};
export type MountedDiagramHost = {
  prepare: (
    generation: string,
    requestId: string,
    batch: DiagramBatch,
  ) => Promise<{ connectionId: string; fingerprint: string }>;
  capture: (
    scope: DiagramScope,
    format: "png" | "svg",
    expectedRevision?: number,
  ) => Promise<DiagramCapture>;
  scope: (kind: DiagramScope["kind"]) => DiagramScope;
  saveState: () => DiagramSaveState;
  flush: () => Promise<void>;
  release: () => void;
  onReleased: (() => void) | null;
};
const hosts = new Map<string, MountedDiagramHost>();
const visibleHosts = new Map<string, { environmentId: EnvironmentId; diagramId: DiagramId }>();
const hostListeners = new Set<() => void>();
const waiters = new Map<string, Set<(host: MountedDiagramHost) => void>>();
export const diagramHostKey = (environmentId: EnvironmentId, diagramId: DiagramId) =>
  `${environmentId}:${diagramId}`;
export function findDiagramHost(environmentId: EnvironmentId, diagramId: DiagramId) {
  return hosts.get(diagramHostKey(environmentId, diagramId));
}
export function getVisibleDiagramHostIds(environmentId: EnvironmentId) {
  return [...visibleHosts.values()]
    .filter((host) => host.environmentId === environmentId)
    .map((host) => host.diagramId)
    .sort();
}
export function subscribeDiagramHosts(listener: () => void) {
  hostListeners.add(listener);
  return () => {
    hostListeners.delete(listener);
  };
}
export function registerDiagramHost(
  environmentId: EnvironmentId,
  diagramId: DiagramId,
  host: MountedDiagramHost,
  visible = true,
) {
  const key = diagramHostKey(environmentId, diagramId);
  hosts.set(key, host);
  if (visible) visibleHosts.set(key, { environmentId, diagramId });
  for (const listener of hostListeners) listener();
  for (const done of waiters.get(key) ?? []) done(host);
  waiters.delete(key);
  return () => {
    if (hosts.get(key) === host) {
      hosts.delete(key);
      visibleHosts.delete(key);
      for (const listener of hostListeners) listener();
    }
    host.release();
  };
}
export function awaitDiagramHost(
  environmentId: EnvironmentId,
  diagramId: DiagramId,
  signal: AbortSignal,
) {
  const existing = findDiagramHost(environmentId, diagramId);
  if (existing) return Promise.resolve(existing);
  return new Promise<MountedDiagramHost>((resolve, reject) => {
    const key = diagramHostKey(environmentId, diagramId);
    const pending = waiters.get(key) ?? new Set();
    const done = (host: MountedDiagramHost) => {
      signal.removeEventListener("abort", abort);
      resolve(host);
    };
    const abort = () => {
      pending.delete(done);
      if (pending.size === 0) waiters.delete(key);
      reject(new Error("Diagram editor disconnected."));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    pending.add(done);
    waiters.set(key, pending);
    signal.addEventListener("abort", abort, { once: true });
  });
}
export async function flushMountedDiagram(environmentId: EnvironmentId, diagramId: DiagramId) {
  await findDiagramHost(environmentId, diagramId)?.flush();
}
