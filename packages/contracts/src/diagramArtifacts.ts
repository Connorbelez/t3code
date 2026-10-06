import * as Schema from "effect/Schema";
import { DiagramHtmlArtifactSource, DiagramRecordId, DiagramTarget } from "./diagrams.ts";

export const DiagramArtifactTarget = Schema.Struct({
  ...DiagramTarget.fields,
  shapeId: DiagramRecordId,
});
export type DiagramArtifactTarget = typeof DiagramArtifactTarget.Type;

export const DiagramArtifactDocument = Schema.Struct({
  source: DiagramHtmlArtifactSource,
  html: Schema.String.check(Schema.isMaxLength(2 * 1024 * 1024)),
  version: Schema.String,
  css: Schema.String.check(Schema.isMaxLength(4 * 1024 * 1024)),
  baseUrl: Schema.optional(Schema.String),
});
export type DiagramArtifactDocument = typeof DiagramArtifactDocument.Type;
export const DiagramArtifactChange = Schema.Struct({
  version: Schema.String,
  error: Schema.optional(Schema.String),
});
export type DiagramArtifactChange = typeof DiagramArtifactChange.Type;
export const DiagramArtifactCssInput = Schema.Struct({
  html: Schema.String.check(Schema.isMaxLength(2 * 1024 * 1024)),
  candidates: Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(
    Schema.isMaxLength(5000),
  ),
});
export const DiagramArtifactCss = Schema.Struct({
  css: DiagramArtifactDocument.fields.css,
});
export const DiagramArtifactCapture = Schema.Struct({
  base64: Schema.String.check(Schema.isMaxLength(16 * 1024 * 1024)),
  width: Schema.Number,
  height: Schema.Number,
});
