import { diagramShapeSchemas, type HtmlArtifactShape } from "@t3tools/diagram-compose/schema";
import { createTLSchema } from "tldraw";

declare module "tldraw" {
  interface TLGlobalShapePropsMap {
    "html-artifact": HtmlArtifactShape["props"];
  }
}

export const createDiagramSchema = () => createTLSchema({ shapes: diagramShapeSchemas });
