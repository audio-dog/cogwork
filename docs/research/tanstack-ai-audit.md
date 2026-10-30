# TanStack AI capability audit for the first-party runtime

Resolves [#164](https://github.com/taylorfsteele/cogwork/issues/164), part of wayfinder map [#159](https://github.com/taylorfsteele/cogwork/issues/159). Context: engine ADR 0006 decided to build a first-party agent runtime as a TanStack AI `chat()` loop behind the existing `HarnessRunner` seam (`packages/engine/docs/adr/0006-first-party-runtime-behind-the-harness-seam.md`). This audit answers: **what does @tanstack/ai give us for free, and what do we have to build?**

**Sources.** Installed packages read directly (`@tanstack/ai@0.42.0`, `@tanstack/ai-acp@0.2.3`, `@tanstack/ai-sandbox@0.2.4`, `@tanstack/ai-sandbox-local-process@0.2.0`, resolved under `node_modules/.pnpm/`), the official docs at tanstack.com/ai (fetched from the TanStack/ai `main` branch, 2026-08-05), and the real usage in `packages/cursor-acp/src/harness.ts`.

**Version caveat, read this first.** npm latest is `@tanstack/ai@0.43.0`; the docs describe `main`, which is ahead of our installed 0.42.0. Several capabilities below shipped *within the last minor*: the interrupts API, `@tanstack/ai-persistence@0.1.0`, `@tanstack/ai-sandbox@0.3.0` durable runs, and the `@tanstack/ai-memory` package. The ecosystem is 0.x and moves weekly — e.g. 0.42 exports a built-in `maxToolCalls` strategy while the `main` docs say "there is no built-in `maxToolCalls` strategy" and give a middleware recipe instead ([agentic-cycle](https://tanstack.com/ai/latest/docs/chat/agentic-cycle)). Every "free" claim below should be re-verified against the version we pin when building.

---

## 1. Agent loop control

**Free.** `chat()` runs the full agentic cycle: model turn → execute tool calls → feed results → repeat. The loop is governed by `agentLoopStrategy`, a pure predicate `(state: AgentLoopState) => boolean` evaluated **between model turns** with `{ iterationCount, messages, finishReason, toolCallCount, lastTurnToolCallCount }` (`@tanstack/ai@0.42.0` `dist/esm/types.d.ts` L656–690). Built-ins: `maxIterations`, `maxToolCalls`, `untilFinishReason`, `combineStrategies` (`dist/esm/activities/chat/agent-loop-strategies.d.ts`). Default is `maxIterations(5)` (`dist/esm/activities/chat/index.js` L125). A separate `maxToolCallsPerTurn` option caps parallel fan-out inside a single turn, since strategies can't see mid-turn (`types.d.ts` L720–736).

**Free.** The middleware system is a full lifecycle: `setup`, `onConfig` (init + before every model turn), `onStart`, `onIteration`, `onChunk` (observe/transform/expand/drop any stream chunk), `onBeforeToolCall` (returning `transformArgs` / `skip` / `abort`), `onAfterToolCall`, `onToolPhaseComplete`, `onUsage`, `onFinish`/`onAbort`/`onError` (exactly one fires), plus sandbox file hooks — all in `dist/esm/activities/chat/middleware/types.d.ts`. Middleware also has a typed capability registry (`requires`/`provides`, validated before the adapter runs). The `main` docs add an `onShouldContinue` hook that vetoes loop continuation per-middleware ([agentic-cycle](https://tanstack.com/ai/latest/docs/chat/agentic-cycle), [middleware](https://tanstack.com/ai/latest/docs/advanced/middleware)); it is **not** in installed 0.42.

### Steer vs queue: can new user input enter a running loop?

This was the ticket's sharpest question. Findings:

- **There is no public "inject a message into a running `chat()`" API.** Messages are fixed at call time; the docs' model is one run per request, continuation = new run ([streaming — threads and runs](https://tanstack.com/ai/latest/docs/chat/streaming)).
- **But the splice point exists and is real.** Before *every* model turn, the engine rebuilds config and re-runs `onConfig`, then adopts whatever `messages` array middleware returns: `this.messages = config.messages` (`dist/esm/activities/chat/index.js` L292–302 calls `runOnConfig` per iteration with `phase: 'beforeModel'`; `applyMiddlewareConfig` at L1492 assigns messages; the hook contract explicitly allows returning `messages` — `middleware/types.d.ts` L149–155, L358–365). A middleware that drains an inbox and appends a `user` message between turns is steering, today, with library-sanctioned hooks — the model sees the new input on its next turn.
- **The client layer already has queue vocabulary, but in-memory and browser-shaped.** `useChat`/`ChatClient` sends mid-stream get `whenBusy: 'queue' | 'drop' | 'interrupt'`, FIFO or batch drain, `maxSize`, `cancelQueued`, and defined flush semantics; `'interrupt'` aborts the current run and starts a fresh one carrying the new message ([streaming — queueing messages](https://tanstack.com/ai/latest/docs/chat/streaming)). Nothing here survives a process restart.

**We own:** the durable prompt inbox — persisting incoming instructions, dedup, ordering, deciding steer (splice via `onConfig`) vs interrupt (abort + re-run) vs queue (wait for `RUN_FINISHED`), and making all of it crash-safe. TanStack gives us the splice point and a semantics vocabulary worth copying; the machinery is ours.

## 2. Tool approval flow, end to end

**Free — the mechanics.** Mark a tool `needsApproval: true` (`types.d.ts` L539–540). When the model calls it:

1. The engine finishes executing non-gated tools, then emits a `CUSTOM` chunk `name: 'approval-requested'` with `{ toolCallId, toolName, input, approval: { id, needsApproval: true } }` (`types.d.ts` L1153–1171), parks the run in a `wait` tool phase, and **ends the stream** (`dist/esm/activities/chat/index.js` L692–714).
2. Resolution is **re-invocation**: the caller re-calls `chat()` with the same message history where the pending `ToolCallPart` now carries `approval: { id, approved }` and `state: 'approval-responded'`. The engine extracts an approvals map from the incoming messages (`extractClientStateFromOriginalMessages`, `index.js` L881–902), and `checkForPendingToolCalls` executes the approved calls before the next model turn (`index.js` L600–714).
3. **Restart survival: yes, by construction.** The pause is entirely encoded in the message list; "no database is required — the browser sends the full message history back on the continuation request, so a stateless server can rebuild the paused step and keep going" ([interrupts overview](https://tanstack.com/ai/latest/docs/interrupts/overview)). For a daemon, that means: persist the messages, and a pending approval survives anything.

**Free — and newer than 0.42:** the raw `approval-requested` event flow is being superseded by a typed **interrupts** API: `interrupts` array with `kind: 'tool-approval' | 'generic' | 'unbound'`, `resolveInterrupt(approved, { payload, editedArgs })`, typed `approvalSchema` per decision branch, human-edited arguments re-validated against the tool's `inputSchema`, reject-with-reason fed back to the model as the tool result, and `cancel()` distinct from reject ([tool approval](https://tanstack.com/ai/latest/docs/interrupts/tool-approval), [migration](https://tanstack.com/ai/latest/docs/interrupts/migration)). `@tanstack/ai-persistence` stores pending interrupts server-side ("pause for a human approval and resume it days later" — [persistence overview](https://tanstack.com/ai/latest/docs/persistence/overview)).

**Free — the policy engine (unexpected).** `@tanstack/ai-sandbox` ships a portable permission policy: `defineSandboxPolicy` with command glob rules (`allow`/`ask`/`deny`, precedence deny > ask > allow, default `'ask'`), coarse `fileWrite`/`network` capability gates, script-alias resolution, plus `evaluateCommand` and `resolveApproval` which bridge a policy + recorded approval decisions into the same `approval-requested` flow (`@tanstack/ai-sandbox@0.2.4` `dist/esm/policy.d.ts`, `approvals.d.ts`). Harness adapters map it onto native permission systems (docs: [sandbox/policy](https://tanstack.com/ai/latest/docs/sandbox/policy)); `@tanstack/ai-acp` resolves ACP permission requests against it (`resolveInteractivePermission`, `@tanstack/ai-acp@0.2.3` `dist/esm/permissions.d.ts`).

**We own:** everything between "run paused" and "run re-invoked" — surfacing the ask to a human (Linear comment, web UI, Slack), persisting the decision, and driving the continuation call. Plus policy *content* (which commands a triage run may execute) and per-workspace policy config. The evaluator and wire format are free.

## 3. Streaming event vocabulary vs `HarnessEvent`

**The vocabulary is literally AG-UI.** `StreamChunk = AGUIEvent`, built on `@ag-ui/core` event types (`types.d.ts` L6, L1405–1410). Full set:

| Family | Events | Payload highlights |
| --- | --- | --- |
| Run lifecycle | `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR` | `threadId`, `runId`, `finishReason`, `usage` (with cost breakdown), `message`/`code` |
| Text | `TEXT_MESSAGE_START/CONTENT/END` | `messageId`, `delta` |
| Tools | `TOOL_CALL_START/ARGS/END`, `TOOL_CALL_RESULT` | `toolCallId`, `toolCallName`, streamed `delta` args, parsed `input`, `result`, output state |
| Reasoning | `REASONING_START/END`, `REASONING_MESSAGE_START/CONTENT/END`, `REASONING_ENCRYPTED_VALUE` | reasoning deltas per message |
| Steps | `STEP_STARTED/FINISHED` | legacy thinking events, still emitted |
| State | `MESSAGES_SNAPSHOT`, `STATE_SNAPSHOT`, `STATE_DELTA` | full transcript / JSON-Patch app state |
| `CUSTOM` | typed `KnownCustomEvent` union (`types.d.ts` L1300–1305) | `approval-requested`, `tool-input-available`, `sandbox.file`, `sandbox.file.diff`, `file.changed`, `*.session-id`, `structured-output.start/complete`, `code_mode:*`, `skill:registered`, `ui-resource` |

Our `HarnessEvent` (`packages/contracts/src/run.ts` L37–45) flattens each chunk to `{ type, name, text, sessionId, usage, finishReason }`, and `cursor-acp`'s `toEvent` (`packages/cursor-acp/src/harness.ts` L54–61) fills `text` only from `TEXT_MESSAGE_CONTENT` and `name` only from `CUSTOM`/`TOOL_CALL_START`. **What we currently drop that a UI would want:**

- `messageId`/`toolCallId`/`runId`/`threadId` correlation — no way to build per-message or per-tool-call cards from the ledger.
- Tool call arguments, parsed input, and results (`TOOL_CALL_ARGS`/`END`/`RESULT` payloads) — the single biggest UI gap: "what did the agent actually do".
- Reasoning/thinking deltas (both event families).
- `CUSTOM` values other than session id — notably `sandbox.file.diff` (live file diffs during a run) and approval payloads.
- Per-turn `usage` beyond the final one, provider-reported `cost`, `model`, timestamps.

ADR 0006 already anticipates widening the contract ("tool calls, permission asks, richer activity for clients"). The widening maps ~1:1 onto AG-UI, and `HarnessEvent` is AG-UI-shaped precisely because cursor-acp streams these chunks today — the cheapest richer contract is "AG-UI event, serialized, plus our envelope", not a new invention.

## 4. Persistence and the event-sourced run ledger

**The core model is caller-supplied history.** `chat()` is stateless: it takes `messages`, streams chunks, and exposes the final array via the engine's `getMessages()` (`index.js` L242–245). Nothing in core prescribes storage. Converters between wire/UI shape and model shape are exported: `uiMessageToModelMessages`, `modelMessagesToUIMessages`, `convertMessagesToModelMessages` etc. (`dist/esm/activities/chat/messages.d.ts`). This is a *good* fit for the event-sourced ledger: the ledger stays the source of truth and we materialize `UIMessage[]`/`ModelMessage[]` for each call — the same fold we already do for session resume.

**New and free (0.43-era):** `@tanstack/ai-persistence` — `withPersistence(adapter)` middleware writes transcript, run status, and pending interrupts to a pluggable store ("build one in about 40 lines", with a conformance suite); `reconstructChat` rebuilds a thread and reports in-flight runs ([persistence overview](https://tanstack.com/ai/latest/docs/persistence/overview), [build-your-own-adapter](https://tanstack.com/ai/latest/docs/persistence/build-your-own-adapter)). Separate, composable layers: **resumable streams** (durable delivery log with resume offsets — [resumable-streams](https://tanstack.com/ai/latest/docs/resumable-streams/overview)) and **`@tanstack/ai-memory`** (recall/save long-term memory middleware with in-memory/redis/mem0/honcho/hindsight adapters — [memory overview](https://tanstack.com/ai/latest/docs/memory/overview)).

**Sandbox-side durability** (for CLI-harness runs, `ai-sandbox@0.3.0` docs): durable runs with an in-sandbox NDJSON **journal** (agent writes to a file, so host death can't lose output), **takeover** (another host adopts a detached run, fenced by numbered tickets), and a **reaper** for abandoned runs, with an unforgeable exit sentinel ([durable-runs](https://tanstack.com/ai/latest/docs/sandbox/durable-runs), [harnesses](https://tanstack.com/ai/latest/docs/sandbox/harnesses)). Note: journaling covers `grokBuildText`/`claudeCodeText`/`codexText`; `acpCompatible` (our Cursor path) has **no journal** even in durable mode. Installed `ai-sandbox@0.2.4` predates all of this; its stores are explicitly in-memory v1 ("the future persistence package" — `dist/esm/store.d.ts` L1–8, now shipped).

**We own:** the decision of where truth lives. Recommendation from this audit: keep the run ledger authoritative, implement TanStack's persistence-adapter contract *over* it (or at minimum persist the final `getMessages()` snapshot per run) so pending interrupts and thread reconstruction come along for free rather than hand-rolled.

## 5. MCP

**Free.** Three tiers, all usable from the first-party runner:

- **Managed:** `chat({ mcp: { clients, connection, lazyTools, onDiscoveryError } })` — discovery and lifecycle owned by the run; `'close'` (default) vs `'keep-alive'` pooling; parallel discovery; auto-prefixed pools (`createMCPClients`) and `MCPDuplicateToolNameError` on collisions; fail-fast or skip-per-source error handling (`dist/esm/activities/chat/mcp/types.d.ts`; [mcp-managed](https://tanstack.com/ai/latest/docs/tools/mcp-managed)). Core takes any structural `MCPToolSource` — it does not depend on `@tanstack/ai-mcp`.
- **Manual/typed:** `client.tools([toolDefinition(...)])` for Zod-typed MCP tools, resources, prompts ([mcp-manual](https://tanstack.com/ai/latest/docs/tools/mcp-manual)).
- **Lazy loading:** `lazy: true` per tool (or `lazyTools: true` for a whole MCP source) keeps schemas out of the prompt until the model discovers them via a synthetic discovery tool; `LazyToolsConfig.includeDescription` tunes the pre-discovery catalog (`types.d.ts` L541–560; [lazy-tool-discovery](https://tanstack.com/ai/latest/docs/tools/lazy-tool-discovery)). `createToolRegistry` gives a mutable registry re-read every iteration for dynamic tool sets (`dist/esm/tool-registry.d.ts`).

**Relation to ADR 0005** (`packages/engine/docs/adr/0005-mcp-skills-engine-assembles-harness-runner-renders.md`): today the engine assembles `McpSkill`s and `cursorRunner` renders them via `ai-sandbox`'s `mcpSkill()` → ACP `mcpServers` projection (`packages/cursor-acp/src/harness.ts` L31–32, L172–179). For the first-party runner the projection layer disappears: the engine hands the same skill config to `chat({ mcp })` directly, and ADR 0005's prediction lands — lazy loading and the tool registry "become our lever" exactly when we own the model loop. The engine-side assembly (config → skills → credentials) stays ours by design.

## 6. Sandboxing

**Free.** `withSandbox(definition)` is middleware providing `SandboxCapability` + `ProjectionCapability` (`@tanstack/ai-sandbox@0.2.4` `dist/esm/middleware.d.ts`). `defineSandbox` composes: a **provider** (where it runs), a **workspace** (git/local/none source, setup commands, named scripts, skills — `fileSkill`/`agentSkill`/`mcpSkill`/`gitSkill` — `instructions` → AGENTS.md, typed `secrets` never written to snapshots/stores/logs), a **policy** (§2), **lifecycle** (per-thread reuse, snapshots, keep-alive), and file **hooks** — every file create/change/delete during a run fires hooks with lazy git-backed `before()`/`after()`/`diff()` accessors and emits `sandbox.file`/`sandbox.file.diff` chunks (`sandbox.d.ts`, `workspace.d.ts`; `middleware/types.d.ts` L4–32).

`localProcessSandbox` — what cursor-acp uses (`packages/cursor-acp/src/harness.ts` L173–180) — is explicitly **no isolation**: it runs on the host in a fixed or temp dir, with `scrubEnv` to drop env vars so host CLIs fall back to stored auth (`@tanstack/ai-sandbox-local-process@0.2.0` `dist/esm/provider.d.ts`). Real isolation is other providers: Docker, Daytona, Vercel, Sprites, Cloudflare ([sandbox/providers](https://tanstack.com/ai/latest/docs/sandbox/providers)).

**For the first-party runner** the sandbox question inverts: tools are *our* server tools running in-process against engine-managed worktrees, so `withSandbox` matters less for execution and more for (a) the policy/approval machinery riding on it, (b) file-event → UI diff streaming, and (c) a future move off the host. The worktree lifecycle we own today stays ours.

## 7. Effect integration seam

TanStack AI is Promise/AsyncIterable-based end to end: `chat()` returns `ChatStream = AsyncIterable<StreamChunk>` (`types.d.ts` L1306–1310); middleware hooks return `T | Promise<T>`. cogwork is Effect v4 (vendored at `.repos/effect`). The bridge already exists and is small (`packages/cursor-acp/src/harness.ts` L74–79): `Stream.fromAsyncIterable(stream, fromThrown)` + `flatMap` that converts `RUN_ERROR` chunks into typed `Stream.fail(HarnessError)`. Both sides are pull-based, so backpressure composes; interruption needs the one deliberate wire: chat's `abortController` (`types.d.ts` L791–804) must be aborted from the Effect stream's finalizer so fiber interruption cancels the model call and in-flight tools (tools receive that signal as `ToolExecutionContext.abortSignal`, `types.d.ts` L400–408). Effect-side helpers: `Stream.fromAsyncIterable` in `.repos/effect/packages/effect/src/stream/Stream.ts`. For hooks that need Effects (e.g. an `onBeforeToolCall` consulting the policy service), run them via the app runtime's `runPromise` at the hook boundary. The seam is ours, but it is thin and already proven in production by cursor-acp.

## 8. Provider adapter coverage and quirks

**First-party API adapters** (docs nav + [overview](https://tanstack.com/ai/latest/docs/getting-started/overview)): OpenRouter (recommended, 300+ models), OpenAI, Anthropic, Gemini, Ollama (local), Groq, xAI Grok, Bedrock, Mistral, BytePlus, fal, ElevenLabs, plus **`openai-compatible`** as the escape hatch for any compatible endpoint. Community adapters: Cloudflare, Cencori, Decart, Mynth, Soniox. Per-model type safety: model options, modalities, and tool metadata are typed per adapter+model (`docs/advanced/per-model-type-safety`).

**Harness adapters** (CLI agents run under `withSandbox`, [sandbox/harnesses](https://tanstack.com/ai/latest/docs/sandbox/harnesses)): `@tanstack/ai-grok-build`, `@tanstack/ai-claude-code`, `@tanstack/ai-codex`, `@tanstack/ai-opencode`, and generic `acpCompatible` from `@tanstack/ai-acp` for any ACP agent. This directly serves ADR 0006's "future CLI adapters remain pluggable runners" — Claude Code/Codex adapters are off-the-shelf if users want them.

**Cursor:** no adapter, and none possible — Cursor has no API; the CLI is the access. It stays our `cursor-acp` harness built on `acpCompatible` with a custom transport (`packages/cursor-acp/src/harness.ts` L134–150), including our workaround for Cursor's vendor JSON-RPC telemetry (`cursor/task`, `cursor/update_todos` — L83–132).

**Quirks and gaps that matter for BYO-provider:**
- Auth is env-var/API-key shaped throughout (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. — [harnesses](https://tanstack.com/ai/latest/docs/sandbox/harnesses)). **No OAuth/device-login flows for consumer subscriptions** (log in with your ChatGPT/Claude account) — for API adapters, keys are the only path; harness adapters can ride a host CLI's stored login (the `scrubEnv` trick). ADR 0006's "log in with your OpenAI or Anthropic account" UX is ours to build, and for consumer (non-API) plans may be constrained by provider ToS, not just engineering.
- `usage` includes provider-reported `cost`/`costDetails` where available (`types.d.ts` L260–268) — useful for the roadmap's cheap-utility-calls accounting.
- Structured outputs: one-shot, multi-turn, streaming partial JSON, and combined tools+schema where the provider supports it (`outputSchema`, `types.d.ts` L756–779) — this is the utility-call workhorse (triage routing, ranking, drafting).

---

## Summary: free from TanStack vs we own

| Free from TanStack | We own |
| --- | --- |
| Agent loop with pluggable between-turns strategies, per-turn tool budget, default `maxIterations(5)` | Loop *policy* per run stage (triage vs implement budgets), and any mid-turn control beyond the built-ins |
| Full middleware lifecycle incl. `onBeforeToolCall` skip/transform/abort and per-turn `onConfig` message splice | **Durable prompt inbox + steer/queue semantics**: persistence, dedup, steer-vs-interrupt-vs-queue decisions, crash-safety |
| Tool approval pause/resume mechanics, typed interrupts (`approvalSchema`, `editedArgs`, reject-with-reason), stateless restart-safe by construction | Approval **UX and transport**: surfacing asks to humans (Linear/UI), persisting decisions, driving the continuation `chat()` call |
| Permission policy engine: `defineSandboxPolicy` command globs + capability gates, deny>ask>allow evaluator, `resolveApproval` | Policy **content and config**: per-workspace/per-stage rules, defaults, and mapping asks onto our coordination surfaces |
| Full AG-UI stream vocabulary: tool lifecycle with args/results, reasoning deltas, file diffs, usage+cost, typed custom events | **`HarnessEvent` contract widening** and the ledger fold; deciding what both runner classes must honor (ADR 0006) |
| Message model + UIMessage↔ModelMessage converters; `@tanstack/ai-persistence` store contracts, conformance suite, resumable streams; `ai-memory` | **Session persistence as our run ledger**: implementing their adapter over our store (or snapshotting `getMessages()`), run/thread identity mapping to `RunId`/`SessionId` |
| MCP: managed clients/pools, discovery, lifecycle, collisions, lazy tools, mutable tool registry | **Engine-side capability assembly** (ADR 0005/0006): config → MCP skills → credentials → per-run tool set; our own server tools |
| Sandbox/workspace/skills/secrets projection, file-event diffs, policy carrier, providers (local/Docker/Daytona/Vercel/Cloudflare), durable-run journal/takeover/reaper for CLI harnesses | Worktree lifecycle (already ours), choosing/operating an isolation provider when local-process stops being acceptable |
| Provider adapters (13+ first-party incl. `openai-compatible`), typed model options, structured outputs, cost-bearing usage; harness adapters for Claude Code/Codex/OpenCode/Grok Build/ACP | **Provider login flows** (BYO-account/OAuth, credential storage — TanStack is API-key only); Cursor stays our `cursor-acp` harness (no adapter possible) |
| — | **Effect v4 bridging seam** (thin, proven in cursor-acp): `Stream.fromAsyncIterable`, abort↔interruption wiring, `runPromise` at hook boundaries, typed `HarnessError` taxonomy |
| — | **Version-churn management**: 0.x weekly movement (approval events → interrupts migration; strategy set changing between 0.42 and `main` docs); pin + re-verify per upgrade |

## Surprises worth flagging

1. **TanStack ships much more of the presumed "we own" list than the ticket assumed.** A permission policy engine, a persistence package with pending-interrupt storage, resumable streams, queue/interrupt send semantics, long-term memory, and durable sandbox runs (journal/takeover/reaper) all exist — most of it landing in the weeks around our installed version. The genuinely-ours list shrank to: durable inbox/steering, approval UX/transport, provider login flows, engine-side assembly, the Effect seam, and the `HarnessEvent` widening.
2. **Between-turns steering is possible today** via the per-iteration `onConfig` messages splice — not documented as a steering API, but a deliberate, typed hook the engine honors before every model turn.
3. **The approval/interrupt model is stateless by design** — a paused run is just a message list with an unanswered tool-call part. For an AFK daemon this is ideal: persistence of the transcript *is* persistence of the pause.
4. **Version drift is the top operational risk.** Docs (`main`) and installed 0.42.0 disagree on real API surface (interrupts, `onShouldContinue`, `maxToolCalls`). Everything here needs re-verification against the pinned version at build time.
