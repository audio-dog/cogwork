# 0017 — A Connection is engine-owned, and pairs with at most one Plugin

- **Status:** accepted
- **Date:** 2026-08-25

## Context

ADR 0011 gave a Plugin a manifest with a Connection-*requirements* field and left one question open:
whether a Plugin may introduce an external system the Engine has never seen. ADR 0013 declined to
scope a Connection. ADR 0014 excluded Connection behaviour and struck four answers it had produced
anyway. ADR 0015 declined a Connection record. Each deferral named [#172](https://github.com/colonylabs/cogwork/issues/172),
and the glossary carried *Connection* as *provisional, do not design against*.

Underneath sat a product question. Setting up cogwork today means editing an executable
`*.workspace.ts` file to name an issue tracker and point it at a credential. The wanted experience is
a page with a card for Linear, a card for GitHub, a card for Granola: click, log in through the
browser, done. Every harness in the field has gone there, and calls the result a *connector*.

`docs/spec/next-phase.md` also holds a seam open: the issue tracker plays **three roles** — sensor,
work-item identity, coordination store — and the roles must separate eventually. Making the tracker
installable is that seam arriving early through the Plugins door.

The first framing was wrong. "Install the Linear connector" was read as *a Plugin supplies the port
implementation*, and the discussion ran at whether a Plugin may ship an adapter. It may not: ADR 0006
puts executable code behind an explicit opt-in layer, ADR 0011's manifest points at files, and every
"connector" in the reference implementations is an out-of-process MCP server, never in-process code.
What a person actually wants to install and authenticate is the **Connection**.

## Decision

**A Connection and a Plugin are two concepts. A Connection is engine-owned. A Plugin declares which
Connections it requires, and a Connection is what both a Plugin's contributions and the Engine's own
ports authenticate through.**

The cut is fixed by two cases, and neither set contains the other:

- **A Plugin with no Connection.** A first-party Plugin of Rules and Skills authenticates nothing.
- **A Connection with no Plugin.** GitHub today is the issue tracker *and* the source control
  provider, and contributes no files at all.

One term cannot name both sets. Collapsing them makes a Rules Plugin a login to nothing, or makes
GitHub a bundle with an empty manifest whose provision path runs for zero files.

### What a Connection is

- **Engine-owned and independently addressable.** Its record lives in the **Control store** — id,
  system, account, status — and its secret stays in the **Credential store**. This *amends ADR 0015*,
  which declined a Connection record while the concept was undefined: a workspace references a
  Connection **by id**, so that id must exist outside a secret store whose backing becomes a keychain.
- **Keyed by system and account.** `linear/acme`, not `linear`. The Credential store already keys by
  account. The product surfaces **one account per system** for now, so a second account is a later
  surface change and never a data migration.
- **No Scope, and reference is not scoping.** This *pays ADR 0013's debt*. The reason is ADR 0013's
  own: a cloned repository must not be able to authenticate as you. A workspace references a
  Connection; it never holds or overrides one.
- **Established by any source the Credential store accepts.** A browser login is preferred where a
  system offers one; an API key is valid where it does not. The source is a property of the
  Connection, not a different concept — which is what lets GitHub appear as established through an
  environment variable today and through OAuth later.
- **One grant serves every port on one account.** A GitHub issue tracker doubles as its own source
  control provider, so one Connection carries the union of the scopes both need. The cost, accepted:
  the read-only provider holds a token that can write. ADR 0005 already puts the trust boundary at
  authentication rather than payload redaction.
- **Connection readiness** is its own term. **No `Readiness` umbrella is minted** — this *settles the
  generalization ADR 0014 deferred*, and settles it the other way. The relation is composition, not
  two peers: *MCP server readiness* already includes "authenticated", so Connection readiness is an
  **input** to it for a Plugin's MCP server, and stands alone for an Engine port, where it gates the
  reconcile heartbeat. ADR 0011 retired one umbrella noun already; name the kind.
- **Revocation is a state, not an act.** A grant revoked outside cogwork makes the Connection not
  ready. Reconcile skips and reports the workspace; a Run Plan requiring it is rejected; the
  Connections page shows the card as needing a re-connect. Install records and settings are untouched,
  because a re-connect must never require a re-install.
- **A provider key is not a Connection.** A Connection binds a system that supplies or receives the
  **work**; a provider key buys inference. Both live in the Credential store. The existing vocabulary
  — *provider key*, *supported providers*, *configured provider* — is unchanged. Establishment method
  does not distinguish them: Anthropic sells no login either.

### What a Plugin may and may not do

- **A Plugin may require a Connection by id from the Engine's known set. It may never define one.**
  This *answers ADR 0011's open question*. The auth-recipe field stays present and unused, on ADR
  0011's own reasoning. The rule is what is decided, and it holds whether or not the field is ever
  filled.
- The door it would open is already open, and narrower than it looks: a Plugin's MCP server
  authenticates unknown systems today with an env-var *name*. The recipe field's only distinct
  capability is *the Engine performing an OAuth exchange against endpoints a bundle named*, which is
  a materially different act and has no caller while every Plugin is first-party.
- **No issue tracker role is Plugin-supplied.** Not sensor, not work-item identity, not coordination
  store. Every external system the **Engine** reads is an Engine port over a Connection, including a
  phase-3 context source such as Granola, whose ingestion, watermark, and dedup are engine-driven. A
  Plugin adds contributions to a Run and never supplies a role. This decides which side of
  `next-phase.md`'s three-role seam a Plugin may be on; it does not split the roles.

### Surfaces and lifecycle

- **A Connections surface exists.** This *amends ADR 0014*, which rejected "a third surface for
  Connections" while the Connection set is closed and first-party. That condition turns out to be the
  reason **for** the surface, not against it: an Engine port's Connection has no Plugin over it, so
  Plugin setup can never be its home. ADR 0014 could not weigh this, having excluded Connection
  behaviour.
- **No new noun.** The page lists Connections. A card is a view of one Connection with the Plugin
  that requires it under it. No *Integration* container is minted — a container invites versioning, scoping, and
  uninstall questions that a view does not have.
- **Establishing is app-level; binding stays per-workspace.** The page makes Linear available to the
  machine. A workspace still names its issue tracker and references the Connection by id, because one
  repository can be tracked in Linear and another in GitHub Issues.
- **Removal cascades down the dependency arrow, never up.** Removing a Connection removes each Plugin
  that requires it; uninstalling a Plugin leaves the Connection and the issue tracker working. The
  rejected inverse — uninstalling the Linear Plugin killing the tracker — takes a person's whole
  pipeline down because they removed a tools bundle.
- **A removal with a live binding is allowed and leaves the binding *dangling***, with a warning
  naming the workspaces. Reconcile reports the workspace and dispatches nothing for it. This is ADR
  0014's existing shape for committed Workspace input values.
- **Install is never blocked on a Connection.** Installing a Plugin that requires a Connection proceeds and
  offers the login in the same flow. If the person abandons the browser, **the install stands** and
  the row reads *Connection needed*. A rollback would need a pending state and a timeout — a rule a
  person must learn and cannot see — and would delete a bundle ADR 0014 already provisioned
  atomically. Codex does exactly this: a declared-but-unestablished connector is `is_accessible:
  false` with an `install_url`, and the plugin install is not blocked.
- **Establishing a Connection installs the Plugin that requires it.** A person who connects Linear and
  then has to find and flip an MCP server has been handed a setup step disguised as a settings screen.
  Both entry paths converge on the same state. This once *amended ADR 0014*'s "after install every
  contribution is off"; [#205](https://github.com/colonylabs/cogwork/issues/205) has since deleted that
  sentence outright, so the two paths converge with no exception to state — see the 2026-08-26
  amendment below.
- Installing on establishment is a **one-time act, not an invariant.** "Linear as the tracker, without
  the Linear tools" stays reachable, because an MCP server that is on costs context on every Run.
  Establishing again after a removal installs again, and needs no memory of an earlier uninstall.

### One Connection, one Plugin

**Which Plugin a Connection brings with it is derived from the Plugin's existing
Connection-requirements field, and one Connection is required by at most one first-party Plugin.** No new field, no manifest flag, no engine lookup table.

The one-to-one rule is what makes derivation exact. Without it, *requires* (a hard dependency) and
*pairs with* (a recommendation) are two relations sharing one field, the auto-install set is open to
every future Plugin naming `linear`, and three Plugins requiring it have no primary. With it, "the Plugin
that requires Linear" and "the Linear Plugin" are the same thing.

Two first-party Plugins requiring one Connection is knowable with the manifests in hand, so it is a
**load-time diagnostic** under ADR 0013's when-is-it-knowable rule, not a Run Plan rejection.

**Reopen trigger, recorded so it is not re-argued:** the day a second first-party Plugin requires one
Connection — or a marketplace admits third-party Plugins — the rule narrows to "at most one
*first-party* Plugin" and a third-party one becomes a candidate the page *offers* rather than
installs. That is a rule change with no data migration, precisely because no field was added.

## Considered Options

- **A Plugin supplies the port implementation.** Rejected. It is ADR 0006's opt-in code layer arriving
  through the Plugins door, and buys nothing while every integration is first-party — the Engine would
  ship the code and then pretend to discover it. It costs a versioned port interface that becomes a
  public API on first external use.
- **One concept: each external system is one installable thing.** Rejected by the two cases above. It
  does not remove a concept; it moves the split to a worse place, between bundles that authenticate
  and bundles that do not.
- **A Plugin contains its Connection.** Rejected on a fact and a case. The fact: [#125](https://github.com/colonylabs/cogwork/issues/125)
  read every bundle under `~/.codex`, `~/.cursor`, and `~/.claude` and found **no secrets** — env-var
  names and public client ids only, with tokens in one file per harness outside every bundle. A Plugin
  is files; a Connection is a live grant. The case: a person who uninstalls the Linear Plugin because
  its MCP server costs too much context would lose their issue tracker.
- **Mint `Readiness` with MCP server readiness and Connection readiness as instances**, as ADR 0014
  expected. Rejected: they are not peers, and the umbrella hides that one feeds the other.
- **Mint a container noun (*Integration*).** Rejected: ADR 0011 retired one umbrella noun and ADR 0014
  minted none. A card is a view.
- **Give a Connection a Scope ladder.** Rejected as ADR 0013 already implied, and rejected again on
  the same trust reason.
- **A field on the Connection naming its Plugin.** Rejected: two statements of one relation can
  disagree, the field is engine-authored so a new one needs a release rather than a catalog
  update, and it is exactly the table that rots if Plugins ever come from outside.
- **A manifest opt-in flag separating *requires* from *pairs with*.** Rejected *for now*: under
  one-to-one the flag has one possible value and no caller, and this project refuses machinery with no
  caller — ADR 0014 rejected a rename map, version ranges, and a completeness marker on that test. The
  reopen trigger above is the flag's cue.
- **Block install until the Connection exists.** Rejected: without the Connection the Plugin does
  nothing *and* the Engine does nothing, so a block repairs nothing and only moves the wall. It also
  makes install order a rule, and stops an offline person installing anything that requires a
  Connection.

## Consequences

- The glossary's **Connection** entry stops being provisional and loses its *Avoid* line about
  scoping. **Connection readiness** joins it as a term.
- **Connections joins Plugins as a surface that may write membership**, by installing the Plugin
  that requires the Connection.
  Customize's contribution rows still may never write membership or credential state — that rule was
  about the surface that renders authority, and it is unchanged.
- The **Control store** gains a Connection record; ADR 0015's closed field list widens by one table.
- The Engine's ports are unchanged in shape. What changes is where their credential comes from and
  how a person establishes it: a Connection id, not a hand-edited `*.workspace.ts` credential.
- `next-phase.md`'s three-role seam stays exactly as held. This ADR only fixes that a Plugin lands on
  the contributions side of it.
- ADR [0016](./0016-one-management-contract-for-the-app-and-the-cli.md) owes three commands. It
  dropped Connection from its candidate list because the term was provisional, giving "four
  candidates, zero survivors". Establish, re-connect, and remove are now real acts, and its
  CLI-and-app parity rule applies to them.
- Codex is recorded as a **convergence**, not a borrow: a `connectors` crate beside its `plugin`
  crate, `AppDeclaration { name, connector_id, category }` declaring connectors by id, and
  `plugin_display_names_by_connector_id` carrying the many-plugins-one-connector relation we chose.
  We deviate on one point deliberately: Codex permits many plugins per connector, and we enforce
  one-to-one so the Plugin can be derived.

Full reasoning: [#172](https://github.com/colonylabs/cogwork/issues/172).


## Amendment (2026-08-26) — "paired install" is struck as a term, and the arrow is confirmed

[#205](https://github.com/colonylabs/cogwork/issues/205) struck **paired install**. The word "paired"
never said what was paired with what, so it needed explaining at every use, and it named an act nobody
refers to twice. No replacement noun is minted. The behaviour is written as the sentence it always
was: **establishing a Connection installs the Plugin that requires it**, and at most one first-party
Plugin requires a given Connection. This follows the same disposition that retired `capability`,
refused a `Readiness` umbrella, and struck `pin`.

Two substantive corrections come with it.

**The exception this ADR amended into ADR 0014 no longer exists.** This ADR narrowed "after install
every contribution is off" to leave establishment as the one case that turned contributions on. #205
deleted the original sentence: after **any** install a Plugin's MCP server is on, and its Skills,
Rules, Commands and Subagents are on disk and therefore active. Establishment and a plain install now
reach the same state with no exception to state, which is what this ADR wanted and could not have.

**Removal cascades down the arrow, never up — confirmed, and the Plugins surface says so.** #205 put
this to the maintainer directly, because uninstall was proposed to remove the Connection too. It does
not. A Connection may also authenticate an Engine port with no Plugin over it, so uninstalling a tools
bundle must never stop the daemon reconciling. Uninstall shows a notice naming the Connection as still
established, and does **not** offer to remove it: **Connections** stays the only surface that writes
Connection state.

## Amendment (2026-09-04) — GitHub repository identity comes from the checkout

[#452](https://github.com/colonylabs/cogwork/issues/452) removes `issueTracker.repo` and
`sourceControl.repo`. No supported workspace observes work or pull requests in a different repository
from its checkout. A Linear tracker with GitHub source control is cross-system, not cross-repository.

The selected worktree remote, `origin` by default, is now the repository authority. Registration,
reload, and re-bind derive its GitHub `owner/repository` from that remote. Provider type, Connection,
actor identity, and bot settings remain explicit. A GitHub tracker or source control provider fails
closed when the selected remote is missing or is not a supported GitHub SSH or HTTPS URL.
