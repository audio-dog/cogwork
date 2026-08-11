# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root — read this **first**. It lists the contexts and, in its Relationships section, traces how work flows across them end to end. This is where the high-level architecture lives; the per-context glossaries do not.
- **`packages/contracts/CONTEXT.md`** — the shared kernel. It owns the cross-cutting orchestration vocabulary (`WorkItem`, `Run`, `Claim`, harness terms, lifecycle stages). Read it alongside any orchestration context (`engine`, `cli`, `cursor-acp`).
- **`CONTEXT.md`** for the specific context you're working in (`packages/<name>/CONTEXT.md`, or `apps/cli/CONTEXT.md`). Each defines only that context's own terms.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. Also check `<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Multi-context repo (presence of `CONTEXT-MAP.md` at the root). Each package/app is a context;
`packages/contracts` is the shared kernel the orchestration contexts reference.

```
/
├── CONTEXT-MAP.md                     ← contexts + cross-context flow (read first)
├── docs/adr/                          ← system-wide decisions
├── apps/
│   └── cli/CONTEXT.md
└── packages/
    ├── contracts/CONTEXT.md           ← shared kernel
    ├── engine/CONTEXT.md
    └── cursor-acp/CONTEXT.md
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
