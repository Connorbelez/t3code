import * as Contracts from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as DiagramService from "../../../diagrams/DiagramService.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";

const shared = {
  failure: Schema.Union([Contracts.DiagramOperationError, Contracts.OrchestratorMcpFailure]),
  failureMode: "return" as const,
  dependencies: [
    Invocation.McpInvocationContext,
    DiagramService.DiagramService,
    Threads.ThreadManagementService,
  ],
};
const projectId = Schema.optional(Contracts.ProjectId);
const target = { projectId, diagramId: Contracts.DiagramId };

const list = Tool.make("t3_diagram_list", {
  ...shared,
  description:
    "List saved diagrams in the calling thread's project. Include archived diagrams on request. Other projects are unavailable to thread callers.",
  parameters: Schema.Struct({ projectId, includeArchived: Schema.optional(Schema.Boolean) }),
  success: Schema.Array(Contracts.DiagramMetadata),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const read = Tool.make("t3_diagram_read", {
  ...shared,
  description:
    "Read current diagram revision and bounded all-page shape/binding summaries. Set includeRecords or recordIds for schema-bearing records and paginate with nextOffset. Retain exact target, ancestor, binding and asset records as expected preconditions before editing. Reads work without an editor.",
  parameters: Schema.Struct({ ...Contracts.DiagramReadInput.fields, projectId }),
  success: Contracts.DiagramReadResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const create = Tool.make("t3_diagram_create", {
  ...shared,
  description:
    "Create an empty saved diagram in the calling project when the user's task calls for it. Attaching a diagram is context and does not authorize changing it.",
  parameters: Schema.Struct({ projectId, name: Contracts.DiagramName }),
  success: Contracts.DiagramMetadata,
}).annotate(Tool.Destructive, false);

const apply = Tool.make("t3_diagram_apply", {
  ...shared,
  description:
    "Apply one atomic bounded SDK record batch. Read first and pass expected records for every target and required ancestor, parent, binding or asset dependency. Respect the attached selection focus and leave unrelated records unchanged. A connected editor host is required. Success is a durable receipt with one host Undo step. Reuse requestId with the identical batch after an uncertain response. Read the receipt before fresh work. Failed or disconnected work is never replayed later.",
  parameters: Schema.Struct({ ...target, batch: Contracts.DiagramBatch }),
  success: Contracts.DiagramMutationReceipt,
})
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const receipt = Tool.make("t3_diagram_receipt", {
  ...shared,
  description:
    "Read this caller's durable mutation receipt after an uncertain outcome. A null result means that request has not committed.",
  parameters: Schema.Struct({ ...target, requestId: Contracts.DiagramRequestId }),
  success: Schema.NullOr(Contracts.DiagramMutationReceipt),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const lifecycle = Tool.make("t3_diagram_update", {
  ...shared,
  description:
    "Rename, duplicate, archive, restore or permanently delete a saved diagram. Archive and delete require an explicit user request. Closing a Canvas or thread preserves its diagrams. Duplicate creates a separate saved document.",
  parameters: Schema.Struct({
    ...target,
    operation: Schema.Literals(["rename", "duplicate", "archive", "restore", "delete"]),
    name: Schema.optional(Contracts.DiagramName),
  }),
  success: Schema.NullOr(Contracts.DiagramMetadata),
}).annotate(Tool.Destructive, true);

const exportDocument = Tool.make("t3_diagram_export", {
  ...shared,
  description:
    "Export an editable tldraw document with its assets. Export is explicit and never mirrors the document into workspace files automatically.",
  parameters: Schema.Struct(target),
  success: Contracts.DiagramDocumentData,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const DiagramCaptureTool = Tool.make("t3_diagram_capture", {
  ...shared,
  failureMode: "error",
  description:
    "Capture a fresh PNG of the specified page, saved selection IDs/bounds or viewport. Returns actual image content plus page-space bounds, dimensions and committed revision. Requires a connected web/desktop editor and preserves human camera/selection. A missing selected shape fails scope recovery rather than expanding the scope.",
  parameters: Schema.Struct({ ...target, scope: Contracts.DiagramScope }),
  success: Schema.Struct({
    diagramId: Contracts.DiagramId,
    revision: Contracts.DiagramRevision,
    scope: Contracts.DiagramScope,
    bounds: Contracts.DiagramBounds,
    screenshot: Schema.Struct({
      data: Schema.String,
      mimeType: Schema.Literal("image/png"),
      width: Contracts.NonNegativeInt,
      height: Contracts.NonNegativeInt,
    }),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const DiagramToolkit = Toolkit.make(
  list,
  read,
  create,
  apply,
  receipt,
  lifecycle,
  exportDocument,
);
export const DiagramCaptureToolkit = Toolkit.make(DiagramCaptureTool);
