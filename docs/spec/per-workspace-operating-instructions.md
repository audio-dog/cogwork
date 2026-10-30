# Per-workspace Operating Instructions overrides — spec

Executes [ADR 0019](../adr/0019-per-workspace-operating-instructions-overrides.md). The ADR is the
*what and why*; this spec is the *how* and the ticket source. Where they disagree, the ADR wins.
The ADR's amendments to [ADR 0018](../adr/0018-contribution-files-live-in-three-authoring-trees.md)
and engine ADR 0007 carry the same authority.

Before writing code: invoke `/effect-ts` and read `docs/agent-patterns/effect-control-flow.md` and
`docs/agent-patterns/effect-test-layers.md`.

## Problem statement

The implement and follow-up Operating Instructions carry a hard local gate: full typecheck, build,
test suite, and lint before a PR opens or a push lands. Every Workspace gets the same instruction
text, because the engine ships one package per operation and resolves nothing per Workspace. For the
colony Workspace the gate does not fit — its test suite is slow and depends on local docker — and no
honest relaxation channel exists: repo `AGENTS.md` and Rules rank below the Operating Instructions,
so their text cannot outrank the gate.

## Solution

An operator may replace an Operating Instructions package per Workspace. The Context assembler
resolves the package source by presence: when
`~/.cogwork/workspaces/<WorkspaceId>/operating-instructions/<name>/` exists, that directory is the
package for `<name>` Runs in that Workspace; when it does not exist, the engine package applies,
unchanged. The override replaces the package whole, and an override that is present but has no
readable, non-empty `INSTRUCTIONS.md` fails the Run loudly instead of falling back.

## User stories

1. As an operator, I want to replace a Workspace's `implement-agent` instructions with my own text,
   so that colony Runs use a local gate its machine can actually meet.
2. As an operator, I want a Workspace with no override to behave exactly as today, so that landing
   the mechanism changes nothing for cogwork.
3. As an operator, I want the override picked up by directory presence alone, so that I never edit
   the workspace record, touch the Control store, or re-register the Workspace.
4. As an operator, I want a Run to fail loudly and name the path when my override directory exists
   but its `INSTRUCTIONS.md` is missing or empty, so that I never believe an override is live while
   the stock gate runs.
5. As an operator, I want the override to carry supporting resource files alongside
   `INSTRUCTIONS.md`, the same contract the engine package has, so that a forked package loses no
   capability.
6. As an operator, I want deregistering a Workspace to delete its override with the rest of its
   private overlay directory, so that no orphaned instruction text survives the Workspace.
7. As an implement or follow-up Operation, I want my Run Plan's instruction layers and provisioned
   resource path built from the override source when one exists, so that the text I follow is the
   operator's, last and highest in the ladder as always.
8. As a reviewer of a Run, I want the Run Plan's provenance to record which source supplied the
   Operating Instructions, so that I can tell an overridden Run from a stock one.
9. As a maintainer, I want the override to stay off the contribution surfaces — no Customize row,
   no on / off, no Authority — so that the contribution model stays exactly as ADR 0018 defines it.

## Implementation decisions

Settled by ADR 0019 and the grilling that produced it; restated here so a ticket needs no other
source.

- **Resolution is by presence, in the Context assembler.** The assembler checks the private overlay
  path first and the engine package directory second. Everything downstream of source selection —
  copy to the Run's host-side resource path, resource recording, entry point supplied as the
  highest-precedence instruction layer — is unchanged.
- **The assemble request gains the Workspace identity.** The assembler cannot form the overlay path
  without knowing which Workspace the Run belongs to; today its request carries none. The executor
  already holds the registered Workspace at every point it prepares a Run, and the workspace record's
  `name` is the minted `WorkspaceId` — thread it through as a plain request member.
- **No new configuration.** The assembler's existing home-directory config member already points at
  the cogwork home, and the private overlay root under it (`workspaces/`) is the same root the
  registry's deregister cascade already deletes. No workspace-record field, no Control store schema
  change, no CLI or desktop change.
- **Replace whole, or not at all.** No amend or append mode, no merging engine text with operator
  text. A directory that exists is the entire package.
- **Present-but-broken fails the Run.** A missing or empty (after trimming) `INSTRUCTIONS.md` inside
  an existing override directory is a context-assembly failure naming the path — the same error
  channel a broken engine package already uses. Never a silent fall back.
- **No scan of the overlay directory.** The assembler looks up the one directory the operation
  names and walks nothing else. A misnamed directory is ordinary lack of effect, owned by the
  operator like the rest of the fork.
- **The safe-path-segment guard applies to both sides.** The operation name already passes a
  single-segment check before it becomes a path; the override path is formed from the same checked
  segment plus the minted `WorkspaceId`, so no new traversal surface opens.
- **Provenance names the source.** The instruction layer and resource records already carry their
  source paths; an overridden Run therefore shows the overlay path where a stock Run shows the
  engine package path. No new provenance field.

## Testing decisions

- Tests assert external behavior at the existing assemble seam: the layers, resources, provisioned
  path, and error of the assembled context — never the assembler's internals.
- Prior art: the existing Context assembler tests, which drive the seam through the in-memory
  filesystem fake. New cases follow the same shape.
- Cases: override present (layers and resources come from the overlay source; the provisioned copy
  is made from it); override absent (byte-identical to today — the existing tests keep passing
  untouched); override directory present with missing `INSTRUCTIONS.md` (typed assembler error
  naming the path); override directory present with whitespace-only `INSTRUCTIONS.md` (same error).
- The executor's threading of the Workspace identity is a pass-through; extend an existing executor
  assembly test to assert the identity reaches the request rather than building a new fixture.

## Out of scope

- **Colony's forked packages.** Operator files on the operator machine, authored by hand after the
  mechanism lands: `implement-agent` and `follow-up-agent` copies with the gate section rewritten to
  a targeted-tests bar (typecheck, build, lint stay hard; CI's full suite remains the merge bar).
  Never repository content, never part of any cogwork change.
- **An amend / append mode.** Rejected in the ADR.
- **Drift detection** between a fork and the shipped text. Rejected in the ADR; operator
  responsibility.
- **A workspace-record field or Control store change.** Rejected in the ADR.
- **Discovering a `WorkspaceId`** (a `workspace list` command or similar). A real gap, deliberately
  not a rider here; [#457](https://github.com/taylorfsteele/cogwork/issues/457) is the adjacent home
  for workspace-record surfacing.
- **Policy profile overrides.** Still deferred to settings-as-data (`next-phase.md`); different
  noun.

## Further notes

- Triage Runs resolve through the same mechanism; nothing exempts them. Colony simply will not fork
  `triage-agent`, because triage has no gate.
- The engine's own guards — branch-name guard, engine-posted coordination marker, sandbox hard-deny
  floor — hold for every Run regardless of instruction text. The override moves no trust boundary:
  it is operator-authored machine config under the cogwork home, on the trusted side of ADR 0013's
  line.
- Adjacent open work, no dependency either way: [#457](https://github.com/taylorfsteele/cogwork/issues/457)
  (publish the workspace record and its edit act) and
  [#87](https://github.com/taylorfsteele/cogwork/issues/87) (run CI checks locally in follow-up).
