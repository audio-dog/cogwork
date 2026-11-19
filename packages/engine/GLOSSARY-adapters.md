# Engine glossary: Adapters and credentials

Part of the [engine glossary](./GLOSSARY.md).

**Issue tracker adapter**:
A concrete implementation of the issue tracker port for GitHub or Linear. It supplies the tracker-native reads — items changed since a cursor, when a label was applied, an item's prose with each comment marked as a person's or not — loads Work Context, and performs catalog actions such as adding a label or posting a comment. It observes nothing by itself; the Tracker Trigger source observes through it. Coordination is a separate authority.
_Avoid_: Work source adapter, client (the HTTP/GraphQL client is a lower-level detail), plugin, Trigger source (the module that reads through it)

**Tracker Trigger source**:
The one Trigger source implementation for issue trackers, instantiated once per tracker system over the issue tracker port. It owns polling, per-workspace cursors, catch-up, the label and comment source revisions, the origin-record cause, and the Cogwork-marker filter; it holds no tracker-specific branch. Each instance keeps its own source id so one tracker's cooldown never stops the other's polling.
_Avoid_: GitHub Trigger source, Linear Trigger source (instances, not modules), pull request Trigger source (the source control port's own)

**Source control provider adapter**:
A concrete implementation of pull-request Trigger sources and Workflow actions, with GitHub the only one today. It also projects the ready-to-merge view from Cogwork origin records and live pull-request state.
_Avoid_: Forge, code host, client (the HTTP client is a lower-level detail), plugin

**Link key**:
The stable key tying a work item to its pull request across systems. GitHub numeric work items first match an open PR's GitHub-resolved closing reference (`Closes #N`); all items retain the `ticketSlug(item.id)` branch-prefix fallback (`fel-157-…`, `13-…`). The engine-cut branch remains stable because it derives from the immutable item id rather than the title. A same-repository closing-reference match carries its actual head branch into follow-up.
_Avoid_: PR reference, branch name (the full branch also carries a title slug that can drift)

**Actor identity**:
Who the daemon acts *as* on a tracker — the authenticated account discovered from the bound **Connection**. It authors the daemon's tracker writes and marks which comments and pull requests are the daemon's own. A workspace stores only the Connection binding; it has no separate actor selector.
Because that account is the person's own, it cannot tell Cogwork's writes from the person's. In a Workflow the **origin record** decides which writes are Cogwork's, never the account.
_Avoid_: Bot id, owner (that's the allowlist), principal (that's an RPC caller)

**Credential store**:
The daemon's credential source for Connections, and the seam every Connection credential is resolved through. It holds the secret half of a **Connection**, whose non-secret record lives in the Control store: stored API keys, environment-variable references, OAuth token pairs, and GitHub CLI source markers keyed by system and account. A Connection id selects one; the caller receives the token and discovered identity, never the persisted secret. Linear, GitHub, Granola, and Slack resolve through it.
At run time it **acquires** the current GitHub CLI token for the Connection's fixed account and holds successful acquisitions in memory for ten minutes; the token is never persisted. A stored browser grant refreshes at read time when possible. Slack's user token and rotating refresh token are one stored OAuth credential, and a Slack refresh also replaces the single-use refresh token. A rejected credential can be invalidated. The same store resolves **provider keys** (see below), so one instance holds external-system credentials and AI-provider keys in one file.
The backing layer is a `0600` file today; an OS keychain on desktop or a per-user database row on a hosted server can arrive behind the same seam later. Unlike the run ledger it is **not** disposable — losing it logs the daemon out — and it is never committed to the repo.
_Avoid_: Secret manager, token cache (the credential file, not the store, holds tokens), auth provider, Run ledger (that one is disposable), config (the non-secret `client_id` lives in config, not here), keychain (only one possible backing layer)

**Provider key**:
An AI provider's API key, resolved through the credential store beside Connection credentials. A provider account is just a provider id plus the env vars a key can live in (most-specific first); resolution prefers a stored key over the environment, and a missing key is an error naming the env vars to set. Keys are durable — no expiry, no refresh — so they persist as a plain `StoredProviderKey` in the `version: 3` credential file; versions 1 and 2 still decode. Bring-your-own-key is the whole story today: a key arrives from the environment or is pasted through `login key`.
_Avoid_: Bearer token (that's the issue-tracker credential with an identity and expiry), secret manager

**Supported providers**:
The in-engine registry of the AI providers cogwork has a runner for — Anthropic, OpenAI, OpenRouter, Google — each with its display name and the env vars its key resolves from. It is the deterministic, offline source of truth for "which providers, which env vars," so key resolution never depends on a network fetch; the models.dev catalog only feeds the model list. A provider is **configured** when a key resolves for it (stored or env); unconfigured providers drop out of the picker silently rather than erroring.
_Avoid_: Model catalog (that's the network list of models; this is the local capability set), provider adapter

**Model catalog**:
The models.dev `api.json` read at runtime for the model picker — provider-keyed JSON decoded down to each model's id and label, filtered to the configured providers. Cached in memory with a TTL; a refresh that fails after a good load serves the stale copy rather than failing the picker, and a cold-cache failure surfaces a typed `CatalogError`. TanStack AI's per-model types remain the compile-time layer; this is the live half.
_Avoid_: Supported providers (that's the local registry), operation model (that's the harness-native model string an operation resolves)

**Model adapter resolution**:
The one owned path from a `provider/model` reference to a live TanStack text adapter: parse the reference, find the wired provider, resolve its key through the credential store, and build the adapter (`resolveModelAdapter` in `src/provider-resolve.ts`). It fails typed — `unknown-model` for an unwired provider prefix or a model the factory has no adapter for, `no-key` when the credential store finds no key. The provider runner resolves through it; the utility-call path (engine ADR 0006's cheap off-session model calls) will resolve through the same seam when its first caller lands — the service was removed until then.
_Avoid_: Provider adapter (that's the per-provider factory this calls), model catalog (that's the picker list, not resolution)

**Token refresh**:
The exchange that trades a stored refresh token for a rotated pair at the issue tracker's token endpoint, and the store's rule for when to run it. It is **reactive** — nothing schedules it, a read that finds an expired or near-expired token triggers it — and **single-flight** per stored credential, so concurrent reads share one exchange rather than racing to spend the same refresh token. The rotated pair is written back to the credential file before the token is handed out, keeping the file the source of truth. A refresh that fails is an auth error, not a quiet fall back to the env var. The store owns the timing; the issue tracker's adapter owns the exchange (`Linear.OAuth.makeTokenRefresh`).
_Avoid_: Token renewal loop, background refresh (there are no timers), re-authentication (that is a fresh grant, not a refresh)

**Client-credentials grant**:
The store's non-interactive OAuth source: it trades an app client id and a client secret read from an environment variable for an app-actor token. It is an adapter capability, never workspace configuration. The minted token is held until its lifetime runs out or the store is told it was rejected; this grant has no refresh token, so a rejection means minting a new one.
_Avoid_: Service account, machine token, app token (that is what it mints, not the source)

**Stored credential**:
One organization's OAuth grant as it is persisted: the token pair, its expiry and scopes, the OAuth client id needed to refresh it, and the identity discovered when it was granted (the organization and the `actorUserId` the app posts as). Keyed by issue tracker and organization, so one file can hold grants for several organizations. The engine defines the shape and the read path; where it lives on disk is the CLI's business.
_Avoid_: Session, Connection record (the `login linear` command mints the grant; the Connection only references it)
