import { DiagramOperationError, type DiagramBatch } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  Editor,
  EmbedShapeUtil,
  createTLStore,
  defaultShapeUtils,
  defaultBindingUtils,
  defaultTools,
  defaultShapeTools,
  isEqual,
  type TLAnyShapeUtilConstructor,
  type TLRecord,
} from "tldraw";
import { parseDocumentRecord } from "./diagramSocket";

export function validateDiagramBatch(mountedEditor: Editor, batch: DiagramBatch) {
  const records = mountedEditor.store.serialize("document");
  for (const expected of batch.expected) {
    if (!isEqual(records[expected.id as TLRecord["id"]] ?? null, expected.record))
      throw new DiagramOperationError({ code: "stale" });
  }
  const puts = batch.puts.map(parseDocumentRecord);
  const container = document.createElement("div");
  container.style.cssText =
    "position:fixed;left:-10000px;width:1024px;height:768px;pointer-events:none";
  document.body.appendChild(container);
  let rehearsal: Editor | undefined;
  try {
    // The pinned SDK's ArrowShapeUtil declaration widens optional callback fields to undefined;
    // its own default array is nevertheless the native Editor's supported runtime configuration.
    const shapeUtils = defaultShapeUtils.map((util) =>
      util.type === "embed" ? EmbedShapeUtil.configure({ embedDefinitions: [] }) : util,
    ) as unknown as readonly TLAnyShapeUtilConstructor[];
    rehearsal = new Editor({
      store: createTLStore({ schema: mountedEditor.store.schema, initialData: records }),
      shapeUtils,
      bindingUtils: defaultBindingUtils,
      tools: [...defaultTools, ...defaultShapeTools],
      initialState: mountedEditor.getCurrentToolId(),
      autoFocus: false,
      getContainer: () => container,
    });
    const editor = rehearsal;
    editor.setCurrentTool(mountedEditor.getPath());
    editor.run(
      () => {
        editor.store.put(puts);
        editor.store.remove(batch.deletes as TLRecord["id"][]);
      },
      { ignoreShapeLock: true },
    );
    const requested = { ...records };
    for (const record of puts) requested[record.id] = record;
    for (const id of batch.deletes) delete requested[id as TLRecord["id"]];
    if (!isEqual(requested, editor.store.serialize("document")))
      throw new DiagramOperationError({ code: "invalid-records" });
  } catch (cause) {
    if (Schema.is(DiagramOperationError)(cause)) throw cause;
    throw new DiagramOperationError({ code: "invalid-records" });
  } finally {
    rehearsal?.dispose();
    container.remove();
  }
}
