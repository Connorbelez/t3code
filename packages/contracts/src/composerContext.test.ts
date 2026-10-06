import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  COMPOSER_CONTEXT_KINDS,
  ComposerContextRecord,
  OrchestrationMessageContext,
  isKnownComposerContextRecord,
} from "./composerContext.ts";
import {
  OrchestrationV2Command,
  OrchestrationV2ConversationMessageJson,
} from "./orchestrationV2.ts";

const decodeRecord = Schema.decodeUnknownOption(ComposerContextRecord);
const decodeContext = Schema.decodeUnknownSync(OrchestrationMessageContext);
const decodeMessage = Schema.decodeUnknownSync(OrchestrationV2ConversationMessageJson);
const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);

const base = { version: 1, contextId: "ctx_1" } as const;

const annotationsPayload = {
  environmentId: "environment-1",
  projectId: "project-1",
  diagramId: "00000000-0000-4000-8000-000000000001",
  pageId: "page:one",
  annotations: [
    {
      id: "ann_1",
      number: 1,
      comment: "Rename this to API Gateway",
      target: { kind: "shapes", shapeIds: ["shape:gateway"] },
    },
    {
      id: "ann_3",
      number: 3,
      comment: "Leave room here",
      target: { kind: "region", bounds: { x: -200, y: -100, w: 180, h: 120 } },
    },
  ],
  capture: {
    revision: 42,
    resolved: [
      { id: "ann_1", bounds: { x: 0, y: 0, w: 160, h: 80 }, marker: { x: 0, y: 0 } },
      {
        id: "ann_3",
        bounds: { x: -200, y: -100, w: 180, h: 120 },
        marker: { x: -200, y: -100 },
      },
    ],
    images: [
      {
        contextId: "image_overview",
        role: "overview",
        annotationIds: ["ann_1", "ann_3"],
        bounds: { x: -248, y: -148, w: 456, h: 276 },
        width: 456,
        height: 276,
      },
    ],
    structure: {
      revision: 42,
      pages: [{ id: "page:one", name: "Page 1", shapeCount: 1 }],
      compositions: [],
      shapes: [],
      bindings: [],
      totalShapes: 1,
      truncated: false,
    },
  },
};

const knownRecords: Record<(typeof COMPOSER_CONTEXT_KINDS)[number], Record<string, unknown>> = {
  image: {
    ...base,
    kind: "image",
    label: "checkout-error.png",
    attachmentId: "att_1",
    name: "checkout-error.png",
    mimeType: "image/png",
    sizeBytes: 1234,
  },
  file: {
    ...base,
    kind: "file",
    label: "notes.txt",
    attachmentId: "att_2",
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 12,
  },
  terminal: {
    ...base,
    kind: "terminal",
    label: "Terminal 1 lines 509-514",
    terminalId: "term-1",
    terminalLabel: "Terminal 1",
    lineStart: 509,
    lineEnd: 514,
    text: "error: boom\n  at main.ts:1",
  },
  element: {
    ...base,
    kind: "element",
    label: "<Button>",
    pageUrl: "http://localhost:3000/checkout",
    pageTitle: "Checkout",
    tagName: "button",
    selector: "#pay",
    htmlPreview: '<button id="pay">Pay</button>',
    componentName: "Button",
    source: { functionName: "Button", fileName: "Button.tsx", lineNumber: 12, columnNumber: 3 },
    styles: "color: red;",
  },
  "preview-annotation": {
    ...base,
    kind: "preview-annotation",
    label: "Checkout",
    annotationId: "ann_1",
    pageUrl: "http://localhost:3000/checkout",
    pageTitle: "Checkout",
    comment: "Make this bigger",
    targetSummary: "1 selected element",
    styleChanges: ["font-size: 20px"],
    elements: [
      {
        pageUrl: "http://localhost:3000/checkout",
        pageTitle: "Checkout",
        tagName: "button",
        selector: "#pay",
        htmlPreview: "<button>Pay</button>",
        componentName: "Button",
        source: null,
        styles: "",
      },
    ],
    screenshotContextId: "ctx_2",
  },
  "review-comment": {
    ...base,
    kind: "review-comment",
    label: "ChatComposer.tsx L4118",
    sectionId: "diff-1",
    sectionTitle: "Changes",
    filePath: "apps/web/src/ChatComposer.tsx",
    startIndex: 4118,
    endIndex: 4118,
    rangeLabel: "L4118",
    text: "Why is this here?",
    diff: "+ const x = 1;",
    fenceLanguage: "diff",
    pullRequest: {
      number: 42,
      title: "Improve context chips",
      url: "https://github.com/pingdotgg/t3code/pull/42",
      headBranch: "feat/context-chips",
      baseBranch: "main",
      state: "open",
      isDraft: false,
    },
  },
  mention: { ...base, kind: "mention", label: "@src/index.ts", path: "src/index.ts" },
  skill: { ...base, kind: "skill", label: "$pinchtab", name: "pinchtab" },
  thread: {
    ...base,
    kind: "thread",
    label: "Fix login flow",
    environmentId: "environment-1",
    threadId: "thread-1",
    title: "Fix login flow",
  },
  diagram: {
    ...base,
    kind: "diagram",
    label: "Architecture",
    payload: {
      environmentId: "environment-1",
      projectId: "project-1",
      diagramId: "00000000-0000-4000-8000-000000000001",
      scope: { kind: "diagram", pageId: "page:one" },
    },
  },
  "diagram-annotations": {
    ...base,
    kind: "diagram-annotations",
    label: "Architecture comments",
    payload: annotationsPayload,
  },
};

