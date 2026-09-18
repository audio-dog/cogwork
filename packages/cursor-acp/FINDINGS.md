# Spike #9 — Cursor `agent acp` under TanStack AI `acpCompatible` + `localProcessSandbox`

**Verdict: GO on the ACP path.** Both risks ADR 0004 named are green: session resume
works end-to-end, and Cursor's blocking extension methods produce a clean, gracefully
handled refusal (never a hang under the real adapter). Two gaps to design around at the
engine layer — no token usage over ACP, and the human `--resume` id doesn't resolve
ACP sessions — neither fatal, neither a reason to fall back to `@cursor/sdk`.

Q1 here covers resume across two *completed* turns. For resume after a turn that was killed
mid-flight, see [FINDINGS-RESUME.md](./FINDINGS-RESUME.md) (spike #99).

## Environment

| Piece | Version |
|---|---|
| Cursor CLI (`agent`) | `2026.07.23-e383d2b` |
| `@tanstack/ai` | 0.42.0 |
| `@tanstack/ai-acp` | 0.2.3 |
| `@tanstack/ai-sandbox` | 0.2.4 |
| `@tanstack/ai-sandbox-local-process` | 0.2.0 |
| `@agentclientprotocol/sdk` (transitive) | 0.25.1 (ACP protocol v1) |
| Model | `auto` · Auth | `CURSOR_API_KEY` env |

Launch command the adapter builds: `agent --model <model> acp` (stdio JSON-RPC).
`initialize` negotiates protocol v1 and advertises
`agentCapabilities = { loadSession: true, sessionCapabilities: { list: {} }, promptCapabilities: { image: true, … } }`,
`authMethods = [cursor_login]`.

## Q1 — Session resume across two runs (`session/load` via `modelOptions.sessionId`): **YES**

The retired adapter probe drove two *separate* `agent acp` processes (each a fresh `chat()` under
`localProcessSandbox`). Run 1 emitted `cursor.session-id = 927cfff4…` and planted a
codeword; Run 2 passed `modelOptions: { sessionId: "927cfff4…" }`, re-emitted the
**same** id, and correctly recalled the planted context. Cross-process resume works.

```
run1.sessionId               = 927cfff4-061d-4358-9e4b-601641213a43
run2.requestedResumeId       = 927cfff4-061d-4358-9e4b-601641213a43
run2.emittedSessionId        = 927cfff4-061d-4358-9e4b-601641213a43   ← same id
q1_context_remembered_across_runs = true
```

The known forum bug (`session/load` → "Session not found" right after `session/new`)
did **not** reproduce on build `2026.07.23`; `session/load` succeeded both in-process
(raw probe) and cross-process (sandbox).

**Hidden risk to harden against:** `@tanstack/ai-acp`'s `session/load` failure handling
is a *silent* `try/catch {}` that falls back to `session/new`
(`session/acp-client.js`). If resume ever breaks, the adapter emits a **new** session id
and continues as a fresh session — there is no "resume failed" event. Detection = compare
the echoed `.session-id` to the one you requested. Because on fallback the adapter rebuilds
the prompt from `messages`, the engine's run ledger must keep enough turn history (or verify
the echoed id) so a silent fresh-start doesn't silently drop all prior context.

## Q2 — Final-turn token usage: **NOT reported** (insufficient for a context-limit staleness policy)

The ACP `session/prompt` response is literally `{"stopReason":"end_turn"}` — no `usage`.
`@tanstack/ai-acp` reads `response.usage` (final-turn), which is `undefined`, so no usage
rides on `RUN_FINISHED` (`q2_usage_reported = false` in both runs). No token counts appear
anywhere in the stream: `session_info_update` carries only `{ title }`,
`available_commands_update` the slash-command list (and the adapter drops both anyway).

Consequence: reading `usage.inputTokens` (from `@cursor/sdk`) to
detect near-context-limit staleness has **no equivalent over Cursor ACP today**.

**Re-verified 2026-08-18 on the same CLI build (`2026.07.23-e383d2b`), still true.** The probe's
prompt response is still `{"stopReason":"end_turn"}`. `@tanstack/ai-acp@0.2.6` reads `usage` from
exactly one place — `response.usage` on the ACP prompt response — so with that empty, the whole
cogwork pipeline (which is otherwise fully wired: `agUiUsage` → executor accumulator → run ledger
token columns → `cogwork runs`) records nothing. The counts **do** exist in the CLI's non-ACP
`agent --print --output-format json` mode (`"usage":{"inputTokens":…,"outputTokens":…,
"cacheReadTokens":…,"cacheWriteTokens":…}`), but the harness is deliberately built on ACP
(ADR-0004) and swapping modes to harvest usage isn't worth losing ACP session/resume + telemetry.

