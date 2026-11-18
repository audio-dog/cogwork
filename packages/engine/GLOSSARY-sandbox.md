# Engine glossary: Sandbox and tools

Part of the [engine glossary](./GLOSSARY.md).

**Owned tool set**:
The owned tools the engine hands a run instead of leaning on the harness's built-ins: `read`, `write`, `edit`, `bash`, `glob`, `grep`, and `webfetch`. Each is a TanStack `toolDefinition` with an Effect handler, and each runs through the run's worktree sandbox rather than touching the host directly. There is no tracker or PR tool — `git` and `gh` ride in on `bash`. File-touching tools go through path confinement first; failures surface as a typed `ToolError`.
_Avoid_: Built-in tools (those are the harness's), MCP server (one server exposes Tools; this set is native)

**Worktree sandbox**:
An `ai-sandbox` `localProcessSandbox` opened onto a Run Plan's Workspace checkout, so the owned tools read, write, and exec against that checkout and nothing else. With no Workspace it owns an empty scratch directory instead. It is an Effect resource: scope close removes an owned scratch directory, but never a Workspace checkout. The base SHA it reports is `git rev-parse HEAD`, or `""` when the checkout is not a git repo.
_Avoid_: Worktree manager (that owns the git lifecycle; this is the process boundary a run's tools execute inside), container

**Path confinement**:
The rule that keeps a file-touching tool inside the worktree root: a requested path is normalized (drop leading `/` and any `/workspace` prefix, resolve `.` and `..`) and any path that would climb above the root is rejected as an `out-of-bounds` `ToolError` before the sandbox is asked to do anything. The typed refusal at the tool layer is the point — it fails clearly instead of leaning on the sandbox's more generic error.
_Avoid_: Sandboxing (that's the process boundary), chroot, jail

**File-diff feed**:
The stream of file-change events the live run view consumes. One watcher serves both paths: it batches events, asks `git check-ignore` what to withhold, debounces per path, and computes a unified diff per change against the Run's base SHA, capped per file. Owned tools consume it directly, and an External Harness with no native file events has it merged into its Run. An External Harness that does report native events normalizes them to the same `AgUiEvent`: a `CUSTOM` event named `sandbox.file.diff`. Payload and metadata remain whole, so fidelity stays runner-declared instead of inferred by the client.
_Avoid_: Event log (that's the durable run record), file watcher (that's the mechanism, this is the diff stream on top of it)

**Policy profile**:
The allow/ask/deny rules a Run's owned tools are gated by. A Workflow Operation chooses `read-only` or `full`. The Harness request carries the immutable choice, and a Harness declares which profiles it can enforce.

An external Harness receives the same `SandboxPolicy` as engine-owned tools. Its native built-in tools are not Cogwork's bridged server tools: the native adapter projects the policy into its own permission, tool, command, and Sandbox controls, while MCP projection stays a separate transport. `policyFidelity` reports whether that native projection is exact, profile-only, or absent. Provider selection is a separate input to the shared external Harness runtime, not part of Harness selection.

The local-process Sandbox provider is a trusted Runtime Host process boundary. It sets the checkout working directory and scrubs environment variables; it is not container or filesystem isolation. A runner may claim worktree confinement only when its native controls or a future isolated provider enforce it.
_Avoid_: Sandbox isolation (that's the process boundary; this is the decision layer above it), per-tool allowlist (bash is command-matched, not all-or-nothing)

**Ask-compiles-to-deny**:
The AFK keystone. The full allow/ask/deny vocabulary is authored in the profiles, but with no human in the session there is nothing to answer an `ask`, so `ask` compiles to `deny` before the tool runs. A denied call is not an error or a park — it returns a `denied` result the model reads and adapts to, adding no approval RPC and never handing the item to a person. The loop budget, not a human, bounds any thrashing.
_Avoid_: Approval flow / interrupt (that's the interactive phase this defers), tool error (a denial is a normal result, not a failure)

**Hard-deny rule**:
A command-glob rule refused in every profile, for every operation — the small floor under even the full profile. Three destructive shapes: force-pushing to `main`/`master`, piping a download straight into a shell (`curl … | sh`), and recursively deleting an absolute or home path. The model is treated as fallible, not adversarial, so the globs are coarse and a hard-deny just returns `denied` like any other refusal.
_Avoid_: Confinement (that keeps writes inside the worktree root; this bounds shell commands), sandbox isolation
