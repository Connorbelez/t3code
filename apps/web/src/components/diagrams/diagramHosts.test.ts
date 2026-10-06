import { DiagramId, ProjectId, type DiagramMetadata } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createTemporaryDiagramEditor, type MountedDiagramHost } from "./diagramHosts";

const diagram = (id: string): DiagramMetadata => ({
  id: DiagramId.make(id),
  projectId: ProjectId.make("project:diagrams"),
  name: id,
  revision: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
});
const plan = diagram("11111111-1111-4111-8111-111111111111");
const other = diagram("22222222-2222-4222-8222-222222222222");
const host = {} as MountedDiagramHost;

describe("temporary diagram editor", () => {
  it("stays mounted through a capture that starts before the prepare's fence releases", () => {
    const shown: Array<string | null> = [];
    const temporary = createTemporaryDiagramEditor((value) => shown.push(value?.name ?? null));
    const prepare = temporary.open(plan);
    prepare.bind(host);
    const capture = temporary.adopt(host);
    prepare.end();
    expect(shown).toEqual([plan.name]);
    capture?.end();
    expect(shown).toEqual([plan.name, null]);

    // The next request finds the editor still registered while it unmounts and keeps it.
    temporary.adopt(host)?.end();
    expect(shown).toEqual([plan.name, null, plan.name, null]);
  });

  it("refuses a second diagram while one is leased and voids leases on reset", () => {
    const shown: Array<string | null> = [];
    const temporary = createTemporaryDiagramEditor((value) => shown.push(value?.name ?? null));
    const lease = temporary.open(plan);
    expect(() => temporary.open(other)).toThrow("Diagram operation failed (busy).");
    temporary.reset();
    lease.end();
    temporary.open(other).end();
    expect(shown).toEqual([plan.name, null, other.name, null]);
  });
});
