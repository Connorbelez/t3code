import { DiagramOperationError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { PageRecordType, createTLSchema, type TLRecord } from "tldraw";
import { describe, expect, it } from "vite-plus/test";

import {
  composeOnHost,
  decodeHostComposeRequest,
  type HostComposeEditor,
} from "./diagramHostCompose";

const isDiagramError = Schema.is(DiagramOperationError);
const page = createTLSchema().types.page.validate({
  id: PageRecordType.createId("page"),
  typeName: "page",
  meta: {},
  name: "Page",
  index: "a1",
});
const request = {
  spec: { kit: "flow" as const, key: "checkout", nodes: [{ key: "start" }, { key: "pay" }] },
};
const replay = (records: readonly TLRecord[]): HostComposeEditor["rehearse"] => {
  return (puts, deletes) => {
    const after = new Map(records.map((item) => [item.id as string, item]));
    for (const id of deletes) after.delete(id);
    for (const item of puts) after.set(item.id, item);
    return after;
  };
};
const editor = (overrides: Partial<HostComposeEditor> = {}): HostComposeEditor => ({
  fontsReady: () => Promise.resolve(),
  measureText: (text) => ({ w: text.length * 8, h: 20 }),
  rehearse: replay([page]),
  ...overrides,
});
const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (cause) {
    if (isDiagramError(cause)) return { code: cause.code, details: cause.details };
    throw cause;
  }
  throw new Error("expected a diagram error");
};

describe("diagram host compose", () => {
  it("teaches that an editor too old for the request needs an update", async () => {
    expect(
      await failure(
        (async () =>
          decodeHostComposeRequest({ spec: { kit: "gantt", key: "plan", nodes: [] } }))(),
      ),
    ).toEqual({
      code: "invalid-spec",
      details: {
        issues: [
          {
            path: "spec.kit",
            message:
              'the T3 Code running this editor is older than the server and cannot read "gantt"; ask the user to update T3 Code where the diagram editor is open, then retry',
          },
        ],
      },
    });
  });

  it("measures text only after the editor's fonts load", async () => {
    const events: string[] = [];
    let pipelineLoaded = () => {};
    const loaded = new Promise<void>((resolve) => {
      pipelineLoaded = resolve;
    });
    await composeOnHost(
      request,
      [page],
      editor({
        // The fonts arrive after the pipeline code, so measuring early would come first.
        fontsReady: () => loaded.then(() => void events.push("fonts")),
        measureText: (text) => {
          events.push("measure");
          return { w: text.length * 8, h: 20 };
        },
      }),
      {
        pipeline: async () => {
          const pipeline = await import("@t3tools/diagram-compose/compose");
          pipelineLoaded();
          return pipeline;
        },
        mermaid: () => Promise.reject(new Error("not expected")),
      },
    );
    expect(events.slice(0, 2)).toEqual(["fonts", "measure"]);
  });

  it("reports a pipeline exception as records the editor cannot build", async () => {
    expect(
      await failure(
        composeOnHost(
          request,
          [page],
          editor({
            rehearse: () => {
              throw new Error("indexBetween: out of order");
            },
          }),
        ),
      ),
    ).toEqual({
      code: "invalid-records",
      details: {
        issues: [
          {
            path: "spec",
            message:
              "the editor could not build this composition (indexBetween: out of order); nothing changed",
          },
        ],
      },
    });
  });

  it("reports code the editor cannot download as a lost connection", async () => {
    const offline = () =>
      Promise.reject(new TypeError("Failed to fetch dynamically imported module"));
    expect(
      await failure(
        composeOnHost(request, [page], editor(), { pipeline: offline, mermaid: offline }),
      ),
    ).toEqual({ code: "disconnected", details: undefined });
    const { compose } = await import("@t3tools/diagram-compose/compose");
    expect(
      await failure(
        composeOnHost({ mermaid: { key: "m", text: "graph TD\n  a --> b" } }, [page], editor(), {
          pipeline: () => Promise.resolve({ compose }),
          mermaid: offline,
        }),
      ),
    ).toEqual({ code: "disconnected", details: undefined });
  });
});
