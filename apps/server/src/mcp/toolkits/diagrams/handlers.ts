import {
  DiagramAnnotations,
  DiagramLifecycleInput,
  DiagramOperationError,
  OrchestratorMcpFailure,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { kitReference } from "@t3tools/diagram-compose/model";
import * as Diagrams from "../../../diagrams/DiagramService.ts";
import { readCaller, readMutationCaller, resolveProjectId } from "../../threadAccess.ts";
import { DiagramToolkit, DiagramImageToolkit } from "./tools.ts";

const access = Effect.fn("DiagramToolkit.access")(function* (
  requested: ProjectId | undefined,
  mutation = false,
) {
  const context = yield* mutation ? readMutationCaller() : readCaller();
  const projectId = yield* resolveProjectId(context, requested);
  if (context.caller !== undefined && context.caller.projectId !== projectId) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Diagram tools are scoped to the calling project.",
    });
  }
  if (mutation && context.limits.interactionMode === "plan") {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Diagram changes are unavailable in this permission mode.",
    });
  }
  return {
    projectId,
    namespace: context.scope.requestNamespace,
    threadId: context.caller?.id,
    diagrams: yield* Diagrams.DiagramService,
  };
});

export const DiagramHandlersLive = DiagramToolkit.toLayer({
  t3_diagram_list: (input) =>
    Effect.gen(function* () {
      const { diagrams, projectId } = yield* access(input.projectId);
      return yield* diagrams.list({
        projectId,
        ...(input.includeArchived === undefined ? {} : { includeArchived: input.includeArchived }),
      });
    }),
  t3_diagram_read: (input) =>
    Effect.gen(function* () {
      const { diagrams, projectId } = yield* access(input.projectId);
      return yield* diagrams.read({ ...input, projectId });
    }),
  t3_diagram_create: (input) =>
    Effect.gen(function* () {
      const { diagrams, projectId } = yield* access(input.projectId, true);
      return yield* diagrams.create({ ...input, projectId });
    }),
  t3_diagram_apply: (input) =>
    Effect.gen(function* () {
      const { diagrams, projectId, namespace, threadId } = yield* access(input.projectId, true);
      return yield* diagrams.applyBatch({
        ...input,
        projectId,
        namespace,
        ...(threadId === undefined ? {} : { threadId }),
      });
    }),
  t3_diagram_kit: (input) =>
    Effect.gen(function* () {
      yield* readCaller();
      return kitReference(input.kit);
    }),
  t3_diagram_receipt: (input) =>
    Effect.gen(function* () {
      const { diagrams, projectId, namespace } = yield* access(input.projectId);
      return yield* diagrams.receipt({ ...input, projectId, namespace });
    }),
  t3_diagram_update: (input) =>
    Effect.gen(function* () {
      const { diagrams, projectId } = yield* access(input.projectId, true);
      const request = yield* Schema.decodeUnknownEffect(DiagramLifecycleInput)({
        ...input,
        projectId,
      }).pipe(Effect.mapError(() => new DiagramOperationError({ code: "invalid-records" })));
      return yield* diagrams.lifecycle(request);
    }),
  t3_diagram_export: (input) =>
    Effect.gen(function* () {
      const { diagrams, projectId } = yield* access(input.projectId);
      return yield* diagrams.exportDocument({ ...input, projectId });
    }),
});

const decodeAnnotations = Schema.decodeUnknownEffect(DiagramAnnotations);

export const DiagramImageHandlersLive = DiagramImageToolkit.toLayer({
  t3_diagram_capture: ({ annotations, ...input }) =>
    Effect.gen(function* () {
      const { diagrams, projectId } = yield* access(input.projectId);
      if (annotations) {
        const { scope } = input;
        if (scope.kind !== "diagram")
          return yield* new DiagramOperationError({
            code: "scope-unavailable",
            details: {
              issues: [
                {
                  path: "scope",
                  message:
                    'Annotations cover a whole page. Pass scope {kind: "diagram", pageId} with the annotations.',
                },
              ],
            },
          });
        // Every other bound is in the tool parameters; only the set's total size can fail here.
        const authored = yield* decodeAnnotations(
          annotations.map((annotation) => ({ id: `tool-${annotation.number}`, ...annotation })),
        ).pipe(Effect.mapError(() => new DiagramOperationError({ code: "too-large" })));
        const capture = yield* diagrams.captureAnnotated({
          projectId,
          diagramId: input.diagramId,
          pageId: scope.pageId,
          annotations: authored,
        });
        // The capture schema guarantees an overview first and geometry for every annotation.
        const overview = capture.images[0]!;
        const numbers = new Map(authored.map((annotation) => [annotation.id, annotation.number]));
        const resolved = new Map(capture.resolved.map(({ id, ...geometry }) => [id, geometry]));
        const screenshot = (image: typeof overview) => ({
          data: image.base64,
          mimeType: image.mimeType,
          width: image.width,
          height: image.height,
        });
        return {
          diagramId: capture.diagramId,
          revision: capture.revision,
          scope,
          bounds: overview.bounds,
          pageId: capture.pageId,
          annotations: authored.map(({ id, ...annotation }) => ({
            ...annotation,
            ...resolved.get(id)!,
          })),
          images: capture.images.map((image) => ({
            role: image.role,
            annotations: image.annotationIds.map((id) => numbers.get(id)!),
            bounds: image.bounds,
            width: image.width,
            height: image.height,
          })),
          screenshot: screenshot(overview),
          screenshots: capture.images.slice(1).map(screenshot),
        };
      }
      const capture = yield* diagrams.capture({ ...input, projectId, format: "png" });
      return {
        diagramId: capture.diagramId,
        revision: capture.revision,
        scope: capture.scope,
        bounds: capture.bounds,
        screenshot: {
          data: capture.base64,
          mimeType: "image/png" as const,
          width: capture.width,
          height: capture.height,
        },
      };
    }),
  t3_diagram_compose: (input) =>
    Effect.gen(function* () {
      const { diagrams, projectId, namespace, threadId } = yield* access(input.projectId, true);
      const { capture, ...result } = yield* diagrams.compose({
        ...input,
        projectId,
        namespace,
        ...(threadId === undefined ? {} : { threadId }),
      });
      if (!capture) return result;
      return {
        ...result,
        screenshot: {
          data: capture.base64,
          mimeType: "image/png" as const,
          width: capture.width,
          height: capture.height,
        },
      };
    }),
});
