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
The full composition of engine layers a daemon host boots. It now lives in the engine (`Daemon.serverLayer`), not here — the CLI is one **host adapter**: it builds the file credential store, the SQLite ledger, the disk workspace loader, the git/worktree platform, the cursor harness runner, and the socket-server transport, then hands them to the engine. The disk loader and credential file stay CLI concerns behind the registry- and credential-store parameters. The desktop app will be the second host.
_Avoid_: Daemon (the running process is the daemon; this is how it's assembled), owning the composition here (it moved to the engine)

**Stop signal**:
A `SIGINT` or `SIGTERM` to the daemon process. The first one starts the engine's **drain** — the runtime interrupts the heartbeats and the drain runs as their shutdown finalizer, giving in-flight runs `--drain-grace` seconds to finish. A second stop signal ends that wait.
_Avoid_: Kill, cancel

**Config home**:
The directory of `*.workspace.ts` files the daemon loads at startup to learn which workspaces to drive.
_Avoid_: Config file, settings

**Credential file**:
Where stored OAuth credentials and AI-provider keys live on this machine — `~/.cogwork/credentials.json` by default, `--credentials` to move it. Written 0600 by renaming a fresh file over the old one, so an interrupted save can neither widen the permissions nor truncate the other organizations' grants or provider keys. A file that cannot be read is logged and treated as empty for reads, and refuses to be overwritten on save rather than discarding whatever it held. The file is `version: 2` — issue-tracker grants plus provider keys — and reads a `version: 1` file (grants only) as one with no provider keys, upgrading it on the next write. This file is the CLI's half of the engine's credential store; the CLI also hands the store Linear's client-credentials grant, so a machine with no file can still authenticate from a secret in the environment.
_Avoid_: Keychain, secret store (this is a plain file; a keychain-backed layer would be a different implementation of the same engine seam)

**login key**:
The `login key --provider <id>` subcommand: the bring-your-own-key path. It reads the API key from stdin (never an argv flag, so it stays out of shell history and the process table — pipe it or paste then Ctrl-D), validates the provider against the engine's supported set, and persists it as a provider key through the credential store. A pasted key and a (future) OAuth-minted one land in the same slot.
_Avoid_: A `--key` flag (that leaks the secret), a separate provider secret file

**models**:
The `models` subcommand: lists the model catalog for the providers a key resolves for. It asks the engine which providers are configured (stored key or env var), then prints the models.dev catalog entries for exactly those. With nothing configured it points the user at `login key` or the env var instead of erroring.
_Avoid_: A picker UI (that's the desktop's job; this is the read-only list), listing every provider regardless of credentials

**Watch**:
The live view — the `watch` subcommand streams run activity over RPC and folds it into per-run terminal output.
_Avoid_: Tail, log
