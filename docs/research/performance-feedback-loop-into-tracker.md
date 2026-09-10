# A performance feedback loop that files its own tickets

Date: 2026-09-01.

> **Two facts below were overtaken the same day this was written.** The engine *can* create issues:
> `createIssue` landed in `82129aff` and sits on the port at
> `packages/engine/src/issue-tracker.ts:132`. And open-issue observation *does* paginate:
> `collectIssuePages` walks pages until a short one
> (`packages/engine/src/github/client.ts:638`), landed in `fd2b9b2e`, so the "one unpaginated page
> of 100" figure cited at four points below no longer holds and auto-filed ticket noise is not the
> correctness bug this doc calls it. The guardrail reasoning — fingerprints, stateful detectors,
> tracker-derived dedup, bounded emission, re-file never reopen — is unaffected and carried into
> ADR [0021](../adr/0021-the-performance-sensor-files-its-own-tickets.md) and ADR
> [0022](../adr/0022-a-sensor-lives-where-its-signal-is-produced.md).

**Question.** When cogwork detects bad performance in itself, can it file a ticket on its own
board and let its own triage → implement → follow-up pipeline carry the fix? What does a
machine-filed ticket need for the pipeline to pick it up with no human, what guardrails does the
auto-filing loop need (dedup, fingerprints, rate limits, reopen-vs-refile), and what must a local
performance detector emit for the ticket to be actionable?

**Sources.** The cogwork engine and its Operating Instructions, read at this worktree's HEAD
(file:line cites below). The maintainer's prior art: the audiodog repo on this machine
(`~/sites/audiodog`), which shipped the same loop for CloudWatch alarms. External primary
sources: Sentry's official docs on event grouping, fingerprint rules, issue states, alerts, and
the GitHub integration; Electron's crashReporter API docs; Crashpad's overview design doc.

**TL;DR.** The pipeline's entry contract is small: an open GitHub issue in the bound repo with
the `needs-triage` label, no `cogwork:claimed` label, no assignee outside the allowlist, and no
open blockers. Everything else — verification, brief-writing, disposition — is what the triage
stage exists to do, so the detector should file thin evidence tickets and let triage do the
thinking. The engine cannot create issues today: the `IssueTracker` port has no create operation,
so a new port method (or the audiodog-style out-of-band filer) is the first build step. The
guardrails are all precedented: fingerprint the *regression*, not the occurrence (Sentry
fingerprints, Crashpad leaves dedup to the server); make the detector stateful so it fires on
transitions, not on every sample (CloudWatch alarm semantics in audiodog); enforce one open
ticket per fingerprint in the engine, never in a prompt; re-file with a cross-link instead of
reopening (audiodog: "flag, don't reopen"). The dispositional fit is strong — this is the
proactive layer's exact shape, gated on precision over recall.

---

## 1. The pipeline today: what a machine-filed ticket needs

### How work enters

The engine polls the bound repo's open issues — one page of 100, unpaginated
(`packages/engine/src/github/client.ts:589`) — and maps labels to triage roles 1:1
(`needs-triage`, `ready-for-agent`, `needs-info`, `ready-for-human`, `wontfix`;
`packages/engine/src/github/markers.ts:5-21`, `docs/agents/triage-labels.md:5-11`). Each open
issue becomes a `ListedItem` with roles, assignees, blockers, claim state, and priority
(`packages/engine/src/github/host.ts:124-135`). The default tracker poll cooldown is one minute
(`packages/engine/src/issue-tracker.ts:22`).

Classification picks the stage (`packages/engine/src/classify.ts:119-124`):

- `needs-triage` → **triage** stage → the `triage-agent` Operating Instructions
  (`packages/engine/src/playbook.ts:49-56`).
- `ready-for-agent` → **implement** stage → `implement-agent`
  (`packages/engine/src/playbook.ts:58-65`).
- A linked PR with failing checks / new human feedback → **follow-up**.