**Resolution (issue #2): a documented best-guess estimate at the harness seam.** The Cursor
descriptor's usage estimator attaches an `estimated`-flagged `usage` (`chars/4` over the prompt + streamed
assistant/reasoning text) whenever the real `RUN_FINISHED` carries none. The flag is honest end to
end (`tokens=~N` in the CLI, a tooltip in the desktop drill-in) so it is never read as metered cost;
it undercounts the hidden system prompt / tools / resumed context. Prior art for a Cursor CLI
token-usage shim: <https://github.com/Strus/pi-cursor-cli-provider>. When Cursor adds `usage` to the
ACP prompt response, the real counts flow through unchanged and the estimate steps aside.

### Q2a — How accurate is `chars/4`? **Within ~3% of a real tokenizer on representative text.**

Two things to keep separate:

- **Billed usage** (what `agent --print` reports) is *not* a yardstick for the estimate. A trivial
  30-char prompt reports `inputTokens: 15473` — almost all of it Cursor's hidden system prompt, tool
  schemas, and cached workspace context that never cross the ACP wire (`outputTokens` is likewise
  inflated by hidden reasoning). The estimate deliberately does not model any of that; it is a floor
  on the *conversation-visible* text.
- **Heuristic quality** — does `chars/4` track a real tokenizer on the text the estimator actually
  sees? — is what we validate, offline and deterministically, in `estimate-accuracy.test.ts` against
  gpt-4o's o200k tokenizer (a stable proxy; token density is close across modern BPE tokenizers).

Measured `est/real` over a representative corpus (2026-08-18, o200k):

| sample          | est/real |
|-----------------|----------|
| issue prose     | 1.22     |
| markdown issue  | 0.99     |
| typescript code | 0.94     |
| json payload    | 0.87     |
| agent output    | 1.12     |
| **corpus total**| **1.03** |

Prose runs slightly hot, code and JSON slightly cold, and they roughly cancel — the whole-corpus
estimate lands within 3% of the tokenizer. The test guards this with generous bands (each sample
within ±40%, the corpus within ±25%) so a regression like changing the divisor trips it, without
being brittle to tokenizer-version drift.

## Q3 — Blocking extension methods to a non-answering client: **clean refusal, gracefully handled**

Cursor **does** send `cursor/create_plan` as a *blocking* JSON-RPC request (observed in
plan mode with the full plan payload). `@tanstack/ai-acp` registers no `extMethod` handler,
so the ACP SDK's dispatcher default branch replies `-32601 "Method not found:
cursor/create_plan"` (verified in source *and* live).

Cursor's reaction to the `-32601`: **graceful degradation** — it fell back to writing the
plan to a file (`~/.cursor/plans/…plan.md`) via a normal `tool_call` and finished the turn
with `end_turn`. No hang, no error surfaced to the run.

A deliberately non-answering client (`SPIKE_EXT=hang`, never resolve `cursor/create_plan`)
**hangs the turn indefinitely** (>90 s). But that only happens if you register a handler
that never resolves — the default/refuse path always answers, so under the real adapter the
blocking methods cannot hang the turn.

(`cursor/ask_question` did not fire in agent-mode attempts — the agent asked its clarifying
question as plain assistant text + `end_turn` instead. Handling would be identical: any
unhandled incoming request gets `-32601`.)

## Q4 — Human attach via `cursor-agent --resume <id>`: **NO** (not on this build)

ACP sessions persist to `~/.cursor/acp-sessions/<uuid>/` (per-session SQLite `store.db` +
`meta.json`, bound to the session `cwd`). Our id `927cfff4…` is there. But the interactive
CLI's `--resume` / `agent ls` read a **different** store, `~/.cursor/chats/`, whose ids are
32-char hex without dashes (e.g. `e639fe9f…`). The ACP uuid is not present there.

`agent --resume 927cfff4… --trust -p "…"` started a **fresh** conversation
("we haven't discussed anything yet") rather than loading the ACP session. Extra friction:
headless `--resume` needs `--trust`/`--force` (else it blocks on a workspace-trust prompt),
and `agent ls` is a TUI requiring a real TTY (raw mode) — not headless-friendly.

