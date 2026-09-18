# Cursor ACP (harness adapter)

The Cursor-specific [harness runner](../engine/CONTEXT.md): it implements the engine's harness
contract by driving the Cursor agent CLI over ACP (Agent Client Protocol). The engine knows nothing
about ACP; this package knows nothing about scheduling. It only translates.

Role in the flow: the engine's executor hands it a harness request; it returns a stream of harness
events.

## Language

**cursorRunner**:
The Cursor descriptor passed to the engine's shared External Harness runtime. It retains only Cursor's ACP transport, model and effort projection, telemetry acknowledgments, diagnostics, and optional token estimate. The shared runtime owns Workspace and MCP projection, host authentication, Sandbox lifecycle, chat streaming, event bridging, and cancellation. When a request references a Session, the descriptor hands its stored opaque handle to Cursor as `modelOptions.sessionId`. Cursor sessions support programmatic resume but no human attach command.
_Avoid_: Harness, driver

Cursor ACP has no journal or takeover capability. Driver loss is never treated as safe detachment.

Cursor ACP also declares file-event fidelity `absent`. Its ACP stream has no supported file-diff event, and the current execution posture rejects local-process Runs before a workspace watcher could be authoritative.

**Cursor model / effort**:
Harness-native strings for Cursor. The picker and adapter share the generated, versioned `cursorModels` tuple (`models:sync` → `models.generated.ts`), never a second live catalog. `models:check` detects drift from the local CLI. Runtime readiness still probes the installed CLI and its model command without changing the picker source. Config authors get autocomplete via `satisfies CursorModel`. Effort is optional (`none` | `low` | `medium` | `high` | `xhigh` | `max`) and becomes a bracket `--model` override for parameterized base ids; the listed preset ids already embed their effort.
_Avoid_: Sync's semantic model tiers (`fast` / `default` / `powerful`); hand-maintaining the model catalog

**ACP (Agent Client Protocol)**:
The stdio JSON-RPC protocol the Cursor CLI exposes via `agent acp`. The wire format this adapter speaks; not a concept the rest of the repo sees.
_Avoid_: API, transport (generically)

**Adapter**:
The TanStack `acpCompatible()` bridge that turns Cursor's ACP stream into TanStack AI stream chunks. The shared External Harness runtime maps those chunks to Harness events.
_Avoid_: Work source adapter (unrelated), harness runner

**Structured result**:
Cursor has no native structured-output contract in ACP. The shared runtime supplies the operation schema through prompt-and-parse, so Cursor declares lower structured-output reliability than native adapters.
_Avoid_: Native structured output, guaranteed JSON mode

**Declared policy posture**:
Cursor declares exactly one Operation profile: Full (ADR 0025). ACP cannot prove worktree confinement or read-only enforcement because Cursor decides which native actions request permission, so no Read only claim is made; the Full declaration trusts Cursor's own permission mode the way ADR 0023 trusts Codex's ambient hooks. An enforceable ACP permission mapping or an isolated Sandbox provider can add the Read only profile later.
_Avoid_: Permission prompt, bypassPermissions, silent downgrade, read-only claim, refuse-everything posture (reversed by ADR 0025)

**Runtime Host process**:
The local-process provider sets the checkout working directory and scrubs environment variables. It is a trusted Runtime Host boundary, not a container, Sandbox, or worktree-confinement mechanism.
_Avoid_: Container, isolated Sandbox

**Token-usage estimate**:
The best-guess `usage` this adapter attaches to a run's terminal event because Cursor's ACP mode reports no real token counts (see [FINDINGS.md](./FINDINGS.md) Q2 — the prompt response is `{stopReason}`, no `usage`; the counts exist only in the CLI's non-ACP `--print --output-format json` mode). The descriptor's usage estimator folds the streamed assistant + reasoning text and, when the real `RUN_FINISHED` carries no `usage`, fills one in at `chars/4` over the prompt plus that streamed text, flagged `estimated`. The flag rides the whole ledger and both surfaces (`cogwork runs` prints `tokens=~N`; the desktop drill-in marks it with a tooltip) so a rough number is never mistaken for a metered one. Because it undercounts, the follow-up resume policy ignores it — only metered usage can trip the resume token cap. It undercounts the system prompt, tools, and resumed server-side context the harness can't see; the day Cursor adds `usage` to the ACP response the real counts flow through untouched (`@tanstack/ai-acp` already forwards them) and this estimate steps aside.
_Avoid_: Metered usage, billing tokens, exact cost
