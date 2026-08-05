# OAuth login for work sources

## Status

accepted

## Context

Work sources (Linear, GitHub) authenticate with a long-lived API key read from an env var via `Config.redacted`. We want a `login` command that opens the provider in a browser and captures a token, so operators don't hand-manage secrets. Linear supports OAuth 2.0 with PKCE, but as of April 2026 all OAuth tokens expire every 24h and must be refreshed, and the coordination model relies on distinguishing the daemon's own comments (`botUserId`) from human ones.

## Decision

- **The daemon authenticates as a distinct app identity (`actor=app`), never as the human operator.** Coordination comments stay attributable to the app, preserving the `botUserId` trust filter that `observe` uses to read only the daemon's own ledger comments.
- **We support two flows: Authorization Code + PKCE (browser login) and client credentials (headless/CI).** PKCE needs no stored secret; client credentials needs a `client_secret` (env var) and yields a 30-day app token.
- **Credentials live behind a `CredentialStore` seam** (service in `engine`, backing layer in `apps/cli`). The layer today is a `0600 ~/.clanker-forge/credentials.json` keyed by Linear organization. Desktop (keychain) and hosted web (per-user DB row) become new layers, not rewrites.
- **The credentials file is the source of truth for the token; the daemon owns refresh.** Refresh is reactive (on expiry/401), single-flight, and rewrites the file. `login` only seeds the initial token — no RPC handoff, and it works even when the daemon is down. No background timers (per repo rules).
- **The store resolves a credential by precedence: browser-login token → client-credentials → env-var API key**, logging which it used. The env-var path is retained as the floor so existing setups keep working.
- **`login` auto-discovers and records the org and the app's `botUserId`** after token exchange, so no work-source identity has to be hand-configured.

## Considered options

- **`actor=user`** — rejected: the daemon's comments would be authored by the operator, collapsing the `botUserId` distinction and breaking the coordination trust filter.
- **Store tokens in the run ledger** — rejected: the ledger is explicitly disposable; secrets need a durable, non-disposable, permission-restricted home.
- **RPC handoff of the token from `login` to the daemon** — rejected: fails when the daemon is down and loses tokens on restart if held only in memory.
- **PKCE only / client credentials only** — rejected in favour of both, so humans get the browser login and CI keeps a non-interactive path.

## Consequences

- A new durable secret file exists on disk (`0600`); it must never be committed and is a different durability class from the run ledger.
- The Linear client gains a token-refresh path and can no longer assume a non-expiring credential.
- A short-lived local HTTP server (loopback) and browser-open capability are introduced — the repo had neither. The loopback redirect URI must be pre-registered in the Linear OAuth app on a fixed port.
- A hosted web app will likely register its own OAuth application (confidential client, hosted callback), independent of the CLI's localhost setup.
