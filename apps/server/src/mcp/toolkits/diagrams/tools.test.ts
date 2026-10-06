import { McpSchema, Tool } from "effect/ai";
import { describe, expect, it } from "vite-plus/test";
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
