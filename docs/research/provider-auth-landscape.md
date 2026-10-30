# Provider auth and model-catalog landscape

Resolves [#163](https://github.com/taylorfsteele/cogwork/issues/163) (part of wayfinder map #146).

**Question:** For bring-your-own-provider in cogwork's TanStack AI runtime — which providers
support subscription OAuth login vs API-key-only vs neither, what does the ToS actually say about a
third-party app reusing subscription tokens, how does opencode implement credentials, and what
should feed the model picker?

**TL;DR:** Only OpenRouter offers an OAuth flow *designed* for third-party apps. OpenAI's ChatGPT
login is technically open and tolerated in practice but has no published third-party program.
Anthropic explicitly prohibits third parties from routing requests through subscription
credentials and has enforced that prohibition twice in 2026. Google killed consumer OAuth for
Gemini CLI in June 2026. Build OpenRouter OAuth + API keys for everything first; treat ChatGPT
OAuth as a fast follow; treat Anthropic and Google as API-key-only. Use models.dev as the catalog
source at runtime, with TanStack AI's per-model types as the compile-time layer.

---

## 1. Provider × auth-method matrix

| Provider | Subscription OAuth for 3rd-party apps | API key | ToS risk of reusing subscription OAuth |
|---|---|---|---|
| **OpenRouter** | ✅ First-class OAuth PKCE; mints a user-controlled API key, no client registration needed ([docs](https://openrouter.ai/docs/guides/overview/auth/oauth)) | ✅ `sk-or-…` | **None** — the flow exists precisely for third-party apps |
| **OpenAI (ChatGPT)** | ⚠️ Codex-style PKCE + device flow works and is shipped openly by opencode; no published program authorizing third parties ([auth docs](https://developers.openai.com/codex/auth)) | ✅ platform.openai.com | **Medium** — docs scope ChatGPT sign-in to "supported Codex clients"; no enforcement against third parties observed; GitHub-style partnership precedent exists |
| **Anthropic (Claude)** | ❌ Explicitly prohibited for third parties ([legal & compliance](https://code.claude.com/docs/en/legal-and-compliance)) | ✅ platform.claude.com | **High** — written prohibition + active enforcement (Jan 2026 token blocking, Apr 2026 billing cutoff); account suspension risk for users |
| **Google (Gemini)** | ❌ Consumer "Login with Google" for Gemini CLI/Code Assist deprecated June 18, 2026 ([deprecation notice](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals)); enterprise Code Assist OAuth requires a GCP project | ✅ AI Studio key (`GEMINI_API_KEY`), or Vertex AI | **N/A for consumers** — the consumer OAuth surface no longer exists; enterprise OAuth is scoped to Google's own IDE/CLI surfaces |
| **GitHub Copilot** | 🤝 Device flow works but requires a **formal partnership**: GitHub officially blessed opencode's Copilot auth in Jan 2026 ([changelog](https://github.blog/changelog/2026-01-16-github-copilot-now-supports-opencode/)); opencode was "required to use" its own partner OAuth app ([maintainer comment](https://github.com/anomalyco/opencode/pull/19350)) | ➖ Fine-grained PAT with Copilot Requests permission ([Copilot CLI auth docs](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)) | **Low with partnership, medium without** — unpartnered clients hit integration-scoped 403s on the session-token exchange |
| **Cursor** | ❌ Neither — subscription usable only through Cursor's own products (CLI/IDE); no BYO-token surface | ❌ no public inference API | N/A (the "CLI-only" reference case from the ticket) |
| xAI, Groq, Mistral, Together, etc. | ❌ | ✅ | N/A — API-key-only providers; models.dev lists env-var keys for ~150 providers |

---

## 2. The ToS reality, per provider

### Anthropic — written prohibition, enforced

The authoritative statement is the Claude Code [Legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance)
(fetched 2026-08-05):

> "**OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max, Team,
> and Enterprise subscription plans and is designed to support ordinary use of Claude Code and
> other native Anthropic applications. … **Developers** building products or services that
> interact with Claude's capabilities, including those using the Agent SDK, should use API key
> authentication through Claude Console or a supported cloud provider. **Anthropic does not permit
> third-party developers to offer Claude.ai login or to route requests through Free, Pro, or Max
> plan credentials on behalf of their users.** Anthropic reserves the right to take measures to
> enforce these restrictions and may do so without prior notice."

That sentence describes exactly what a "log in with your Anthropic account" feature in
cogwork would be. The enforcement timeline:

- **Jan 2026** — Anthropic blocked consumer OAuth tokens used by opencode, Roo Code, Goose, and
  OpenClaw, and "tightened safeguards against spoofing the Claude Code harness"; some user
  accounts were suspended (reported by [autonomee.ai](https://autonomee.ai/blog/claude-code-terms-of-service-explained/)).
- **Feb 2026** — the prohibition above was published as documentation, closing the Agent SDK
  loophole.
- **Apr 3–4, 2026** — Boris Cherny (Head of Claude Code) announced subscriptions "will no longer
  cover usage on third-party tools like OpenClaw"; third-party use now requires prepaid **usage
  bundles** billed at API rates, or an API key ([The Verge](https://www.theverge.com/ai-artificial-intelligence/907074/anthropic-openclaw-claude-subscription-ban)).
- **May–Jun 2026** — a broader plan to move Agent SDK / `claude -p` / third-party usage to a
  separate credit pool was announced for June 15 and then **paused** ([digitalapplied.com summary](https://www.digitalapplied.com/blog/anthropic-claude-credit-overhaul-june-15-2026)).

opencode's own docs are blunt about the outcome ([providers.mdx](https://github.com/anomalyco/opencode),
vendored at `.repos/opencode/packages/web/src/content/docs/providers.mdx`):

> "There are plugins that allow you to use your Claude Pro/Max models with OpenCode. Anthropic
> explicitly prohibits this. Previous versions of OpenCode came bundled with these plugins but
> that is no longer the case as of 1.3.0."

And indeed the vendored source has **no** Anthropic OAuth — `.repos/opencode/packages/core/src/plugin/provider/anthropic.ts`
is catalog/header tweaks only.

### OpenAI — technically open, formally unaddressed

- Codex supports "Sign in with ChatGPT for subscription access" and API keys
  ([developers.openai.com/codex/auth](https://developers.openai.com/codex/auth)). The docs speak
  of the ChatGPT desktop app, Codex CLI, and IDE extension; the [help center](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
  says the ChatGPT Terms of Use govern, and mentions the Compliance API covering "supported Codex
  clients" — there is no statement either permitting or prohibiting unaffiliated clients.
- In practice the flow is wide open: the Codex CLI is Apache-2.0 open source with the OAuth
  client ID visible, and opencode ships the identical flow (same `auth.openai.com` issuer, client
  `app_EMoamEEZ73f0CkXaXp7hrann`, localhost:1455 callback, plus a device-code variant) with an
  honest `originator: "opencode"` parameter — see
  `.repos/opencode/packages/core/src/plugin/provider/openai.ts`. opencode's docs advertise
  ChatGPT Plus as usable "with zero setup" and there has been no OpenAI enforcement action
  analogous to Anthropic's.
- Note: OpenAI's separate "Sign in with ChatGPT" partner beta (Notion, Vercel) is **identity
  only** — it shares name/email, not model access ([Apps SDK auth](https://developers.openai.com/apps-sdk/build/auth)
  is likewise about apps inside ChatGPT, not BYO-subscription inference).

Net: medium risk. The mechanism works, is tolerated, and OpenAI's posture has been the opposite of
Anthropic's — but a policy flip would be within their rights since nothing authorizes it in writing.

### Google — the consumer OAuth door closed

Gemini CLI's "Login with Google" rode on Gemini Code Assist licenses. As of **June 18, 2026**,
the individual/Google AI Pro/Ultra tiers stopped serving Code Assist and Gemini CLI requests, and
"you can no longer use the Login with Google option"
([deprecation notice](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals));
consumers are pointed at the Antigravity product family. What remains:

- **Gemini API key** from [AI Studio](https://aistudio.google.com/app/apikey) — the documented
  path for headless/third-party use ([gemini-cli auth docs](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/authentication.mdx)).
- **Vertex AI / enterprise Code Assist** — OAuth exists but requires a GCP project and is scoped
  to Google's own surfaces.

For cogwork: Google is API-key-only.

### OpenRouter — the one provider that wants this

OpenRouter's [OAuth PKCE flow](https://openrouter.ai/docs/guides/overview/auth/oauth) is built for
exactly the "log in with your account" UX: redirect to `https://openrouter.ai/auth` with a
`callback_url` + S256 code challenge, then POST the code to
[`/api/v1/auth/keys`](https://openrouter.ai/docs/api/api-reference/oauth/exchange-authorization-code-for-api-key),
which returns a **user-controlled API key** (`sk-or-…`). No client registration, no client secret,
no refresh-token lifecycle — the exchanged artifact is a durable key the user can revoke from
their OpenRouter dashboard. OpenRouter publishes an [agent skill](https://github.com/OpenRouterTeam/skills/blob/main/skills/openrouter-oauth/SKILL.md)
telling developers to add this to their apps. One login yields 300+ models across every major lab,
billed to the user's OpenRouter credits.

### GitHub Copilot — partnership-gated subscription OAuth

GitHub [officially supports opencode with Copilot subscriptions](https://github.blog/changelog/2026-01-16-github-copilot-now-supports-opencode/)
(Jan 2026) via a GitHub device-login flow — proof that "bring your subscription to a third-party
harness" can be a sanctioned, partnered arrangement. The mechanics: device flow under a GitHub
App, then exchange the `ghu_` user token for a short-lived Copilot session token via
`api.github.com/copilot_internal/v2/token`; session tokens are scoped to an integration and the
API 403s without matching `Copilot-Integration-Id` headers ([opencode PR #19350 discussion](https://github.com/anomalyco/opencode/pull/19350),
where a maintainer notes "we have our own oauth app and we are required to use it"). Unpartnered
access lives off the `copilot_internal` endpoint — functional but gray. GitHub also allows
fine-grained PATs with the "Copilot Requests" permission as a documented non-OAuth path
([Copilot CLI auth](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)).

---

## 3. How opencode implements credentials (vendored source)

All paths relative to `.repos/opencode`.

**Storage.** Credentials live as rows in opencode's global SQLite database
(`packages/core/src/credential.ts`, table in `packages/core/src/credential/sql.ts`), not a JSON
file. The value is a tagged union (`packages/schema/src/credential.ts`):

- `Credential.OAuth` — `{ type: "oauth", methodID, access, refresh, expires, metadata? }`
- `Credential.Key` — `{ type: "key", key, metadata? }`

One credential per integration: `Credential.create` deletes any existing row for the integration
inside the same transaction before inserting.

**Integration registry.** `packages/core/src/integration.ts` defines three method kinds — `oauth`,
`key`, `env`. Plugins register an `OAuthImplementation` with `authorize()` (returns a URL +
instructions + a `callback` effect that resolves to a `Credential.OAuth`) and an optional
`refresh()`. `connection.resolve()` returns usable credential material and transparently runs
`refresh` when `expires` has passed, persisting the rotated token.

**Auto-generated key/env methods.** `packages/core/src/plugin/models-dev.ts` walks the models.dev
catalog and registers a `key` method plus an `env` method (with the provider's documented env-var
names) for *every* provider — so "paste an API key" support for ~150 providers costs zero
provider-specific code. OAuth is opt-in per provider plugin.

**Shipped OAuth implementations** (this snapshot ships exactly two in core):

- **OpenAI ChatGPT** (`packages/core/src/plugin/provider/openai.ts`): browser PKCE against
  `https://auth.openai.com/oauth/authorize` with a localhost:1455 callback server, and a headless
  device-code variant against `/api/accounts/deviceauth/*`. Extracts `chatgpt_account_id` from
  the JWT claims into credential metadata; refresh via `grant_type=refresh_token`.
- **OpenCode Console** (`packages/core/src/plugin/provider/opencode.ts`): RFC 8628 device flow
  (`/auth/device/code` → poll `/auth/device/token`, handling `authorization_pending` /
  `slow_down`), then fetches user + org for metadata. Also the pattern for their hosted gateway:
  after OAuth, provider/model config is fetched server-side from `/api/config`.
- Anthropic OAuth: **absent** (removed in 1.3.0 per their docs, § 2 above). GitHub Copilot OAuth
  in the current release goes through a partner OAuth app (see PR #19350); the copilot plugin in
  this snapshot (`packages/core/src/plugin/provider/github-copilot.ts`) is catalog/endpoint
  routing only.

**Model catalog.** `packages/core/src/models-dev.ts` fetches `${source}/api.json` where source
defaults to `https://models.opencode.ai` (their mirror of models.dev), caches to
`~/.cache/opencode/models.json` with a 5-minute TTL and hourly background refresh, uses a
cross-process file lock to prevent racing CLIs, and falls back to a bundled snapshot
(`OPENCODE_MODELS_DEV`) when offline. Env overrides: `OPENCODE_MODELS_URL`,
`OPENCODE_MODELS_PATH`, `OPENCODE_DISABLE_MODELS_FETCH`.

---

## 4. Model-catalog sources for a picker

**models.dev** ([github.com/sst/models.dev](https://github.com/sst/models.dev), MIT) is the
upstream of what opencode fetches: a community-maintained TOML database (by the SST team, built
for opencode) served as JSON:

- `https://models.dev/api.json` — provider-keyed: models with cost, limits, modalities,
  capabilities, plus per-provider `npm` (AI SDK package) and `env` (API-key env var names).
- `https://models.dev/models.json` — provider-agnostic model facts.
- `https://models.dev/catalog.json` — both combined (~150 providers, ~5,300 provider-model rows).

**TanStack AI** ([tanstack.com/ai/latest](https://tanstack.com/ai/latest)) provides the
*compile-time* half: each adapter (`@tanstack/ai-openai`, `-anthropic`, `-gemini`, `-openrouter`,
…) type-gates model IDs, per-model `modelOptions`, content modalities, and provider-tool pairings
— invalid model names or incompatible tools are TypeScript errors
([per-model type safety](https://tanstack.com/ai/latest/docs/advanced/per-model-type-safety),
[beta announcement](https://tanstack.com/blog/tanstack-ai-beta)). That's a static union baked into
the package version — great for correctness of the code paths we ship, useless as a live catalog
(no pricing, no new-model pickup between releases, no cross-provider metadata).

**Recommendation:** fetch models.dev (`api.json`) as the runtime catalog for the picker — filter
to the providers cogwork has adapters for, cache with TTL + bundled-snapshot fallback the
way opencode does — and let TanStack AI's types validate the models we hardcode (defaults, tests).
Don't invent a third catalog. The `env` field in models.dev doubles as the source for "which env
var do we read for this provider," same trick opencode uses.

---

## 5. Recommended credential architecture for cogwork

cogwork already has the right seam: `packages/engine/src/credential-store.ts` defines a
`CredentialStore` service resolving stored-OAuth → client-credentials → env, with schema-validated
persistence (`CredentialFile`, version 1) in `~/.cogwork/credentials.json`, single-flight
refresh gating per account, and `Redacted` tokens throughout. Extend it; don't replace it.

**Build order (by leverage / risk):**

1. **API keys for every provider** (now). Add a `Key` variant alongside `StoredToken` (mirroring
   opencode's `Credential.Value` union) and drive "which providers / which env vars" from the
   models.dev catalog. This is the universal floor: it's the only compliant path for Anthropic and
   Google, and it works for OpenAI, OpenRouter, xAI, Groq, Mistral, etc.
2. **OpenRouter OAuth PKCE** (first login button). Zero ToS risk, no client registration, and the
   exchanged artifact is a plain API key — so it stores as a `Key` credential with metadata, no
   refresh machinery needed. One login covers 300+ models, which is the best possible
   "eventually-casual user" experience.
3. **OpenAI ChatGPT OAuth** (fast follow, behind a flag). Implement the Codex PKCE + device flow
   as opencode does, with an honest originator identifier. Medium ToS risk — no written
   authorization exists — so label it clearly ("uses your ChatGPT plan") and keep API-key fallback
   one click away in case OpenAI's posture changes.
4. **Do not build Anthropic or Google subscription OAuth.** Anthropic's prohibition is explicit,
   written, and enforced without notice; Google's consumer surface no longer exists. Claude and
   Gemini are API-key providers here, full stop.
5. **GitHub Copilot: only via partnership.** The opencode precedent shows GitHub will bless
   third-party harnesses; pursue it if/when cogwork wants Copilot, rather than shipping the
   `copilot_internal` gray path.

**Where tokens live:** stay with `~/.cogwork/credentials.json` (0600) rather than adopting
opencode's SQLite — the daemon already owns that file and the versioned-schema migration path
(`version: 1` → `2` adding a `provider` credential kind) is cheap. Keep the existing per-account
semaphore refresh gating; OpenRouter needs none (keys don't expire), ChatGPT OAuth reuses the
`TokenRefresh` seam that Linear tokens already exercise.

---

## Sources

- Anthropic, Claude Code Legal and compliance — https://code.claude.com/docs/en/legal-and-compliance
- Anthropic Consumer Terms — https://www.anthropic.com/legal/consumer-terms
- The Verge on the April 4, 2026 third-party cutoff — https://www.theverge.com/ai-artificial-intelligence/907074/anthropic-openclaw-claude-subscription-ban
- OpenAI Codex authentication — https://developers.openai.com/codex/auth
- OpenAI Help Center, "Using Codex with your ChatGPT plan" — https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan
- OpenAI Apps SDK auth (identity-only third-party surface) — https://developers.openai.com/apps-sdk/build/auth
- Google, Gemini Code Assist consumer deprecation — https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals
- Gemini CLI authentication docs — https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/authentication.mdx
- OpenRouter OAuth PKCE — https://openrouter.ai/docs/guides/overview/auth/oauth and https://openrouter.ai/docs/api/api-reference/oauth/exchange-authorization-code-for-api-key
- GitHub Changelog, Copilot × opencode partnership — https://github.blog/changelog/2026-01-16-github-copilot-now-supports-opencode/
- GitHub Copilot CLI authentication — https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli
- opencode Copilot token-exchange discussion — https://github.com/anomalyco/opencode/pull/19350
- models.dev — https://github.com/sst/models.dev and https://models.dev/api.json
- TanStack AI — https://tanstack.com/ai/latest/docs/getting-started/overview and https://tanstack.com/ai/latest/docs/advanced/per-model-type-safety
- opencode vendored source — `.repos/opencode/packages/core/src/{credential.ts,integration.ts,models-dev.ts}`, `.repos/opencode/packages/core/src/plugin/provider/{openai.ts,opencode.ts,anthropic.ts,github-copilot.ts}`, `.repos/opencode/packages/schema/src/credential.ts`, `.repos/opencode/packages/web/src/content/docs/providers.mdx`
- cogwork credential seam — `packages/engine/src/credential-store.ts`
