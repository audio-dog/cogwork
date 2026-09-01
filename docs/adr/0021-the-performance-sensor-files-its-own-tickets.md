# 0021 — The performance sensor files its own tickets

- **Status:** accepted
- **Date:** 2026-09-01

## Context

The product's general loop is sense → classify → schedule → act → record, and nothing may assume
*sense* means polling a tracker (`docs/agents/product.md:28-30`). The issue tracker has been the
only sensor so far. Meanwhile the app has a performance problem it can now measure about itself
(ADR [0020](./0020-telemetry-is-local-first-in-its-own-store.md)), and the maintainer already
built the target shape once: audiodog pipes CloudWatch alarms into GitHub issues labeled
`needs-triage`, which its agent loop then carries to a PR (the maintainer's audiodog project,
`docs/agents/alarm-to-issue-pipe-spec.md` there — a path outside this repository, accepted). The research on the pipeline's entry
contract, dedup precedents (Sentry grouping, Crashpad throttling), and dispositional fit is in
`docs/research/performance-feedback-loop-into-tracker.md`.

Two facts shape the mechanism. The pipeline's pickup contract is already machine-friendly: an open
issue with `needs-triage`, no claim, no disallowed assignee, no open blockers — triage verifies the
claim and writes the Agent Brief itself. And the engine cannot create issues today: the issue
tracker port's writes stop at labels and comments.

## Decision

**cogwork gets a performance sensor: deterministic engine code that watches the telemetry store
and files a ticket when the app's own health degrades.** It is the first non-tracker sensor, and
it is engine code, not a model — "models are for intelligence; the engine is for everything else"
(`docs/agents/technical-disposition.md`). The model enters at triage, where synthesis is needed.

**The sensor watches an enumerated signal set with fixed thresholds, and fires on transitions.**
First slice: the daemon's event-loop delay and the daemon's heap used against its limit, with the
renderer's equivalents joining once its gauges report. A signal must breach its threshold for N
consecutive windows to enter alarm; the ticket files on the *transition into* alarm, never per
sample; recovery re-arms it. Thresholds are set from the measured baselines of the measurement
campaign — the sensor is built last in the milestone, after real numbers exist, because a guessing
sensor files wrong tickets and "a wrong ticket costs more trust than a missed one"
(`docs/agents/product.md:89-91`). Bias every threshold toward silence.

**It files thin evidence tickets at `needs-triage`.** The body carries: a human `Signal:` line
(metric, subsystem, direction); the numbers (observed value, threshold, window, consecutive
breaches); reproduction context (runs in flight, workspace count, app version, machine load); and
the path to the offending snapshot under `~/.cogwork/` — the triage agent runs on the same machine,
so the file carries the weight and the body carries the path. It carries no diagnosis, no source
paths, no prescribed fix: diagnosis is triage's job. Labels: `needs-triage` plus `origin:selfperf`.

**Identity is a fingerprint, and dedup derives from the tracker.** The fingerprint is a stable
string over (signal, subsystem, direction) — measurements excluded, the Sentry normalization rule —
carried in the body as a `<!-- cogwork:… -->` marker through the existing marker codec. Before
filing, the sensor scans open `origin:selfperf` issues for the fingerprint: an open match gets a
"fired again" comment with fresh numbers instead of a new issue. One open ticket per fingerprint is
enforced by the filer's code, never by a prompt, and the dedup state has no second store — the
tracker is the authority it is derived from (ADR
[0003](./0003-work-source-as-coordination-substrate.md)).

**Re-file, don't reopen.** The sensor never reopens a closed issue — the tracker is shared with
humans, and reopening a human's close is an authority violation. Recurrence after the fix merged
files a new issue titled as a regression and cross-linked to the closed one; recurrence before the
fix merged comments on the original and files nothing.

**Bounded emission.** A hard cap on filings per day (Crashpad throttles a client to one upload an
hour for the same reason), and the cap bounds the resource — tickets filed — never the number of
signals the sensor may watch.

**The engine gains `createIssue` on the issue tracker port.** One new write beside the existing
label and comment operations, GitHub first, riding the same credential path every other tracker
write uses. A deterministic detector does not spend a model run to make one HTTP POST.

**Closure stays human.** Each ticket's close condition is written in its body ("signal back under
X over window W"), PRs link `Refs #n`, and a person closes with the evidence in front of them. A
deterministic VERIFY step that closes on observed recovery is the natural follow-up once the
sensor has filed real tickets well — deliberately out of scope now, while there is one user to
verify against.

## Considered Options

**Filing straight at `ready-for-agent`.** Then the sensor must write a complete Agent Brief, and a
deterministic detector cannot honestly rate "high confidence an unattended agent can build this"
for an arbitrary regression. Filing at `needs-triage` keeps the existing confidence gate as the
only gate and matches audiodog exactly.

**An out-of-band filer (audiodog's shape: an external pipe posting to the API).** audiodog had no
resident process to own the loop; cogwork's daemon is already resident on the machine where the
signals live. A second process would duplicate auth, config, and scheduling the daemon already has.

**Per-occurrence filing with post-hoc dedup.** The shape every precedent avoids: Sentry groups
before it acts, CloudWatch's alarm hysteresis fires on state change. Stateful transition-firing
does most of the dedup work before a ticket exists.

**Reopening on recurrence.** Sentry can auto-regress because it owns its issue lifecycle end to
end; cogwork's tracker is shared. audiodog's "flag, don't reopen" is the right borrow.

## Consequences

- The proactive layer's first non-tracker sensor exists, and the loop it exercises — engine files,
  triage verifies, implement fixes, a human closes on recovery — is the same loop every later
  sensor (meetings, errors) will ride.
- The issue tracker port grows one write. The engine can now put work on its own board, which
  makes the observation window a correctness concern: the reconcile poll reads one unpaginated
  page of 100 open issues, so machine-filed noise can push real work out of the engine's sight.
  The cap and dedup exist to keep machine tickets rare; the window itself needs widening
  independently.
- `origin:selfperf` joins the label vocabulary; dashboards and dedup queries key on it.
- Machine-filed tickets sit at `medium` priority: the priority field lives on org-level issue
  fields the engine's GraphQL query cannot see. Accepted — nobody is waiting on an unattended
  pipeline (`docs/agents/technical-disposition.md`, the cost/latency-vs-correctness fork).
