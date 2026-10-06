import {
  ComposerContextId,
  DiagramAnnotationId,
  DiagramId,
  EnvironmentId,
  ProjectId,
  type DiagramAnnotationTarget,
  type DiagramAnnotationsContextRecord,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  importDiagramAnnotations,
  removeDiagramAnnotation,
  saveDiagramAnnotation,
  type DiagramAnnotationDraftState,
  type DiagramAnnotationPage,
} from "./diagramAnnotationDrafts";

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");
const diagramId = DiagramId.make("0b6d3f4e-1a2b-4c3d-8e9f-0123456789ab");
const mainPage: DiagramAnnotationPage = {
  environmentId,
  projectId,
  diagramId,
  pageId: "page:main",
  label: "Architecture [Main]",
};
const MAIN_ID = "diagram-annotations_env-1-0b6d3f4e-1a2b-4c3d-8e9-7b35400522ad7190";
const OTHER_ID = "diagram-annotations_env-1-0b6d3f4e-1a2b-4c3d-8e9-bdbd0bcad55b72b5";
const box: DiagramAnnotationTarget = { kind: "shapes", shapeIds: ["shape:box"] };
const corner: DiagramAnnotationTarget = {
  kind: "region",
  bounds: { x: 400, y: -40, w: 120, h: 80 },
};
const empty: DiagramAnnotationDraftState = { records: [], nextNumber: 1 };

function mintIds() {
  let next = 0;
  return () => DiagramAnnotationId.make(`a${++next}`);
}

/** Saves each comment as a new one and returns the resulting draft state. */
function saveAll(
  state: DiagramAnnotationDraftState,
  comments: ReadonlyArray<string>,
  mintId = mintIds(),
) {
  return comments.reduce(
    (current, comment) =>
      saveDiagramAnnotation(current, mainPage, { comment, target: box }, mintId).state,
    state,
  );
}

interface AnnotationInput {
  readonly id: string;
  readonly number: number;
  readonly comment: string;
  readonly target: DiagramAnnotationTarget;
}

const annotationsOf = (annotations: ReadonlyArray<AnnotationInput>) =>
  annotations.map((annotation) => ({
    ...annotation,
    id: DiagramAnnotationId.make(annotation.id),
  }));

function mainRecord(annotations: ReadonlyArray<AnnotationInput>): DiagramAnnotationsContextRecord {
  return {
    version: 1,
    kind: "diagram-annotations",
    contextId: ComposerContextId.make(MAIN_ID),
    label: "Architecture Main",
    payload: {
      environmentId,
      projectId,
      diagramId,
      pageId: "page:main",
      annotations: annotationsOf(annotations),
    },
  };
}

const id = (value: string) => DiagramAnnotationId.make(value);

describe("diagram annotation drafts", () => {
  it("edits, retargets and deletes comments by id while their numbers stay put", () => {
    const mintId = mintIds();
    const first = saveDiagramAnnotation(
      empty,
      mainPage,
      { comment: "  Make this box blue ", target: box },
      mintId,
    );
    expect(first.result).toEqual({
      ok: true,
      annotation: { id: "a1", number: 1, comment: "Make this box blue", target: box },
      contextId: MAIN_ID,
      createdRecord: true,
    });
    const second = saveDiagramAnnotation(
      first.state,
      mainPage,
      { comment: "Room for a legend", target: corner },
      mintId,
    );
    expect(second.result).toMatchObject({ ok: true, createdRecord: false });
    const edited = saveDiagramAnnotation(
      second.state,
      mainPage,
      { id: id("a1"), comment: "Make this box green", target: corner },
      mintId,
    );
    expect(edited.state).toEqual({
      records: [
        mainRecord([
          { id: "a1", number: 1, comment: "Make this box green", target: corner },
          { id: "a2", number: 2, comment: "Room for a legend", target: corner },
        ]),
      ],
      nextNumber: 3,
    });

    const withoutFirst = removeDiagramAnnotation(edited.state, id("a1"));
    expect(withoutFirst).toEqual({
      state: {
        records: [
          mainRecord([{ id: "a2", number: 2, comment: "Room for a legend", target: corner }]),
        ],
        nextNumber: 3,
      },
      removedRecordId: null,
    });
    expect(removeDiagramAnnotation(withoutFirst.state, id("a2"))).toEqual({
      state: { records: [], nextNumber: 3 },
      removedRecordId: MAIN_ID,
    });
  });

  it("leaves the gap when the highest number is deleted and another comment is saved", () => {
    const three = saveAll(empty, ["one", "two", "three"]);
    const afterDelete = removeDiagramAnnotation(three, id("a3")).state;
    const saved = saveDiagramAnnotation(
      afterDelete,
      mainPage,
      { comment: "four", target: box },
      () => id("a4"),
    );
    expect(
      saved.state.records[0]?.payload.annotations.map(({ id, number }) => [id, number]),
    ).toEqual([
      ["a1", 1],
      ["a2", 2],
      ["a4", 4],
    ]);
    expect(saved.state.nextNumber).toBe(5);
  });

  it("keeps two comments on the same shape as two numbered comments", () => {
    const state = saveAll(empty, ["Rename it", "Also move it left"]);
    expect(state.records).toEqual([
      mainRecord([
        { id: "a1", number: 1, comment: "Rename it", target: box },
        { id: "a2", number: 2, comment: "Also move it left", target: box },
      ]),
    ]);
  });

  it("reports why a comment cannot be saved and leaves the draft alone", () => {
    const save = (state: DiagramAnnotationDraftState, comment: string) =>
      saveDiagramAnnotation(state, mainPage, { comment, target: box }, () => id("new"));

    const blank = save(empty, " \n ");
    expect(blank).toEqual({ state: empty, result: { ok: false, reason: "empty" } });

    const long = save(empty, "x".repeat(2_001));
    expect(long).toEqual({ state: empty, result: { ok: false, reason: "too-large" } });

    // Eleven full comments fit; the twelfth passes the page's 24,000-character budget.
    const nearlyFull = saveAll(
      empty,
      Array.from({ length: 11 }, () => "y".repeat(2_000)),
    );
    expect(save(nearlyFull, "y".repeat(2_000)).result).toEqual({ ok: false, reason: "too-large" });

    const full = saveAll(
      empty,
      Array.from({ length: 30 }, (_, index) => `note ${index + 1}`),
    );
    const tooMany = save(full, "one more");
    expect(tooMany.result).toEqual({ ok: false, reason: "too-many" });
    expect(tooMany.state).toBe(full);

    const exhausted: DiagramAnnotationDraftState = { records: [], nextNumber: 1_000 };
    expect(save(exhausted, "late")).toEqual({
      state: exhausted,
      result: { ok: false, reason: "numbers-exhausted" },
    });
  });
});

