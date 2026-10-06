# Diagram ownership

Status: project-owned diagrams are implemented. The HTML artifact source model below is an accepted design awaiting implementation.

Saved diagrams belong to environment-local projects. Their canonical records and uploaded assets live in environment-owned storage, independent of threads, panel tabs, provider sessions, and workspace branches. This lets threads using different worktrees share a diagram without making its identity depend on a checkout path or duplicating it per conversation. Portability uses explicit editable import/export; there is no automatic workspace-file mirror.

A diagram is one mutable document. Attaching it to chat references that document, while ordinary message images represent the input supplied to the provider. Those images do not introduce diagram version history. Git checkpoint restore affects workspace files and deliberately does not rewind diagrams; a separate version requires an explicit duplicate or export. This chooses shared mutable documents over tying diagram state to Git checkpoints or historical chat attachments.

## HTML artifact sources

Accepted product decision; canvas HTML artifacts are not yet implemented.

HTML artifacts support both inline source owned by the diagram and source backed by a workspace HTML file. Diagram records remain in SQL; HTML artifacts do not introduce a backing JSON file or automatic workspace mirror. Inline source lets an artifact exist without creating a workspace file; file-backed source keeps ordinary file editing and version control available. A backing file is the artifact's source, rather than an automatic mirror of diagram-owned source. The diagram owns the artifact's placement and connector arrows in either mode.

File-backed artifacts use ordinary file references and can link to an existing HTML file. Source changes refresh the rendered artifact immediately; reloading resets its local runtime state.

Artifacts include interactive screen mocks, plans, explainers, and other HTML documents. Their contents are edited through source rather than by manipulating HTML elements on the canvas. Each artifact is independently interactive. Connector arrows describe relationships; cross-artifact navigation and shared runtime state are outside this initial decision.

Input inside the artifact goes directly to its HTML. Canvas dragging uses a small outer frame, so interacting with a document does not require switching into an interaction mode.
