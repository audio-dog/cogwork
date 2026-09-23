# 0027 — Headless review is one bounded round of report-only reviewers

- **Status:** accepted
- **Date:** 2026-09-23

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
- **Reviewers are focused, parallel, clean-context, and report-only.** Four roles: **rule-reviewer**
  (mechanical standards compliance), **minimalist** (the code-simplifier and complexity-skeptic
  merged, with an early exit for a diff that is already lean), **security-auditor** (diff-scoped,
  runs on every diff, never skipped), and **spec-reviewer** (does the diff implement the brief).
  No reviewer edits code; the two-axis code-review's standards axis folds into rule-reviewer.
  Bugbot leaves the fan-out — CI owns it.
- **One fix round, then stop.** Blocking findings are always fixed. Nits are fixed at the
  implementer's judgment. Every finding left unfixed gets a recorded disposition in the PR body —
  *won't-fix* with a concrete reason, or *escalated* — never a silent pass. After the fix round the
  Run re-gates what the fixes touched and does **not** re-review.
- **The perfection guard sits on the reviewer.** A finding must cite the specific hunk and the
  specific rule or risk; judges are told not to go for perfection. The guard limits reviewer churn,
  not implementer diligence.
- **The full production build runs once.** Intermediate cycles run typecheck, targeted tests, and
  lint on touched files; the build runs after the fix round, before commit.

## Considered options

- **Status quo with a round cap only.** Leaves the edit-making simplifier forcing a re-gate and the
  five-way fan-out's overlapping findings; the cap alone recovers the least time.
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
  minimalist reviewer.
- Expected effect against the measured baseline: the review tail compresses from three or four
  cycles to one, which the retro prices at roughly half of a typical implement Run.
