# Cursor ACP (harness adapter)

The Cursor-specific [harness runner](../engine/CONTEXT.md): it implements the engine's harness
contract by driving the Cursor agent CLI over ACP (Agent Client Protocol). The engine knows nothing
about ACP; this package knows nothing about scheduling. It only translates.

Role in the flow: the engine's executor hands it a harness request; it returns a stream of harness
events.

## Language

**cursorRunner**:
The factory that produces the engine's harness runner for Cursor. Maps harness-request `model` / `effort` onto Cursor CLI `--model` (including bracket `effort=` overrides) via TanStack `acpCompatible` `modelOptions`. The package also exports `cursorModels` / `cursorEfforts` for typed playbook config.
_Avoid_: Harness, driver

**Cursor model / effort**:
Harness-native strings for Cursor. `cursorModels` / `cursorEfforts` are a typed subset for workspace config (`satisfies CursorModel`); runtime still accepts any id `agent --list-models` reports. Effort is optional (`none` | `low` | `medium` | `high` | `xhigh` | `max`) and becomes a bracket `--model` override when set; preset ids that already embed effort need no separate field.
_Avoid_: Sync's semantic model tiers (`fast` / `default` / `powerful`)

**ACP (Agent Client Protocol)**:
The stdio JSON-RPC protocol the Cursor CLI exposes via `agent acp`. The wire format this adapter speaks; not a concept the rest of the repo sees.
_Avoid_: API, transport (generically)

**Adapter**:
The TanStack `acpCompatible()` bridge that turns the ACP stream into TanStack AI stream chunks, which are then mapped to harness events. Local to this package.
_Avoid_: Work source adapter (unrelated), harness runner

**Sandbox**:
The scoped local-process environment — working directory set to the run's checkout, with env scrubbed — the Cursor CLI is launched inside.
_Avoid_: Container, worktree
