# CLI (client & daemon host)

`clanker-forge`, the command-line tool. It is both the **host** that composes the engine into a
running daemon and the **client** that talks to a running daemon over RPC. It speaks the shared
kernel ([contracts](../../packages/contracts/CONTEXT.md)) and drives the
[engine](../../packages/engine/CONTEXT.md).

Role in the flow: start the daemon, then observe it — status, runs, live watch — or reach into the
engine directly for worktree upkeep.

## Language

**Client**:
Anything that talks to a running daemon over the RPC transport (a Unix socket): the CLI's `status` / `runs` / `watch` subcommands today, a GUI later.
_Avoid_: Frontend. Note: the `worktree` subcommand embeds the engine directly rather than going through a daemon, so "clients never embed the engine" is not a rule here.

**Server layer**:
The full composition of engine layers — registry, work source, ledger, harness, reconcile, executor, scheduler, RPC handlers — that the `daemon` command boots.
_Avoid_: Daemon (the running process is the daemon; this is how it's assembled)

**Config home**:
The directory of `*.workspace.ts` files the daemon loads at startup to learn which workspaces to drive.
_Avoid_: Config file, settings

**Credential file**:
Where stored OAuth credentials live on this machine — `~/.clanker-forge/credentials.json` by default, `--credentials` to move it. Written 0600 by renaming a fresh file over the old one, so an interrupted save can neither widen the permissions nor truncate the other organizations' grants. A file that cannot be read is logged and treated as empty for reads, and refuses to be overwritten on save rather than discarding whatever it held. This file is the CLI's half of the engine's credential store; the CLI also hands the store Linear's client-credentials grant, so a machine with no file can still authenticate from a secret in the environment.
_Avoid_: Keychain, secret store (this is a plain file; a keychain-backed layer would be a different implementation of the same engine seam)

**Watch**:
The live view — the `watch` subcommand streams run activity over RPC and folds it into per-run terminal output.
_Avoid_: Tail, log
