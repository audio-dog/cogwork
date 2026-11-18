# 0019 — A Workspace may replace an Operating Instructions package from its private overlay tree

- **Status:** accepted
- **Date:** 2026-09-01

## Context

The `implement-agent` and `follow-up-agent` Operating Instructions carry a hard local gate: full
typecheck, build, test suite, and lint before a PR opens or a push lands. The gate is right for
cogwork. It is wrong for the colony Workspace, where the full suite is slow and depends on local
docker containers — CI runs the suite with the proper setup, and the local gate as written asks the
agent for a bar the machine cannot meet.

No existing mechanism can honestly fix this per Workspace. Position in the concatenation is the only
instruction precedence there is, and Operating Instructions sit last and highest — so a repo
`AGENTS.md` or a Rules file that relaxes the gate merely contradicts text that outranks it.
ADR [0018](./0018-contribution-files-live-in-three-authoring-trees.md) dispositioned the Engine
Operating Instructions "kept as is — Engine Authority, shipped with the binary, not a contribution
and not in any tree," which was true and is the row this decision amends.

Two prior positions bound the shape. ADR
[0013](./0013-two-settings-families-with-different-scope-sets.md) rejected a per-repository override
ladder because a cloned repository must not select behavior on a machine belonging to someone who
merely cloned it — that reasoning stands untouched here, because the override below is
operator-authored machine config, not repository content. And the *policy profile* per-workspace
override stays deferred to settings-as-data (`docs/spec/next-phase.md`); that is a different noun,
and this decision does not reach it.

A narrower fix was on the table: a `testPolicy` field on the workspace record, shaped like
`linearHistory`, consumed by a parameterized gate paragraph in the shared text. The maintainer chose
the general capability instead — the feature is worth building only if a Workspace can customize its
instructions fully, not gate-by-gate.

## Decision

### Resolution is by presence in the private overlay tree

When the Context assembler resolves the Operating Instructions for operation `<name>` in a
Workspace, it looks first at

```
~/.cogwork/workspaces/<WorkspaceId>/operating-instructions/<name>/
```

If that directory exists, it is the Operating-instructions package for the Run: copied whole to the
Run's host-side resource path, resources recorded, `INSTRUCTIONS.md` supplied as the last and
highest instruction layer — exactly the engine-package flow with a different source. If it does not
exist, the engine package is used, unchanged, which keeps every unregistered-override Workspace on
today's behavior with no migration.

The tree is ADR 0018's private workspace overlay: operator-authored, uncommitted, keyed by the
minted `WorkspaceId`, and already deleted by the deregister cascade — so an override dies with its
Workspace. No new field lands on the workspace record. Presence is the whole state, the same test
ADR 0018 applied to the non-executing contribution kinds: a directory that exists says everything a
setting could say.

### Replace whole, or not at all

An override replaces the entire package — `INSTRUCTIONS.md` and every supporting resource. There is
no amend or append mode, no merging of an override file over engine text. A person who writes custom
Operating Instructions owns the whole document.

### Present-but-broken fails the Run

An override directory that exists but has no readable, non-empty `INSTRUCTIONS.md` is a context
assembly failure that names the path — never a silent fall back to the engine package. A silent
fallback would run the stock gate while the operator believes the override is live, which is the
exact confusion the override exists to remove. The assembler looks up the one directory the
operation names and walks nothing else; a misnamed directory is ordinary lack of effect, owned by
the operator like the rest of the fork.

### The fork is the operator's

An override receives no engine improvements: when the shipped package changes, the fork keeps its
old text. It can also drop the authority-boundary prose — never merge, never switch branches,
escalation rules. Both are accepted as operator responsibility, stated in documentation rather than
enforced by machinery. The engine's own guards are unaffected by any text: the branch-name guard,
the engine-posted coordination marker, and the sandbox hard-deny floor hold for every Run regardless
of what the instructions say. The documented practice is to start every fork as a copy of the
shipped package and edit from there.

### Still not a contribution

An override is not a contribution: no Customize row, no on / off, no Authority, no place in the
scan. It is the same engine-resolved, mandatory, last-and-highest instruction content, with an
operator-supplied source. The glossary's boundary — Rules are advisory, Operating Instructions are
mandatory — is unchanged.

## Considered Options

- **A `testPolicy` knob on the workspace record**, shaped like `linearHistory`, consumed by a
  parameterized gate paragraph in the shared text. Rejected by the maintainer: it fixes only the
  gate, and every future per-Workspace divergence mints another knob in the shared document.
- **An explicit workspace-record field naming the override path.** Rejected: a contract change, a
  control-store schema change, and a deregister / re-register ceremony to point at a directory whose
  presence already says everything. ADR 0018 removed settings that carried no information the file's
  location did not; adding one here would reverse that.
- **An amend / append mode beside replace.** Rejected: two resolution paths and a precedence story
  between them, to serve a one-paragraph tweak nobody has asked for.
- **Drift detection** — record which shipped version a fork copied, warn when the shipped text
  moves. Rejected: machinery without a live case. One forked Workspace exists; revisit if drift
  actually bites a second one.
- **A repository-committed override.** Rejected on ADR 0013's grounds: tickets, PRs, and outside
  contributors reach repository content, and the gate is a trust control that must stay with the
  person who runs the daemon.

## Consequences

- ADR 0018 gains an amendment narrowing its Operating Instructions disposition row: Engine Authority
  and shipped-with-the-binary remain the default, and the private overlay tree may now carry a
  replacement.
- Engine ADR 0007's assembler flow gains a source-resolution step, and the assembler must learn
  which Workspace a Run belongs to — today it receives no Workspace identity.
- The **Operating-instructions package** glossary entries in `packages/contracts/GLOSSARY.md` and
  `packages/engine/GLOSSARY.md` are updated with the override source and its failure rule.
- The colony Workspace gets forked `implement-agent` and `follow-up-agent` packages: copies of the
  shipped text with only the gate section changed — typecheck, build, and lint stay hard; the test
  step becomes targeted tests chosen by the agent's judgment; the baseline-failure proof applies to
  whatever was run; CI's full suite remains the merge bar. Triage has no gate and is not forked.
  These are operator files on the operator's machine, never repository content of colony or cogwork.
- The policy profile deferral in `docs/spec/next-phase.md` is untouched.
