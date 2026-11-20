# Cursor Harness: ACP versus the Cursor SDK

Date: 2026-11-05. Resolves [#878](https://github.com/taylorfsteele/cogwork/issues/878). Related:
[#874](https://github.com/taylorfsteele/cogwork/issues/874).

**Question:** Should the Cursor Harness move from ACP (`agent acp` through `@tanstack/ai-acp`) to the
Cursor SDK (`@cursor/sdk`)? What does each transport give Cogwork, and what does each one cost?

## Recommendation

**Move to the SDK behind the same Harness runner seam, and retire ACP, if the probes allow it.** The
follow-up ticket starts with three live probes in a scratch directory. One rule decides:

| Probe 1: `--plugin-dir` under `agent acp` | Probe 3: SDK Read only holds | Decision |
|---|---|---|
| passes | fails | Stay on ACP. Close the follow-up ticket. |
| passes | passes | Move to the SDK. |
| fails | either | Move to the SDK. |

Probe 2 (Skills through SDK `local.dirs`) does not change the decision. It decides only whether the
Skills criterion stays in the ticket. If it fails, Skills stay an open gap on both transports.

The SDK gives Cogwork three things that ACP does not (details in the tables below):

1. **Metered usage and cost.** Each turn reports real token counts, and `agent.getUsage()` adds cost
   in cents. ACP reports no usage, so the Cursor descriptor attaches a `chars/4` estimate today.
2. **A tool allow list that Cursor enforces.** `tools` and `disallowedTools` can make a Read only
   profile. This is a new fact, not the trigger ADR 0025 names. Adding Read only needs a new decision
   that amends ADR 0025.
3. **Members without files in the worktree.** Skills through `local.dirs`, Subagents through
   `agents`, and MCP servers through `mcpServers`.

It also gives typed errors, including `AgentNotFoundError` on resume. ACP signals a failed resume
only by a changed session id.

The cost is in [Cost](#cost). In short: Cogwork owns an adapter of 500–700 lines, pins a fast-moving
closed-licence SDK, adds a second Cursor sign-in, and runs the SDK in a child process.

**Do not switch only to fix the `AGENTS.md` overwrite.** ACP can already carry Instructions without a
worktree file. `@tanstack/ai-acp` prepends `systemPrompts` to the prompt text (`applySystemPrompts` in
`adapters/compatible.js`). The Cursor descriptor only has to set
`transport.instructionProjection: "system-prompt"`. This is not a real system prompt, as it is for
Claude Code. The text repeats in the user message on every turn, resumed turns too, so it costs
tokens on each turn. It is still the cheapest fix, and it belongs to the separate bug.

## What was compared

| Source | Version | Files read |
|---|---|---|
| `@cursor/sdk` | 1.3.1 (latest, 2026-11-03) | npm tarball: `README.md`, `dist/esm/options.d.ts`, `agent.d.ts`, `run.d.ts`, `messages.d.ts`, `usage-types.d.ts`, `vendor/cursor-sdk-shared/delta-types.d.ts`, `tool-call-types.d.ts`. |
| t3code Cursor driver | `@cursor/sdk` 1.2.0 | `.repos/t3code/packages/provider-cursor/src/server/`: `adapter.ts`, `CursorAgentSdk.ts`, `CursorSdk.ts`, `sdkModel.ts`, `auth.ts`, `textGeneration.ts`, `CursorSdkCatalog.ts`, `accountUsage.ts`. |
| `@tanstack/ai-acp` | 1.0.0 (workspace catalog) | `dist/esm/adapters/compatible.js`, `adapters/projection.js`, `session/acp-client.js`. |
| Cursor CLI | `2026.08.11-e8db854` (installed) | `agent --help`, and one live ACP probe. |
| Cogwork | `main` at `7195ead5` | `packages/cursor-acp/src/harness.ts`, `FINDINGS.md`, `FINDINGS-RESUME.md`, `packages/engine/src/external-harness-runtime.ts`, ADR 0004, 0024, 0025, engine ADR 0006. |

The t3code PR numbers in the work item are not in the t3code clone. The code covers the same
subjects, and this note cites the code.

## Members

**Skills.**
- ACP: no native channel. ACP `session/new` takes only `cwd` and `mcpServers`. `@tanstack/ai-acp` skips agent
  Skills and plugins with a warning. It links git Skills only into a `skillsDir` inside the worktree.
- ACP, 2026-11-18 ([#985](https://github.com/taylorfsteele/cogwork/issues/985)): ACP now carries
  Skills through the tool bridge. `acpCompatible` gives `chat()` tools to `agent acp` as an HTTP MCP
  server in `session/new`, so `withSkills`' catalog and `load_skill` reach Cursor with no worktree
  file. A live probe on Cursor CLI `2026.11.11-b912975` loaded a Skill this way.
- ACP: `agent --plugin-dir` is a global CLI flag. No source confirms that `agent acp` honours it. The
  live probe could not run (see [Live probes](#live-probes)).
- SDK: `local.settingSources` loads the ambient `project`, `user`, `team`, `mdm`, and `plugins`
  layers. Nothing loads without it.
- SDK: `local.dirs` adds workspace roots. Rules and Skills "load from every unique path". One root can
  be a provisioned Skills directory outside the checkout. There is no `pluginDirs` option.

**Subagents.**
- ACP: no channel. Only `.cursor/agents/` files in the worktree.
- SDK: `agents: Record<string, AgentDefinition>` takes `description`, `prompt`, `model`, and
  `mcpServers`. t3code does not use it.

**MCP servers.**
- ACP: `session/new` `mcpServers`. The live probe shows `mcpCapabilities: { http: true, sse: true }`.
- SDK: `mcpServers` on `Agent.create` and again on each `send`. Both merge with ambient servers (SDK
  1.0.39 or later, per t3code). The descriptor can declare `mcpProjection: "native"`.
- SDK: `local.customTools` runs host callbacks as an in-process MCP server with no approval step.
  Cogwork must not use it (see [Security controls](#security-controls)).

**Instructions without a worktree file.**
- ACP: yes, with `instructionProjection: "system-prompt"`, as described above. The descriptor does not
  set it today, so the runtime writes `AGENTS.md`.
- SDK: the same prepend works. `systemPrompt` replaces Cursor's whole system prompt and is gated per
  account. Do not use it. t3code appends its instructions to the user text.

**Hooks.**
- ACP: no channel. Only what Cursor loads from its own project or user config.
- SDK: no hook option. Hooks load only through `settingSources`.

**Sandbox Policy.**
- ACP: `policyFidelity: "none"`. Cursor decides which actions ask permission. `agent --sandbox` and
  `--auto-review` are global flags with no confirmed effect under `acp`. Cursor declares Full only.
- SDK: `tools` and `disallowedTools` form an allow list ("deny wins"). Cursor enforces it through the
  `x-cursor-agent-allowed-tools` and `x-cursor-agent-exclude-tools` request headers. An unknown tool
  name throws a `ConfigurationError`.
- SDK: the allow list covers only the main agent loop. `task` children keep their own tools. The
  `mcp` group covers every MCP tool, including the engine tool bridge.
- SDK: `local.sandboxOptions.enabled` turns on Cursor's OS sandbox. `local.autoReview` turns on the
  server classifier.

## Run behaviour

**Session resume.**
- ACP: `session/load` through `modelOptions.sessionId`. It works across processes (spikes #9 and #99).
  On a load failure `@tanstack/ai-acp` starts a new session. The only signal is a changed
  `<name>.session-id` event, which the engine can compare with the requested handle.
- SDK: `Agent.resume(agentId, options)` throws `AgentNotFoundError`. `tools`, `disallowedTools`,
  `systemPrompt`, and `teamId` are not persisted. Each resume must send them again. `local.store`
  lets the caller own the agent store.

**Structured output.**
- Neither transport has a native schema option. Both keep prompt-and-parse. t3code parses JSON from
  text.

**Usage and cost.**
- ACP: none. The prompt response is `{ stopReason }`.
- SDK: `turn-ended` and the `usage` message carry input, output, cache-read, cache-write, and reasoning
  tokens. `RunResult.usage` is cumulative. `agent.getUsage()` adds `rawCostCents` and `chargedCents`.
  `usageQuality` becomes `"metered"`.
- Not a third option: t3code reads account usage from `cursor.com/api/dashboard/get-filtered-usage-events`
  with a session cookie from the keychain (`accountUsage.ts`). The endpoint is undocumented, and the
  data is per account, not per Run.

**File-change events.**
- ACP: none (`fileEventFidelity: "absent"`).
- SDK: `edit` results carry `diffString`. Shell writes report nothing.
- Both: the runtime File-diff feed (`transport.runtimeFileDiffFeed: true`) works on either transport,
  as it does for Codex. It sees shell writes too. Use it on both, and do not map SDK `edit` results.
  ACP Cursor can set it today, without this change.

**Cancellation.**
- ACP: `session/cancel`, then kill the `agent` process.
- SDK: `run.cancel()`. t3code waits 10 seconds, then finalizes the turn itself. Killing the child
  process is the backstop.

**Authentication.**
- ACP: host login (`agent login` or `CURSOR_API_KEY`). Readiness cannot see login state.
- SDK: an explicit `apiKey`, then `CURSOR_API_KEY`, then `~/.cursor/sdk/auth.json`. It does not read
  the `agent login` credential. `Cursor.auth.login()` opens a browser and mints a 90-day API key.
  `Cursor.auth.status()` gives readiness a real login state.

**Readiness and catalog.**
- ACP: `agent --version` and `agent --list-models`. `model.ts` decomposes composite model ids.
- SDK: no CLI to install. `Cursor.models.list()` returns `{ id, parameters, variants }`, which matches
  Cogwork's option axes without composite ids. t3code calls the public `/v1/me` and `/v1/models`
  endpoints, so readiness does not start the agent runtime. ADR 0024 still holds: the catalog stays
  generated and checked in.

### Known SDK failure modes from t3code

- **An error after the final message.** A retryable stream error after `turn-ended` can make the SDK
  resume from an older checkpoint and end the run with an error. t3code treats such an error as
  completed (`CURSOR_RESUME_NO_PROGRESS_MESSAGE` in `adapter.ts`).
- **Unawaited promise rejections after close.** t3code installs a process-wide `unhandledRejection`
  guard (`CursorSdk.ts`). The daemon must not. A child process contains them.
- **Sandbox support is cached per process.** A child process for each Run avoids the shared cache.
- **`~/.cursor/sandbox.json` widens writable paths** outside `settingSources`. t3code refuses a
  sandboxed run when the file exists.
- **Platform binaries.** The SDK finds `@cursor/sdk-<platform>-<arch>` (ripgrep and the sandbox
  helper, about 10 MB) by walking up `node_modules`. The desktop package must ship it.

## Where the SDK adapter sits

The seam is `HarnessRunner`, and it does not move. Below it, the External Harness runtime takes one
`ExternalHarnessDescriptor<Adapter>` for each Harness. `Adapter` is a TanStack `AnyTextAdapter`. The
SDK adapter fills that same slot. It is not a new seam and not a second runtime.

```
HarnessRunner seam (engine)            ← unchanged
  └─ externalHarnessRunner(descriptor) ← unchanged: Workspace, secrets, cancel, bridgeChat, scrub
       └─ Cursor descriptor            ← changed: catalog, readiness, projection, diagnostics
            └─ makeAdapter → Cursor SDK text adapter   ← new, Cogwork-owned
                 └─ sandbox.process.spawn(node <SDK host script>)   ← child process
                      └─ @cursor/sdk Agent.create / resume / send
```

**The adapter's interface** is TanStack's text adapter:

- `chatStream(options)`: messages, `systemPrompts`, `modelOptions` (`{ sessionId? }`), `outputSchema`,
  `tools`, and the abort signal in; TanStack stream chunks out.
- `structuredOutput(options)`: rejects, as `acpCompatible` does. `outputSchema` rides on `chat()`.

**What moves behind it:**

- **Event bridge.** SDK `InteractionUpdate` to TanStack chunks: `text-delta` to text, `thinking-delta`
  to reasoning, `tool-call-started` and `tool-call-completed` to tool calls, `turn-ended` usage to
  `RUN_FINISHED` usage, and the agent id to the `<name>.session-id` custom event. The SDK ships a
  process wire format (`createSdkMessageRunStreamEvent`, `decodeLocalRunStreamEvent`), so the child
  streams NDJSON.
- **Engine tool bridge.** Today `acpCompatible` serves `request.tools` (issue search, pull request
  tools) from the daemon as an HTTP MCP server (`nodeHttpBridgeProvisioner`). The SDK adapter must
  provision the same bridge and pass it to the child as one more `mcpServers` entry. The tools then
  still run in the daemon.
- **Process boundary.** The child runs under the runtime's local-process Sandbox. It keeps the
  checkout `cwd`, the inherited-environment allow list, and the secret scrub. If the SDK ran inside
  the daemon, the agent's shell would get the daemon's environment.

**What moves into the Cursor descriptor:**

- **Catalog.** `models:sync` reads `Cursor.models.list()`, not `agent --list-models`. The
  composite-id half of `model.ts` goes.
- **Readiness.** `Cursor.auth.status()` and the pinned SDK version replace `agent --version`.
- **Projection.** `projectOptions` builds `AgentOptions`: the model selection, `settingSources`,
  `local.dirs`, `mcpServers` (`mcpProjection: "native"`), and the Operation profile as `tools`,
  `disallowedTools`, and `sandboxOptions`.
- **Diagnostics.** SDK error classes (`AuthenticationError`, `RateLimitError`, `AgentBusyError`,
  `ConfigurationError`, `AgentNotFoundError`) replace ACP `RequestError` codes.

**What leaves the tree:** `interceptCursorTelemetry` (the hand ack of `cursor/task` and
`cursor/update_todos`), `estimatedUsage` and its accuracy test, the `gpt-tokenizer` dev dependency,
`@agentclientprotocol/sdk`, and `@tanstack/ai-acp`.

**ACP retires.** Keeping ACP beside the SDK would add a second Cursor adapter that no user chooses
between. That is speculative, and it doubles the test surface. The seam keeps one Cursor adapter.

## Cost

| | ACP | Cursor SDK |
|---|---|---|
| Adapter ownership | TanStack owns `acpCompatible`. Cogwork owns a 458-line descriptor. | Cogwork owns the adapter, the event bridge, the tool bridge wiring, and the child host. Estimate 500–700 lines, plus replay fixtures. |
| Upgrade path | The user updates the Cursor CLI. `cursorVersionRequirement` gates it. | Cogwork bumps a pinned SDK and its platform packages. Six releases from 2026-10-20 to 2026-11-03. Closed licence ("© Anysphere Inc. All rights reserved"). |
| Install | The user installs the Cursor CLI. | Nothing for the user. About 30 MB of dependencies in the desktop package. |
| Sign-in | The existing `agent login`. | A new sign-in (browser flow or API key). The key expires after 90 days. |
| Known defects | Resume fallback shows only as a changed id. Vendor requests acked by hand. | Error after the final message. Unawaited rejections. Per-process sandbox cache. |

## Security controls

The SDK opens trust questions that ACP hides inside the CLI. The follow-up ticket must hold each one:

- **Read only is profile-level.** Cursor enforces the allow list through request headers, so
  `policyFidelity` is `"profile-only"`, not `"exact"`. Read only must remove `task`, because children
  keep their own tools. It must also remove `mcp`, or name which MCP servers a Read only Run keeps.
- **Resume resends the policy.** `tools` and `disallowedTools` are not persisted. A resume that omits
  them gives a Read only Run the full tool set.
- **`settingSources` is an explicit list.** Each ambient layer loads hooks, MCP servers, and rules from
  the host. Each layer in the list is a decision, as ADR 0023 was for Codex hooks.
- **The API key is a per-Run secret.** It reaches the child through the Sandbox secrets and is scrubbed
  from events and errors. Whether the agent's shell inherits it is a probe question.
- **No secret in the agent store.** Check that MCP bearer values passed to `Agent.create` are not
  written to the SDK agent store.
- **No `customTools`.** They run without an approval step.
- **Refuse a sandboxed Run when `~/.cursor/sandbox.json` exists**, as t3code does.

## Live probes

The work item allows probes in a scratch directory. One probe ran.

**Ran: ACP `initialize` on CLI `2026.08.11`.** `agentCapabilities` were
`{ loadSession: true, mcpCapabilities: { http: true, sse: true }, promptCapabilities: { image: true }, sessionCapabilities: { list: {} } }`.

**Blocked: `agent --plugin-dir <dir> acp`.** The probe compares the `available_commands_update` list of
a session with and without a plugin Skill. It sends no prompt and uses no model tokens. It could not
run here. `agent acp` writes `~/.cursor/projects/<cwd>` on start, and this Run's sandbox does not
grant that path. With a scratch `HOME`, `session/new` fails with `-32000 Authentication required`.

**For the follow-up ticket, before any code:**

1. `--plugin-dir` under `agent acp`: does the plugin Skill appear in `available_commands_update`?
2. SDK `local.dirs` with a scratch Skills root: does a Skill from it answer a prompt that names it?
3. SDK Read only: `disallowedTools` with `edit`, `write`, `delete`, `shell`, `applyAgentDiff`,
   `task`, and `mcp`. Does `Agent.create` accept every name? Does a prompt that asks for a file write
   fail?

## Proposed follow-up ticket

**Title:** Move the Cursor Harness from ACP to the Cursor SDK

**Body:**

> ## Goal
>
> Replace the ACP transport in the Cursor descriptor with a Cogwork-owned TanStack text adapter over
> `@cursor/sdk`. Keep the `HarnessRunner` seam and the External Harness runtime unchanged. Retire ACP.
>
> ## Gate
>
> First run the three probes in `docs/research/cursor-acp-versus-cursor-sdk.md` § Live probes in a
> scratch directory, and record the results in that note. Apply the decision table in its
> Recommendation. If it says stay on ACP, stop and report.
>
> ## Acceptance criteria
>
> - The Cursor descriptor's `makeAdapter` returns a Cogwork-owned adapter that runs `@cursor/sdk` in a
>   child process through the Run's local-process Sandbox. `structuredOutput` rejects, as ACP does.
> - Engine tools reach the agent through the TanStack tool bridge as an HTTP MCP server.
> - Each `RUN_FINISHED` carries metered usage, and the profile says `usageQuality: "metered"`. The
>   `chars/4` estimate is deleted.
> - Resume uses `Agent.resume` and resends the Operation profile's tool lists. A missing agent is a
>   typed failure.
> - The descriptor declares `mcpProjection: "native"`, `instructionProjection: "system-prompt"`, and
>   `runtimeFileDiffFeed: true`. No Run writes `AGENTS.md` into the checkout.
> - If probe 2 passes, provisioned Skills reach the agent through `local.dirs`, outside the checkout.
> - If probe 3 passes, a new ADR amends ADR 0025 and Cursor declares Read only with
>   `policyFidelity: "profile-only"`.
> - An error after `turn-ended` completes the Run.
> - Readiness reports login state from `Cursor.auth.status()`. The desktop app and the CLI have a
>   sign-in path.
> - Every control in the note's § Security controls holds, with a test where the control is code.
> - `@tanstack/ai-acp`, `@agentclientprotocol/sdk`, `interceptCursorTelemetry`, and the estimate code
>   leave the tree.
> - The shared public-Harness conformance suite passes for Cursor.