const withPayload = (patch: Record<string, unknown>) => ({
  ...knownRecords["diagram-annotations"],
  payload: { ...annotationsPayload, ...patch },
});

describe("ComposerContextRecord", () => {
  it.each(COMPOSER_CONTEXT_KINDS)("round-trips a %s record", (kind) => {
    const decoded = decodeRecord(knownRecords[kind]);
    expect(Option.isSome(decoded)).toBe(true);
    expect(Option.getOrThrow(decoded)).toEqual(knownRecords[kind]);
  });

  it("keeps unknown kinds with their payload", () => {
    const decoded = decodeRecord({
      ...base,
      kind: "future-thing",
      label: "Future",
      payload: { anything: [1, 2, 3] },
    });
    expect(Option.getOrThrow(decoded)).toEqual({
      version: 1,
      contextId: "ctx_1",
      kind: "future-thing",
      label: "Future",
      payload: { anything: [1, 2, 3] },
    });
  });

  it("does not let a malformed known kind slide through as unknown", () => {
    expect(Option.isNone(decodeRecord({ ...base, kind: "image", label: "x" }))).toBe(true);
    expect(Option.isNone(decodeRecord({ ...base, kind: "diagram", label: "x", payload: {} }))).toBe(
      true,
    );
  });

  it("bounds the serialized payload of future context kinds", () => {
    const unknown = { ...base, kind: "future-thing", label: "Future" };
    expect(Option.isSome(decodeRecord({ ...unknown, payload: "x".repeat(63_998) }))).toBe(true);
    expect(Option.isNone(decodeRecord({ ...unknown, payload: "x".repeat(63_999) }))).toBe(true);
    expect(Option.isNone(decodeRecord({ ...unknown, payload: '"'.repeat(32_000) }))).toBe(true);
    expect(
      decodeContext({
        version: 1,
        records: [
          { ...unknown, payload: "x".repeat(64_000) },
          { ...knownRecords.skill, contextId: "ctx_skill" },
        ],
      }).records,
    ).toEqual([{ ...knownRecords.skill, contextId: "ctx_skill" }]);
  });

  it("rejects bad ids and versions", () => {
    expect(Option.isNone(decodeRecord({ ...knownRecords.skill, contextId: "has space" }))).toBe(
      true,
    );
    expect(Option.isNone(decodeRecord({ ...knownRecords.skill, version: 2 }))).toBe(true);
    expect(Option.isNone(decodeRecord({ ...knownRecords.skill, kind: "Bad Kind" }))).toBe(true);
  });
});

