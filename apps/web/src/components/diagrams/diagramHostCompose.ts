import {
  DiagramComposeRequest,
  DiagramOperationError,
  type DiagramHostComposeResult,
  type DiagramMermaidSource,
  type DiagramSpec,
} from "@t3tools/contracts";
import type { ComposePorts } from "@t3tools/diagram-compose/compose";
import type { TLRecord } from "tldraw";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

const decodeRequest = Schema.decodeUnknownResult(DiagramComposeRequest);
const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();
const isDiagramError = Schema.is(DiagramOperationError);

/**
 * The server validated the request against its own schema, so one this build cannot read comes
 * from a newer server, such as a kit added after this editor was built.
 */
export function decodeHostComposeRequest(input: unknown): DiagramComposeRequest {
  const decoded = decodeRequest(input);
  if (Result.isSuccess(decoded)) return decoded.success;
  const keys = (formatIssue(decoded.failure.issue).issues[0]?.path ?? []).map((segment) =>
    typeof segment === "object" ? segment.key : segment,
  );
  const value = keys.reduce<unknown>(
    (parent, key) =>
      typeof parent === "object" && parent !== null ? Reflect.get(parent, key) : undefined,
    input,
  );
  const path = keys
    .map((key, index) =>
      typeof key === "number" ? `[${key}]` : `${index === 0 ? "" : "."}${String(key)}`,
    )
    .join("");
  throw new DiagramOperationError({
    code: "invalid-spec",
    details: {
      issues: [
        {
          path: path || "request",
          message: `the T3 Code running this editor is older than the server and cannot read ${
            JSON.stringify(value)?.slice(0, 200) ?? "this request"
          }; ask the user to update T3 Code where the diagram editor is open, then retry`,
        },
      ],
    },
  });
}

/** What a mounted editor lends the compose pipeline. */
export interface HostComposeEditor {
  /** Resolves once the fonts compose measures with are loaded. */
  readonly fontsReady: () => Promise<void>;
  readonly measureText: ComposePorts["measureText"];
  readonly rehearse: ComposePorts["rehearse"];
}

/** Code split out of the editor chunk: the pipeline with ELK, and Mermaid. */
export interface HostComposeChunks {
  readonly pipeline: () => Promise<typeof import("@t3tools/diagram-compose/compose")>;
  readonly mermaid: () => Promise<{
    mermaidToSpec: (source: DiagramMermaidSource) => Promise<DiagramSpec>;
  }>;
}
const chunks: HostComposeChunks = {
  pipeline: () => import("@t3tools/diagram-compose/compose"),
  mermaid: () => import("./mermaidSpec"),
};

/**
 * Failures carry codes the server already knows, so a newer web client still reports them to an
 * older server: code that will not download is a lost connection, and any other pipeline
 * exception means the editor could not build records for the composition.
 */
export async function composeOnHost(
  request: DiagramComposeRequest,
  records: readonly TLRecord[],
  editor: HostComposeEditor,
  load: HostComposeChunks = chunks,
): Promise<DiagramHostComposeResult> {
  const [{ compose }] = await Promise.all([download(load.pipeline), editor.fontsReady()]);
  try {
    return await compose(request, records, {
      measureText: editor.measureText,
      rehearse: editor.rehearse,
      parseMermaid: async (source) => (await download(load.mermaid)).mermaidToSpec(source),
    });
  } catch (cause) {
    if (isDiagramError(cause)) throw cause;
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new DiagramOperationError({
      code: "invalid-records",
      details: {
        issues: [
          {
            path: "spec",
            message: `the editor could not build this composition (${reason.slice(0, 800)}); nothing changed`,
          },
        ],
      },
    });
  }
}

async function download<T>(chunk: () => Promise<T>): Promise<T> {
  try {
    return await chunk();
  } catch {
    throw new DiagramOperationError({ code: "disconnected" });
  }
}
