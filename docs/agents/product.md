# Product

What cogwork is, who it is for, where it is, and where it is going.

Read this when a question needs an answer the code cannot give you — during `/triage`, or when
answering in the maintainer's place. `docs/agents/technical-disposition.md` is its sibling and
its complement: **this doc says what the product is; that one says how the maintainer decides.**
Neither restates the other.

## What earns a line here

- **The roadmap-turn test.** If the next three tickets all landed, would this sentence need
  editing? If yes it belongs on a map or a ticket, not here.
- **The cache test.** Could an agent find this by reading the code, a `CONTEXT.md`, or the issue
  tracker? Then it does not live here. This document caches only what the environment cannot
  tell you: why the thing exists, what it refuses to be, and who it is for.
- **Slice-level status lives on the tracker.** For "is X built yet", read the issue tracker or
  the code. This document will not tell you, and if it appears to, do not believe it.

## What cogwork is

**cogwork is a productivity assistant for a software engineer. Coding orchestration is its
first capability, not its definition.** The `triage → implement → follow-up → PR` pipeline is
one workflow keyed by a work-item type, not the product itself. A Slack reply or meeting prep
is a peer workflow over the same runtime, never another stage bolted onto the pipeline.
([#168](https://github.com/taylorfsteele/cogwork/issues/168))

**The general loop is sense → classify → schedule → act → record.** Issue-tracker-plus-coding-
harness is its first instance. Nothing may assume that *sense* means polling a tracker or that
*act* means running a harness — those are today's implementations of two general steps.

**The north star is a meeting to a pull request with no human in the middle.** A meeting
mentions a bug; cogwork mints the ticket, triages it, implements it, and opens the PR. It is a
capstone that proves the loop closed end to end, not an exit criterion.

## Who it is for

**cogwork is for software engineers.** That is the audience it is built for, and its vocabulary,
surfaces, and defaults may assume it. The maintainer is the first of them and the only one today,
using it daily and dogfooding it — cogwork builds cogwork — so their experience is the entire
feedback loop. They are an instance of the audience, not the definition of it.

**The ambition reaches past coders to casual non-coders.** As the proactive layer lands, the
person being helped is less and less someone who reads a stack trace, and provider login UX and
plain vocabulary get more valuable over time. It is an ambition rather than a current audience:
do not trade an engineer's experience today against a non-coder who does not exist yet, and do
not introduce vocabulary that will have to be unlearned.

**Leave room for the user who is not here yet; build for the one who is.** Architecting or
scaffolding against negative space that a future feature could fill costs little and often
improves the shape of the thing you are building today — the [seams held open](#seams-held-open)
below are that discipline written down. What waits is the feature itself, until someone needs it.

## Where we are

The epoch, not the changelog. Each claim licenses a default answer to a whole class of
questions. For anything finer-grained than this, read the tracker.

**Nothing is publicly released.** A breaking change costs a migration of zero installs. Renaming
a contract, reshaping a schema, or deleting a command is free — do not design around
compatibility that is owed to nobody.

**cogwork runs single-user and local.** One machine, one person's credentials, no tenancy and no
auth system to uphold. The contracts are nonetheless shaped to survive going remote, which is a
design constraint rather than a feature being built.

**The premise is still being proved.** The bet — that an agent pipeline can carry well-defined
work to a merged PR unattended — is not yet settled by evidence. Investment goes to the
pipeline's judgment quality before it goes to surface area.

**The written corpus is young and compounding.** Direction, principles, and ADRs are still being
laid down. A question with no written answer is more likely a gap than a fork; that is what the
disposition's line is for.

## Where it is going

Three capabilities. They are deliberately unnumbered — the *order* they arrive in is the
tracker's business, and phase numbers are the part that goes stale.

**Mission control** — a desktop control tower over the AFK agents. Ambient confidence that
everything is moving, live runs watchable as they happen, and the ability to act in place on the
few decisions the pipeline cannot self-resolve. It informs and offers override; it does not gate.

**The owned runtime** — cogwork owns the model loop rather than renting it. A first-party runner
registered *behind* the existing harness seam, beside the external CLI harnesses rather than
replacing them, with bring-your-own-provider credentials. Harnesses exist to run coding sessions;
everything else runs on the owned layer.

**The proactive layer** — real-world context becomes proposed work. Meetings first, then the rest.
The job is to turn what was said into a work item the existing pipeline can carry, gated on
precision rather than recall: a wrong ticket costs more trust than a missed one.

## Not now

Each of these is a positive claim about the present. The boundary falls out of it.

**Hosting is a someday, not a now.** Every contract is shaped to survive the daemon going remote
and multi-user; the hosting itself has no owner and no date.

**Interactive sessions follow the runtime.** Chat, steer/queue, and mid-run approvals are in the
product's future, and session contracts are shaped for them from the start. The surface and the
machinery come after mission control and the owned runtime are real.

**Pull request review stays on GitHub.** The shipped coding template ends with a person reviewing and
merging there, as does the process used to build Cogwork. Workflow authors choose their human gates;
Cogwork does not enforce one. Branch protection supplies a hard mechanism when wanted. The PR read
model is shaped richly enough to host an in-app panel the day that changes.

**Workspace config is heading for declarative, schema-validated data.** It is executable
TypeScript today. That is a migration with a destination, not the destination.
(ADR [0006](../adr/0006-workspace-config-trends-toward-declarative-data.md))

**Selling a first-party AI provider is a far-future product.** Provider credentials are the
user's own, brought to cogwork.

## Seams held open

Named so future work knows the reopen cost. None of this is in scope to build.

**The issue tracker plays three roles at once** — sensor, work-item identity, and coordination
store (ADR [0003](../adr/0003-work-source-as-coordination-substrate.md)). Non-coding work has no
tracker, so the roles separate eventually.

**"Act" generalises to an actuator.** The coding harness is one actuator and the owned provider
layer is another. Nothing may assume that acting means running a harness.

**The coordination store becomes ours when a work item has no tracker.** The full store waits for the
first non-coding workflow.

**A knowledge layer — what cogwork knows about you — is deferred.** Meeting ingestion is its seed.

## The product reference

**Feldspar** (`~/sites/feldspar`) is the product model for the proactive layer — prepared next
steps over briefings, precision over recall, human-approved plans. Take its product lessons, not
its code. Reference *implementations* for technical questions are a different list and live in
the technical disposition.

## Where the reasoning lives

A claim here gists a decision; the decision itself lives in exactly one place.

- `docs/adr/` — system-wide decisions, and the per-package `<context>/docs/adr/` beside them.
- [`docs/spec/next-phase.md`](../spec/next-phase.md) — a superseded snapshot of closed wayfinder
  map [#159](https://github.com/taylorfsteele/cogwork/issues/159). Its **Decision log** table is the
  index from an area to the ticket that holds its full reasoning.
- The issue tracker — every live map and its decision tickets. See
  [`docs/agents/issue-tracker.md`](./issue-tracker.md).
