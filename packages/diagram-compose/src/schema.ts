import { DiagramHtmlArtifactSource } from "@t3tools/contracts";
import {
  createShapePropsMigrationSequence,
  createTLSchema,
  defaultShapeSchemas,
  type TLBaseShape,
} from "@tldraw/tlschema";
import { T } from "@tldraw/validate";
import * as Schema from "effect/Schema";

const isSource = Schema.is(DiagramHtmlArtifactSource);
const decodeSource = Schema.decodeUnknownSync(DiagramHtmlArtifactSource, {
  onExcessProperty: "error",
});
const sourceValidator = new T.Validator((value) => {
  if (!isSource(value)) throw new T.ValidationError("Invalid HTML artifact source");
  try {
    decodeSource(value);
  } catch {
    throw new T.ValidationError("Invalid HTML artifact source");
  }
  return value;
});

export const htmlArtifactProps = {
  w: T.nonZeroNumber,
  h: T.nonZeroNumber,
  title: T.string.check((value) => {
    if (value.length > 200) throw new T.ValidationError("Artifact title exceeds 200 characters");
  }),
  source: sourceValidator,
};

type HtmlArtifactProps = {
  w: number;
  h: number;
  title: string;
  source: DiagramHtmlArtifactSource;
};

export type HtmlArtifactShape = TLBaseShape<"html-artifact", HtmlArtifactProps>;

declare module "@tldraw/tlschema" {
  interface TLGlobalShapePropsMap {
    "html-artifact": HtmlArtifactProps;
  }
}

export const htmlArtifactMigrations = createShapePropsMigrationSequence({ sequence: [] });

export const diagramShapeSchemas = {
  ...defaultShapeSchemas,
  "html-artifact": { props: htmlArtifactProps, migrations: htmlArtifactMigrations },
};

export function createDiagramSchema() {
  return createTLSchema({
    shapes: diagramShapeSchemas,
  });
}
