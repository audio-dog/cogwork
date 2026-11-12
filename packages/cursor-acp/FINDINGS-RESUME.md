# Spike #99 — Mid-turn Cursor session resume

**Verdict: GO on automatic resume for both `interrupted` and `crashed` runs.** A session whose
last turn was killed mid-flight reloads cleanly and comes back *inside* that turn, not at the last
completed turn boundary. The interrupted turn's user prompt replayed on every single run, so the
resumed agent still knows what it was asked. Resume after a `SIGKILL` was indistinguishable from
resume after a graceful ACP `session/cancel`, so a drain that cancels first buys no extra fidelity.

One caveat drives the nudge wording: **the tail of the interrupted turn is ragged.** The last
assistant text and the last tool call may or may not have been committed, so the agent's memory of
its own progress can lag what is actually on disk — in 3 of 4 mid-turn runs it believed less work
was done than had really landed. The nudge must send it to the checkout for ground truth rather
than letting it trust its transcript.

## Environment

| Piece | Version |
|---|---|
| Cursor CLI (`agent`) | `2026.07.23-e383d2b` |
| `@agentclientprotocol/sdk` | 0.25.1 (ACP protocol v1) |
| `@tanstack/ai-acp` | 0.2.3 |
| Model | `auto` · Auth | prior `agent login` |

`initialize` advertised `agentCapabilities.loadSession = true` on every run.

## Method

The retired resume probe drove raw ACP (no TanStack adapter, so nothing was hidden) against a
throwaway git checkout, one session per run:

1. **Turn 1 (identical everywhere)** plants a codeword and completes — a known-good committed turn.
2. **Turn 2** is a five-step task: create `step-N.md`, announce `STEP N DONE`, strictly one at a
   time. Each arm stops it differently:
   - `completed` — let it run to `end_turn`.
   - `cancelled` — after 2 completed tool calls, ACP `session/cancel`, then dispose (a graceful drain).
   - `killed` — after 2 completed tool calls, `SIGKILL` the agent process (no flush opportunity).
3. Kill the process, spawn a **fresh** `agent acp`, and `session/load` the same session id.
   The updates the agent replays during `session/load` are captured as protocol-level ground truth
   for "what state did it come back in" — a stronger oracle than asking the model.
4. Ask the resumed agent what it remembers (no work), then send the candidate nudge and check
   whether it finishes the job without redoing completed steps.

**Sample: 5 runs** — `killed` × 3 (the arm the decision rests on), `completed` × 1, `cancelled` × 1.
One model, one CLI build. Where runs disagreed, that is called out rather than averaged away.

### What this does *not* model

The probe SIGKILLs the **agent** process. A `crashed` run per ADR 0002 is the **daemon** dying, and
in production the agent is a child spawned by `localProcessSandbox` from inside the daemon — so a
daemon SIGKILL *orphans* the agent rather than killing it. A real crash recovery may therefore find
the old agent still alive, still holding the session store, and still editing the checkout. That
case is untested here and is called out as a condition on the go decision below.

## Q1 — Does `session/load` survive a mid-turn kill? **YES**

`session/load` succeeded on all 5 runs, including all 3 `SIGKILL`s with a turn in flight. No
"session not found", no stuck-turn lock, no need to cancel first.

The mechanism is that the session store commits during the turn rather than at turn end. The store
(`~/.cursor/acp-sessions/<uuid>/store.db`) keeps a root pointer as hex-encoded JSON under `meta`
key `0` (`latestRootBlobId`), alongside a `blobs` table. Comparing a snapshot taken after turn 1
against one taken after the stop:

```
blob count after turn 1 (every run)      = 11
blob count after stop — completed        = 69
blob count after stop — cancelled        = 28
blob count after stop — killed (SIGKILL) = 27, 27, 26   ← read after the kill, all three runs
root pointer advanced during turn 2      = true (every run)
```

