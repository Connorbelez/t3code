# Diagram ownership

Status: accepted design for the personal tldraw integration; implementation pending.

Saved diagrams belong to environment-local projects. Their canonical records and assets live in environment-owned storage, independent of threads, panel tabs, provider sessions, and workspace branches. This lets threads using different worktrees share a diagram without making its identity depend on a checkout path or duplicating it per conversation. Portability uses explicit editable import/export; there is no automatic workspace-file mirror.

A diagram is one mutable document. Attaching it to chat references that document, while ordinary message images represent the input supplied to the provider. Those images do not introduce diagram version history. Git checkpoint restore affects workspace files and deliberately does not rewind diagrams; a separate version requires an explicit duplicate or export. This chooses shared mutable documents over tying diagram state to Git checkpoints or historical chat attachments.
