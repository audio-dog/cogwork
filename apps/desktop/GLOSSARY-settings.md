# Desktop glossary: Settings surfaces

Part of the [desktop glossary](./GLOSSARY.md).

The surfaces that write the configuration the shared kernel defines.

**Plugins**:
The surface that owns Plugin **membership** — install and uninstall, the whole of it — and the setup that follows an install. It and **Connections** are the only surfaces permitted to change what is installed. Its sections are **Needs Attention**, **Installed**, and **Catalog**. Uninstalling shows a notice naming any **Connection** the Plugin required as still established: removal cascades down the dependency arrow and never up, so Plugins never removes a Connection.
"Permitted" is a **client-surface rule, and the daemon does not enforce it**: it sees one `Principal` and cannot tell which panel called. What holds the split is the act list — membership and settings are different commands, so a surface that calls only settings commands has no branch that could change membership. Do not build a caller-kind check to satisfy this line.
_Avoid_: Marketplace, Customize, Plugin store; `pin` (retired — no harness exposes version pinning to a person); *stage*, *accept* and *decline* an update, and *refresh the catalog* (all four retired — nothing is fetched, so an app update is the only thing that changes a Plugin); and the lowercase plural *plugins*, which means the bundles

**Customize**:
The surface that owns **contribution settings** — an MCP server's on / off — and that renders every other contribution read-only. The kind is the view and the authority is a badge on the row — and for a `local:` row that badge *is* the Authoring tree, so it is shown once, not twice. Since ADR 0018 removed the setting from Skill, Rules and Subagent, their rows show what exists and which tree it came from, and carry no toggle. An MCP server keeps its toggle, and a `local:repo` one is the offer-versus-enable row ADR 0013 owes: *this repository offers this. It is off. You can turn it on.* The MCP server view groups by the Engine's conclusion — **Needs Attention** and **Ready** — never by the person's choice: a server switched off greys out and takes a *Disabled* pill in place, so it is switched back on where it was left. It may show a Plugin-owned row's status, including one that failed to load, and it may **never** write membership or credential state: authority is part of a contribution's immutable identity, so the surface that renders authority is the wrong place to change it. As with **Plugins**, "never" is a client-surface rule the daemon does not enforce.
_Avoid_: Plugins, Settings, preferences

**Connections**:
The surface where a person **connects**, **re-connects**, or removes a system, with one card per system and no container noun over it. It may write Plugin membership, but only this way: **connecting installs the Plugin that requires the Connection.** At most one first-party Plugin requires a given Connection, which is what makes that Plugin derivable. No noun is minted for the act.
_Avoid_: Integration, connector, Customize, Plugins, setup wizard, *paired install* (retired — it never said what was paired with what, and named an act nobody refers to twice)

**Workspaces**:
The surface that owns what the daemon operates over and under on this machine: register, update and deregister a **Workspace**, re-bind its checkout path, set its Operation settings, and set the daemon's runtime limits. `WorkspaceState.Registered` publishes the complete stored registration record. Update replaces its mutable non-path columns without touching Private workspace overlay rows. Named for its dominant subject; Operation settings live with the Workspace whose Runs they govern, while the workspace record's columns and the limits are machine facts (ADR 0016). (Restoring the **Control store**'s pre-migration copy was withdrawn with ADR 0015's 2026-08-27 amendment.)
**Register is the trust act.** Registering admits the repository's Workspace input Authoring tree — see **Scope** and ADR 0018. There is no repository settings file behind this surface: `register` writes the workspace record instead.
_Avoid_: Settings (already on Customize's _Avoid_ line), Engine (the machinery being managed, not a pane), Daemon, Workspace (the singular is the registered repo, not the surface), machine config