The drop and gate conditions (`packages/engine/src/classify.ts:144-159`):

- `wontfix` label, or the `cogwork:claimed` label without a readable claim → dropped.
- Assignee allowlist: when `issueTracker.assigneeAllowlist` is configured
  (`packages/contracts/src/workspace.ts:37`, threaded at
  `packages/engine/src/reconcile.ts:240`), an item is dropped unless one of its assignees is on
  the list (`packages/engine/src/classify.ts:136-137`). A machine filer must assign the item to
  an allowlisted account, or the workspace must run without an allowlist.
- `needs-info` / `ready-for-human` → surfaced to the human queue, never run.
- Open blockers gate the implement stage only (`packages/engine/src/classify.ts:152`) —
  `ready-for-agent` on a blocked ticket is fine; the engine sequences on the dependency itself.
- Three consecutive failures at a stage hand the item to a human
  (`maxAttemptsPerStage = 3`, `packages/engine/src/classify.ts:128,154`).

The scheduler then bounds everything: global and per-workspace concurrency plus a daily run
budget, all from the Control store (`packages/engine/src/scheduler.ts:43-55,112-118`).

### The minimum viable machine-filed ticket

An issue enters the autonomous pipeline with no human when it is:

1. **Open**, in the bound repo, within the first 100 open issues
   (`packages/engine/src/github/client.ts:589` — no pagination, so a flood literally hides work).
2. Labeled **`needs-triage`** (`packages/engine/src/classify.ts:123`).
3. **Not labeled** `cogwork:claimed`, `wontfix`, `needs-info`, or `ready-for-human`.
4. **Assigned** to an allowlisted account when an allowlist is configured; unassigned is fine
   otherwise (`packages/engine/src/classify.ts:136-137`).
5. **Priority**: comes from a selected organization single-select issue field. The GitHub issue
   listing includes its values, and the adapter matches the selected stable field ID; absent or
   unknown values become `medium`. This matches the organization-level `Priority` field
   colonylabs uses.

**Body shape: there is no machine-readable body contract.** Triage reads the body as a human
claim, verifies it against the codebase, and writes the Agent Brief itself
(`packages/engine/operating-instructions/triage-agent/INSTRUCTIONS.md:72,79-83`). The engine's
own coordination state lives in comments carrying `<!-- cogwork:… -->` markers, which GitHub
renders invisibly (`packages/engine/src/github/markers.ts:34-46`).

Two labeling strategies, and the safer one:

- **File at `needs-triage` (recommended).** The triage agent verifies the claim, checks for
  redundancy and prior rejection, resolves technical open questions from the disposition doc,
  and only promotes to `ready-for-agent` at high confidence
  (`triage-agent/INSTRUCTIONS.md:52,67-72,79`). A detector's job is evidence, not judgment —
  this matches "self-halt over gates" and costs one extra pipeline stage.
- **File straight at `ready-for-agent`.** Then the *detector* must write a complete Agent Brief:
  behavioral desired state, testable acceptance criteria, explicit out-of-scope, no file paths
  or line numbers (`packages/engine/operating-instructions/triage-agent/AGENT-BRIEF.md:9-37`).
  A deterministic detector cannot honestly rate "high confidence an AFK agent can build this
  unattended" for an arbitrary regression. Skip this until the loop has earned trust.

**The pipeline already anticipates machine-filed work.** The implement instructions distinguish
work-item origin and let it drive PR linking: `Closes #n` when merge should close the item,
`Refs #n` "when something downstream (e.g. a post-deploy verify step) is responsible for closing
it" (`packages/engine/operating-instructions/implement-agent/INSTRUCTIONS.md:40,122`). A
performance ticket closed only when the metric actually recovers is exactly the `Refs` case —
audiodog built that VERIFY step (§3).

An origin label (audiodog uses `origin:cloudwatch` / `origin:rum`;
`~/sites/audiodog/docs/agents/agent-dev-loop-spec.md:17,75`) is the cheap way to give triage,
dashboards, and dedup queries a handle on machine-filed tickets. Something like `origin:selfperf`
plus a marker line in the body carrying the fingerprint.