So programmatic re-attach works (any ACP client can `session/load` the persisted session),
but the pasteable `cursor-agent --resume <id>` human handoff that
`attachCommand` produces does **not** resolve an ACP-origin session id.

## Recommendation

**Confirm the ACP path.** The two ADR 0004 risks are green (Q1 resume works; Q3 blocking
methods = clean, gracefully-handled refusal, never a hang under the real adapter). Design
around two non-fatal gaps at the engine layer:

1. **No token usage over ACP (Q2).** Drive the staleness policy from a heuristic instead of
   `usage.inputTokens`: `resumeMaxAge`, turn count, transcript size, or a periodic
   fresh-session cadence — or get a token estimate from a direct TanStack model-provider call.
   The engine already owns this policy; it just can't read the number from the harness.
2. **Human attach id mismatch (Q4).** `cursor-agent --resume <acpId>` won't resolve ACP
   sessions. Either drop the paste-a-command affordance for Cursor, route human attach through
   an ACP client, or track a Cursor CLI request to unify the `acp-sessions` / `chats` stores.

Also harden against the **silent resume fallback** in `@tanstack/ai-acp` (verify the echoed
`.session-id`; keep full turn history in the ledger). No need to fall back to a
`@cursor/sdk`-backed adapter — the only two things it offers that ACP doesn't are exactly
Q2 and Q4, both manageable above the harness seam. Keep `@cursor/sdk` as the documented
fallback only if a heuristic staleness policy proves inadequate.

## Code gotchas (carry these into the real implementation)

Things that cost time here and will bite again — the seam-level knowledge worth reusing:

1. **`withSandbox` requires a `workspace`, even for a pre-existing local checkout.** Without
   one, `chat()` throws `Middleware "sandbox" declares it provides "sandbox-projection" but
   never called provide()`. The projection capability is only provided when
   `definition.workspace` is set. For a checkout you already have on disk, use
   `defineWorkspace({ source: { type: "none" } })` — it satisfies the capability and skips the
   clone (`bootstrapWorkspace` reads `workspace.source.type` unconditionally, so an omitted
   `source` throws `Cannot read properties of undefined (reading 'type')`).
2. **Bind the checkout with `localProcessSandbox({ dir })`.** A fixed `dir` is used as-is for
   every create/resume and is *not* removed on destroy (`removeOnDestroy` defaults false when
   `dir` is set). The adapter's default virtual cwd `/workspace` maps onto that real dir via
   `resolveHarnessCwd` → `handle.resolve` (leading `/workspace` or `/` is stripped and joined
   under the root, with an escape-the-root guard).
3. **Launch command is `agent --model <m> acp`** — global flags come *before* the `acp`
   subcommand; there is no `--acp` flag. Mode selection is `agent --mode plan|ask acp`
   (or `--plan`). Plan mode is what makes Cursor emit `cursor/create_plan`.
4. **Headless auth = `CURSOR_API_KEY` in the child env.** `localProcessSandbox` inherits
   `process.env`, so the spawned `agent` picks it up. Do **not** set `authMethodId` on the
   adapter — that triggers the ACP `authenticate` / `cursor_login` path; rely on the API key
   (or a prior `agent login`) instead.
5. **Resume wiring:** the session id rides on a CUSTOM event named `"<name>.session-id"`
   (here `cursor.session-id`). Thread it back via `chat({ modelOptions: { sessionId } })`.
   On resume the adapter sends only the trailing user message; on a *silent* load-failure
   fallback it rebuilds the prompt from full `messages` — so keep full turn history in the
   ledger and verify the echoed id.
6. **Headless `agent --resume` blocks on a workspace-trust prompt** unless you pass
   `--trust` (or `--force`/`--yolo`). And `agent ls` is an Ink TUI that needs a real TTY
   (raw mode) — it errors under piped stdio, so it's not usable from a daemon.
7. **ACP session store ≠ interactive chat store.** `~/.cursor/acp-sessions/<uuid>/`
   (SQLite `store.db` + `meta.json`, keyed by `cwd`) vs `~/.cursor/chats/` (hex ids). The
   `attachCommand` handoff must account for this.
8. **No `usage` on the ACP prompt response** — don't build anything that reads
   `RunResult.usage` / `usage.inputTokens` from the harness; it will always be undefined.
9. **The probes ran directly under Node 24's native type stripping.** They needed no build step,
   matching the daemon's node-native approach.

## Archived evidence

The spike scripts were retired after the adapter shipped. This document preserves their findings,
but the original experiments are no longer runnable from this package.