The `killed` runs are the load-bearing evidence: `SIGKILL` gives no chance to flush, so the growth
from 11 blobs and the advanced root pointer must have been committed *while the turn was running*.
(The `completed` and `cancelled` snapshots were taken after `end_turn` and after cancel settled
respectively, so on their own they would not distinguish incremental commits from a flush at the
end.)

## Q2 — What state does it come back in? **Mid-turn, not the last completed step**

The replayed history from `session/load`:

| Run | Stop reason | Tool calls done live | Replayed updates | Replayed `tool_call` | Step prompt | Partial text |
|---|---|---|---|---|---|---|
| `completed` | `end_turn` | 5 | 26 | 5 | yes | yes |
| `cancelled` | `cancelled` | 2 | 11 | 1 | yes | yes |
| `killed` 1 | `SIGKILL` | 2 | 11 | 1 | yes | yes |
| `killed` 2 | `SIGKILL` | 2 | 10 | 1 | yes | **no** |
| `killed` 3 | `SIGKILL` | 2 | 10 | 1 | yes | **no** |

Every mid-turn run replayed the interrupted turn's **user prompt** and one tool call. Resume lands
inside the killed turn, and the agent does not need to be re-told the task. That is the result the
go decision rests on, and it held on every run.

The **tail** is what varies. The assistant's partial text (`STEP 1 DONE`) replayed in one of three
`killed` runs. Anything after the last committed tool call should be treated as "may or may not be
there".

**`cancelled` and `killed` came back the same shape** — 11 updates for `cancelled`, 11 / 10 / 10
for the three `killed` runs, with identical update kinds and the same single `tool_call`. A
graceful ACP cancel restores nothing a hard kill doesn't. That is a free result for #98: drain can
prefer `session/cancel` for the agent's own sake, but resume fidelity is not the reason to.

### The transcript can lag the checkout

Live, each mid-turn run had 2 tool calls reported completed, but only **one** `tool_call` appeared
in the replay. The agent's self-report tracked its transcript, not the disk:

```
killed 1:  finished step 1, step 2 write interrupted.        disk: step-1.md, step-2.md
killed 2:  finished step 1 only.                             disk: step-1.md, step-2.md
killed 3:  created step-1.md only, then stopped before STEP 1 DONE.   disk: step-1.md
cancelled: finished step 1, step 2 write was interrupted.    disk: step-1.md, step-2.md
```

In 3 of these 4 the agent **under-reported** — work was on disk that its memory did not account
for. (`killed` 3 happens to line up, because its second tool call was not a file write.) The
under-report is never in the other direction: the transcript did not once claim work that had not
happened. So the risk to design against is redoing finished work, not skipping unfinished work.
The `completed` arm replayed 5 of 5 tool calls, so this is an artifact of being interrupted, not
general transcript lossiness.

## Q3 — Does earlier committed history survive? **YES**

All 5 runs recalled `peridot` from turn 1. Turns that completed before the kill are intact; only
the interrupted turn's tail is ragged.

## Q4 — Does a continuation nudge work? **YES, every run**

The nudge under test, sent as the only user message on the resumed session:

> You were interrupted part-way through the task above and this session has just been resumed.
> Nothing has changed except that time passed. Inspect the working directory to see how far you
> got, then continue from exactly where you stopped. Do not start over and do not redo completed
> work. If the task is already complete, say COMPLETE and stop.

| Run | Behaviour | Files before → after | Redid completed work |
|---|---|---|---|
| `completed` | checked the directory, replied `COMPLETE` | 5 → 5 | no |
| `cancelled` | "Steps 1–2 are done", continued 3→5 | 2 → 5 | no |
| `killed` 1 | checked the directory, continued 3→5 | 2 → 5 | no |
| `killed` 2 | "Steps 1–2 are done. Continuing from step 3." | 2 → 5 | no |
| `killed` 3 | continued from step 2 | 1 → 5 | no |

No pre-existing file was rewritten in any run (compared by mtime), and every run finished all five
steps. The "inspect the working directory" clause is what carried the mid-turn runs: `killed` 2 is
the clearest case — its transcript said "finished step 1 only", and it still correctly resumed at
step 3 after looking at disk.

