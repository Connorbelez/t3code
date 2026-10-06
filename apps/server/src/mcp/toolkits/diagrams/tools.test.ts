import { describe, expect, it } from "@effect/vitest";
import {
  DiagramAnnotatedCapture,
  DiagramId,
  EnvironmentId,
  ProjectId,
  type DiagramPrepareAnnotationsInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool } from "effect/ai";
import * as DiagramService from "../../../diagrams/DiagramService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DiagramImageToolkit, DiagramToolkit } from "./tools.ts";

describe("diagram MCP registration", () => {
  it("registers every diagram tool with the MCP object input contract", () => {
    const tools = { ...DiagramToolkit.tools, ...DiagramImageToolkit.tools };
    for (const tool of Object.values(tools)) {
      const registered = new McpSchema.Tool({
        name: tool.name,
        inputSchema: Tool.getJsonSchema(tool),
      });
      expect(registered.inputSchema.type).toBe("object");
    }
  });
});

const projectId = ProjectId.make("project:diagram-mcp");
const diagramId = DiagramId.make("00000000-0000-4000-8000-000000000000");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:diagram-mcp"),
  requestNamespace: "diagram-mcp-session",
  thread: undefined,
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "diagram-mcp", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "diagram-mcp", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const decodeCapture = Schema.decodeUnknownSync(DiagramAnnotatedCapture);
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/** The service answers with an overview of both annotations and a detail of the second. */
const serveAnnotations = (requests: DiagramPrepareAnnotationsInput[]) =>
  McpHttpServer.layerDiagramToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.mock(DiagramService.DiagramService)({
        captureAnnotated: (input) =>
          Effect.sync(() => {
            requests.push(input);
            return decodeCapture({
              diagramId: input.diagramId,
              revision: 7,
              pageId: input.pageId,
              annotations: input.annotations,
              resolved: [
                { id: "tool-4", bounds: { x: 0, y: 0, w: 80, h: 40 }, marker: { x: -12, y: -12 } },
                { id: "tool-9", bounds: { x: 900, y: 0, w: 4, h: 4 }, marker: { x: 888, y: -12 } },
              ],
              images: [
                {
                  role: "overview",
                  annotationIds: ["tool-4", "tool-9"],
                  bounds: { x: -60, y: -60, w: 1000, h: 200 },
                  width: 1000,
                  height: 200,
                  mimeType: "image/png",
                  base64: Buffer.from("overview").toString("base64"),
                },
                {
                  role: "detail",
                  annotationIds: ["tool-9"],
                  bounds: { x: 860, y: -40, w: 80, h: 80 },
                  width: 160,
                  height: 160,
                  mimeType: "image/png",
                  base64: Buffer.from("detail").toString("base64"),
                },
              ],
            });
          }),
      }),
    ),
    Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
  );

const callCapture = (args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name: "t3_diagram_capture", arguments: { projectId, diagramId, ...args } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

describe("t3_diagram_capture with annotations", () => {
  it.effect("numbers the agent's annotations and returns the overview, then each detail", () => {
    const requests: DiagramPrepareAnnotationsInput[] = [];
    return Effect.gen(function* () {
      const result = yield* callCapture({
        scope: { kind: "diagram", pageId: "page:main" },
        annotations: [
          {
            number: 4,
            comment: "This box overlaps",
            target: { kind: "shapes", shapeIds: ["shape:box"] },
          },
          {
            number: 9,
            comment: "Tiny label",
            target: { kind: "region", bounds: { x: 900, y: 0, w: 4, h: 4 } },
          },
        ],
      });

      expect(requests).toEqual([
        {
          projectId,
          diagramId,
          pageId: "page:main",
          annotations: [
            {
              id: "tool-4",
              number: 4,
              comment: "This box overlaps",
              target: { kind: "shapes", shapeIds: ["shape:box"] },
            },
            {
              id: "tool-9",
              number: 9,
              comment: "Tiny label",
              target: { kind: "region", bounds: { x: 900, y: 0, w: 4, h: 4 } },
            },
          ],
        },
      ]);
      const metadata = {
        diagramId,
        revision: 7,
        scope: { kind: "diagram", pageId: "page:main" },
        bounds: { x: -60, y: -60, w: 1000, h: 200 },
        pageId: "page:main",
        annotations: [
          {
            number: 4,
            comment: "This box overlaps",
            target: { kind: "shapes", shapeIds: ["shape:box"] },
            bounds: { x: 0, y: 0, w: 80, h: 40 },
            marker: { x: -12, y: -12 },
          },
          {
            number: 9,
            comment: "Tiny label",
            target: { kind: "region", bounds: { x: 900, y: 0, w: 4, h: 4 } },
            bounds: { x: 900, y: 0, w: 4, h: 4 },
            marker: { x: 888, y: -12 },
          },
        ],
        images: [
          {
            role: "overview",
            annotations: [4, 9],
            bounds: { x: -60, y: -60, w: 1000, h: 200 },
            width: 1000,
            height: 200,
          },
          {
            role: "detail",
            annotations: [9],
            bounds: { x: 860, y: -40, w: 80, h: 80 },
            width: 160,
            height: 160,
          },
        ],
        screenshot: { mimeType: "image/png", width: 1000, height: 200 },
        screenshots: [{ mimeType: "image/png", width: 160, height: 160 }],
      };
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual(metadata);
      const [text, ...images] = result.content;
      expect(text?.type === "text" ? decodeJsonText(text.text) : null).toEqual(metadata);
      expect(
        images.map((image) =>
          image.type === "image" ? Buffer.from(image.data).toString() : image.type,
        ),
      ).toEqual(["overview", "detail"]);
    }).pipe(Effect.provide(serveAnnotations(requests)));
  });

  it.effect("tells the agent to capture the whole page when annotations name another scope", () => {
    const requests: DiagramPrepareAnnotationsInput[] = [];
    return Effect.gen(function* () {
      const result = yield* callCapture({
        scope: { kind: "viewport", pageId: "page:main", bounds: { x: 0, y: 0, w: 10, h: 10 } },
        annotations: [{ number: 1, comment: "Here", target: { kind: "shapes", shapeIds: ["a"] } }],
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: "text",
          text: 'Diagram operation failed (scope-unavailable): scope: Annotations cover a whole page. Pass scope {kind: "diagram", pageId} with the annotations.',
        },
      ]);
      expect(requests).toEqual([]);
    }).pipe(Effect.provide(serveAnnotations(requests)));
  });
});
