# Harness switching versus the TanStack structured-result rollout

Date: 2026-08-20.

## Recommendation

The harness-switch design fits the new architecture unchanged, but implementation should wait until
[#111](https://github.com/taylorfsteele/cogwork/issues/111) lands. This is sequencing for a clean diff,
not an architectural dependency: #109–111 change result-schema preparation, terminal-event folding,
and stage completion inside the executor, while explicitly preserving ordinary events and session
behavior. The switch fix belongs earlier, where the executor selects one session before it inserts a
run and calls `HarnessRunner`.

After #111, implement one engine-owned **session plan** for each run:

- read the branch's latest session, then load its session row;
- resume only when that session's `harness` equals the selected harness and existing resume policy
  allows it;
- otherwise mint a session owned by the selected harness and use the full stage prompt;
- use that same selected `SessionId` in both `RunRecord.session` and `HarnessRequest.session`;
- treat recovery with a changed harness and explicit `fresh` the same way: mint, full prompt, no
  failed attempt;
- log one informational harness-switch event with workspace, branch, old harness, and new harness.

Do not filter the lookup by selected harness, migrate transcripts/handles, resurrect an older matching
session, add lineage state, or move compatibility logic into individual runners.

## Why it fits

The landed TanStack upgrade was deliberately behavior-preserving: fresh sessions, resume handles,
event recording, and provider-runner behavior had to remain unchanged
([#108](https://github.com/taylorfsteele/cogwork/issues/108),
[#112](https://github.com/taylorfsteele/cogwork/pull/112)). The three follow-on tickets deepen the
existing `HarnessRunner` seam rather than replace it:

- [#109](https://github.com/taylorfsteele/cogwork/issues/109) derives a structured-result schema from
  `LifecycleStage`, supplies it through each TanStack adapter, folds exactly one
  `structured-output.complete` event, and Effect-decodes it before coordination. Its acceptance
  criteria explicitly retain owned-transcript session folding.
- [#110](https://github.com/taylorfsteele/cogwork/issues/110) changes implement completion from transcript
  sentinel parsing to the shared structured result.
- [#111](https://github.com/taylorfsteele/cogwork/issues/111) does the same for follow-up and deletes the
  remaining text-result accumulator/protocol. It explicitly requires owned- and opaque-session
  behavior to remain unchanged.

That makes structured results and session compatibility independent axes:

| Concern | Owner | Decision input |
| --- | --- | --- |
| Conversation continuity | executor + session store | latest session owner, selected harness, resume policy |
| Stage result contract | harness service + executor fold | lifecycle stage |
| Native resume mechanism | individual runner | selected engine session's owned transcript or opaque handle |

`HarnessRequest` already carries both `stage` and `session`, so #109 can derive the result contract
from `stage` while the session plan supplies a compatible `session`; no extra public selector is
needed ([harness.ts](../../packages/engine/src/harness.ts)). Each runner already resolves resume data
only from that engine session: Codex and Cursor ask `SessionStore.resumeHandle`, while the provider
runner folds the owned transcript. The session row already stores its creating `harness`, so no schema
migration is needed ([session-store.ts](../../packages/engine/src/session-store.ts),
[contracts context](../../packages/contracts/CONTEXT.md)).

## Current defect and integration point

Session selection is currently split across several paths:

- `resolveSession` reuses `sessionForBranch` or a recovery session without checking its owner;
- implement preparation independently reads `latestRunByBranch` and passes that run's session;
- follow-up preparation independently runs resume policy and may omit the handle while the run record
  still reuses the old engine session;
- recovery preparation always sends a continuation nudge with the recovered session.

See [executor.ts](../../packages/engine/src/executor.ts),
[run-ledger.ts](../../packages/engine/src/run-ledger.ts), and
[SQLite ledger](../../apps/cli/src/ledger.ts). This split permits the observed cross-harness resume and
also means explicit `fresh` is not yet a true conversation boundary.

The fix should therefore consolidate selection rather than add a harness check to only
`resolveSession`. A single plan must decide session identity, prompt mode, and whether resume guards
apply before `RunRecord` insertion. `sessionForBranch` is already the right chronological primitive:
both in-memory and SQLite implementations return the newest branch run's session without filtering by
harness. Loading that row and comparing its `harness` implements Cursor → Codex → Cursor correctly.

## Sequencing

No API introduced by #109–111 is required to implement this. However, all three tickets touch
`executor.ts` and its interface tests, especially the accumulator, completion functions, and stream
fold. Implementing concurrently would create avoidable conflicts and could build the session plan
around text-result structures that #111 deletes.

Recommended order:

1. Land #109, then #110, then #111 in their declared dependency order.
2. Re-read the final executor shape.
3. Add the centralized session plan and focused executor/ledger tests.
4. Verify runner contract tests stay unchanged except where fixtures need the newly selected session.

The design documentation already records the intended invariant in
[engine ADR 0002](../../packages/engine/docs/adr/0002-restart-recovery-resumes-sessions.md) and the
[shared glossary](../../packages/contracts/CONTEXT.md). No source implementation was changed by this
research.

## Sources

- Cogwork issues [#108](https://github.com/taylorfsteele/cogwork/issues/108),
  [#109](https://github.com/taylorfsteele/cogwork/issues/109),
  [#110](https://github.com/taylorfsteele/cogwork/issues/110), and
  [#111](https://github.com/taylorfsteele/cogwork/issues/111), read with their comments and linked PRs.
- Landed upgrade PR [#112](https://github.com/taylorfsteele/cogwork/pull/112).
- Existing structured-output architecture research:
  [tanstack-ai-harness-structured-outputs.md](./tanstack-ai-harness-structured-outputs.md).
- Current engine, contracts, runner, and SQLite ledger source linked inline above.
