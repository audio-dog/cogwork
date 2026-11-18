# Trusted-bot wake signal — implementation plan

Narrows what a bot on the **Bot allowlist** may use to wake a Follow-up. Today any comment an
allowlisted bot writes on a pull request wakes one. That takes Bugbot's `PR Summary` comment — posted
minutes before Bugbot has reviewed anything — as a reason to spend a Run.

This plan is the *how*. The **Bot allowlist** entry in
[`packages/contracts/GLOSSARY.md`](../../packages/contracts/GLOSSARY.md) is the *what*, and where the
two disagree the glossary wins.

Before writing code: invoke `/effect-ts`, and read `docs/agent-patterns/effect-schema-unions.md`
(the decode boundary in Step 1) and `docs/agent-patterns/effect-test-layers.md` (Step 4). Read
`packages/engine/AGENTS.md` and `CODING_STANDARDS.md`.

## The problem

`cursor[bot]` writes five different things on a cogwork pull request. Only one of them is a finding.

| What it writes | Where GitHub keeps it | Its marker | A finding? |
| --- | --- | --- | --- |
| `## PR Summary` and a risk rating | PR-level issue comment | `<!-- CURSOR_SUMMARY -->` | No |
| "Bugbot reviewed your changes and found N potential issues" | review body | `<!-- BUGBOT_REVIEW -->` | No — a header |
| "Stale Bugbot comment from a previous run." | review body, edited in place | `<!-- BUGBOT_REVIEW_STALE -->` | No |
| "Left a non-blocking comment and did not approve…" | review body | `<!-- CURSOR_AUTOMATION_ID -->` | No |
| A title, a severity and a description | **inline comment on a line of the diff** | `<!-- DESCRIPTION START -->` | **Yes** |

`sourceControlSignals` in `packages/engine/src/github/provider.ts` reads all three GitHub streams and
joins them into one flat `Feedback` list. The kind is lost at that join, so `botTriggerSignal` cannot
tell a finding from narration.

The cost is larger than the noise. The woken Run finds nothing to fix and pushes nothing, so
`noProgressAfterRound` keeps the count. Three of these hand the pull request to a human with no work
done. A false wake spends tokens *and* a third of the safety net.

## The rule

**A trusted bot wakes a Follow-up when it opens a new thread on a line of the diff.**

Everything else that bot writes on the pull request wakes nothing. An entry on the allowlist may end
with `:any` to drop the shape test and take every comment, which is the escape hatch for a bot that
only speaks at pull-request level.

Human feedback does not change. A person's PR-level comment still wakes a Follow-up and can still
set `/fresh`.

## The evidence

Every `cursor[bot]` review on the last 60 pull requests of `colonylabs/cogwork`, with the inline
comments attached to each one counted:

- Every review carrying `<!-- BUGBOT_REVIEW -->` had **at least one** inline comment. Never zero.
  The count ran from 1 to 4.
- The only reviews with zero inline comments were the Cursor automation notes.
- When Bugbot finds no bug it posts **no review at all**. PRs 698 and 706 carry a `PR Summary`
  comment and nothing else.

So no Bugbot finding has ever arrived without an inline comment, and the shape test loses nothing.

The GitHub API does permit a review body with no inline comments — the automation notes prove it. The
rule therefore rests on observed Bugbot behaviour, not on a contract. That is why the `:any` escape
hatch exists.

`in_reply_to_id` separates a finding from a reply. PR 700 carried both:

```
4048343769  in_reply_to_id=null        cursor[bot]  ### Shared hook pins worktree-local binary
4048370072  in_reply_to_id=4048343769  cursor[bot]  The mechanism is real, but the shim is less brittle…
4048160867  in_reply_to_id=4047924946  cursor[bot]  Done in `ab82f9f8` — the whole section is removed.
```

Bugbot posts findings only at top level. The two replies came from a Cursor background agent that
shares the login.

## Step 1 — carry the thread parent onto `RawComment`

In `packages/engine/src/github/client.ts`:

- `CommentSchema` decodes `in_reply_to_id`. It is absent on an issue comment and null on a top-level
  review comment, so it is optional and nullable.
