import type { DiagramContextRecord } from "@t3tools/contracts";
import { ShapesIcon } from "lucide-react";

import { ContextChip, ContextChipLabel } from "./ContextChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export const OPEN_DIAGRAM_CONTEXT_EVENT = "t3:open-diagram-context";

export function DiagramContextChip(props: { record: DiagramContextRecord; copyMarkdown?: string }) {
  const { record } = props;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="diagram"
            render={<button type="button" />}
            data-markdown-copy={props.copyMarkdown}
            aria-label={`Diagram, ${record.label}`}
            onClick={() =>
              window.dispatchEvent(new CustomEvent(OPEN_DIAGRAM_CONTEXT_EVENT, { detail: record }))
            }
          >
            <ShapesIcon />
            <ContextChipLabel>{record.label}</ContextChipLabel>
          </ContextChip>
        }
      />
      <TooltipPopup side="top">
        Open diagram. {record.payload.scope.kind} scope.
        {record.payload.revision === undefined
          ? " Live reference"
          : ` Revision ${record.payload.revision}`}
        {record.payload.imageStatus === "unavailable" ? ". Image unavailable" : ""}
      </TooltipPopup>
    </Tooltip>
  );
}
