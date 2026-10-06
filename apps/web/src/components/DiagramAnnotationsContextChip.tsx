import type { DiagramAnnotationsContextRecord } from "@t3tools/contracts";
import { MessageSquareTextIcon } from "lucide-react";

import { ContextChipShell } from "./contextChipParts";

const TOOLTIP_COMMENT_MAX_CHARS = 140;

/**
 * Inline chip for one page's Canvas comments, in the composer and in sent messages. The tooltip
 * reads the record only, so a sent message keeps showing what was sent after the diagram changes.
 */
export function DiagramAnnotationsContextChip(props: {
  record: DiagramAnnotationsContextRecord;
  copyMarkdown?: string;
}) {
  const annotations = props.record.payload.annotations.toSorted(
    (left, right) => left.number - right.number,
  );
  const count = annotations.length;
  const label = `${props.record.label} · ${count} ${count === 1 ? "comment" : "comments"}`;
  return (
    <ContextChipShell
      kind="diagram"
      icon={<MessageSquareTextIcon />}
      label={label}
      aria-label={`Canvas comments, ${label}`}
      data-markdown-copy={props.copyMarkdown}
      tooltip={annotations
        .map(({ number, comment }) => {
          const line = comment.replace(/\s+/g, " ");
          return `#${number} ${
            line.length > TOOLTIP_COMMENT_MAX_CHARS
              ? `${line.slice(0, TOOLTIP_COMMENT_MAX_CHARS - 1)}…`
              : line
          }`;
        })
        .join("\n")}
    />
  );
}
