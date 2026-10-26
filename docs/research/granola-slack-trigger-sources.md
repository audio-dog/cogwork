# Research: Granola and Slack as Trigger sources

Resolves [#779](https://github.com/colonylabs/cogwork/issues/779), part of the
[Customizable Workflows map (#656)](https://github.com/colonylabs/cogwork/issues/656).

**Question**: what do Granola and Slack offer as Trigger sources, and what does each need from
Cogwork?

This note builds on [`feldspar-workflow-ideas.md`](./feldspar-workflow-ideas.md) (#657), which
surveyed Feldspar's workflows and already recorded its watermark-plus-grace ingestion (§3.6) and its
directed-at-me salience filter (§3.1). It does not repeat those. It goes one level down: how
Feldspar reads each source, what the sources themselves expose, and what that fixes for a Trigger.

All claims were read on 2026-10-26. Feldspar paths are relative to `~/sites/feldspar`. Granola's
local artifacts are under `~/Library/Application Support/Granola/` on this machine. Web sources are
Granola's own API docs (`docs.granola.ai`) and Slack's own developer docs (`docs.slack.dev`,
`api.slack.com`). Each claim names its source inline.

---

## 1. The short answer

| | Granola | Slack |
| --- | --- | --- |
| **Event kinds a Trigger can name** | `transcript ingested` (a note first appears with summary and transcript). `meeting ended` is not a separate signal; it is the same moment, and the public API has no event for it. Plus `note edited` (summary regenerated). | `message directed at me` (DM, @mention), `message in a channel`, `reaction added`. All three are first-class Slack events. |
| **Stable identity** | `note_id` (`not_` + 14 chars) plus `updated_at`. Webhook `event_id` is reused on retry. | `(team_id, channel, ts)`. `ts` is unique per channel. Events API `event_id` is globally unique. |
| **How to observe** | **Poll** `GET /v1/notes?updated_after=` with a watermark; the API has a true modified-since filter. Webhooks need a public HTTPS URL and a Business plan. | **Socket Mode**: a WebSocket the daemon opens; no public URL. Polling `conversations.history` is the fallback and is rate-limited hard for a shared app. |
| **Where the sensor runs** | In the daemon, as an engine port (ADR 0017). Granola's local files are encrypted, so the local disk is not a readable signal. | In the daemon, holding the socket. |
| **Connection** | `granola/<email>`, API key (`grn_`). No login flow; Granola sells a key. | `slack/<team>`, bot token (`xoxb-`) and app-level token (`xapp-`) from a Slack app the person creates in their own workspace. Optionally a user token (`xoxp-`) for "me" = the human. |
| **Plugin** | Could pair with a Granola MCP Plugin (`https://mcp.granola.ai/mcp`), but the MCP server uses browser OAuth, not the API key. One Connection does not serve both. | No first-party Plugin today. A Slack MCP Plugin would be a separate OAuth grant. |
| **Work context** | One note: summary markdown, attendees, calendar event, transcript items (speaker, text, times). Transcripts are tens of KB; the API pages them at 100 items. | One message plus its thread via `conversations.replies`, plus channel and sender names. Messages are small; a thread is bounded by `limit` (up to 1000 for an internal app). |

---

## 2. Feldspar, one level down

Feldspar's prior research recorded the *shape* of ingestion. These are the facts underneath it.

### 2.1 How Feldspar reads Granola

- **Through Granola's hosted MCP server, not the public REST API and not local files.** The
  preset `granola` points at `https://mcp.granola.ai/mcp` (`src/renderer/entry.tsx:123`,
  `src/renderer/pages/Settings/Settings.tsx:100`). Sync goes through
  `McpRemoteDocumentProvider.syncGranolaDocuments`
  (`src/main/external-context/providers/mcpRemoteDocumentProvider.ts:895`): it initializes an MCP
  session, lists tools, picks a list tool from `["list_meetings", "search_meetings",
  "granola-list-notes"]` (line 905) and a transcript tool from `["get_meeting_transcript", ...]`
  (lines 1075–1083).
- **The list is cheap; the transcript is the expensive call.** There is no bulk transcript tool, a
  transcript is "~tens of KB", and a tight loop trips Granola's "Rate limit exceeded" guard, so
  Feldspar sleeps 350 ms between transcript calls and retries twice with backoff (lines 92–100).
  `get_meetings` accepts at most 10 ids per call (line 91).
- **A transcript grows while the meeting is live.** Feldspar re-fetches a stored transcript until
  the meeting is 12 hours old, because "a transcript pulled mid-meeting is PARTIAL"
  (`GRANOLA_TRANSCRIPT_FINALIZE_WINDOW_MS`, lines 105–117; `isStoredGranolaTranscriptFinal`,
  line 127). A stored doc shorter than 6000 chars is treated as a summary, not a transcript
  (line 104).
- **Speaker labels changed under them.** The hosted MCP started emitting `Microphone:` /
  `Speaker:` instead of `Me:` / `Them:` around 2026-07-11; Feldspar normalizes at ingest
  (`normalizeGranolaTranscriptSpeakerLabels`, lines 141–165).
- **Identity**: one meeting is one `remote_context_documents` row with `url =
  granola://meeting/<meetingId>` (line 987). Dedup is by `(source_id, url)` through
  `findRemoteContextDocumentBySourceUrl`. A re-sync re-persists only when
  `remoteContextDocumentContentChanged` says the text differs after whitespace normalization
  (`src/main/external-context/models/remoteContextDocument.ts:63`). A "never-downgrade" guard
  refuses to overwrite a stored transcript with a thinner payload (`isGranolaContentDowngrade`,
  `mcpRemoteDocumentProvider.ts:194`).
- **Watermark**: `oauth_mcp_servers.last_queried` (the source row; `ContextSourceTable` in
  `src/main/external-context/models/contextSource.ts:50–72`), advanced by `markServerQueried` at
  the end of a sync (`mcpRemoteDocumentProvider.ts:1006`). The next window starts at
  `min(last_queried, now − 3 days)` for Granola (`computeProviderSince`,
  `src/main/external-context/jobs/sourceSyncJob.ts:41–55`; `DEFAULT_SYNC_GRACE_DAYS = 3`,
  line 31; first sync looks back 14 days, line 19). The grace exists because the list tool
  filters by created date only.
- **Credential**: an MCP OAuth access token (plus refresh token, scopes, expiry —
  `OAuthMcpCredentialPayload`, `contextSource.ts:10–17`), stored as `credential_ciphertext` in the
  same source row. The ciphertext is produced by `createSafeStorageCredentialProtector`
  (`src/main/mcp/credentialProtection.ts`), which prefers a local AES-256-GCM key file
  (`mcp-servers/credential-key.json` under `userData`) over Electron `safeStorage`
  (`src/main/mcp/oauthMcpServers.ts:10–20`). Feldspar uses Granola's Dynamic Client Registration
  and a loopback callback on `127.0.0.1/oauth/callback`
  (`src/main/mcp/oauthMcpServerService.ts:333–349`).

### 2.2 How Feldspar reads Slack

- **Two paths, one connector.** The live Slack Web API path (`SlackConnector` with
  `SlackFetchGateway`, `src/main/external-context/connectors/slackConnector.ts`) and a hosted
  "Slack Archive" MCP (`https://slack-history-repo.scribehow.com/mcp`,
  `src/shared/contextAppPresets.ts:2`). The direct Web API connector was **retired to legacy**
  once the archive shipped, because running both "double-ingested every Slack message" and
  "spawned duplicate todos/cards" (`contextAppPresets.ts:38–43`). The archive is Feldspar's own
  service; it is not something Cogwork can reuse.
- **Units, not messages.** The Web API path enumerates **conversations** (every DM and group DM
  via `conversations.list types=im,mpim`), plus two workspace-wide searches as opaque units: the
  `<@me>` mention search and the `from:@me` search (`slackConnector.ts:11–26`, 41–55). Active
  channels are deliberately *not* in the core (line 15). Each conversation drains most-recent-first
  through `conversations.history`; the searches go through `assistant.search.context`
  (`slackConnector.ts:314–317`; `src/main/external-context/providers/slackApi.ts:5–14` lists every
  method Feldspar calls — note `conversations.replies` is **not** among them).
- **Watermark**: the source's `last_queried`, advanced **only when every in-scope unit drained
  completely** (`slackConnector.ts:385–390`). The window is `max(now − 14 days, last_queried − 1
  day)` (`resolveSince`, lines 406–421; `SLACK_INCREMENTAL_GRACE_MS = 1 day`, line 71).
- **Identity**: `slack_messages` has `UNIQUE (workspace_key, channel_id, slack_ts)` and carries
  `thread_root_ts`, `sender_user_id`, `permalink`, and `raw_payload_json`
  (`src/main/external-context/database/externalContextMigrations.ts:128–153`). The document URL is
  `slack://conversation/<channel>/message/<ts>` (`slackConversationProvider.ts:3279`), or the Slack
  permalink when one is known.
- **"Directed at me" is a deterministic filter**, not an event: DM, an `<@Uself>` token, or a
  direct question (`?`), resolved against the self identity
  (`src/main/external-context/jobs/salienceDetector.ts:146–161, 329–330`). The self id must be
  known before the two searches can run at all (`slackConnector.ts:133–134`).
- **Credential**: a Slack **user** token obtained by OAuth with the scopes in
  `slack-app-manifest.yaml` — `channels:history`, `groups:history`, `im:history`,
  `mpim:history`, `*:read`, `search:read.*`, `users:read`, `users:read.email`, `chat:write`,
  `im:write` — with `socket_mode_enabled: false` and `token_rotation_enabled: true`. The redirect
  is a custom URI scheme (`scribehow://mcp-oauth/callback`) and the manifest comment says PKCE
  must stay on for that reason. The token lives in the same `credential_ciphertext` column as
  Granola's.

### 2.3 What this fixes for Cogwork

Feldspar paid for three things Cogwork can avoid by reading the sources directly:

1. A **grace window** because the Granola list tool filters by created date. Granola's public API
   has `updated_after` (§3.2), which is a true modified-since watermark.
2. **Polling for threads it never fetched**: Feldspar has no `conversations.replies` call, so the
   "whole conversation" context it prizes (#657 §2.B) comes from the drained history, not from the
   thread the message is in. Slack's thread API is one call (§4.4).
3. **Two Slack read paths** that double-ingested. Cogwork should have one.

---

## 3. Granola

### 3.1 What is on this machine

`~/Library/Application Support/Granola/` on 2026-10-26 (Granola desktop 7.668.3, per an update
check URL in `sentry/scope_v3.json`):

| File | Size | What it is |
| --- | --- | --- |
| `cache-v6.json.enc` | 2.1 MB | The app's document cache. **Encrypted.** No readable header; not JSON. |
| `granola.db`, `granola.db-wal`, `granola.db-shm` | 20 MB + 4 MB | A SQLite-shaped store (WAL files present). **Encrypted**: the first 16 bytes are not `SQLite format 3\0`, and `sqlite3` reports "file is not a database". |
| `supabase.json.enc` | 2.9 KB | The auth session. **Encrypted.** |
| `user-preferences.json.enc`, `stored-accounts.json.enc`, `window-state.json.enc` | small | Encrypted preferences and account list. |
| `local-state.json` | 19.5 KB | Plain JSON. One key, `featureFlags`. |
| `local-asr/`, `sherpa-native/` | 108 MB | A local speech model (`sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en`), on-device ASR. |
| `sentry/scope_v3.json` | 206 KB | Sentry breadcrumbs: the app's own API hosts. |
| Chromium folders (`Cache`, `IndexedDB`, `Local Storage`, `Session Storage`, …) | | Electron's. |

**The artifact outranks the docs, and the artifact is sealed.** Every file that would hold a
transcript or a token carries a `.enc` suffix or an opaque header. `local-state.json` names the
flags that did it: `encrypted_cache_storage: true`, `encrypted_supabase_storage: true`,
`encrypted_preferences_storage: true`, `ydoc_sqlite_storage: true`. Earlier Granola builds kept a
plain `cache-v3.json` and `supabase.json` that community tools read; that path is closed on this
build. Cogwork must not try to open it. Reading a local-first app's private store is also the
wrong trust posture: the file is Granola's, not the person's export.

`local-state.json` also records what Granola has shipped server-side, all `true` here:
`public_api_transcripts_enabled`, `public_api_user_notes_enabled`, `public_api_folders_enabled`,
`webhooks_api`, `enable_webhook_ui`, `folder_webhooks`, `mcp_enabled`, `api_keys_page_enabled`,
`zapier_integration`. The Sentry breadcrumbs show the app talking to `api.granola.ai/v1/*`
(`insert-transcriptions`, `refresh-calendar-events`, `get-document-metadata`, …). That is the
app's private API, not a supported surface.

The `supabase.json.enc` file is where the account session lives. It stays on disk; this note
describes it and does not copy it.

### 3.2 The public API

Source: [docs.granola.ai/introduction](https://docs.granola.ai/introduction),
[List Notes](https://docs.granola.ai/api-reference/list-notes),
[Get Note](https://docs.granola.ai/api-reference/get-note),
[Get Transcript](https://docs.granola.ai/api-reference/get-transcript),
[Changelog](https://docs.granola.ai/api-reference/changelog).

- **Base**: `https://public-api.granola.ai/v1`. Bearer API key, prefix `grn_`. Keys are made in
  the desktop app at Settings → Connectors → API keys with one or both access scopes, *Personal
  notes* and *Public notes*. "Any workspace member on a Business plan can create API keys."
  Workspace admins can also create non-expiring workspace keys.
- **`GET /v1/notes`**: filters `created_after`, `created_before`, **`updated_after`**,
  `folder_id`, `space_id`; `page_size` 1–30 (default 10); cursor pagination (`hasMore`, `cursor`).
  Each `NoteSummary` has `id` (`^not_[a-zA-Z0-9]{14}$`), `title`, `owner {name, email}`,
  `created_at`, `updated_at`, `deleted_at`.
- **`GET /v1/notes/{id}?include=transcript`**: adds `web_url`, `calendar_event {event_title,
  invitees[], organiser, calendar_event_id, scheduled_start_time, scheduled_end_time}`,
  `attendees[] {name, email}`, `folder_membership`, `space_membership`, `summary_text`,
  `summary_markdown`, `private_notes_text` / `private_notes_markdown` (owner's key only), and
  `transcript[] {speaker {source: microphone|speaker, attribution: me|them, diarization_label,
  name}, text, start_time, end_time}`. If the transcript is too large to inline the call returns
  `413 TRANSCRIPT_TOO_LARGE`.
- **`GET /v1/notes/{id}/transcript`**: the same items, cursor-paged, `page_size` 1–100
  (default 50).
- **Visibility rule that defines the event**: "The API only returns notes that have a generated
  AI summary and transcript. Notes that are still being processed or were never summarized won't
  appear in responses — the List Notes endpoint excludes them, and the Get Note endpoint returns
  a 404."
- **Rate limit**: 25-request burst over 5 s, 5 req/s sustained (300/min), `429` on excess.
- **Retention caveat**: a person or an enterprise can auto-delete transcripts after 1 day to
  1 year; notes stay, transcripts go, permanently
  ([Transcript auto-deletion](https://docs.granola.ai/help-center/consent-security-privacy/transcript-auto-deletion)).
  A Trigger that fires late may find a note with no transcript.

### 3.3 Webhooks

Source: [docs.granola.ai/webhooks](https://docs.granola.ai/webhooks),
[Create Webhook Endpoint](https://docs.granola.ai/api-reference/create-webhook-endpoint).

- Events: `note.generated` ("the first AI summary for a note is generated"), `note.edited`
  ("summary is edited or regenerated", with `data.changed_fields`, today always `["summary"]`),
  `note.access_granted`.
- Payload: `{event_id, event_type, note_id, occurred_at}` only. "Payloads carry no note content.
  When you receive one, fetch the note with your API key."
- Delivery: Standard Webhooks signature (`webhook-id`, `webhook-timestamp`, `webhook-signature`,
  HMAC-SHA256 over `id.timestamp.body` with a `whsec_` secret shown once). 15 s to answer `2xx`.
  Retries with exponential backoff for four days; retries reuse `event_id`. After four days of
  failure the endpoint is disabled and "events missed while disabled are not replayed".
- **Constraints**: "The URL must be HTTPS and publicly reachable; addresses on private networks
  are rejected." "Webhooks are available on Business and Enterprise plans."

### 3.4 The hosted MCP server

Source: [Granola MCP](https://docs.granola.ai/help-center/sharing/integrations/mcp).

`https://mcp.granola.ai/mcp`, Streamable HTTP, browser OAuth with Dynamic Client Registration;
"there is no API key or service account access method for MCP". Tools: `list_meetings`,
`get_meetings`, `get_meeting_transcript` (paid plans), `get_meeting_attachment`,
`list_meeting_folders`, `query_granola_meetings`, `get_account_info`, `switch_workspace`,
`sign_out`. "Rate limits currently average around 100 requests per minute across all tools." Free
plan sees only the last 30 days. This is the surface Feldspar built on (§2.1), and the one that
changed speaker labels under it.

### 3.5 What this fixes for a Granola Trigger

**Event kinds.**

- `transcript ingested` is real: the moment a note first appears in `GET /v1/notes` (it appears
  only once summary and transcript exist, §3.2), or a `note.generated` webhook. Call it what it is
  in the catalog: *Note generated*.
- `meeting ended` is **not a separate signal**. Granola stops transcribing on call-end detection,
  15 minutes of silence, sleep, or a click
  ([How transcription works](https://docs.granola.ai/help-center/taking-notes/transcription)),
  and then generates the summary. The public API exposes no "ended" event and no transcription
  state. `calendar_event.scheduled_end_time` is the scheduled end, not the real one. A Trigger
  named *Meeting ended* would fire at the same moment as *Note generated*, so the catalog entry
  is redundant; keep one.
- A third kind exists that the catalog lacks: *Note edited* (`note.edited`, or `updated_at`
  advancing on a known note). A person can also *resume* transcription on an ended note and
  regenerate, which arrives as the same edit.

**Identity.** `note_id` is the stable key; `(note_id, updated_at)` dedupes a re-read, because a
regenerated summary bumps `updated_at`. Webhook `event_id` dedupes a redelivery. Transcript items
have no id; use `(note_id, start_time, speaker.source)` if a Trigger ever needs one.

**Observation.** Poll `GET /v1/notes?updated_after=<watermark>` with `page_size=30`. The filter
is modified-since, so the grace window Feldspar needed shrinks to a safety margin (minutes) against
clock skew, not days. Granola's cost model is the inverse of Slack's: the list is cheap at
300/min, and the transcript is one or two more calls per new note. Webhooks are better latency but
need a public HTTPS endpoint and a Business plan; a local-first daemon has neither by default.
Feldspar's 12-hour "transcript may still be growing" window does **not** carry over: the public
API hides a note until its summary and transcript exist, and a later regeneration arrives as
`note.edited`.

**Connection.** System `granola`, account = the owner email that `GET /v1/notes/{id}` reports for
the person's own notes (or whatever `get_account_info` reports; the REST API has no `whoami`, so
the account is best read from the first owned note or typed, as Linear's is). Source: a pasted API
key, the `stored-key` kind the Credential store already has
(`packages/engine/src/credential-store.ts`). ADR 0017 allows this: "an API key is valid where
[a system] does not [offer a login]". The Control store check constraint
`connections_system IN ('github','linear')` (`packages/engine/src/control-store-schema.ts:41`)
must widen.

**Plugin pairing.** A Granola MCP Plugin would need the OAuth grant to `mcp.granola.ai`, which is
a different credential from the API key. Under ADR 0017's one-grant-per-account rule, that is a
second Connection or a Connection with two secrets. Recommendation: ship the Trigger on the API key
alone and do not pair a Plugin until an Operation needs Granola tools at Run time; a Run already
receives the transcript as frozen Work context (ADR 0030), so the MCP server would be optional
context at most.

**Work context.** One note: `summary_markdown`, `attendees`, `calendar_event`, and the transcript
items. Feldspar measured transcripts at tens of KB; the API's 413-then-paginate behaviour agrees
that some do not fit inline. Freeze the summary and the transcript text at admission; carry
`web_url` as the Resource reference.

**Catalog check** (`apps/desktop/src/renderer/src/features/workflow-catalog.ts:119–125`):
*Transcript ingested* — supported (rename to *Note generated*). *Meeting ended* — not supportable
as a distinct event; drop or alias.

---

## 4. Slack

### 4.1 Three ways to observe

Source: [Events API](https://docs.slack.dev/apis/events-api/),
[Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/),
[Comparing HTTP & Socket Mode](https://docs.slack.dev/apis/events-api/comparing-http-socket-mode/),
[conversations.history](https://docs.slack.dev/reference/methods/conversations.history/).

| | Events API over HTTP | Socket Mode | Polling `conversations.history` |
| --- | --- | --- | --- |
| Needs a public URL | Yes (Request URL, HTTPS) | **No** | No |
| Credential | bot/user token for scopes | the same **plus** an app-level token (`xapp-`) for `apps.connections.open` | bot or user token |
| Delivery | POST per event; ack `2xx` in 3 s; 3 retries (now, +1 min, +5 min); `x-slack-retry-num` header | Same payload in an envelope `{payload, envelope_id, type, accepts_response_payload}`; ack by echoing `envelope_id`; no signature check needed | Pull; `oldest`/`latest`/cursor |
| Connection life | stateless | URL from `apps.connections.open`, refreshes "once every few hours", `disconnect` with `refresh_requested`; up to 10 concurrent sockets | n/a |
| Volume cap | 30,000 events / workspace / app / hour | same | Tier 3, 50+/min — **or Tier 1, 1/min, 15 messages**, see §4.3 |
| Marketplace | required for listing | "Apps using Socket Mode are not currently allowed in the public Slack Marketplace" | n/a |
| Slack's own guidance | "we recommend using HTTP for production" | "if it is a requirement that you work behind a firewall and do not have the ability to expose HTTP endpoints, Socket Mode is there for you" | "Most apps do not need the ability to read the full content of a channel" |

### 4.2 The events and their scopes

Source: [message](https://docs.slack.dev/reference/events/message/),
[message.im](https://docs.slack.dev/reference/events/message.im/),
[app_mention](https://docs.slack.dev/reference/events/app_mention/),
[reaction_added](https://docs.slack.dev/reference/events/reaction_added/).

| Catalog entry | Slack event | Scope | Notes |
| --- | --- | --- | --- |
| Message directed at me (DM) | `message.im` | `im:history` | `channel_type: "im"`. For a bot token: DMs to the bot. For a user token: the person's DMs. |
| Message directed at me (@mention) | `app_mention` | `app_mentions:read` | Mentions of **the app's bot user** only, and only in conversations the app is in. "Messages sent to your app in direct message conversations are not dispatched via `app_mention`." There is **no** event for "a human was @mentioned"; that is `message.*` plus a text filter for `<@Uself>` — Feldspar's rule (§2.2). |
| Message in a channel | `message.channels` / `message.groups` / `message.mpim` | `channels:history` / `groups:history` / `mpim:history` | Bot token: channels the bot is a member of. User token: everything the user can see. |
| Reaction added | `reaction_added` | `reactions:read` | `item {type: message, channel, ts}`, `reaction` (emoji name), `user`, `item_user`. |

Every inner event carries `event_ts`; message events carry `ts` ("the unique (per-channel)
timestamp"), `channel`, `user`, `text`, and `thread_ts` when in a thread. Edits arrive as subtype
`message_changed`; deletes as `message_deleted` with `hidden: true`. The outer envelope carries
`team_id`, `api_app_id`, `event_id` ("globally unique across all workspaces"), `event_time`, and
`authorizations[]`.

### 4.3 The rate-limit fork

Source: [Rate limit changes for non-Marketplace apps (2025-05-29)](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps),
[Slack changelog](https://api.slack.com/changelog/events-api), [Tokens](https://docs.slack.dev/authentication/tokens/).

`conversations.history` and `conversations.replies` are Tier 3 (50+/min, `limit` up to 999/1000)
**for Marketplace apps and for "internal customer-built apps"**. For apps "commercially
distributed outside of the Marketplace" they are Tier 1: **1 request per minute, 15 objects per
request**, applied to new installs since 2025-05-29 and to existing installs since 2026-03-03.
Slack's stated reason: these methods "have the potential to exfiltrate large amounts of sensitive
conversational data".

This decides the Connection shape. If Cogwork ships **one Slack app** (one client id) that every
person installs, Cogwork is a non-Marketplace distributed app: thread reads drop to 1/min and
Socket Mode is barred from the Marketplace route. If **each person creates a Slack app in their own
workspace** from a manifest Cogwork supplies, it is an internal customer-built app: Tier 3 reads,
Socket Mode allowed, no Cogwork-owned client secret, and no OAuth redirect to host. Slack's OAuth
also requires `redirect_uri` to "use HTTPS"
([Installing with OAuth](https://docs.slack.dev/authentication/installing-with-oauth/)), which a
local daemon cannot offer without a hosted relay. Feldspar's manifest sidestepped this with a
custom URI scheme and then retired the connector (§2.2).

**Recommendation**: the per-workspace manifest app. The person pastes its bot token (`xoxb-`) and
app-level token (`xapp-`) into the Connections page; both are the `stored-key` kind. This is a
**borrow** from how every Socket Mode tutorial Slack publishes is set up, not a standard; record it
as such.

### 4.4 Thread context

Source: [conversations.replies](https://docs.slack.dev/reference/methods/conversations.replies/).

`conversations.replies(channel, ts)` returns the parent and every reply, earliest first, cursor
paged, `limit` default 1000 (15 for a Tier 1 app). Replies carry `thread_ts` (the parent's `ts`)
and `parent_user_id`. "If there are no replies then just the single message referenced by `ts` will
return." One call per Trigger firing turns a message event into a message-with-thread Work context.
`users.info` (scope `users:read`) resolves `U…` ids to names; `conversations.info` resolves `C…`
to a channel name.

### 4.5 What this fixes for a Slack Trigger

**Event kinds.** All three catalog entries map to real events (§4.2). The one correction: *Message
directed at me* has two meanings, and the spec must pick one or name both.

- *Me = Cogwork's bot*: `app_mention` + `message.im` on the bot token. Clean, low volume, exactly
  what Slack designed. The person must invite the bot to channels.
- *Me = the human*: a **user token** (`xoxp-`, user scopes `channels:history`, `groups:history`,
  `im:history`, `mpim:history`) subscribed to all `message.*` events, and a deterministic filter
  for DM / `<@Uself>` / direct question, as Feldspar does. Higher volume (every message the person
  can see), and the Run acts with the person's own read access.

Feldspar chose the human (#657 §2.B). For Cogwork's Phase 3 posture — a bot persona that is
invited where it should listen — the bot reading is the smaller trust surface and needs no
self-identity bootstrap. Offer the bot reading first.

**Identity.** `(team_id, channel, ts)` is the message key, as Feldspar's `UNIQUE` constraint
encodes. `event_id` dedupes a redelivered event, and `x-slack-retry-num` (HTTP) or a repeated
`envelope_id` (socket) marks a retry. A reaction's key is `(team_id, item.channel, item.ts,
reaction, user)`. An `edited` message keeps its `ts`; treat `message_changed` as a new event on the
same key if a Trigger wants edits.

**Observation.** Socket Mode from the daemon. The daemon calls `apps.connections.open` with the
`xapp-` token, holds the WebSocket, acks each envelope, and reconnects on `refresh_requested`;
Slack's guidance to open a second socket before a scheduled restart fits an Effect fiber with a
supervisor. There is no watermark: delivery is push, "best-effort", and "by default, we will not
attempt to deliver an event that is more than two hours late" unless Delayed Events is on. A
**scheduled sweep backstop** (the #657 §3.1 pattern) over `conversations.history` with a short
`oldest` catches what the socket missed while the daemon was down — at Tier 3 this is cheap; at
Tier 1 it is not, which is one more reason for the per-workspace app.

**Connection.** System `slack`, account = `team_id` (or the team domain) that `auth.test` returns
for the bot token; the same call returns the bot's `user_id` and `bot_id`, which is the "me" the
directed-at-me filter needs, and it needs no scope
([auth.test](https://docs.slack.dev/reference/methods/auth.test/)). Two secrets under one Connection — bot token and app-level token — or three with
a user token. ADR 0017's "one grant serves every port on one account" already accepts a union of
scopes on one Connection; two token strings for one account is the same idea and should be stored
as one Connection with a composite credential, not two Connections.

**Plugin pairing.** None today. A Slack MCP Plugin for Run-time tools would want the same bot
token, so the pairing is natural if one is built; the Slack *Send a message* and *Reply in thread*
output actions in the catalog are engine output actions over the same Connection, not Plugin tools.

**Work context.** The message (`text`, `user`, `channel`, `ts`, `thread_ts`, `permalink` via
`chat.getPermalink`), the thread from `conversations.replies`, and resolved user and channel
names. Slack truncates a message over 40,000 characters and recommends 4,000
([chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/)); most are a few
hundred bytes. A thread is at most `limit` messages per page. Freeze the thread at admission (ADR 0030); a reply
posted mid-Run reaches the next round.

**Catalog check** (`workflow-catalog.ts:108–118`): *Message directed at me* — supported, with the
bot-vs-human choice above. *Message in a channel* with options `#engineering`, `#product` —
supported; the option list must come from `conversations.list` on the Connection, not be typed.
*Reaction added* with options `👀`, `✅` — supported; Slack delivers emoji **names**
(`eyes`, `white_check_mark`), so the option must be stored as the name and rendered as the glyph.

---

## 5. ADR 0022 applied: where each sensor lives

ADR 0022 says a sensor lives where its signal is produced, and ADR 0021's reason for putting the
first sensor in the engine was that "cogwork's daemon is already resident on the machine where the
signals live."

- **Granola.** The audio is captured on this machine, but the signal a Trigger needs — a note
  with its summary and transcript — is produced in Granola's cloud, and the local copy is
  encrypted (§3.1). So the daemon is not where the signal is readable; Granola's API is. A sensor
  at the signal would be a webhook receiver, which needs a public HTTPS endpoint the daemon does
  not have. The honest shape for a local-first daemon is a **poll from the daemon**: ADR 0017
  already names this — "a phase-3 context source such as Granola, whose ingestion, watermark, and
  dedup are engine-driven." When the daemon goes remote (the turn `technical-disposition.md`
  says to survive), the same port grows a webhook receiver and the poll becomes the backstop.
- **Slack.** The signal is produced in Slack's cloud. Socket Mode lets the daemon hold a
  connection *to* where the signal is without exposing itself, which is the closest a local-first
  daemon can get to living at the signal. ADR 0022's second instance put the sensor on a GitHub
  runner because GitHub supplied auth and scheduling natively; here Slack supplies delivery
  natively over the socket, and the daemon supplies the credential and the restart supervision it
  already has for the reconcile heartbeat.

Both sensors are therefore engine code in the daemon, as the two ADRs together require. Neither is
a Plugin: ADR 0017 is explicit that no sensor role is Plugin-supplied.

---

## 6. Flags for the Workflows spec

1. **Two Trigger shapes, named.** A *polling* Trigger (Granola) = watermark on a modified-since
   field + a small grace + per-event dedup key. A *push* Trigger (Slack) = a held connection + ack
   + a scheduled sweep backstop. The spec should say both exist and that a push Trigger has no
   watermark of its own. (§3.5, §4.5; extends #657 flag 1.)
2. **Event identity is per source and must be declared.** `(note_id, updated_at)`;
   `(team_id, channel, ts)`; plus the delivery id (`event_id`) for redelivery. A Trigger
   definition carries its dedup key, and the engine owns dedup, as ADR 0017 says. (§3.5, §4.5)
3. **"Me" is a Connection fact.** *Message directed at me* resolves against the Connection's
   identity — the bot user id from `auth.test`, or a human's user id if a user token is held. The
   spec should say which reading Cogwork ships first and that the filter is deterministic. (§4.5)
4. **A Connection may hold more than one secret.** Slack needs a bot token and an app-level token
   for one account. ADR 0017's record (id, system, account, status) is unchanged; the Credential
   store entry for one account becomes composite. (§4.5)
5. **Catalog corrections.** Drop or alias Granola *Meeting ended* (no distinct signal); rename
   *Transcript ingested* to *Note generated*; add *Note edited*. Slack channel and emoji options
   are read from the Connection, and emoji are stored by name. (§3.5, §4.5)
6. **Connection setup for Slack is a manifest, not a login.** The person creates an app in their
   workspace from a Cogwork-supplied manifest and pastes two tokens. This keeps Tier 3 reads and
   Socket Mode, and it keeps Cogwork out of the non-Marketplace distributed-app class. The
   Connections page needs a "paste tokens" source for Slack, as it has for Linear. (§4.3)
7. **Late Triggers may find less than they expect.** Granola transcripts can be auto-deleted;
   Slack messages can be edited or deleted after the event. Work context is frozen at admission
   (ADR 0030), so the spec should say a Trigger that fires on an item the source no longer has
   ends with a recorded reason, not a Run. (§3.2, §4.2)
8. **Widen the Control store.** `connections_system IN ('github','linear')` gains `granola` and
   `slack`; boot converges the schema. (§3.5)

## 7. What was not read

- The Granola `.enc` files and `granola.db` were not decrypted and must not be. Their existence
  and sizes are the finding.
- Slack's `assistant.search.context` method, which Feldspar uses for the two workspace searches,
  was not re-read from Slack's docs; Feldspar's call sites and manifest scopes (`search:read.*`)
  are the citation. It is an AI-apps surface and not needed for the bot-persona Trigger.
- Granola's Zapier integration ([docs](https://docs.granola.ai/help-center/sharing/integrations/zapier))
  sends title, creator, attendees, calendar event, private notes, summary markdown, transcript and
  link on *Note added to folder* or *Note shared to Zapier*. It confirms what Granola considers one
  note's payload; it is not a path Cogwork would use.
