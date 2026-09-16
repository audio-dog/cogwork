# Cursor ACP (harness adapter)

The Cursor-specific [harness runner](../engine/CONTEXT.md): it implements the engine's harness
contract by driving the Cursor agent CLI over ACP (Agent Client Protocol). The engine knows nothing
about ACP; this package knows nothing about scheduling. It only translates.

Role in the flow: the engine's executor hands it a harness request; it returns a stream of harness
events.

## Language

**cursorRunner**:
The Cursor descriptor passed to the engine's shared External Harness runtime. It retains only Cursor's ACP transport, catalog discovery, model and effort projection, telemetry acknowledgments, diagnostics, and optional token estimate. The shared runtime owns Workspace and MCP projection, host authentication, Sandbox lifecycle, chat streaming, event bridging, and cancellation. When a request references a Session, the descriptor hands its stored opaque handle to Cursor as `modelOptions.sessionId`. Cursor sessions support programmatic resume but no human attach command.
_Avoid_: Harness, driver

Cursor ACP has no journal or takeover capability. Driver loss is never treated as safe detachment.

Cursor ACP also declares file-event fidelity `absent`. Its ACP stream has no supported file-diff event, and the current execution posture rejects local-process Runs before a workspace watcher could be authoritative.

**Cursor model / effort**:
Harness-native strings for Cursor, as **parameterized base ids** — `claude-opus-5`, not `claude-opus-5-thinking-high`. `--model` takes parameters as a bracket list on a base id (`'claude-opus-5[context=1m,effort=high,fast=false]'`), so the base id and its parameters are the two halves of one selection. Effort is one such parameter and differs per model: `composer-2.5` takes none, `claude-opus-5` takes five. It is never a Harness-wide list.

The Operation's `effort` setting supplies the `effort` parameter; its **model options** setting supplies the rest. The runner composes both onto the base id as one bracket list, replacing any parameter the stored id already carries.

`agent --list-models` cannot express this — it flattens every combination into one id and drops the display name — so the catalog comes from Cursor's own picker over ACP: `cursor/list_available_models`, answered only for a client that declares `_meta.parameterizedModelPicker`. That is the runner's `native` catalog source. The generated, versioned `cursorModelCatalog` (`models:sync` → `models.generated.ts`) is the `fallback`, so an unreachable agent narrows the picker rather than emptying it; `models:check` detects drift. Runtime readiness still probes the installed CLI and its model command without changing the picker source. Config authors get autocomplete via `satisfies CursorModel`.
_Avoid_: Sync's semantic model tiers (`fast` / `default` / `powerful`); hand-maintaining the model catalog; the flattened `--list-models` ids as a catalog; a Harness-wide Cursor effort list

**ACP (Agent Client Protocol)**:
The stdio JSON-RPC protocol the Cursor CLI exposes via `agent acp`. The wire format this adapter speaks; not a concept the rest of the repo sees.
_Avoid_: API, transport (generically)

**Adapter**:
The TanStack `acpCompatible()` bridge that turns Cursor's ACP stream into TanStack AI stream chunks. The shared External Harness runtime maps those chunks to Harness events.
_Avoid_: Work source adapter (unrelated), harness runner

**Structured result**:
Cursor has no native structured-output contract in ACP. The shared runtime supplies the operation schema through prompt-and-parse, so Cursor declares lower structured-output reliability than native adapters.
_Avoid_: Native structured output, guaranteed JSON mode

**Unsupported policy posture**:
Cursor ACP runs with explicit headless permissions and a fail-closed permission mode. ACP cannot prove worktree confinement or either Operation profile because Cursor decides which native actions request permission. The runner therefore rejects every current local-process Run before native launch. A future isolated Sandbox provider can supply confinement independently, but Cursor still needs an enforceable profile before it can run.
_Avoid_: Permission prompt, bypassPermissions, silent downgrade

**Runtime Host process**:
The local-process provider sets the checkout working directory and scrubs environment variables. It is a trusted Runtime Host boundary, not a container, Sandbox, or worktree-confinement mechanism.
_Avoid_: Container, isolated Sandbox

**Token-usage estimate**:
The best-guess `usage` this adapter attaches to a run's terminal event because Cursor's ACP mode reports no real token counts (see [FINDINGS.md](./FINDINGS.md) Q2 — the prompt response is `{stopReason}`, no `usage`; the counts exist only in the CLI's non-ACP `--print --output-format json` mode). The descriptor's usage estimator folds the streamed assistant + reasoning text and, when the real `RUN_FINISHED` carries no `usage`, fills one in at `chars/4` over the prompt plus that streamed text, flagged `estimated`. The flag rides the whole ledger and both surfaces (`cogwork runs` prints `tokens=~N`; the desktop drill-in marks it with a tooltip) so a rough number is never mistaken for a metered one. Because it undercounts, the follow-up resume policy ignores it — only metered usage can trip the resume token cap. It undercounts the system prompt, tools, and resumed server-side context the harness can't see; the day Cursor adds `usage` to the ACP response the real counts flow through untouched (`@tanstack/ai-acp` already forwards them) and this estimate steps aside.
_Avoid_: Metered usage, billing tokens, exact cost
