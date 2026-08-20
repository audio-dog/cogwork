# Side panel is a user-assembled surface catalog

**Status:** accepted — supersedes the fixed-tabs decision in the desktop shell-revamp spec (issue #53 / `docs/spec/desktop-shell-revamp.md` §3).

The shell-revamp spec made Attention and Activity **permanent fixed tabs** of the side panel. We reverse that. The side panel becomes a **user-assembled surface catalog**, modelled on t3code's right panel: it starts empty and the operator adds the tabs they want. A tab is a **Tool surface** (Attention, Activity, and a Terminal placeholder — one instance each, added from the catalog) or a **Subject surface** (one instance per subject — the item tab today, keyed by work item; a future PR review keyed by a pull request, opened by clicking the subject, never from the catalog). Tabs are drag-reorderable (`@dnd-kit`) and persist across launches. We did this because the fixed-tab model conflated "one instance" with "permanent", could not grow to new surface kinds (PR review, terminal) without more hard-coding, and did not let the operator shape their own workspace. The `Surface` code word and the `surfaceId` identity scheme (bare kind for Tool surfaces, kind + subject key for Subject surfaces) already supported this, so the model change is mostly removing the seeded fixed set.

## Considered options — pinning the right-panel toggle

The toggle must stay put when the panel opens or closes. We pin it with a **single absolutely-positioned control in a `relative` content root** (`--workspace-controls-right` / `--workspace-controls-top`), and move maximize beside it. We rejected two alternatives a future reader would reach for:

- **`position: fixed`** (the left sidebar's `SidebarControl` pattern) — re-anchors to any ancestor that gains a `transform`, `filter`, or `will-change`, so it can silently drift.
- **t3code's reparenting** (render the same node in the header when closed, a pinned strip when open) — keeps the right offset by hand across mount points (t3code carries a code comment warning it once jumped) and remounts the node, closing any open tooltip or menu.

The absolute single-mount avoids both, needs no per-state offset discipline, and re-slots cleanly if the top bar is restructured later.
