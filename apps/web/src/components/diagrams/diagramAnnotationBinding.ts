import type { DiagramAnnotationId, DiagramAnnotationsContextRecord } from "@t3tools/contracts";

import type {
  DiagramAnnotationEdit,
  DiagramAnnotationPage,
  DiagramAnnotationSaveResult,
} from "../../lib/diagramAnnotationDrafts";

/** How a Canvas reads and writes the comments in the current message draft. */
export interface DiagramAnnotationBinding {
  /** This environment's saved comment sets in the current message draft. */
  readonly records: ReadonlyArray<DiagramAnnotationsContextRecord>;
  readonly save: (
    page: DiagramAnnotationPage,
    edit: DiagramAnnotationEdit,
  ) => DiagramAnnotationSaveResult;
  readonly remove: (annotationId: DiagramAnnotationId) => void;
  /** False when the server cannot prepare annotated context; Canvas hides annotating. */
  readonly supported: boolean;
}
