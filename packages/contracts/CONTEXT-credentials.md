# Credentials

Part of the [Contracts (shared kernel)](CONTEXT.md) glossary.

**Credential store**:
The daemon's credential source for Connections: stored API keys, environment-variable references, OAuth token pairs, and GitHub CLI source markers keyed by system and account. At run time it **acquires** the current GitHub CLI token for the Connection's fixed account and holds successful acquisitions in memory for ten minutes; the token is never persisted. Slack's user token and rotating refresh token are one stored OAuth credential. A seam: the backing layer is a `0600` file today, an OS keychain on desktop, a per-user database row on a hosted server. Unlike the run ledger it is **not** disposable — losing it logs the daemon out — and it is never committed to the repo. Linear, GitHub, Granola, and Slack acquire credentials through it. It holds the secret half of a **Connection**, whose non-secret record lives in the Control store.
_Avoid_: Run ledger (that one is disposable), config (the non-secret `client_id` lives in config, not here), keychain (only one possible backing layer).