## Recommendation

### Nudge wording for #102

```
You were interrupted part-way through the task above and this session has just been resumed.
Nothing has changed except that time passed. Inspect <worktreePath> to see how far you got, then
continue from exactly where you stopped. Do not start over and do not redo completed work. If the
task is already complete, say COMPLETE and stop.
```

This is the tested text with one substitution: the runs above said "the working directory" (the
agent's cwd was already the checkout), and `<worktreePath>` names it explicitly. That substitution
is the one part of the wording **not** covered by the evidence, and it lands in the clause the
results say is load-bearing — worth confirming on the first real resumed run.

Rationale, clause by clause — each earns its place from an observed behaviour:

- **"the task above"** — the interrupted turn's prompt replayed on every run (Q2), so restating the
  full stage prompt is redundant and risks the agent re-planning from scratch. This clause only
  works when resume actually succeeded; see the mismatch guard below.
- **"Inspect `<worktreePath>`"** — the load-bearing clause. The transcript can lag the checkout, so
  the filesystem is the only reliable record of where work stopped. Every mid-turn run needed this
  to avoid redoing a completed step.
- **"Do not start over and do not redo completed work"** — the failure this spike was most worried
  about. With the inspect clause: zero redone work across all 5 runs.
- **"If the task is already complete, say COMPLETE and stop"** — covers the race where the daemon
  dies after the turn finished but before the outcome is recorded. The `completed` arm exercises
  exactly this and replied `COMPLETE` without touching a file. Nothing needs to parse that token,
  but it is there if the engine wants a cheap signal for "resumed into an already-finished run".
- **No mention of restarts, crashes, or the daemon.** "Nothing has changed except that time passed"
  was enough; naming the crash invites the agent to investigate the infrastructure instead of the
  task.

### Go / no-go for automatic resume

**GO**, for both restart outcomes in ADR 0002, with three conditions.

1. **Verify the echoed session id before trusting the nudge.** `@tanstack/ai-acp` 0.2.3 swallows a
   `session/load` failure in a bare `catch {}` and falls through to `session/new`
   (`session/acp-client.js`). There are actually *two* ways into that silent fresh session: the
   load throwing, and the agent simply not advertising `loadSession`, in which case no
   `session/load` is attempted at all. The `resumed` flag the package computes stays on its
   internal handle and never reaches the stream — the adapter pushes only
   `{ kind: "session", sessionId }` — so the sole signal available to the engine is the emitted
   `<name>.session-id`. Compare it against the one requested; both failure paths change it.
   (Don't debug this from adapter logs: `compatible.ts` logs `resume=<uuid>` *before* the load is
   attempted, so it reads the same on success and on fallback.)
2. **Have a full-prompt fallback ready for that case.** If #102 sends the nudge as the run's only
   prompt — the natural reading of "a short continuation nudge rather than the full stage prompt" —
   then a silently-fresh session receives *only* "you were interrupted, continue from where you
   stopped": no task, no history, and a checkout full of unexplained files. (The adapter sends just
   the trailing user message on a successful resume and rebuilds from `messages` on fallback, but
   `cursorRunner` passes exactly one message, so both paths emit the same text and the fallback
   path saves nothing.) On an id mismatch, re-send the full stage prompt instead.
3. **Decide what to do about an orphaned agent.** A daemon `SIGKILL` does not kill the agent it
   spawned. Recovery may resume a session whose original agent is still running, still writing to
   the same store, and still editing the checkout — a case this spike did not test. Reaping any
   surviving agent for the run before resuming is the cheap defence; #101 is the natural home for
   it.

Conditions 1 and 2 are engine-side and need nothing from the harness seam; #97 already puts the
session id where recovery can read it. Condition 3 is a process-lifecycle question for #101.

## Archived evidence

The spike script was retired after automatic resume shipped. This document preserves its findings,
but the original experiment is no longer runnable from this package.