- `RawComment` gains the decoded value. `toRawComment` maps it.

`listReviewComments` already calls `/pulls/{n}/comments`, which returns the field. No new request and
no new round trip.

Acceptance: decoding a review comment with a parent, a review comment without one, and an issue
comment all succeed, and the parent survives onto `RawComment`.

## Step 2 — the bot signal reads only top-level diff comments

In `packages/engine/src/github/provider.ts`:

- `botTriggerSignal` takes the review comments alone, not the joined `Feedback` list, and keeps only
  those with no thread parent.
- `humanCommentSignal` keeps reading all three streams. Do not narrow the human path.
- `isTrustedBotFeedback` keeps excluding a body carrying a cogwork marker.
- `sourceControlSignals` stops passing the joined list to the bot path.

`packages/engine/src/follow-up.ts` does not change. `latestBotTriggerAtMillis`, `hasNewBotTrigger`
and `triggersFollowUp` keep their shapes and are fed a narrower signal.

Write the reason for refusing Bugbot's own HTML markers as a comment where the human and bot paths
split, beside the existing note at `isHumanFeedback`. A marker list would couple the engine to one
vendor's private strings; the shape test does not.

Acceptance, with `cursor[bot]` on the allowlist:

- A `<!-- CURSOR_SUMMARY -->` issue comment wakes nothing.
- A `<!-- BUGBOT_REVIEW -->` review body wakes nothing.
- A `<!-- CURSOR_AUTOMATION_ID -->` review body wakes nothing.
- A top-level inline comment on a diff line wakes a Follow-up.
- An inline comment with a thread parent wakes nothing.
- A human's PR-level comment still wakes one, and `/fresh` in it still takes effect.
- An allowlisted bot still cannot set `/fresh` and still does not reset the no-progress counter.

## Step 3 — the `:any` suffix

`botAllowlist` stays `Schema.Array(TrimmedNonEmptyString)` in
`packages/contracts/src/workspace.ts`. Nothing about the schema changes, so every stored workspace
keeps decoding and gains the strict rule.

`targetFromRepo` in `provider.ts` parses each entry instead of dropping it into a `Set`:

- An entry ending in `:any` yields that login with the shape test off.
- Any other entry is a bare login with the shape test on.

Only the exact `:any` suffix is recognised. `GitHubTargetConfig.botAllowlist` becomes a map from
login to mode, and `isHumanFeedback` tests membership by login whatever the mode says — an
allowlisted login is never the human path.

The desktop is the only place a person writes this field, through one comma-separated text box.
Update the two field descriptions in
`apps/desktop/src/renderer/src/components/workspace-setting-rows.tsx` so the suffix is discoverable.
The box needs no new control, and it cannot drop what it cannot hold.

Acceptance: `cursor[bot]:any` wakes on every comment shape in Step 2's list; `cursor[bot]` wakes only
on the top-level diff comment; a login that happens to contain a colon elsewhere is unaffected.

## Step 4 — tests

Extend `packages/engine/src/github/github.test.ts`. Cover every line of Step 2's and Step 3's
acceptance lists. Build the fixtures from the real shapes recorded above, markers included.

## Out of scope

- **The no-progress counter does not change.** A round that pushes nothing still counts, on purpose.
  Teaching it to forgive a round that "correctly found nothing" needs a judge, and the only judge
  available is the agent that just did nothing. Reopen this only if false wakes survive the fix.
- **Resolved and outdated threads are not read.** A finding you dismiss before the next reconcile
  still wakes a Follow-up. Reading thread state needs a GraphQL `reviewThreads` query that the engine
  does not make today, which is one more round trip per observed pull request per poll. The
  reconcile heartbeat is about a minute, so the window is small, and your own reply wakes the
  Follow-up as human feedback regardless.
- **No ADR.** The decision is surprising and it is a real trade-off, but it is not hard to reverse.
  The glossary entry carries the rule and the code comment in Step 2 carries the refusal.

## Size

The whole change is four files and well under one ticket's worth of work. It splits along Step 2 and
Step 3 if it must, in that order — the shape test stands alone, the suffix does not.
