# An action entry is registered once

An output action is defined in one place, as one typed value: its catalog row, the target it freezes,
the write it performs, its phase in the Action plan's fixed order, and the engine Tools a Run needs
to use it. A registry keyed by the full catalog key holds every Action entry; the Trigger and action
catalog's action rows derive from the registry.

Before this, one action lived in five hand-synced tables across three files: a catalog row in the
adapter that offered it, a target producer, a set that chose the source-control target path, a rank
predicate, and an executor, with the runner keeping two more name sets for the Tools a Run needs.
Rows agreed by string; the executor was found by the key's suffix after the app prefix was stripped,
so `github.x` and `linear.x` could never share a suffix and a missing row failed at run time. The
2026-11-04 architecture review counted seven touch points for one new write.

The registry makes a missing executor a type error and a suffix collision unrepresentable. The
builder and executor in `workflow-action-plan.ts` keep what is theirs — freeze order, write keys,
approval, hand-off — and know no entry by name. Entries live in engine modules grouped by the app
they write to; an adapter offers nothing to the catalog and only answers port calls. The issue
actions are one entry each, mapped over both tracker systems, because the issue tracker port already
routes the write.

## Considered Options

- **Key the executor table by full key and stop there.** Rejected as the instance fix: it removes the
  suffix hazard and leaves four tables to keep in step.
- **Let each adapter register its own entries.** Rejected: an executor is a Workflow-plan concern
  that calls ports; placing it inside an adapter would make the adapter know the Action plan.

## Consequences

Phase replaces the rank predicates; the fixed order of ADR 0035 is a field on the entry. The runner's
tool-need sets are replaced by the entries' declared Tools, which is one of the facts Run Plan
resolution (ADR 0016) decides over. Migration is expand–contract by app — Cogwork, issue, source
control, Slack — with the old tables deleted in the last step.
