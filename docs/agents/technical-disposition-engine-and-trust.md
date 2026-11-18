# Technical disposition: The engine, placement, and trust

Part of [Technical disposition](./technical-disposition.md). Cite these heuristics by name.

## Models and the engine

**Models are for intelligence; the engine is for everything else.** Reach for a model when the work
needs synthesis, reasoning, or creativity — putting pieces of information together into something
new. Everything else is deterministic code, and the more of the system that is deterministic, the
better. An application that asks a model to interact with large parts of itself is expensive, slow
(the model spends its first minutes discovering tools and details), and unpredictable. The test:
**could two runs on the same input disagree, and would that disagreement be a bug?** Then it belongs
in code.

**The engine constrains the model.** Predictability and cost come from the constraint, not from the
model. A model that is not confined can return work wildly different from what was asked, so the
deterministic layer stays in charge of what happens next — it decides, checks, and disposes, whatever
the model returns.

**Build the environment, not the prompt.** What surrounds a model matters more to its success than
the model itself. Give it prepared context and deterministic checks up front rather than making it
discover them, since the minutes spent discovering are both the latency and the unreliability. A
check being deterministic is a reason to hand it to the model, not a reason to withhold it.
(engine ADR [0007](../../packages/engine/docs/adr/0007-context-assembler-layers-and-playbook-skill-provision.md)
is this rule implemented.)

**Utility calls skip the harness.** Direct model calls the app makes for itself — triage routing,
ranking, drafting, summaries — go through the owned provider layer and must not depend on an external
agent CLI being installed. This rule does not cover Operations; each Operation uses the Harness its
author chose.
(engine ADR [0006](../../packages/engine/docs/adr/0006-first-party-runtime-behind-the-harness-seam.md))

## What runs where

**The engine assembles; the runner renders.** The engine resolves what a run gets — context,
instructions, MCP skills, credentials — and each runner projects that into its own native channel.
A runner chooses presentation, never membership.
(engine ADRs [0005](../../packages/engine/docs/adr/0005-mcp-skills-engine-assembles-harness-runner-renders.md)
and [0006](../../packages/engine/docs/adr/0006-first-party-runtime-behind-the-harness-seam.md))

**Explicit over ambient.** Anything mandatory arrives because the engine supplied it. Ambient
discovery — a CLI finding a config file, a tool the host happens to have installed — may add optional
context and may never carry a requirement. The test: **would this still work on a clean machine the
engine had just provisioned?**
(engine ADRs [0007](../../packages/engine/docs/adr/0007-context-assembler-layers-and-playbook-skill-provision.md)
and [0010](../../packages/engine/docs/adr/0010-codex-cli-is-an-external-harness.md))

**Put the decision where the information is.** A choice made where the inputs are stale or partial is
a choice made wrong. Context grows inside the model loop, so only the loop can decide what to keep —
a transcript frozen at dispatch time cannot. When a decision keeps needing data from elsewhere, the
decision is in the wrong place, not the data.
(engine ADR [0006](../../packages/engine/docs/adr/0006-first-party-runtime-behind-the-harness-seam.md))

**Name the authority; derive the rest.** Exactly one system is authoritative for a given fact, and
everything else derives from it. A key derived from an immutable id beats a dual write that has to be
reconciled. It follows that anything derived is disposable: losing the Run ledger is safe because the
Control store stays authoritative for coordination, and new state is derivable until it demonstrably
cannot be.
(ADR [0036](../adr/0036-every-work-item-is-coordinated-in-the-control-store.md); engine ADR
[0004](../../packages/engine/docs/adr/0004-issue-tracker-and-source-control-provider-are-separate-ports.md))

## Trust and boundaries

**Secure the channel, not the payload.** The client is the user's own UI and needs rich detail to
render a good experience — full error messages, file paths, live agent output. Keep RPC payloads
rich and secure the channel instead: owner-only socket now, real auth and TLS when it goes remote.
The one thing withheld is a *raw, unexpected* exception — return a generic message, log the detail —
and that is robustness, not secrecy.
(ADR [0005](../adr/0005-trust-boundary-is-authentication-not-payload-redaction.md))

**Data over code.** Prefer declarative, schema-validated, syncable config to executable config. Data
cannot `rm -rf` you, and it syncs and edits in a GUI for free. Reserve executable code for an
explicit, opt-in plugin layer trusted by provenance. This sidesteps sandboxing entirely.
(ADR [0006](../adr/0006-workspace-config-trends-toward-declarative-data.md))

**Enforce at the mechanism, not by instructing the agent.** A guarantee holds because the transport,
the schema, or the policy makes the alternative impossible — not because a prompt asked for it or a
tool allowlist named it. Linear's read-only MCP endpoint enforces read-only at the transport; the
engine, not the agent, cuts the branch.
(engine ADRs [0005](../../packages/engine/docs/adr/0005-mcp-skills-engine-assembles-harness-runner-renders.md)
and [0010](../../packages/engine/docs/adr/0010-codex-cli-is-an-external-harness.md))

**A bundle names a secret; the engine holds it.** A Plugin declares which credential it needs and
never carries one, so the engine owns every credential and hands it in at dispatch. This is what
keeps a bundle publishable — a bundle that held a token would itself be a secret file — and it is
the only arrangement where an update that widens access is visible to compare and consent to before
it runs. Settled by reading what the shipped harnesses write to disk: every plugin bundle under
`~/.codex/plugins/`, `~/.cursor/plugins/`, and `~/.claude/plugins/` carries env-var *names*
(`${DD_API_KEY}`) and public OAuth client ids, never values, while the tokens sit in one file per
harness outside every bundle (`~/.codex/auth.json`, `~/.cursor/cli-config.json`). Three independent
implementations, no spec between them — a **convergence**.
(supersedes the open fork this section carried; the lifecycle detail lands with
[#125](https://github.com/taylorfsteele/cogwork/issues/125), update-time consent with
[#135](https://github.com/taylorfsteele/cogwork/issues/135))

**Approval names what it approves.** When you require a human to approve something, what makes the
approval real is that it names the specific thing it is approving — not that a human was sitting at
a keyboard. The reflex to resist is "require an interactive prompt", which is the wrong axis for a
product whose agents run unattended. A prompt nobody read approves nothing. A scripted approval that
echoes back the exact change is the real thing.
