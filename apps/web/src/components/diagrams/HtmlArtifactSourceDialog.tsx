import { useState } from "react";
import { createShapeId, type Editor } from "tldraw";
import { DiagramHtmlArtifactSource } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { HtmlArtifactShape } from "@t3tools/diagram-compose/schema";
import { Button } from "~/components/ui/button";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";

const isArtifactSource = Schema.is(DiagramHtmlArtifactSource);

export type HtmlArtifactSourceAction =
  | { kind: "create-inline" }
  | { kind: "create-file" }
  | { kind: "edit"; shape: HtmlArtifactShape };
export function HtmlArtifactSourceDialog({
  action,
  editor,
  close,
}: {
  action: HtmlArtifactSourceAction;
  editor: Editor;
  close: () => void;
}) {
  const existing = action.kind === "edit" ? action.shape : null;
  const file = action.kind === "create-file" || existing?.props.source.kind === "file";
  const [title, setTitle] = useState(existing?.props.title ?? "HTML artifact");
  const [source, setSource] = useState(
    existing?.props.source.kind === "file"
      ? existing.props.source.path
      : (existing?.props.source.html ??
          (file
            ? ""
            : '<!doctype html>\n<html>\n<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>\n<body><h1>Hello canvas</h1></body>\n</html>')),
  );
  const artifactSource = file
    ? { kind: "file" as const, path: source.trim() }
    : { kind: "inline" as const, html: source };
  const sourceValid = isArtifactSource(artifactSource);
  const valid = title.length <= 200 && sourceValid;
  const save = () => {
    if (!valid) return;
    const props = { title: title.trim() || "HTML artifact", source: artifactSource };
    editor.markHistoryStoppingPoint("HTML artifact source");
    if (existing)
      editor.updateShape<HtmlArtifactShape>({ id: existing.id, type: "html-artifact", props });
    else {
      const center = editor.getViewportPageBounds().center;
      const id = createShapeId();
      editor.createShape<HtmlArtifactShape>({
        id,
        type: "html-artifact",
        x: center.x - 240,
        y: center.y - 180,
        props,
      });
      editor.select(id);
    }
    close();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup>
        <DialogTitle>
          {existing ? "Edit HTML artifact source" : file ? "Link HTML file" : "Add HTML artifact"}
        </DialogTitle>
        <DialogDescription>
          {file
            ? "Use the path of an existing HTML file in this project."
            : "HTML is saved with this diagram. Scripts run inside the artifact."}
        </DialogDescription>
        <div className="mt-4 grid gap-3">
          <label className="grid gap-1 text-sm">
            Title
            <Input
              maxLength={200}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          {file ? (
            <label className="grid gap-1 text-sm">
              File path
              <Input
                maxLength={4096}
                value={source}
                placeholder="designs/screen.html"
                onChange={(event) => setSource(event.target.value)}
              />
            </label>
          ) : (
            <label className="grid gap-1 text-sm">
              HTML source
              <textarea
                className="h-72 w-full resize-y rounded-md border border-input bg-background p-3 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                spellCheck={false}
                maxLength={1_000_000}
                value={source}
                onChange={(event) => setSource(event.target.value)}
              />
            </label>
          )}
          {!sourceValid ? (
            <p role="alert" className="text-sm text-destructive">
              {file
                ? "Enter a file path of at most 4096 characters."
                : "HTML source must be at most 1,000,000 characters."}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button disabled={!valid} onClick={save}>
              {existing ? "Save source" : file ? "Link file" : "Add artifact"}
            </Button>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