describe("importing diagram annotation sets", () => {
  const draft: DiagramAnnotationDraftState = {
    records: [
      mainRecord([
        { id: "a1", number: 1, comment: "Make this box blue", target: box },
        { id: "a2", number: 2, comment: "Room for a legend", target: corner },
      ]),
    ],
    nextNumber: 3,
  };
  const pastedMain: DiagramAnnotationsContextRecord = {
    ...mainRecord([
      { id: "x1", number: 1, comment: "Pasted first", target: box },
      { id: "x5", number: 5, comment: "Pasted fifth", target: corner },
    ]),
    contextId: ComposerContextId.make("diagram-annotations_from-mobile"),
  };
  const pastedOther: DiagramAnnotationsContextRecord = {
    version: 1,
    kind: "diagram-annotations",
    contextId: ComposerContextId.make("diagram-annotations_other-page"),
    label: "Architecture Other",
    payload: {
      environmentId,
      projectId,
      diagramId,
      pageId: "page:other",
      annotations: annotationsOf([{ id: "x2", number: 2, comment: "Pasted second", target: box }]),
    },
  };

  it("renumbers conflicting comments once in number order and merges them by page", () => {
    const imported = importDiagramAnnotations(draft, [pastedMain, pastedOther]);
    expect(imported.state).toEqual({
      records: [
        mainRecord([
          { id: "a1", number: 1, comment: "Make this box blue", target: box },
          { id: "a2", number: 2, comment: "Room for a legend", target: corner },
          { id: "x1", number: 3, comment: "Pasted first", target: box },
          { id: "x5", number: 5, comment: "Pasted fifth", target: corner },
        ]),
        {
          ...pastedOther,
          contextId: OTHER_ID,
          payload: {
            ...pastedOther.payload,
            annotations: [{ id: "x2", number: 4, comment: "Pasted second", target: box }],
          },
        },
      ],
      nextNumber: 6,
    });
    expect([...imported.rewritten]).toEqual([
      ["diagram-annotations_from-mobile", MAIN_ID],
      ["diagram-annotations_other-page", OTHER_ID],
    ]);
    expect(imported.dropped).toBe(0);

    const again = importDiagramAnnotations(imported.state, [pastedMain, pastedOther]);
    expect(again.state).toEqual(imported.state);
    expect([...again.rewritten]).toEqual([
      ["diagram-annotations_from-mobile", MAIN_ID],
      ["diagram-annotations_other-page", OTHER_ID],
    ]);
  });

  it("brings a sent set back without its frozen capture", () => {
    const drafted = mainRecord([
      { id: "s1", number: 1, comment: "Make this box blue", target: box },
    ]);
    const sent: DiagramAnnotationsContextRecord = {
      ...drafted,
      payload: {
        ...drafted.payload,
        capture: {
          revision: 7,
          resolved: [
            { id: id("s1"), bounds: { x: 100, y: 80, w: 200, h: 120 }, marker: { x: 100, y: 80 } },
          ],
          images: [
            {
              role: "overview",
              annotationIds: [id("s1")],
              bounds: { x: 52, y: 32, w: 296, h: 216 },
              width: 296,
              height: 216,
              contextId: ComposerContextId.make("image_sent-overview"),
            },
          ],
          structure: {
            revision: 7,
            pages: [],
            compositions: [],
            shapes: [],
            bindings: [],
            totalShapes: 0,
            truncated: false,
          },
        },
      },
    };

    expect(importDiagramAnnotations(empty, [sent]).state).toEqual({
      records: [mainRecord([{ id: "s1", number: 1, comment: "Make this box blue", target: box }])],
      nextNumber: 2,
    });
  });
});
