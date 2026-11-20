# 0027 — Headless review is one bounded round of report-only reviewers

- **Status:** accepted
- **Date:** 2026-09-23
- **Amended:** 2026-09-29 — compose `/code-review` intact; drop the forked spec-reviewer
- **Amended:** 2026-11-02 — a repo's own guidance may add reviewers to the round

## Context

A run-event retrospective (2026-09-23) measured where implement Runs spend their wall time. In both
registered workspaces, ~97% of wall time is model latency between tool calls, so a Run's duration is
effectively its turn count. The review stage of the shipped `implement-agent` package — a
code-simplifier that edits the diff, then a fan-out of rule, security, complexity, and two-axis
code reviews, then "implement any findings" — consumed 45–90% of total wall time. The instructions
put no bound on the loop, so runs cycled fix → re-review → re-gate three and four times, with the
late rounds surfacing style nits and filename complaints at ~8–10 minutes per cycle. The simplifier
editing code *after* the local gate forced a full re-gate by construction.

Two research notes ground the redesign.
[`review-pipeline-design.md`](../research/review-pipeline-design.md): ponytail — the inspiration for
the simplifier — is actually an always-on *upfront* ruleset whose on-demand review pass is
diff-scoped and report-only; CriticGPT found model critics nitpick and hallucinate more than human
reviewers, with recall and spurious claims rising together; both vendors cap evaluator loops and
OpenAI's judge example instructs the judge "do not go for perfection"; intrinsic self-correction
degrades results while fresh-context external critics work; review precedent (Tricorder, Semgrep)
scopes analyzers to the diff but never skips a security pass on a risk heuristic.

## Decision

The shipped `implement-agent` and `follow-up-agent` packages restructure their review stage:

- **The minimalism ruleset moves upfront.** A detailed lean-code ruleset (ponytail-shaped) becomes
  part of the implement instructions, so simple code is generated rather than retrofitted.
- **Three reviews in parallel, all report-only.** **`/code-review`** — the skill-pack skill,
  invoked intact with the branch merge-base as fixed point, the work item (including the triage
  requirements digest) as spec source, and `~/.agents/rules/*` added to its standards sources —
  owns documented standards, the Fowler smell baseline, and spec fidelity. **minimalist** (the
  code-simplifier and complexity-skeptic merged, with an early exit for a diff that is already
  lean) owns over-engineering. **security-auditor** runs on every diff. No reviewer edits code.
  Bugbot leaves the fan-out — CI owns it. The standalone rule-reviewer and a forked spec-reviewer
  stay out of this fan-out: their work is `/code-review`'s two axes, and forking them would break
  single-source-of-truth with the skill pack.
- **One fix round, then stop.** Blocking findings are always fixed. Nits are fixed at the
  implementer's judgment. Every finding left unfixed gets a recorded disposition in the PR body —
  *won't-fix* with a concrete reason, or *escalated* — never a silent pass; `/code-review`'s
  numbered findings (`S1`, `SP1`, …) give the completion criterion something checkable to bind to.
  After the fix round the Run re-gates what the fixes touched and does **not** re-review.
- **A repo may add reviewers to the round** (amendment 2026-11-02). The round dispatches the three
  reviewers above plus each reviewer the repo's own guidance adds, in the same parallel batch, under
  the same bound. Their findings need the same dispositions. The three stay: a repo adds a concern
  and never removes one. What a repo reviews for is the repo's development process, not a Cogwork
  feature, so its brief lives in the repo and the stock package names no repo reviewer. The first
  case is cogwork's own bug-hunter (`AGENTS.md`, `docs/agents/bug-hunt.md`). Cogwork lost access to
  Bugbot, which this decision had given the bug review through CI, and the external Harnesses
  project no Subagent from the Run Plan, so a repo doc that `AGENTS.md` points at is the carrier
  that reaches every Harness
  ([research](../research/bugbot-alternatives-for-bug-review.md)).
- **The perfection guard sits on the reviewer.** A finding must cite the specific hunk and the
  specific rule, smell, or risk; judges are told not to go for perfection. The guard limits
  reviewer churn, not implementer diligence.
- **The full production build runs once.** Intermediate cycles run typecheck, targeted tests, and
  lint on touched files; the build runs after the fix round, before commit.

## Considered options

- **Status quo with a round cap only.** Leaves the edit-making simplifier forcing a re-gate and the
  five-way fan-out's overlapping findings; the cap alone recovers the least time.
- **Fork `/code-review` into rule-reviewer + spec-reviewer.** Tried in the first cut of this
  decision. Rejected on amendment: the fork duplicated the skill pack's briefs, orphaned the smell
  baseline, and made every upstream `/code-review` update a hand-carry. Composition — invoke the
  skill with its existing parameters — keeps the pack intact and still fits the three-way fan-out.
- **Consolidate to one or two reviewers.** Anthropic's production experience found a single judge
  with one rubric most consistent, but the retro shows the fan-out was never the measured cost, and
  focused single-rubric personas are what the operator credits for review fidelity. Rejected.
- **Move review out of the implement Run into a post-PR operation.** The reviewer at the PR has the
  least context pressure, and the follow-up loop already reacts to PR feedback. Deferred, not
  rejected: revisit if review still dominates wall time after bounding.

## Consequences

- The shipped packages are rewritten; the colony workspace's private-overlay forks (ADR
  [0019](./0019-per-workspace-operating-instructions-overrides.md)) are operator files and must be
  updated by hand to match.
- The code-simplifier and complexity-skeptic subagent definitions retire in favor of the merged
  minimalist reviewer. The rule-reviewer asset remains for interactive use; it is no longer part of
  the headless fan-out.
- Mechanical rule-checking rides `/code-review`'s standards axis on the Run's model rather than a
  dedicated `light`-tier role; the `light` tier's primary customer for headless work is the triage
  operation (ADR [0028](./0028-subagent-model-choice-is-a-named-level-not-a-pinned-model.md)).
- Expected effect against the measured baseline: the review tail compresses from three or four
  cycles to one, which the retro prices at roughly half of a typical implement Run.
