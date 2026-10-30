# 0005 — The trust boundary is authentication, not payload redaction

- **Status:** accepted
- **Date:** 2026-08-05
- **Amended:** 2026-08-06 — the auth seam, see [Amendment](#amendment-2026-08-06--the-auth-seam)

## Context

The daemon exposes state over local RPC. `GetStatus` returns workspace status and
config-load failures; `WatchActivity` streams live agent output (message text, tool
calls). The socket is local and openable by any same-user process. cogwork is
single-user today, becomes a desktop app next, and a web app long-term — where the
daemon is reached over a network.

The #10 review raised "RPC failure-message path leakage": `DaemonStatus.failures`
carries absolute config paths and raw import errors, and the watch stream carries
unredacted agent output. The proposed fix was to redact at the boundary — relativize
paths, genericize messages — so a local snooping process could not read them.

That framing is wrong for a client-facing coding tool. The client is the user's own UI,
and its job is to render a live, detailed view of what the agents are doing. Redacting
at the boundary starves the UI of exactly the detail it needs.

The reference implementations confirm the alternative. opencode keeps payloads rich and
puts security at the channel: typed errors reach the client with specific messages, only
*unexpected* internal errors are held back (generic message + a `ref` + a server-side
log), and access is gated by an optional server password plus a CORS/origin allowlist
that trusts localhost and the desktop renderer. t3code does not expose a raw port at all
— it reaches the daemon over SSH / Tailscale, an authenticated encrypted layer, and
keeps the payload full-fidelity.

## Decision

Keep RPC payloads rich. Full failure messages, absolute `checkoutPath`, and the full
`WatchActivity` stream stay as-is — the client UI needs them. The trust boundary is the
*channel*, not the payload:

- **Now (local / desktop):** an owner-only (`0600`) socket under a per-user directory
  (`~/.cogwork/`). Same trust as the user's shell.
- **Later (web / remote):** real authentication and TLS, added when the daemon goes
  remote — not payload scrubbing.

The one thing withheld is *raw, unexpected* exceptions: model expected failures as typed
domain errors with clean, client-appropriate messages (which may name the config file —
that is useful, not a leak), and for genuine surprises return a generic message and log
the detail server-side. This is a robustness and UX practice, not secrecy.

## Consequences

- The desktop and web clients can render real error UX and live agent output without a
  redaction layer fighting them.
- Security effort concentrates at the channel: socket permissions now, an auth + TLS
  story to design before the daemon is exposed remotely.
- Introducing typed domain errors for expected failures is a small, ongoing hygiene task,
  distinct from any "hide detail from clients" work — which is explicitly not a goal.

## Amendment (2026-08-06) — the auth seam

The original decision named *where* the trust boundary sits (the channel) but not *the
seam* auth drops into. [Client contract and transport (#148)](https://github.com/taylorfsteele/cogwork/issues/161)
resolved that seam. This amendment records it, so "add auth when remote" has a concrete
insertion point rather than a reopened design.

The rule that makes the daemon hosted-ready without building any hosting: **no handler may
assume there is no caller.** The single seam that enforces it:

- **A `Principal` in every handler's context.** One `RpcMiddleware` provides a `Principal`
  (the current user) into the handler context. Today it is a fixed local owner; a remote
  daemon swaps in a middleware that authenticates the request and provides the real
  principal. Handlers read the caller now, so per-user scope is a later filter, not a
  reshape. This is the one shape that is expensive to reopen — hence recording it here.
- **The token rides as a request header.** Effect RPC carries headers over any transport,
  so a bearer token survives the socket → WebSocket / HTTP+SSE swap unchanged. The
  middleware ignores it today.
- **Read models already key by `WorkspaceId`.** So authorizing a caller to a subset of
  workspaces is a handler-level filter over existing shapes, not a contract change.
- **Commands and queries are separate RPC groups.** The split gives the middleware one
  place to guard state-changing commands more strictly than reads, when auth arrives.

Built now: the middleware seam (fixed local owner) and the socket move to `~/.cogwork`
at `0600` — the original decision named this location, but the code had drifted to
`$TMPDIR` with no permission set, so this closes that gap. Explicitly **not** built now:
the login flow, TLS, and the scope filter. Each drops into the seams above when the daemon
goes remote.
