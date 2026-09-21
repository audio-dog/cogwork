# CLI (client & headless daemon host)

`cogwork`, the command-line tool. It is a **client** that talks to a running daemon over RPC,
and a **headless daemon host** for CI/SSH. On a laptop the desktop app is the primary daemon host;
the CLI does not own that role. It speaks the shared kernel
([contracts](../../packages/contracts/CONTEXT.md)) and drives the
[engine](../../packages/engine/CONTEXT.md).

Role in the flow: start a headless daemon when no desktop host is present, then observe and control a
running daemon — status, runs, live watch, limits, scheduling — or reach into the engine directly for
worktree upkeep.

## Language

**Client**:
Anything that talks to a running daemon over the RPC transport (a Unix socket): the CLI's `status` / `runs` / `watch` / `limits` / `scheduling` subcommands, and the desktop mission-control UI.
When the daemon cannot be reached, read-only management commands open the Control store read-only.
They show its durable rows and label every daemon-derived section *needs a daemon*. Live and write
commands still require the daemon; the CLI never starts one for a client command.
_Avoid_: Frontend. Note: the `worktree` subcommand embeds the engine directly rather than going through a daemon, so "clients never embed the engine" is not a rule here.

**Daemon host**:
The process responsible for booting the server layer and keeping the daemon alive. On a laptop the desktop app is primary; the CLI `daemon` command remains the headless host for CI/SSH.
_Avoid_: Treating the CLI as the product's always-on host; embedding the long-lived engine inside a UI renderer

**Server layer**:
The full composition of engine layers a daemon host boots. It now lives in the engine (`Daemon.serverLayer`), not here — the CLI is one **host adapter**: it builds the file credential store, the SQLite ledger, the git/worktree platform, the Claude Code, Codex, Cursor, and configured replay Harness runners, and the socket-server transport, then hands them to the engine. The workspace registry is engine-owned and loaded from the Control store. The desktop app is the second host.
_Avoid_: Daemon (the running process is the daemon; this is how it's assembled), owning the composition here (it moved to the engine)

**Stop signal**:
A `SIGINT` or `SIGTERM` to the daemon process. The first one starts the engine's **drain** — the runtime interrupts the heartbeats and the drain runs as their shutdown finalizer, giving in-flight runs `--drain-grace` seconds to finish. A second stop signal ends that wait.
_Avoid_: Kill, cancel

**Credential file**:
Where stored OAuth credentials, Connection API keys or environment references, and AI-provider keys live on this machine — `~/.cogwork/credentials.json` by default, `--credentials` to move it. Written 0600 by renaming a fresh file over the old one, so an interrupted save can neither widen the permissions nor truncate another credential. The file is `version: 3`; versions 1 and 2 remain readable and upgrade on the next write. This file is the CLI's half of the engine's credential store.
_Avoid_: Keychain, secret store (this is a plain file; a keychain-backed layer would be a different implementation of the same engine seam)

**login key**:
The `login key --provider <id>` subcommand: the bring-your-own-key path. It reads the API key from stdin (never an argv flag, so it stays out of shell history and the process table — pipe it or paste then Ctrl-D), validates the provider against the engine's supported set, and persists it as a provider key through the credential store. A pasted key and a (future) OAuth-minted one land in the same slot.
_Avoid_: A `--key` flag (that leaks the secret), a separate provider secret file

**connection**:
The daemon-backed management group for `establish`, `re-connect`, and `remove`. Connect and re-connect read an API key from stdin by default. `--env` selects an environment-variable name, GitHub's `--github-cli` uses the account from `gh auth login`, and Linear's `--stored` selects an existing browser-login grant. The GitHub account is discovered from the accepted credential, so only Linear takes the optional account argument. Cogwork does not load `~/.cogwork/.env`; environment references resolve only from the daemon process environment. Removal reports the Workspace ids left dangling.
_Avoid_: Putting an API key in argv, editing the Control store directly

**login linear**:
The browser OAuth flow for Linear. It stores the grant, establishes the matching Connection through the daemon, and therefore installs the requiring Linear Plugin in the same act.
_Avoid_: A Workspace-owned OAuth app or a separate establish step

**workspace**:
The daemon-backed management group. `register` admits a checkout and mints its `WorkspaceId`; `update` replaces its mutable non-path record from schema-decoded JSON; `re-bind` changes that identity's checkout path; `deregister` removes the registration and private tree without erasing Run history. All four require a running daemon.
_Avoid_: The `worktree` command, which manages disposable checkouts under one registered Workspace

**Watch**:
The live view — the `watch` subcommand streams run activity over RPC and folds it into per-run terminal output.
_Avoid_: Tail, log