## 2. What the engine can already write, and the gap

**The `IssueTracker` port has no create operation.** Its full surface is observe, claim,
release, note, triaged, implemented, followedUp, attemptFailed, handOff, handBack, stalled,
reclassify (`packages/engine/src/issue-tracker.ts:123-150`). The GitHub client's writes are
`addLabel`, `removeLabel`, `createComment`, `editComment`
(`packages/engine/src/github/client.ts:641-658`), driven through the coordination host's
`addRole`/`addClaim`/comment operations (`packages/engine/src/github/host.ts:139-150`). Nothing
in the engine, the plugins, or the apps creates a GitHub issue today (repo-wide grep for
`createIssue`/`issues.create`/`gh issue create` finds only Linear's *label* creation,
`packages/engine/src/linear/client.ts:612`).

**The auth path is already there.** Every GitHub call goes through one `send`: when the
workspace binds a connection, the token comes from the `CredentialStore` (OAuth tokens with
refresh, stored per connection — `packages/engine/src/credential-store.ts:40-55`); otherwise it
falls back to the `GITHUB_TOKEN` env var
(`packages/engine/src/github/client.ts:429-458`, tokenEnv set at
`packages/engine/src/github/provider.ts:38`). Rate-limit handling (`retry-after`,
`x-ratelimit-reset`) is built into the client (`packages/engine/src/github/client.ts:300-307`),
and tracker errors feed an exponential cooldown capped at 15 minutes
(`packages/engine/src/cooldown.ts:18-20`).

