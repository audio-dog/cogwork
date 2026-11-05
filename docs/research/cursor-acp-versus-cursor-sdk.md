# Cursor Harness: ACP versus the Cursor SDK

Date: 2026-11-05. Resolves [#878](https://github.com/taylorfsteele/cogwork/issues/878). Related:
[#874](https://github.com/taylorfsteele/cogwork/issues/874).

**Question:** Should the Cursor Harness move from ACP (`agent acp` through `@tanstack/ai-acp`) to the
Cursor SDK (`@cursor/sdk`)? What does each transport give Cogwork, and what does each one cost?

## Recommendation

**Change to the SDK, behind the same Harness runner seam, and retire ACP.** Do it as one follow-up
ticket that starts with three live probes. If a probe fails, stay on ACP.

The SDK lets Cogwork supply four things that ACP cannot:

1. **Metered usage and cost.** Each turn reports real token counts. `agent.getUsage()` also returns
   cost in cents. ACP reports no usage, so the Cursor descriptor attaches a `chars/4` estimate today.
2. **An enforceable Read only profile.** `tools` and `disallowedTools` are a tool allow list that
   Cursor enforces. This is the "enforceable permission mapping" that ADR 0025 names as the condition
   to add Read only.
3. **Members without files in the worktree.** `local.dirs` adds a workspace root outside the checkout.
   Skills and rules load from it. `agents` takes Subagent definitions in code. `mcpServers` takes MCP
   servers in code.
4. **Explicit resume failure.** `Agent.resume` fails with `AgentNotFoundError`. ACP through
   `@tanstack/ai-acp` falls back to a new session and tells nobody.

The cost is real but bounded:

- Cogwork owns a TanStack text adapter of about the size of today's `harness.ts`. No TanStack
  adapter exists for the SDK.
- Cogwork pins a closed-licence SDK that ships fast: six releases from 2026-10-20 to 2026-11-03.
- Users sign in a second time. The SDK does not read the `agent login` credential.
- The SDK runs the agent loop in the calling process. The adapter must run it in a child process to
  keep the Runtime Host process boundary (see [Where the SDK adapter sits](#where-the-sdk-adapter-sits)).

**Do not switch only to fix the `AGENTS.md` overwrite.** ACP can already carry Instructions without a
file in the worktree. `@tanstack/ai-acp` prepends `systemPrompts` to the prompt
(`applySystemPrompts` in `adapters/compatible.js`). The Cursor descriptor only has to set
`transport.instructionProjection: "system-prompt"`, as Claude Code does. That fix belongs to the
separate bug and does not depend on this decision.

## What was compared

| Source | Version | How |
|---|---|---|
| `@cursor/sdk` | 1.3.1 (latest, 2026-11-03) | Read the published `.d.ts` files and README from the npm tarball. |
| t3code Cursor driver | `@cursor/sdk` 1.2.0 | Read `.repos/t3code/packages/provider-cursor/src/server/`. |
| `@tanstack/ai-acp` | 1.0.0 (the workspace catalog) | Read `dist/esm/adapters` and `dist/esm/session`. |
| Cursor CLI | `2026.08.11-e8db854` (installed) | `agent --help`, plus one live ACP probe (see [Live probes](#live-probes)). |
| Cogwork | `main` at `7195ead5` | `packages/cursor-acp`, `packages/engine/src/external-harness-runtime.ts`. |

The t3code PR numbers in the work item (#27906, #19412, #27715, #27185) are not in the t3code clone.
They may be Cursor tracker numbers. The t3code code shows the same subjects, and this note cites the
code.

## Members

| Member | ACP today | Cursor SDK |
|---|---|---|
| **Skills** | No channel. ACP `session/new` takes only `cwd` and `mcpServers`. `@tanstack/ai-acp` warns and skips agent Skills and plugins, and links git Skills only into a `skillsDir` inside the worktree (`adapters/projection.js`). `agent --plugin-dir` is a global CLI flag, and no source confirms that `agent acp` honours it. The live probe could not run. | `local.settingSources` loads ambient `project`, `user`, `team`, `mdm`, and `plugins` layers. Nothing loads without it. `local.dirs` adds extra workspace roots, and "project rules, skills … load from every unique path". Cogwork can point one root at a provisioned Skills directory outside the checkout. There is no `pluginDirs` option. |
| **Subagents** | No channel. Only `.cursor/agents/` files in the worktree. | `agents: Record<string, AgentDefinition>` takes `description`, `prompt`, `model` (or `"inherit"`), and `mcpServers`. t3code does not use it. |
| **MCP servers** | `session/new` `mcpServers`. Cursor advertises `mcpCapabilities: { http: true, sse: true }` (live probe). The shared runtime projects them through the Workspace. | `mcpServers` on `Agent.create` and again on each `send`. Both merge with `settingSources` servers (SDK ≥ 1.0.39, per t3code). The descriptor can declare `mcpProjection: "native"`. `local.customTools` also runs host callbacks as an in-process MCP server with no approval step. |
| **Instructions without a worktree file** | Yes, with `instructionProjection: "system-prompt"`. `@tanstack/ai-acp` prepends system prompts to the user prompt. The Cursor descriptor does not use it today, so the runtime writes `AGENTS.md`. | Same prepend shape is available. `systemPrompt` *replaces* Cursor's whole system prompt and is gated per account ("Custom system prompt is not enabled for this account"). Do not use it. A `local.dirs` root with an `AGENTS.md` is a second channel. t3code appends its instructions to the user text. |
| **Hooks** | No channel in ACP. Only what Cursor loads from its own project or user config. | Ambient only, through `settingSources`. No hook option. A `local.fs` tree disables all hooks. |
| **Sandbox Policy** | `policyFidelity: "none"`. Cursor decides which actions ask permission. `@tanstack/ai-acp` answers with `permissions: "headless"`. `agent --sandbox` and `--auto-review` are global CLI flags with no confirmed effect under `acp`. Cursor declares Full only (ADR 0025). | `tools` / `disallowedTools` allow list ("deny wins"), enforced through request headers (`x-cursor-agent-allowed-tools`, `x-cursor-agent-exclude-tools`). `local.sandboxOptions.enabled` turns on Cursor's OS sandbox. `local.autoReview` turns on the server classifier. A Read only profile can remove `edit`, `delete`, `shell`, and `applyAgentDiff`. The allow list does not cover `task` children, so Read only must also remove `task`. MCP tools stay the separate MCP transport. |

## Run behaviour

| Behaviour | ACP today | Cursor SDK |
|---|---|---|
| **Session resume** | `session/load` through `modelOptions.sessionId`. Works across processes (spike #9, spike #99). `@tanstack/ai-acp` swallows a load failure in `catch {}` and starts a new session silently. | `Agent.resume(agentId, options)`. Fails with `AgentNotFoundError`. `tools`, `disallowedTools`, `systemPrompt`, and `teamId` are not persisted and must be sent again. `local.store` lets the caller own the agent store. `local.force` expires a run that a crashed process left active. |
| **Structured output** | None. The shared runtime uses prompt-and-parse. | None. No schema option. t3code parses JSON from text. A `customTools` "submit result" tool with an `inputSchema` is possible, but the SDK does not validate tool input against it. Keep prompt-and-parse. |
| **Usage and cost** | None. The prompt response is `{ stopReason }`. The descriptor attaches an `estimated` `chars/4` usage. | `turn-ended` and the `usage` message carry `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, and `reasoningTokens`. `RunResult.usage` is cumulative. `agent.getUsage()` adds `rawCostCents` and `chargedCents`. t3code maps none of it. `usageQuality` becomes `"metered"`. |
| **File-change events** | None (`fileEventFidelity: "absent"`). | `edit` tool results carry `diffString`, `linesAdded`, and `linesRemoved`. `write` can return `fileContentAfterWrite`. Shell writes report nothing. This is `best-effort` at most. The runtime File-diff feed (`transport.runtimeFileDiffFeed`) works on either transport and stays the better source. |
| **Cancellation** | `session/cancel`, then kill the `agent` process. | `run.cancel()`. t3code waits 10 seconds for the turn to settle, then finalizes it itself. With a child process (below), killing the child is the backstop. |
| **Authentication** | Host login: `agent login` or `CURSOR_API_KEY`. Readiness cannot see login state; the launch verifies it. | Explicit `apiKey`, then `CURSOR_API_KEY`, then `~/.cursor/sdk/auth.json`. It does not read the `agent login` credential. `Cursor.auth.login()` opens a browser and mints a 90-day user API key. `Cursor.auth.status()` gives readiness a real login state. |
| **Readiness and catalog** | `agent --version` and `agent --list-models`. Composite model ids that `model.ts` decomposes into axes. | No CLI to install. `Cursor.models.list()` returns `{ id, parameters, variants }`, which matches Cogwork's canonical axes without composite-id parsing. t3code calls the public `/v1/me` and `/v1/models` endpoints so readiness does not start the agent runtime. ADR 0024 still holds: the catalog stays generated and checked in. |
| **Blocking extension requests** | `cursor/create_plan` and `cursor/ask_question` get `-32601`. The descriptor acks `cursor/task` and `cursor/update_todos` by hand (`interceptCursorTelemetry`). | Typed tool calls (`createPlan`, `updateTodos`, `task`). No hand-written protocol code. |
| **Human attach** | No (spike #9, Q4). | No. Local agents live in the SDK store, not in the CLI chat store. |

### Known SDK failure modes from t3code

- **A turn that errors after the final message.** A retryable stream error after `turn-ended` can make
  the SDK resume from an older checkpoint and end the run with an error. t3code treats an error after
  `turn-ended` as completed (`adapter.ts`, `CURSOR_RESUME_NO_PROGRESS_MESSAGE`). The SDK adapter needs
  the same rule.
- **Unhandled promise rejections after close.** The SDK writes final frames from promises that nothing
  awaits. t3code installs a process-wide `unhandledRejection` guard (`CursorSdk.ts`). In the daemon
  that guard is not acceptable. A child process contains it.
- **Sandbox support is cached per process.** t3code primes the sandbox before the first Full access
  run. A child process per Run avoids the shared cache.
- **`~/.cursor/sandbox.json` widens writable paths** outside `settingSources`. t3code refuses to run
  its sandboxed text generation when that file exists.
- **Platform binaries.** The SDK finds `@cursor/sdk-<platform>-<arch>` (ripgrep and the sandbox
  helper, about 10 MB) by walking up `node_modules`. The desktop package must ship and hoist it.

## Where the SDK adapter sits

Use `/codebase-design` vocabulary. The **seam** is `HarnessRunner`, and it does not move. Below it, the
External Harness runtime already takes one `ExternalHarnessDescriptor<Adapter>` per Harness, where
`Adapter` is a TanStack `AnyTextAdapter`. The SDK adapter fills that same slot. It is not a new seam
and not a second runtime.

```
HarnessRunner seam (engine)            ← unchanged
  └─ externalHarnessRunner(descriptor) ← unchanged: Workspace, secrets, cancel, bridgeChat, scrub
       └─ Cursor descriptor            ← changed: catalog, readiness, projection, diagnostics
            └─ makeAdapter → CursorSdkTextAdapter   ← new, Cogwork-owned
                 └─ sandbox.process.spawn(node cursor-sdk-host.js)   ← child process
                      └─ @cursor/sdk Agent.create / resume / send
```

**The adapter's interface** is TanStack's `chatStream(options)`: messages, `systemPrompts`,
`modelOptions` (`{ sessionId? }`), `outputSchema`, `tools`, and the abort signal in; TanStack stream
chunks out. The shared runtime already turns those chunks into Harness events.

**What moves behind it:**

- **Event bridge.** SDK `InteractionUpdate` to TanStack chunks: `text-delta` to text content,
  `thinking-delta` to reasoning, `tool-call-started` / `tool-call-completed` to tool calls,
  `turn-ended` usage to the `RUN_FINISHED` usage, `edit` results to `file.changed`, and the agent id
  to the `<name>.session-id` custom event. The SDK already ships a process wire format
  (`createSdkMessageRunStreamEvent`, `decodeLocalRunStreamEvent`), so the child streams NDJSON.
- **Process boundary.** The child runs under the runtime's local-process Sandbox. It keeps the
  checkout `cwd`, the inherited-environment allow list, and the secret scrub. Running the SDK inside
  the daemon would give the agent's shell the daemon's environment.

**What moves into the Cursor descriptor:**

- **Catalog.** `models:sync` reads `Cursor.models.list()` instead of `agent --list-models`.
  `model.ts` shrinks: the SDK takes `{ id, params }`, not a composite id.
- **Readiness.** `Cursor.auth.status()` plus the pinned SDK version replace `agent --version`.
  Authentication becomes observable.
- **Projection.** `projectOptions` builds `AgentOptions`: model selection, `settingSources`,
  `local.dirs` for provisioned Skills, `mcpServers` (`mcpProjection: "native"`), the Operation
  profile as `tools` / `disallowedTools` and `sandboxOptions`, and Instructions as a system prompt.
- **Diagnostics.** SDK error classes (`AuthenticationError`, `RateLimitError`, `AgentBusyError`,
  `ConfigurationError`) replace ACP `RequestError` codes.

**What leaves the tree:** `interceptCursorTelemetry`, `estimatedUsage` and its accuracy test, the
`gpt-tokenizer` dev dependency, `@agentclientprotocol/sdk`, `@tanstack/ai-acp`, and the composite-id
half of `model.ts`. `FINDINGS.md` and `FINDINGS-RESUME.md` stay as ACP history.

**One adapter.** The seam keeps one Cursor adapter. Do not keep ACP beside the SDK as a fallback:
one adapter behind a slot is a hypothetical seam, and two Cursor adapters double the test surface for
no user choice. The package rename (`cursor-acp` to `cursor`) goes in the same ticket.

## Cost

| | ACP | Cursor SDK |
|---|---|---|
| Adapter ownership | TanStack owns `acpCompatible`. Cogwork owns about 460 lines of descriptor. | Cogwork owns the adapter, the event bridge, and the child host. Estimate 500–700 lines, plus replay fixtures. |
| Upgrade path | User updates the Cursor CLI. `cursorVersionRequirement` gates it. | Cogwork bumps a pinned SDK and its platform packages. Six releases in two weeks. Closed licence ("© Anysphere Inc. All rights reserved"). |
| Install | User installs the Cursor CLI. | Nothing for the user. About 30 MB of dependencies in the desktop package. |
| Sign-in | Existing `agent login`. | A new sign-in (`Cursor.auth.login()` browser flow, or an API key). A 90-day key expiry. |
| Known defects | Silent resume fallback. Hand-acked vendor requests. | Error after the final message. Unawaited promise rejections. Per-process sandbox cache. |

## Live probes

The work item allows probes in a scratch directory. One probe ran. The others need the follow-up ticket.

**Ran — ACP `initialize` on CLI `2026.08.11`.** `agentCapabilities` were
`{ loadSession: true, mcpCapabilities: { http: true, sse: true }, promptCapabilities: { image: true }, sessionCapabilities: { list: {} } }`.

**Blocked — `agent --plugin-dir <dir> acp`.** The probe compares the `available_commands_update` list
of a session with and without a plugin Skill, with no prompt and no model tokens. It could not run
here. `agent acp` writes `~/.cursor/projects/<cwd>` on start, and this Run's sandbox does not grant
that path. With a scratch `HOME`, `session/new` fails with `-32000 Authentication required`. The
question stays open.

**For the follow-up ticket, before any code:**

1. `--plugin-dir` under `agent acp` (the probe above). If it works, ACP closes the Skills gap.
2. SDK `local.dirs` with a scratch Skills root: does a Skill from it appear in the `system` init
   message `tools` or answer a prompt that names it?
3. SDK Read only: `disallowedTools: ["edit", "delete", "shell", "applyAgentDiff", "task"]`.
   Does a prompt that asks for a file write fail?

If probe 1 passes and probe 3 fails, stay on ACP and close the follow-up ticket. The SDK gains would
then be usage, Subagents, and explicit resume failure, which do not pay for the adapter.

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
> Run the three probes in `docs/research/cursor-acp-versus-cursor-sdk.md` § Live probes in a scratch
> directory first. Record the results in that note. Stop and report if `--plugin-dir` works under
> `agent acp` and SDK Read only does not hold.
>
> ## Acceptance criteria
>
> - The Cursor descriptor's `makeAdapter` returns a Cogwork-owned adapter that runs `@cursor/sdk` in a
>   child process through the Run's local-process Sandbox.
> - Each `RUN_FINISHED` carries metered usage. The capability profile says `usageQuality: "metered"`.
>   The `chars/4` estimate is deleted.
> - Resume uses `Agent.resume`. A missing agent is a typed failure, not a silent new session.
> - The descriptor declares `mcpProjection: "native"` and `instructionProjection: "system-prompt"`.
>   No Run writes `AGENTS.md` into the checkout.
> - Provisioned Skills reach the agent through `local.dirs`, outside the checkout.
> - If probe 3 passes, Cursor declares Read only as well as Full, and ADR 0025 is amended.
> - An error after `turn-ended` completes the Run, as t3code does.
> - Readiness reports login state from `Cursor.auth.status()`. A sign-in path exists for the desktop
>   app and the CLI.
> - `@tanstack/ai-acp`, `@agentclientprotocol/sdk`, `interceptCursorTelemetry`, and the estimate
>   code leave the tree. The package is renamed from `cursor-acp`.
> - The shared public-Harness conformance suite passes for Cursor.

## Sources

- `@cursor/sdk` 1.3.1: `dist/esm/options.d.ts`, `agent.d.ts`, `run.d.ts`, `messages.d.ts`,
  `usage-types.d.ts`, `vendor/cursor-sdk-shared/delta-types.d.ts`, `tool-call-types.d.ts`, `README.md`.
- t3code: `packages/provider-cursor/src/server/adapter.ts`, `CursorAgentSdk.ts`, `CursorSdk.ts`,
  `sdkModel.ts`, `auth.ts`, `textGeneration.ts`, `CursorSdkCatalog.ts`.
- `@tanstack/ai-acp` 1.0.0: `dist/esm/adapters/compatible.js`, `adapters/projection.js`,
  `session/acp-client.js`.
- Cogwork: `packages/cursor-acp/src/harness.ts`, `packages/cursor-acp/FINDINGS.md`,
  `packages/cursor-acp/FINDINGS-RESUME.md`, `packages/engine/src/external-harness-runtime.ts`,
  ADR 0004, ADR 0024, ADR 0025, engine ADR 0006.
