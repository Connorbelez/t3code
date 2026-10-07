import type { DiagramAnnotationsContextRecord } from "@t3tools/contracts";
import { MessageSquareTextIcon } from "lucide-react";

import { ContextChipPopover } from "./contextChipParts";

/**
 * Inline chip for one page's Canvas comments, in the composer and in sent messages. The details
 * read the record only, so a sent message keeps showing what was sent after the diagram changes.
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
  const capture = props.record.payload.capture;
  return (
    <ContextChipPopover
      kind="diagram"
      icon={<MessageSquareTextIcon />}
      label={label}
      accessibleLabel={`Canvas comments, ${label}`}
      {...(props.copyMarkdown === undefined ? {} : { copyMarkdown: props.copyMarkdown })}
    >
      <div className="max-h-80 space-y-3 overflow-y-auto">
        <p className="text-xs text-muted-foreground">
          {capture
            ? `Captured revision ${capture.revision} · ${capture.images.length} ${capture.images.length === 1 ? "image" : "images"}`
            : "These comments will be captured when you send."}
        </p>
        <ol className="space-y-3">
          {annotations.map(({ id, number, comment }) => (
            <li key={id} className="flex gap-2 text-xs">
              <span className="shrink-0 font-medium">#{number}</span>
              <p className="min-w-0 whitespace-pre-wrap break-words">{comment}</p>
            </li>
          ))}
        </ol>
      </div>
    </ContextChipPopover>
  );
}