So filing a ticket from the engine is: one new `createIssue(repo, title, body, labels)` on the
GitHub client, surfaced through a port. The alternative path — an agent session running `gh issue
create` per `docs/agents/issue-tracker.md:7` — is the convention for *skills* ("When a skill says
'publish to the issue tracker': create a GitHub issue,"
`docs/agents/issue-tracker.md:28-30`), not for the daemon; a deterministic detector should not
spend a model run to make one HTTP POST ("Models are for intelligence; the engine is for
everything else," `docs/agents/technical-disposition.md:181-187`).

## 3. Guardrails: dedup, fingerprints, rate limits, reopen vs re-file

### The Sentry model: fingerprint the class, not the occurrence

Sentry's grouping is the canonical precedent. "A fingerprint is a way to uniquely identify an
event, and all events have one. Events with the same fingerprint are grouped together into an
issue" ([Issue Grouping](https://docs.sentry.io/concepts/data-management/event-grouping/)).
Default grouping hashes normalized stack frames (app frames only, revision hashes stripped),
falling back to exception type+value, falling back to the *parameterized* message — variable
values are normalized out precisely so ten occurrences with different numbers make one issue,
not ten. Custom [fingerprint rules](https://docs.sentry.io/concepts/data-management/event-grouping/fingerprint-rules/)
override this: `matcher -> fingerprint` with variables like `{{ default }}` and
`{{ transaction }}`, e.g. `error.type:ConnectionError stack.function:'connect' -> bot-error`.

Sentry's [GitHub integration](https://docs.sentry.io/organization/integrations/source-code-mgmt/github/)
then maps **one Sentry issue to one GitHub issue** — manual "Link Issue," or an alert action
"Create a new GitHub issue." The dedup burden sits on the grouping layer plus the alert
conditions ("issue is new"), and issue alerts carry an explicit **action interval**: actions run
at most "once every X" per issue, X from 5 minutes to 30 days
([issue alert config](https://docs.sentry.io/product/alerts/create-alerts/issue-alert-config/),
[alert rule API](https://docs.sentry.io/api/alerts/create-an-issue-alert-rule-for-a-project/) —
`frequency`, 5–43200 minutes).

Reopen semantics: "A plain Resolve treats any later event as a regression," and "if the same
issue comes back in a newer release than the one you resolved it in, its status will
automatically change to Regressed"
([issue states](https://docs.sentry.io/product/issues/states-triage/)). Archived issues
resurface automatically as Escalating on a significant spike. Release-awareness is what makes
"reopen" sound there: recurrence *after the fix shipped* is a regression; recurrence before it
shipped is the same issue still happening.

### The crash-reporter model: throttle at the client, dedup at the server

Crashpad (Electron's crash backend) does **no client-side dedup** — every dump is its own report,
identified by a per-install client id, and "the strategy is very simplistic, it simply limits
uploads to one upload per hour, and failed uploads are aborted"
([Crashpad overview design](https://chromium.googlesource.com/crashpad/crashpad/+/master/doc/overview_design.md)).
Electron exposes the same knob: `rateLimit` — "If true, limit the number of crashes uploaded to
1/hour" ([Electron crashReporter](https://www.electronjs.org/docs/latest/api/crash-reporter)).
The lesson: the emitting client's only job is *bounded emission*; identity and grouping live
where the aggregate view is. In cogwork's single-tracker world both jobs land on the filer, so
it needs both mechanisms explicitly.

### The audiodog precedent: the maintainer already built this loop

audiodog pipes `CloudWatch Alarm State Change` events into GitHub issues with **no Lambda**:
EventBridge rule → API destination → `POST /repos/…/issues`, body templated to
`title: "[alarm] <alarmName> (<region)>"`, labels `["needs-triage", "origin:cloudwatch"]`,
DLQ for failed deliveries (`~/sites/audiodog/docs/agents/alarm-to-issue-pipe-spec.md:9-12,188-198`).
Its guardrails, all in one spec (`~/sites/audiodog/docs/agents/agent-dev-loop-spec.md`):

- **The detector is a state machine.** The rule filters `state.value = ALARM`, so an issue files
  on the *transition into* alarm, never per datapoint
  (`alarm-to-issue-pipe-spec.md:63`). CloudWatch's alarm hysteresis is the dedup's first line.
- **Signature = alarm identity** (name/ARN). Triage's dedup phase: "Exact match to an OPEN
  same-origin issue → auto-close the new one as duplicate + append a 'fired again' note to the
  canonical. Match to a recently closed issue → flag, **don't reopen**"
  (`agent-dev-loop-spec.md:145`).
- **Regression vs. not-yet-fixed** is decided by git ancestry against the deploy marker: fix not
  yet promoted → annotate and leave passive; fix already live → genuine regression, run a normal
  proposal (`agent-dev-loop-spec.md:145`).
- **Flood safety**: pipe rate-limited to 1 request/s, worker pool concurrency 2, soft daily
  session budget ~50 (`agent-dev-loop-spec.md:55`; `alarm-to-issue-pipe-spec.md:35`).
- **Machine-origin lifecycle**: PRs use `Refs #n`; a deterministic VERIFY job polls the alarm
  post-deploy and closes the issue only when the signal recovers
  (`agent-dev-loop-spec.md:159,219`). Issue↔alarm correlation is "free: parse `**ARN:**` from
  the pipe-generated body" (`agent-dev-loop-spec.md:219`).
- **Stage/origin labels are explicit** (`origin:*`, `stage:*`), and same-error-on-two-stages is
  two cross-linked issues, never one (`agent-dev-loop-spec.md:75,93`).

### Synthesis for cogwork

- **Fingerprint = the regression's identity, not its measurements.** A stable string from
  (metric or span name, subsystem, direction), values excluded — the Sentry normalization rule.
  Carry it in the issue body as a `<!-- cogwork:… -->` marker so it is machine-scannable and
  invisible to readers, reusing the existing marker codec
  (`packages/engine/src/github/markers.ts:42-62`).
- **Dedup state derives from the tracker itself.** Before filing, scan open (and recently
  closed) `origin:selfperf` issues for the fingerprint marker; open match → append a
  "fired again" comment with the fresh numbers instead of filing. This follows "Name the
  authority; derive the rest" (`docs/agents/technical-disposition.md:227-233`, ADR 0003) — no
  second dedup store to reconcile — and audiodog's canonical-issue pattern. One open ticket per
  fingerprint is enforced **by the filer's code**, per "Enforce at the mechanism, not by
  instructing the agent" (`docs/agents/technical-disposition.md:249-254`).
- **Make the detector stateful.** Alarm-style: a signal must cross the threshold for N
  consecutive windows to enter `alarm`, and file only on the transition. Recovery re-arms it.
  This is where most of the "one ticket per distinct regression" work happens; per-occurrence
  filing with post-hoc dedup is the shape to avoid.
- **Rate limits, both layers.** A hard cap on filings (audiodog: bounded by alarm count +
  1 req/s; Crashpad/Electron: 1 upload/hour; Sentry: per-issue action interval). The scheduler's
  daily run budget (`packages/engine/src/scheduler.ts:53,118`) already bounds what filed tickets
  can *cost*, but not tracker noise — and the 100-open-issue observation window
  (`packages/engine/src/github/client.ts:589`) makes tracker noise a correctness bug, not just
  clutter: enough machine tickets push real work out of the engine's sight.
- **Re-file, don't reopen.** The triage agent may never close (`triage-agent/INSTRUCTIONS.md:16`),
  and reopening a human-closed ticket is the same class of authority violation. Sentry can
  auto-regress because it owns its issue lifecycle end to end; cogwork's tracker is shared with
  humans. audiodog's "flag, don't reopen" is the right borrow — a convergence with Sentry's
  *release-aware* regression logic: recurrence with the fix commit an ancestor of HEAD → new
  issue titled as a regression, cross-linked to the closed one; recurrence with the fix not yet
  merged → comment on the open/closed original, file nothing.

## 4. What the detector must emit for an actionable ticket

### Thresholds vs baselines

Sentry's metric alerts name the three options: fixed thresholds ("when you have a clear idea of
what constitutes good or bad performance"), percent-change against a comparison window, and
anomaly detection against a learned baseline
([metric alert config](https://docs.sentry.io/product/alerts/create-alerts/metric-alert-config/)).
For a single-user local daemon, start with **fixed thresholds on a small enumerated set of
signals** — "Enumerate before you model"
(`docs/agents/technical-disposition.md:129-136`) — and let a baseline (e.g. trailing 7-day
median stored beside the Control store) replace a threshold only where a fixed number keeps
being wrong. The detector must be deterministic code: "could two runs on the same input
disagree, and would that disagreement be a bug?" (`docs/agents/technical-disposition.md:186`).

The raw signals largely exist: the engine already meters runs in flight, budget used,
budget-exhausted ticks, and job outcomes (`packages/engine/src/scheduler.ts:30-41`), and the CLI
wires Effect metrics/traces/logs to OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set
(`apps/cli/src/telemetry.ts:22-48`). What is missing is any *local consumer* of these metrics —
today they only leave the process.

### The ticket body

Triage verifies claims by reproducing them (`triage-agent/INSTRUCTIONS.md:72`); a performance
claim is only verifiable if the ticket pins down what was measured. Emit:

- **Fingerprint marker** (machine line, see §3) plus a human `Signal:` line naming metric,
  subsystem, and direction.
- **The numbers**: observed value, threshold or baseline it broke, window, unit, and how many
  consecutive windows fired. Sentry's parameterization lesson inverted: values leave the
  *fingerprint* but must be *in the body*.
- **Reproduction context**: runs in flight and budget used at detection time (the scheduler
  gauges), workspace count, app version / commit sha, machine load (CPU count, load average,
  free memory). audiodog's equivalent is the alarm ARN + state reason
  (`alarm-to-issue-pipe-spec.md:188-194`).
- **The offending snapshot on disk, by path.** Because "cogwork runs single-user and local.
  One machine" (`docs/agents/product.md:63-65`), the triage and implement agents run on the same
  machine that detected the regression — a CPU profile or span dump written under `~/.cogwork/`
  (e.g. `perf/<fingerprint>/<timestamp>.cpuprofile`) is directly readable by the agent, no
  upload store needed. The body carries the path; the file carries the weight. (This is the one
  part that breaks if the daemon ever goes remote — an accepted cost under "take the shape that
  survives the turn you can see coming," since the *ticket contract* survives even when the
  attachment mechanism must change.)
- **What it should NOT contain**: a diagnosis, file paths into the source, or a prescribed fix —
  brief durability rules (`AGENT-BRIEF.md:9-17`), and diagnosis is triage's job.

Acceptance criterion for the eventual brief writes itself from the same data: "the signal
returns under X over window W." That is also the close condition — which is why machine perf
tickets should be linked `Refs #n`, with closure owned by the detector observing recovery
(audiodog's VERIFY, `agent-dev-loop-spec.md:219`; the `Refs` seam already in
`implement-agent/INSTRUCTIONS.md:122`).

## 5. Dispositional constraints that shape the feature

- **This *is* the proactive layer's shape.** "The general loop is sense → classify → schedule →
  act → record" and nothing may assume sense means polling a tracker
  (`docs/agents/product.md:28-30`); the north star is minting a ticket from real-world context
  and carrying it to a PR unattended (`docs/agents/product.md:32-34`). A performance sensor is
  the cheapest first non-tracker sensor. The gate that comes with it: "gated on precision rather
  than recall: a wrong ticket costs more trust than a missed one"
  (`docs/agents/product.md:89-91`). Bias every threshold toward silence.
- **Deterministic detector, model-free filing.** "Models are for intelligence; the engine is for
  everything else" and "utility calls skip the harness"
  (`docs/agents/technical-disposition.md:181-187,201-204`). The model enters at triage, where
  synthesis is actually needed.
- **Enforce at the mechanism.** Dedup, rate caps, and the one-ticket-per-fingerprint invariant
  are filer code, not prompt instructions (`docs/agents/technical-disposition.md:249-254`).
- **Bound the resource, not the axis** (`docs/agents/technical-disposition.md:297-300`): cap
  filings per day and open machine tickets per fingerprint; do not cap how many *signals* the
  detector may watch.
- **Autonomous with override.** The loop's posture is inform-and-offer-override, and quality
  problems are solved by better self-halt judgment, not new human gates
  (`docs/agents/technical-disposition.md:287-293`, ADR 0007). Filing at `needs-triage` keeps the
  existing confidence gate as the only gate.
- **Tracker stays authoritative.** Dedup state read from the tracker, not a parallel store
  (`docs/agents/technical-disposition.md:227-233`, ADR 0003).
- **The open cost/latency-vs-correctness fork** (`docs/agents/technical-disposition.md:324-328`)
  cuts at this feature twice: an unattended pipeline where nobody is waiting weakens the urgency
  of latency regressions (priority default `medium` is probably right), and the detector's own
  overhead must not become the regression it reports.
- **No speculative machinery.** First slice: a handful of engine-side signals with fixed
  thresholds, one filer, one origin label. Baselines, renderer/desktop signals, and profile
  attachment schemes wait for the first ticket the thin version files badly.

## Bottom line

The pipeline's pickup contract is already machine-friendly — label `needs-triage`, stay under the
claim/allowlist/blocker gates, and triage does the rest — and the implement stage already has the
`Refs`-linked, downstream-closed lifecycle machine tickets want. The two things that do not exist
are the `createIssue` write on the GitHub port and the detector itself. Every guardrail question
has a settled precedent: Sentry for fingerprints and per-issue action intervals, Crashpad for
client-side throttling, and audiodog — the maintainer's own prior build — for the full loop
including stateful detection, tracker-derived dedup, "fired again" comments, flag-don't-reopen,
and recovery-gated closure.