describe("DiagramAnnotationsContextRecord", () => {
  const decodes = (record: Record<string, unknown>) => Option.isSome(decodeRecord(record));
  const [first, second] = annotationsPayload.annotations;

  it("keeps a draft without a capture", () => {
    const { capture: _capture, ...draft } = annotationsPayload;
    const record = { ...knownRecords["diagram-annotations"], payload: draft };
    expect(Option.getOrThrow(decodeRecord(record))).toEqual(record);
  });

  it("rejects ambiguous or empty comments", () => {
    expect(decodes(withPayload({ annotations: [first, { ...second, number: 1 }] }))).toBe(false);
    expect(decodes(withPayload({ annotations: [first, { ...second, id: "ann_1" }] }))).toBe(false);
    expect(decodes(withPayload({ annotations: [] }))).toBe(false);
    expect(decodes(withPayload({ annotations: [{ ...first, comment: "   " }] }))).toBe(false);
  });

  it("rejects a region without area", () => {
    const flat = { ...second, target: { kind: "region", bounds: { x: 0, y: 0, w: 40, h: 0 } } };
    expect(decodes(withPayload({ annotations: [first, flat] }))).toBe(false);
  });

  it("bounds a page's comments so none is ever truncated", () => {
    const annotation = (index: number, comment: string) => ({
      id: `ann_${index}`,
      number: index + 1,
      comment,
      target: { kind: "shapes", shapeIds: ["shape:gateway"] },
    });
    const { capture: _capture, ...draft } = annotationsPayload;
    const set = (comment: string) =>
      Array.from({ length: 12 }, (_, index) => annotation(index, comment));
    expect(
      decodes({ ...withPayload({}), payload: { ...draft, annotations: set("é".repeat(1_900)) } }),
    ).toBe(true);
    expect(
      decodes({ ...withPayload({}), payload: { ...draft, annotations: set("é".repeat(2_000)) } }),
    ).toBe(false);
    expect(decodes(withPayload({ annotations: [annotation(0, "x".repeat(2_001))] }))).toBe(false);
  });

  it("rejects a capture that does not describe exactly these comments", () => {
    const capture = annotationsPayload.capture;
    const [overview] = capture.images;
    expect(
      decodes(withPayload({ capture: { ...capture, resolved: capture.resolved.slice(0, 1) } })),
    ).toBe(false);
    expect(
      decodes(
        withPayload({
          capture: { ...capture, images: [{ ...overview, annotationIds: ["ann_1"] }] },
        }),
      ),
    ).toBe(false);
    expect(
      decodes(withPayload({ capture: { ...capture, images: [{ ...overview, role: "detail" }] } })),
    ).toBe(false);
    const detail = {
      ...overview,
      role: "detail",
      annotationIds: ["ann_9"],
      contextId: "image_detail",
    };
    expect(decodes(withPayload({ capture: { ...capture, images: [overview, detail] } }))).toBe(
      false,
    );
    const duplicate = { ...overview, role: "detail", annotationIds: ["ann_3"] };
    expect(decodes(withPayload({ capture: { ...capture, images: [overview, duplicate] } }))).toBe(
      false,
    );
  });

  it("tells known payload kinds apart from unknown ones", () => {
    const known = Option.getOrThrow(decodeRecord(knownRecords["diagram-annotations"]));
    const unknown = Option.getOrThrow(
      decodeRecord({ ...base, kind: "future-thing", label: "Future", payload: {} }),
    );
    expect([isKnownComposerContextRecord(known), isKnownComposerContextRecord(unknown)]).toEqual([
      true,
      false,
    ]);
  });

  it("never lets one number name two comments in a message", () => {
    const otherPage = {
      ...knownRecords["diagram-annotations"],
      contextId: "ctx_2",
      payload: { ...annotationsPayload, pageId: "page:two", capture: undefined },
    };
    const renumbered = {
      ...otherPage,
      payload: {
        ...otherPage.payload,
        annotations: [{ ...first, id: "ann_5", number: 5 }],
      },
    };
    const { capture: _capture, ...draft } = annotationsPayload;
    const records = [{ ...knownRecords["diagram-annotations"], payload: draft }];
    expect(() => decodeContext({ version: 1, records: [...records, otherPage] })).toThrow();
    expect(decodeContext({ version: 1, records: [...records, renumbered] }).records).toHaveLength(
      2,
    );
  });
});

describe("OrchestrationMessageContext", () => {
  it("rejects aggregate context size even when each record is valid", () => {
    const record = {
      ...knownRecords["preview-annotation"],
      styleChangeDetails: Array.from({ length: 200 }, () => ({
        targetId: "target",
        selector: null,
        property: "content",
        previousValue: "x".repeat(8_000),
        value: "y".repeat(8_000),
      })),
    };
    expect(Option.isSome(decodeRecord(record))).toBe(true);
    expect(() => decodeContext({ version: 1, records: [record] })).not.toThrow();
    expect(() =>
      decodeContext({
        version: 1,
        records: Array.from({ length: 6 }, (_, index) => ({
          ...record,
          contextId: `ctx_${index}`,
        })),
      }),
    ).toThrow();
  });

  it("normalizes decoded record identifiers", () => {
    const context = decodeContext({
      version: 1,
      records: [{ ...knownRecords.skill, contextId: "  ctx_1  ", name: "  review  " }],
    });
    expect(context.records[0]).toMatchObject({ contextId: "ctx_1", name: "review" });
  });

  it("rejects oversized arrays before dropping malformed records", () => {
    expect(() =>
      decodeContext({ version: 1, records: Array.from({ length: 201 }, () => ({})) }),
    ).toThrow();
  });

  it("drops undecodable records and keeps valid siblings", () => {
    const context = decodeContext({
      version: 1,
      records: [
        knownRecords.skill,
        { version: 1, kind: "image" },
        { ...knownRecords.terminal, contextId: "ctx_2" },
      ],
    });
    expect(context.records.map((record) => record.kind)).toEqual(["skill", "terminal"]);
  });

  it("rejects duplicate normalized context identities", () => {
    expect(() =>
      decodeContext({
        version: 1,
        records: [knownRecords.skill, { ...knownRecords.terminal, contextId: " ctx_1 " }],
      }),
    ).toThrow();
  });

  it("is optional on messages and message dispatch commands", () => {
    const message = {
      createdBy: "user",
      creationSource: "web",
      id: "m1",
      threadId: "t1",
      runId: null,
      nodeId: null,
      role: "user",
      text: "hi",
      attachments: [],
      streaming: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(decodeMessage(message).context).toBeUndefined();
    const withContext = decodeMessage({
      ...message,
      context: { version: 1, records: [knownRecords.mention] },
    });
    expect(withContext.context?.records).toHaveLength(1);

    const command = decodeCommand({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: "c1",
      threadId: "t1",
      messageId: "m1",
      text: "hi",
      attachments: [],
      context: { version: 1, records: [knownRecords.image] },
      dispatchMode: { type: "start_immediately" },
    });
    expect(command.type === "message.dispatch" && command.context?.records[0]?.kind).toBe("image");
  });
});
