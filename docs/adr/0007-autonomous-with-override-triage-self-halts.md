# 0007 — Autonomous-with-override: triage self-halts, no approval gate

- **Status:** accepted
- **Date:** 2026-08-05

> **Amendment (2026-10-27).** [Customizable Workflows §17](../spec/customizable-workflows-documents-and-adrs-the-build-changes.md#17-documents-and-adrs-the-build-changes)
> makes human gates the Workflow author's choice. The statement that a person reviews and merges
> describes the shipped coding template and how Cogwork is built, not an approval guard in Cogwork.
> GitHub branch protection can enforce that gate when a hard mechanism is wanted.

## Context

The mission-control v1 spec ([#160](https://github.com/taylorfsteele/cogwork/issues/160),
under wayfinder map [#159](https://github.com/taylorfsteele/cogwork/issues/159)) had to
settle how much the human sits in the loop. One candidate surface was "triage approve/veto" — a
queue where triage *proposes* a classification and waits for the maintainer to approve before the
work proceeds.

That would have *introduced* a gate that does not exist today. Triage is already autonomous: the
triage agent decides a role (`ready-for-agent` / `needs-info` / `ready-for-human` / `wontfix`),
applies it itself, and the pipeline runs end-to-end to an open pull request with no human in the
loop. The only hard human gate is PR review + merge, which lives on GitHub and which the follow-up
agent is explicitly forbidden to touch.

The tension is real and identity-defining. A gated model is safer per-item but turns the daily
driver into a babysitting queue and contradicts the whole "it runs itself" pitch. An ungated model
is only as good as the agent's judgment about when *not* to proceed.

## Decision

The pipeline is **autonomous-with-override**. No blocking approval gate is introduced.

- Agents run end-to-end unattended. The one hard human gate is **PR review + merge**.
- Triage exercises **judgment about its own confidence**: it drives well-defined, well-supported,
  fits-the-model work straight to a PR, and it **self-halts** — parking the item as `needs-info` or
  `ready-for-human` with its reasoning — when requirements are genuinely unclear, the change
  conflicts with how the code works, or the task is too big for one session. Self-halt is not a new
  mechanism; it is triage emitting a needs-human role instead of `ready-for-agent`.
- Human involvement is **override, not approval**: reclassify an item, answer a self-halt, cancel a
  run — plus the PR gate. A surface's default posture is to *inform and offer override*, never to
  block the agent behind a human's click.
- Mission control's job is to make the self-halt **legible and actionable** (show the agent's
  question inline, let you answer or override in place) — not to gate the agent.

## Consequences

- Mission control is a **supervisory control tower, not an approval queue**. Its attention rail is
  the set of things the pipeline genuinely cannot self-resolve: needs-human items, PRs waiting on
  review, and escalated failures.
- The quality of the autonomy rests on **triage's self-halt judgment**. That makes the triage
  skill's discretion a product-critical surface — invest there rather than in building gates.
- A per-workspace or per-task **opt-in** gate remains compatible with this decision and can arrive
  later without contradicting it; it is explicitly not built now.
- Swapping to a gated-by-default model later would reshape the whole mission-control surface, so
  this is recorded rather than left implicit. As the audience trends toward casual non-coders, a
  lightweight confirmation step may re-enter for *them* — this decision is about the maintainer-
  dogfooding phase and the product's default posture.
