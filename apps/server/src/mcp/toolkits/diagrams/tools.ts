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
    "Read current diagram revision and bounded all-page shape/binding summaries. Each composition is listed once instead of its member shapes; pass compositionKey (or includeCompositions) for its detail: each member's last composed spec including ref, whether someone edited it, and its current text when edited, paged by compositionOffset and compositionLimit. Set includeRecords or recordIds for schema-bearing records and paginate with nextOffset. Retain exact target, ancestor, binding and asset records as expected preconditions before editing. Reads work without an editor.",
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
    "Apply one atomic bounded SDK record batch. Read first and pass expected records for every target and required ancestor, parent, binding or asset dependency. Respect the attached selection focus and leave unrelated records unchanged. A connected editor host is required. Success is a durable receipt with one host Undo step. Reuse requestId with the identical batch after an uncertain response. Read the receipt before fresh work. Failed or disconnected work is never replayed later. Prefer t3_diagram_compose for composition members (shapes whose meta has t3Composition); raw edits to them count as human edits.",
  parameters: Schema.Struct({ ...target, batch: Contracts.DiagramBatch }),
  success: Contracts.DiagramMutationReceipt,
})
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const composeGuidance = [
  "Compose a structured diagram such as a flowchart, state machine, UML class diagram, ER diagram, C4 view, architecture diagram, sequence diagram, wireframe screens or user flow from a spec of nodes and edges. T3 Code lays it out and draws editable stock shapes inside a frame named by the composition key.",
  "Prefer this over t3_diagram_apply for structured diagrams, and describe content, not coordinates: labels default to keys, kinds default per kit, and edges accept [from, to, label?]. t3_diagram_kit lists a kit's vocabulary and an example; invalid specs fail listing the valid options.",
  'Group nodes inside a boundary kind (flow group, state composite, uml-class package, c4 boundary, architecture zone) by setting parent to its key; boundaries nest. Every kit has a note kind; body { "on": "<node key>" } attaches it to that node.',
  "Instead of spec you may pass Mermaid flowchart, stateDiagram, classDiagram, erDiagram or sequenceDiagram text as mermaid: { key, text, title? }. Node IDs become member keys, so composing the same Mermaid again updates in place; subgraphs, composite states and namespaces become boundaries, and styling is ignored. Other Mermaid types fail unsupported-mermaid.",
  "By default the spec or Mermaid replaces the whole composition with that key. Before recomposing an existing key, read it with t3_diagram_read compositionKey and build the new spec from the member specs there.",
  'For small changes to an existing composition, send mode "patch" with a spec of only the nodes and edges to add or change, plus removeKeys for members to delete (a removed node takes its edges with it); every other member stays as it is. Mermaid always replaces. A shorthand edge in a patch is matched by its derived key from→to:kind, so give key to change a repeated edge.',
  "Recomposing keeps every existing position, places new members around them, keeps human edits to members your spec leaves unchanged, and rewrites only unedited members whose spec changed.",
  "If your spec changes or drops a member that someone else also edited, nothing changes and the call fails with conflict listing those keys in details.members; merge their current text into your spec, or leave those members as they were, and retry.",
  "Set relayout: true only when the user asks to rearrange the diagram, because it moves every member. The result lists overlapping member pairs; mention them rather than relaying out unasked.",
  'operation "remove" with key deletes a composition; arrows the user drew to it stay, unbound, and shapes the user drew inside its frame stay. operation "detach" with key leaves every shape in place as ordinary shapes you no longer manage; composing that key again starts a new composition. Do either only when the user asks.',
  "includeMembers: true returns each member key's shape ID. capture: true returns an image of the composition's frame after the change, to check your own result; it is costly, so use it once you are done, not on every call. When the image cannot be made, the change still applied and captureError says why.",
  "Retry freely after an uncertain response: without requestId an identical retry is a no-op; with requestId, a retry of a request that already committed returns that commit with zero counts and no image, without composing again, so use a new requestId for new work.",
  "If the call fails stale or busy, the canvas changed or someone is editing it: read the composition again and recompose against the current canvas.",
  "One composition is at most 500 records; split large diagrams into several compositions by area.",
  "A connected editor host is required. Attaching a diagram is context and does not authorize changing it.",
].join(" ");

const { capture: _capture, ...composeResultFields } = Contracts.DiagramComposeResult.fields;

/** Registered as an image tool: a capture goes out as image content, not base64 JSON. */
export const DiagramComposeTool = Tool.make("t3_diagram_compose", {
  ...shared,
  description: composeGuidance,
  parameters: Schema.Struct({ ...Contracts.DiagramComposeInput.fields, projectId }),
  success: Schema.Struct({
    ...composeResultFields,
    screenshot: Schema.optional(
      Schema.Struct({
        data: Schema.String,
        mimeType: Schema.Literal("image/png"),
        width: Contracts.NonNegativeInt,
        height: Contracts.NonNegativeInt,
      }),
    ),
  }),
})
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const kit = Tool.make("t3_diagram_kit", {
  ...shared,
  description:
    "Look up a composition kit's node kinds, edge kinds, defaults and a short example spec for t3_diagram_compose.",
  parameters: Schema.Struct({ kit: Contracts.DiagramKit }),
  success: Contracts.DiagramKitReference,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

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
    'Capture a fresh PNG of the specified page, saved selection IDs/bounds, viewport, or composition frame ({kind: "composition", key}). Returns actual image content plus page-space bounds, dimensions and committed revision. Requires a connected web/desktop editor and preserves human camera/selection. A missing selected shape fails scope recovery rather than expanding the scope.',
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
  kit,
  receipt,
  lifecycle,
  exportDocument,
);
export const DiagramImageToolkit = Toolkit.make(DiagramCaptureTool, DiagramComposeTool);
