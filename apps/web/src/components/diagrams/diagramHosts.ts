import {
  DiagramOperationError,
  type DiagramAnnotatedCapture,
  type DiagramBatch,
  type DiagramCapture,
  type DiagramComposeRequest,
  type DiagramHostAnnotateInput,
  type DiagramHostComposeResult,
  type DiagramId,
  type DiagramMetadata,
  type DiagramPageScope,
  type DiagramScope,
  type EnvironmentId,
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
    scope: DiagramPageScope,
    format: "png" | "svg",
    expectedRevision?: number,
  ) => Promise<DiagramCapture>;
  compose: (request: DiagramComposeRequest) => Promise<DiagramHostComposeResult>;
  /** Renders numbered comments over the page; never touches the store, selection or camera. */
  annotate: (input: DiagramHostAnnotateInput) => Promise<DiagramAnnotatedCapture>;
  scope: (kind: DiagramPageScope["kind"]) => DiagramPageScope;
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

export type TemporaryDiagramLease = {
  /** Records the editor the lease mounted, so later requests can find it. */
  bind: (host: MountedDiagramHost) => void;
  end: () => void;
};
/**
 * The off-screen editor a host mounts for a diagram no window has open. Each request using it
 * holds a lease and it unmounts when the last lease ends, so the capture that follows a compose
 * keeps the editor its prepare mounted instead of losing it mid-capture.
 */
export function createTemporaryDiagramEditor(show: (diagram: DiagramMetadata | null) => void) {
  type Entry = { diagram: DiagramMetadata; host: MountedDiagramHost | null; leases: number };
  let current: Entry | null = null;
  const lease = (entry: Entry): TemporaryDiagramLease => {
    entry.leases += 1;
    if (entry.leases === 1) show(entry.diagram);
    let ended = false;
    return {
      bind: (host) => {
        entry.host = host;
      },
      end: () => {
        if (ended || current !== entry) return;
        ended = true;
        entry.leases -= 1;
        if (entry.leases === 0) show(null);
      },
    };
  };
  return {
    /** Leases the temporary editor when `host` is it, even while it is unmounting. */
    adopt: (host: MountedDiagramHost) =>
      current !== null && current.host === host ? lease(current) : null,
    /** Mounts `diagram` off-screen, or shares the editor already mounted for it. */
    open: (diagram: DiagramMetadata) => {
      if (current && current.leases > 0 && current.diagram.id !== diagram.id)
        throw new DiagramOperationError({ code: "busy", diagramId: diagram.id });
      if (current?.diagram.id !== diagram.id) current = { diagram, host: null, leases: 0 };
      return lease(current);
    },
    /** Unmounts at once and voids outstanding leases, as when the host connection drops. */
    reset: () => {
      current = null;
      show(null);
    },
  };
}
