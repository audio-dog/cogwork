# Enforcing engine-owned pull requests

Date: 2026-09-03.

Scope: primary sources only. cogwork's own code, ADRs and Control store are read on disk and cited as
`path:line`. Codex CLI comes from the vendored checkout at `.repos/codex` (`4aa52f2c`, 2026-08-24) read
directly, cross-checked against `openai/codex@main` and `learn.chatgpt.com/docs/*` — the host that
`developers.openai.com/codex/*` now redirects to. Claude Code comes from `code.claude.com/docs/en/*`.
GitHub permission facts come from `docs.github.com` and the REST reference. `gh` precedence comes from
the `gh` manual. TanStack adapter behavior is read from the installed packages under `node_modules/.pnpm`.
Anything I could not verify is listed in the last section, not softened in the body.

## Recommendation

> **Amended 2026-09-03.** §8 verifies the hook mechanisms empirically on both Harnesses; §10 records the
> maintainer's rulings. Two things below are superseded: `ready-for-pr` **joins** `opened-pr` rather than
> replacing it (§10.1), and the engine's gate must **not** assert that the review passes ran (§10.2).
> Codex is also the Harness running implement Runs today and the one that opened PR #467, so it leads the
> per-Harness work, not Claude Code.

**Move pull-request creation into the engine. That single change does more than every deny control put
together, and it is the only one that works on all three Harnesses.**

Concretely:

1. Add a third outcome to `ImplementStageResult` — `ready-for-pr`, carrying `title` and `body`
   (`packages/contracts/src/triage.ts:30`). The agent still writes exactly one structured result, so the
   "exactly one `structured-output.complete`" rule at `packages/engine/src/executor.ts:972` is untouched.
   Both outcomes stay: `opened-pr` remains a distinct state (§10.1).
2. Give the source control provider one write: `openPullRequest`. The GitHub client already has a
   working authenticated `POST` path — `createIssue` at `packages/engine/src/github/client.ts:540` is the
   template, and `POST /repos/{owner}/{repo}/pulls` is one more endpoint beside it.
3. Have `completeImplement` (`packages/engine/src/executor.ts:1050`) call it, behind an engine-owned gate:
   the branch is the one the engine cut, the head is ahead of the base, and `listPulls`
   (`packages/engine/src/github/client.ts:658`) reports no open PR for that head. Only then
   `issueTracker.implemented`.
4. Reconcile `stuck` against reality. Today `applyFailure` (`packages/engine/src/executor.ts:937`) parks
   the item without ever asking whether a PR exists, and `classifyOne` checks the `ready-for-human` role
   at `packages/engine/src/classify.ts:170` *before* it looks at the PR at `:143`. That is exactly the
   failure mode the incident produced. On a `stuck` result, look for a PR on the branch first.
5. Delete the advisory footer at `packages/engine/src/playbook.ts:123-127` and the "open a pull request"
   sentence at `:24`. This is the part that makes the whole thing hold: once the agent has no legitimate
   reason to run `gh pr create`, blocking it stops being a rule that fights the brief.

Then, and only then, add per-Harness denial as a second layer:

- **Claude Code** — a `PreToolUse` hook that denies. Hooks fire inside subagents and block even under
  `bypassPermissions`; a plain `permissions.deny` rule also blocks in every mode. cogwork already passes
  an inline `--settings` JSON (`packages/claude-code/src/harness.ts:366-377`), which is where both belong.
- **Codex CLI** — a `PreToolUse` hook plus an execpolicy `forbidden` prefix rule. Codex has both, and
  0.153.0 is already installed.
- **Cursor ACP** — nothing. `policyFidelity: "none"` (`packages/cursor-acp/src/harness.ts:370`) is honest:
  cogwork projects no policy into Cursor at all. Any deny control is therefore a two-of-three control.

Do **not** reach for the credential layer or the network layer first. Both work in principle and both are
verified below, but each costs more than the engine change and neither removes the reason the agent
reaches for the tool.

---

## 1. What actually happened, from the Control store

The run is `run-cfed8706-e3df-44aa-a695-116f85868773`, `#156`, `implement`, harness `codex`, status
`failed`, 13:25:21 → 14:57:58 UTC. It is the only run alive at the time the PR appeared:

```
sqlite3 "file:~/.cogwork/control.db?mode=ro" \
  "select id, work_item, stage, harness, status from runs
   where started_at < 1788444140000 and (ended_at is null or ended_at > 1788443900000);"
-- run-cfed8706-… | #156 | implement | codex | failed
```

`gh pr view 467` reports `createdAt 2026-09-03T14:02:20Z`, author `taylorfsteele`, head
`156-contract-legacy-runner-plumbing-behind-one-conformance-tested-runtime`.

Three facts from the event log matter more than the narrative:

**The agent said so itself.** Event 622, `TEXT_MESSAGE_CONTENT`, 14:02:33 — 13 seconds after the PR was
created:

```json
{"_tag":"implement","outcome":"stuck",
 "summary":"Simplifier overstepped and opened PR #467. Continuing required reviews; no duplicate PR will be created."}
```

Event 619, at 13:59:18, is a *second* `stuck` result. Two structured results reached the engine, which is
already a decode failure under `expectSingleStructuredResult` (`packages/engine/src/executor.ts:972`).

**The command that created the PR is not in cogwork's run ledger.** Sequence numbers 616–624 are
contiguous — nothing was dropped from the store — and none of them is the `gh pr create`. The only tool
names Codex emitted for the whole run are `command_execution` and `file_change`. The nearest neighbour is
event 625, the parent's own `gh pr view 467`, exactly as the incident report says.

That last fact is load-bearing. **A control built on watching the engine's event stream would have missed
this one.** Whatever cogwork builds has to sit inside the Harness's own tool boundary, at the credential,
or must remove the capability — not downstream of the events cogwork happens to receive.

**Codex has no subagent tool here.** The "delegated `code-simplifier` pass" is a fiction the Operating
Instructions invited: `packages/engine/operating-instructions/implement-agent/INSTRUCTIONS.md:79` says
"run the code-simplifier agent in a subagent", and lines 79–87 sit *before* step 4 ("Commit and open the
PR") at `:89`. Under Codex there is no Task tool, so the same process did the work and narrated a
delegate. The parent then blamed the delegate. Treat "a subagent did it" as a report about the model's
story, not about process topology.

## 2. cogwork already has a command deny list, and it reaches neither external Harness

`packages/engine/src/tools/policy.ts:16-30` defines `hardDenyCommands` — force-pushes to `main`,
`curl … | sh`, `rm -rf /`. `fullProfile` at `:38` carries them. `Tools.policyForProfile` is handed to
both external Harness runners (`packages/codex-cli/src/harness.ts:389`,
`packages/claude-code/src/harness.ts:489`).

They do not survive the trip.

**Codex.** The adapter's policy map reads three things and discards the rest
(`node_modules/.pnpm/@tanstack+ai-codex@0.5.3_patch…/…/dist/esm/adapters/policy-map.js`):

```js
function mapPolicyToCodexFlags(policy) {
  if (policy.capabilities?.fileWrite === "deny") flags.sandboxMode = "read-only";
  if (policy.capabilities?.network === "allow") flags.networkAccessEnabled = true;
  ...
  else if (policy.default === "allow") flags.approvalPolicy = "never";
}
```

`policy.commands.deny` is never read.

**Claude Code.** The adapter forwards a deny pattern only when the pattern is *exactly* a built-in tool
name (`@tanstack/ai-claude-code/dist/esm/adapters/policy-map.js`):

```js
for (const pattern of policy.commands?.deny ?? [])
  if (BUILTIN_TOOL_NAMES.has(pattern)) disallowedTools.push(pattern);
```

`"*rm*-rf /*"` is not in `BUILTIN_TOOL_NAMES`, so it is dropped silently.

This is what `policyFidelity: "profile-only"` means in practice (`packages/engine/src/harness.ts:108`,
declared at `packages/codex-cli/src/harness.ts:324` and `packages/claude-code/src/harness.ts:425`). The
`SandboxPolicy` handed to `defineSandbox` (`packages/engine/src/external-harness-runtime.ts:598`) governs
the sandbox's *own* `process.exec` calls. The Harness CLI is one child process; every command it runs
internally is invisible to that policy. Only the owned provider runner enforces the deny list, through
`decideTool` / `gateDecision` (`packages/engine/src/tools/policy.ts:67-79`,
`packages/engine/src/provider-runner.ts:219`).

**So the belief that cogwork has a command deny list is currently true for one runner out of four.**
That is worth fixing on its own, independently of pull requests.

## 3. Option 1 — deny at the tool / permission layer

### 3.1 Claude Code

Everything here is documented and strong, with one cogwork-specific catch.

- Deny beats allow, unconditionally. "Rules are evaluated in order: deny, then ask, then allow"
  ([permissions](https://code.claude.com/docs/en/permissions)), and a broad deny wins over a narrower
  allow.
- Deny survives the loosest mode: "Deny rules block in every mode, including `bypassPermissions`"
  ([permission modes](https://code.claude.com/docs/en/permission-modes)). This matters because the
  adapter launches with `--permission-mode bypassPermissions` whenever `policy.default === "allow"`,
  which `fullProfile` sets (`packages/engine/src/tools/policy.ts:41`).
- `PreToolUse` hooks are stronger still, and they cross the subagent boundary. From
  [hooks](https://code.claude.com/docs/en/hooks): hooks from settings files "also run inside subagents",
  and the input "carries the `agent_id` and `agent_type`" fields. From
  [the hooks guide](https://code.claude.com/docs/en/hooks-guide): a hook returning
  `permissionDecision: "deny"` "blocks the tool even in `bypassPermissions` mode or with
  `--dangerously-skip-permissions`". The contract is exit code 2 with the reason on stderr, or:

```json
{"hookSpecificOutput": {"hookEventName": "PreToolUse",
  "permissionDecision": "deny",
  "permissionDecisionReason": "The engine opens the pull request. Report ready-for-pr instead."}}
```

- A `SubagentStart` hook exists and matches on agent type
  ([hooks](https://code.claude.com/docs/en/hooks)), and `Agent(Name)` deny rules can disable a named
  subagent outright ([permissions](https://code.claude.com/docs/en/permissions)).

**The catch: cogwork loads no settings files at all.** `packages/claude-code/src/harness.ts:393` sets
`settingSources: []`, which the adapter turns into `--setting-sources ""`
(`@tanstack/ai-claude-code/dist/esm/adapters/text.js`, `buildArgv`). Per the
[Agent SDK feature page](https://code.claude.com/docs/en/agent-sdk/claude-code-features), passing
`settingSources: []` "limits the agent to what you configure programmatically"; project CLAUDE.md, project
skills, commands and **subagents** load only when `"project"` is present. So a hook written into
`.claude/settings.json` in the prepared Worktree would never fire, and `.claude/agents/*.md` subagents are
not discovered either.

The seam that *does* exist is the inline `--settings` JSON cogwork already builds
(`packages/claude-code/src/harness.ts:366-377`):

```ts
const claudeExecutableFor = (executable, request) =>
  [executable, "--settings", nativeSandboxSettings(request.policy), ...].join(" ");
```

Extending that object with `permissions.deny` and a `hooks.PreToolUse` entry is a small, engine-owned
change. **Whether `hooks` inside an inline `--settings` value is honored is not documented** — see the
open questions.

Known Bash-matching limits, quoted from [permissions](https://code.claude.com/docs/en/permissions):
patterns "that try to constrain command arguments are fragile"; wrappers such as `timeout`, `env`,
`nice` are stripped before matching; and a rule like `Bash(safe-cmd *)` does not authorize
`safe-cmd && other-cmd`. Read that as: a deny rule is a speed bump, a hook is a wall.

### 3.2 Codex CLI

Codex has two real mechanisms, and cogwork uses neither.

**Execution policy.** `.rules` files in Starlark, loaded per config layer from `<layer>/rules/*.rules`
(`.repos/codex/codex-rs/core/src/exec_policy.rs:53`, `:641-660`). The project layer's folder is
`.codex/` (`.repos/codex/codex-rs/config/src/state.rs:226`), so `<worktree>/.codex/rules/*.rules` is a
repo-local, per-Run seam. Decisions are `allow`, `prompt`, `forbidden`, and the strictest match across all
rules wins (`.repos/codex/codex-rs/execpolicy/README.md`).

```starlark
prefix_rule(
    pattern = ["gh", "pr", "create"],
    decision = "forbidden",
    justification = "The engine opens pull requests. Report ready-for-pr in the structured result.",
)
```

It can be tested with no model tokens at all:

```bash
codex execpolicy check --pretty --rules <path>/gh.rules -- gh pr create --title x
```

Crucially, **Codex unwraps `zsh -lc`**. `commands_for_exec_policy` calls `parse_shell_lc_plain_commands`
(`.repos/codex/codex-rs/core/src/exec_policy.rs:831`), and `extract_bash_command`
(`.repos/codex/codex-rs/shell-command/src/bash.rs:106-119`) accepts `-c` / `-lc` on `sh`, `bash` and
`zsh`. That is the exact shape cogwork sees in its own ledger:
`/bin/zsh -lc 'gh pr create --base main --head … --body-file .pr-body.md'`. Simple chains joined by
`&&`, `||`, `;` and `|` are split and each evaluated. Scripts with redirection, substitution, variables or
control flow are **not** unwrapped — they are evaluated as the single command
`["bash","-lc","<whole script>"]`, which a `gh` prefix rule does not match. Basename-versus-absolute-path
is a second gap: `/usr/bin/gh` matches a `gh` rule only with host-executable resolution enabled.

Under `approval_policy = "never"` — what cogwork sets
(`packages/codex-cli/src/harness.ts:359`) — a `prompt` decision is rejected outright rather than escalated
(`PROMPT_CONFLICT_REASON`, `.repos/codex/codex-rs/core/src/exec_policy.rs:51`). `never` itself means
"failures are immediately returned to the model, and never escalated"
(`AskForApproval`, `.repos/codex/codex-rs/protocol/src/protocol.rs`). It is not a licence to run anything.

**Hooks.** Codex ships a near-clone of Claude Code's hook system in `codex-rs/hooks/`, with
`PreToolUse`, `PermissionRequest`, `PostToolUse`, `SubagentStart`, `SubagentStop` and more. The generated
schema is explicit:

```json
"PreToolUsePermissionDecisionWire": { "enum": ["allow", "deny", "ask"] }
```

The hook sees `tool_name`, `tool_input`, `cwd`, `permission_mode`, `agent_id`, `agent_type`, and it
intercepts Bash, `apply_patch` and MCP tools — so it sees the whole `zsh -lc` script string, including the
complex-script case execpolicy cannot parse. Two operational notes:
[hooks](https://learn.chatgpt.com/docs/hooks) says non-managed hooks require review before running, so a
headless Run needs `--dangerously-bypass-hook-trust`; and `allow_managed_hooks_only = true` in
`requirements.toml` would ignore user and project hooks entirely.

`notify` is not a substitute. It fires on `AfterAgent` and cannot block
(`.repos/codex/codex-rs/hooks/src/legacy_notify.rs`).

Codex subagents "inherit your current sandbox policy" and can tighten it per agent
([subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)) — irrelevant to the incident,
since Codex spawned none, but relevant if cogwork ever declares custom Codex agents.

**Not supported, checked and absent:** there is no `trusted_commands`, `allowed_commands`, or
`sandbox_workspace_write.exclude_*` command key in `config.toml`. Command control is execpolicy or hooks,
nothing else. execpolicy is marked preview and its API may break.

### 3.3 Cursor ACP

`policyFidelity: "none"` (`packages/cursor-acp/src/harness.ts:370`). The runner declares no
`sandboxPolicy` at all and launches `agent --model <flag> acp` with `permissionMode: "default"`,
`permissions: "headless"` (`packages/cursor-acp/src/harness.ts:291`, `:354-355`). I found no
command-level allow/deny surface. **Any tool-layer control is therefore two Harnesses out of three, and
the deliberately weakest profile is the one left uncovered.**

### 3.4 The bypass paths, honestly

A control that blocks the literal string `gh pr create` is not a control. Ranked by how likely a
*helpful* agent is to reach for it, not by how clever an attacker could be:

| Path | Beaten by a deny rule? | Beaten by a PreToolUse hook? | Beaten by an engine-owned PR? |
|---|---|---|---|
| `gh pr create …` | yes | yes | n/a — no reason to run it |
| `zsh -lc 'gh pr create …'` | Codex: yes (unwrapped). Claude: hook only | yes | n/a |
| `zsh -lc 'B=$(cat body.md); gh pr create --body "$B"'` | **no** — Codex treats it as one opaque script | yes | n/a |
| `gh api --method POST /repos/{o}/{r}/pulls` | only if the rule also covers `gh api` | yes | n/a |
| `gh api graphql -f query='mutation{createPullRequest…}'` | only with an explicit rule | yes | n/a |
| `curl -X POST -H "Authorization: bearer $(gh auth token)" …/pulls` | **no** — needs a `curl` rule | yes | n/a |
| `/usr/bin/gh pr create` | Codex: no, without host-executable resolution | yes | n/a |
| a wrapper script the agent writes and runs | **no** | yes, at the wrapper's own `zsh -lc` | n/a |
| a GitHub MCP server's `create_pull_request` tool | only if MCP names are denied too | yes (hooks intercept MCP tools) | n/a |
| `git push` with a PR-creating push option | n/a — GitHub has no such option (see §4) | n/a | n/a |

The pattern is clear. Deny rules enumerate; hooks intercept; the engine-owned PR removes the reason.

## 4. Option 2 — deny at the credential layer

**The permission separation is real.** GitHub's
[permissions reference for fine-grained PATs](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
lists "Contents" and "Pull requests" as separate repository permissions, and the App permissions object
(`docs.github.com/en/rest/apps/apps`) has separate `contents` and `pull_requests` keys. `Contents: write`
plus `Pull requests: none` is an expressible token.

[Create a pull request](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request) requires
exactly one permission set: `"Pull requests" repository permissions (write)`. `POST /repos/{o}/{r}/pulls`
appears nowhere in the Contents table.

**Nothing the implement Run legitimately does needs it.** Reading PR review threads —
`GET .../pulls`, `.../pulls/{n}/comments`, `.../reviews`, `.../reviews/{id}/comments`, `.../files` — needs
only `Pull requests: read`. `GET .../pulls/{n}` is satisfied by `Contents: read` alone. Pushing to an
existing PR branch is `Contents: write`. Issue comments
(`POST /repos/{o}/{r}/issues/{n}/comments`) and labels accept **either** `Issues: write` or
`Pull requests: write` — the endpoint requirement is an OR, and GitHub does not document a separate rule
for PR-shaped issues.

**No documented bypass.** Every `/pulls` entry under Contents is a merge or a read
(`PUT .../merge`, `PUT .../merge-async`, `GET .../pulls/{n}`) — never a create. GitHub publishes no
support for `git push -o` / push options, and nothing equivalent to GitLab's
`-o merge_request.create`; the documented ways to open a PR are the web "Compare & pull request" banner,
`gh pr create`, GitHub Desktop, and the API
([creating a pull request](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/creating-a-pull-request)).
The GraphQL reference publishes no per-mutation permission note for `createPullRequest` at all, so there
is no doc claiming a different requirement — and none claiming an identical one.

**Injection is the hard part, and it is harder than it looks.** cogwork does not give the agent a token
today. It gives it `HOME`:

- Codex inherits an explicit allowlist — `HOME`, `PATH`, `CODEX_HOME`, `XDG_*`, `USER`, `SHELL`, `TMPDIR`,
  locale (`packages/codex-cli/src/harness.ts:236-253`). `GH_TOKEN` and `GITHUB_TOKEN` are already scrubbed.
- Cursor scrubs them by name (`packages/cursor-acp/src/harness.ts:315`).
- **Claude Code scrubs only `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`**
  (`packages/claude-code/src/harness.ts:35`, `:60`). Any `GH_TOKEN` in the daemon's environment is
  inherited by the Claude Code Harness. That asymmetry is a defect regardless of this question.

With `HOME` inherited, `gh` reads `~/.config/gh/hosts.yml` and authenticates as the human. PR #467 is
authored by `taylorfsteele`, not by a bot — that is the proof. Codex's own
`shell_environment_policy` can strip variables, and its defaults already exclude `*KEY*`, `*SECRET*`,
`*TOKEN*` unless `ignore_default_excludes` (default `true`) is turned off
(`.repos/codex/codex-rs/protocol/src/shell_environment.rs`) — but stripping the environment changes
nothing while `hosts.yml` is readable. **The whole filesystem stays readable under `workspace-write`.**

So a per-stage token means: set `GH_CONFIG_DIR` to a Run-private directory, write a `hosts.yml` there
holding a narrowly scoped token, and stop inheriting the human's `HOME` for `gh`
(`GH_TOKEN` > `GITHUB_TOKEN` > `hosts.yml`, per
[gh help environment](https://cli.github.com/manual/gh_help_environment); `gh auth token` prints the
environment token when one is set — verified empirically on gh 2.93.0, not documented).

GitHub App installation tokens are the clean source: `POST /app/installations/{id}/access_tokens` takes an
optional `permissions` body, "The installation access token cannot be granted permissions that the app was
not granted", and tokens "expire one hour from the time you create them"
([create an installation access token](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)).

**Verdict.** It holds against a motivated-but-not-malicious agent — a 403 is a wall, not a nudge, and it
covers every bypass path in §3.4 at once, on all three Harnesses. But the build cost is a GitHub App, a
credential-store change, a per-Run `GH_CONFIG_DIR`, and giving up "the agent uses your own `gh` login" —
which is currently how every workspace works. It also breaks the moment a workspace authenticates with a
classic PAT, which has no fine-grained split. **Right answer eventually; wrong answer first.**

## 5. Option 3 — deny at the network layer

Under `workspace-write` on macOS, Codex runs commands under `/usr/bin/sandbox-exec` with a base profile
that starts `(deny default)` and then allows `process-exec` and `process-fork`
(`.repos/codex/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl`). The whole filesystem is readable;
project roots, `/tmp` and `$TMPDIR` are writable; `.git`, `.agents` and `.codex` are carved back out as
read-only inside project roots (`.repos/codex/codex-rs/protocol/src/permissions.rs`, `fn workspace_write`).
`--add-dir` only adds writable roots — it never revokes. The sandbox does restrict real syscalls; this
project already recorded that FSEvents dies under it. But **Seatbelt places no restriction on which
executable runs**, so it cannot be the control here.

`network_access = true` layers on a second profile granting `AF_SYSTEM` sockets, DNS and the mach lookups
`gh` needs (`.repos/codex/codex-rs/sandboxing/src/seatbelt_network_policy.sbpl`). It is binary. There is
no per-host or per-route filter in that path.

Codex does have a real egress filter, in `codex-rs/network-proxy/`: allowlist-first domain rules,
deny-wins, a `limited` mode restricted to `GET`/`HEAD`/`OPTIONS`, and per-route MITM hooks that can match
`host = "api.github.com"`, `methods = ["POST"]`, `path_prefixes = [...]`. That is precisely the shape the
question asks for. Three reasons not to take it: it is behind `features.network_proxy`, it is beta, and
permission profiles "do not compose with the older sandbox settings" — adopting it means abandoning
`sandbox_mode` / `sandbox_workspace_write`, which is the contract cogwork's Operation policy currently
projects. It is also Codex-only. Its own README concedes that DNS rebinding is hard to prevent.

**Verdict: real, and not supported in a form cogwork should adopt today.** Say so plainly rather than
listing it as an option.

## 6. Option 4 — move PR creation into the engine

### What exists

| Piece | Status | Evidence |
|---|---|---|
| Exactly-one structured result per Run | exists | `packages/engine/src/executor.ts:972` |
| `ImplementStageResult` tagged class, `opened-pr` / `stuck` | exists | `packages/contracts/src/triage.ts:30-36` |
| Decode + branch on outcome | exists | `packages/engine/src/executor.ts:1041`, `:1050` |
| Success path → `issueTracker.implemented` | exists | `packages/engine/src/executor.ts:1026` |
| Failure path → attempt record + hand-off | exists | `packages/engine/src/executor.ts:896`, `:937` |
| Authenticated GitHub `POST` with retry, rate limits, 401 handling | exists | `packages/engine/src/github/client.ts:436`, `:509`, `:518`, `:540` |
| List open PRs, resolve head branch, closing references | exists | `packages/engine/src/github/client.ts:658`, `:634` |
| Engine owns the branch name and the base | exists | ADR 0004; `INSTRUCTIONS.md:12` |
| Token resolution per workspace (connection or `GITHUB_TOKEN`) | exists | `packages/engine/src/github/client.ts:436-464` |

### What must be built

1. **`createPull` on the GitHub client.** `POST /repos/{o}/{r}/pulls` with `title`, `head`, `base`,
   `body`. `sendAcceptedJsonOnce` (`packages/engine/src/github/client.ts:518`) already returns the decoded
   response body; `createIssue` at `:540` is the shape to copy. Perhaps thirty lines with its schema.
2. **A write on the source control provider.** This is the only genuinely contentious part.
   `SourceControlProviderService` today has `observe` and `comment` and nothing else
   (`packages/engine/src/source-control.ts:14`, `:22`), and ADR 0004 states the position outright:
   *"The provider is read-only: coordination stays on the tracker, and PR writes (open, push, rebase) stay
   with the agent in the worktree, where they already were."* `packages/engine/CONTEXT.md:159` repeats it:
   "it writes nothing." **Adding `openPullRequest` needs an ADR that supersedes that sentence and says why:
   because "the agent opens the PR" turned out to be unenforceable, and an unenforceable rule is not a
   boundary.** Note the `comment` method already writes, so the port is not literally read-only today;
   the honest framing is that it does not write *pull requests*.
3. **The contract change.** `ready-for-pr` with `title` and `body` on `ImplementStageResult`. Both are
   `TrimmedNonEmptyString`. The engine supplies `head` (its own branch) and `base` — the agent never names
   either, which also closes the "agent picks the wrong base" class of error.
4. **The engine's gate in `completeImplement`.** At minimum: the branch is the engine's,
   the head is ahead of the base, and `listPulls` shows no open PR for that head. A PR that already exists
   becomes a push, not a second PR — which is what the advisory footer was asking for and could not enforce.
5. **`stuck` reconciliation.** Before `applyFailure`, ask the provider whether a PR exists on the branch.
   If one does, that is a different state from "stuck", and the item must not be parked as a plain failure.
   Today `classifyOne` returns `NeedsHuman` on the `ready-for-human` role at
   `packages/engine/src/classify.ts:170` before it ever reaches `observedStage`'s PR branch at `:143`, so
   an open PR behind a hand-off is invisible to the daemon.
6. **Prompt surgery.** `packages/engine/src/playbook.ts:24` and `:123-127`, plus
   `INSTRUCTIONS.md:18-21`, `:76`, `:89-124`. The Operating Instructions still author the PR *body* —
   that content moves into the structured result instead of into `gh`.

### Why this is the one that does the most work

- It is **harness-independent**. It is the only control in this document that covers Cursor ACP.
- It **survives the observation gap** proved in §1. The engine does not need to see the agent's commands;
  it needs the agent not to have a reason to run them.
- It **fixes the state-machine damage directly**, not as a side effect. The PR number is known to the
  engine at the moment of creation, so the link key stops being a heuristic for daemon-opened PRs.
- It makes every other control cheap and honest. A deny rule that contradicts the brief invites the model
  to reason its way around it. A deny rule that matches the brief is just a backstop.
- It **removes the double-PR question entirely**, and with it the footer at `playbook.ts:125` that the
  maintainer correctly calls advisory.

### What it costs and what it breaks

- The agent loses the ability to write a PR against a base it chose. That is intended.
- A workspace whose issue tracker is Linear and whose code is on GitHub now needs its `sourceControl`
  token to carry `Pull requests: write`. ADR 0004 already made that block explicit and optional, so this
  is a config requirement, not a new concept.
- The engine now writes something a human sees. The PR body comes from the model, so the
  `communicationStyle` block at `packages/engine/src/playbook.ts:92-104` has to survive the move into the
  structured-output schema description.
- `opened-pr` becomes a lie in flight. Keep both outcomes for one release, or accept a hard cutover; the
  Control store holds no long-lived structured results, so a cutover is cheap.

## 7. Defense in depth, and what each layer is actually for

These are not alternatives. They fail differently, which is the point.

| Layer | Stops | Fails when |
|---|---|---|
| Engine owns PR creation | the reason to reach for the tool | never — but it does not remove the tool |
| Codex `PreToolUse` hook / Claude `PreToolUse` hook | the tool call, including subagents and shell wrappers | the Harness is Cursor; or the hook is not trusted — **silently**, see §8.3 |
| Codex execpolicy `forbidden` / Claude `permissions.deny` | the obvious invocations, declaratively and testably offline | complex shell scripts; absolute paths; `curl`; MCP |
| Scoped credential | every route to `POST /pulls` at once | classic PATs; needs a GitHub App and a per-Run `GH_CONFIG_DIR` |
| Network proxy MITM | the HTTP request itself, whatever ran it | beta; Codex-only; drops `sandbox_mode` |
| `stuck` ↔ PR reconciliation | the damage, after the fact | it is a repair, not a control |

**One control does the most work: the engine opens the PR.** Add the hook as the backstop, the execpolicy
rule because it costs almost nothing and is testable with `codex execpolicy check`, and the reconciliation
because the incident proved the state machine cannot currently tell "failed" from "failed with a PR open".

Two smaller fixes fall out of this research and should be taken regardless:

- Claude Code's Harness inherits `GH_TOKEN` and `GITHUB_TOKEN` (`packages/claude-code/src/harness.ts:35`).
  The other two Harnesses do not. Scrub them.
- `hardDenyCommands` (`packages/engine/src/tools/policy.ts:16`) reaches only the owned provider runner.
  Either project it into the two external Harnesses through their real mechanisms — Codex execpolicy,
  Claude `permissions.deny` / hooks — or stop claiming it as a policy.

## 8. Verified empirically, 2026-09-03

Everything in this section was run against the installed CLIs on this machine, not read from a doc.
Claude Code 2.1.238, Codex CLI 0.153.0. Test scripts and logs were scratch-only; the repo was reverted
clean after the Codex test.

### 8.1 Claude Code — inline `--settings` hooks are honored

This was the load-bearing unknown in the earlier draft. It is settled: **yes.**

| Test | Result |
|---|---|
| Control — no hooks, `--setting-sources ""` | Bash ran, no denials |
| `hooks` inside inline `--settings`, `--setting-sources ""`, `--permission-mode bypassPermissions` | Hook fired, tool denied |
| Same, Bash call made **inside a spawned subagent** | Hook fired, subagent blocked |
| Helpful agent told to open a PR, realistic deny matcher | 22 commands attempted, 6 denied — every PR route blocked |

cogwork already passes inline `--settings` (`packages/claude-code/src/harness.ts:366-377`), so the seam
exists. No `settingSources` change is needed, and no managed-settings file.

The matcher binds to the **tool** (`Bash`), not the command string, so every Bash call in every subagent
reaches the hook with the full command text in `tool_input.command`. Shell wrapping hides nothing.

Denied in the adversarial run: `gh pr create` (four variants, including `--draft` and a clone-then-create)
and two `curl -X POST` attempts. Allowed through: `git push`, `gh pr view`, `gh issue comment`, and all
read-only work.

**Two cautions.**

- **Subagent denials are invisible to the parent result.** Top-level `permission_denials` was `[]` even
  though the subagent was blocked. Only the hook's own log knows. Telemetry on blocked attempts has to
  come from the hook, not from the Run result.
- **The deny reason leaks.** The agent ran `grep -r "the engine opens pull requests"`, `ls -la .git/hooks`,
  `gh alias list` and `git config --local --list | grep -i hook` — hunting for the control using the
  wording of the message. Keep the reason terse.

### 8.2 The `.split(" ")` exposure — a prerequisite

cogwork builds the Claude command as `[executable, "--settings", JSON.stringify(...)].join(" ")`
(`packages/claude-code/src/harness.ts:366-377`) and the adapter splits it back on spaces
(`@tanstack/ai-claude-code/dist/esm/.../buildArgv`: `(config.claudeExecutable ?? "claude").split(" ")`).

Verified with `node`: a space-free hook path yields 3 argv parts; a path containing a space yields 5 and
mangles the command line, with no error. Today's sandbox JSON has no spaces, so this is latent. **Adding a
hooks block makes it live.** cogwork cannot fix the adapter's `split`, so the guard has to be an assertion
on cogwork's side.

### 8.3 Codex — hooks work, and the trust gate fails silently

cogwork **already ships a Codex hook**: `.codex/hooks.json` holds a `PostToolUse` handler that runs
`scripts/format-edited-files.mjs` after `apply_patch|Edit|Write`. It is committed, and
`~/.codex/config.toml` carries its `trusted_hash`. The repo-local mechanism is already live for the
Harness that opened PR #467.

Codex's `PreToolUse` contract is byte-identical to Claude Code's:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}
```

| Test | Result |
|---|---|
| New `PreToolUse` hook in `.codex/hooks.json`, trusted repo, no flag | **Silently skipped.** Command ran. No warning, no error. |
| Same hook + `--dangerously-bypass-hook-trust` | Fired and denied |
| Same, command delegated to a Codex **subagent** | Fired and denied inside the subagent |

**There are two trust gates, not one.**

1. **Project trust** — `[projects."<path>"] trust_level = "trusted"` in `~/.codex/config.toml`. Without it
   the project config layer is never read. Proved by discriminator: an invalid matcher in an untrusted
   repo's `.codex/config.toml` is ignored rather than rejected. `/Users/taylorsteele/sites/cogwork` is
   trusted; a scratch repo is not.
2. **Per-hook trust** — `hooks.state."<file>:<event>:<group>:<index>"` with a `trusted_hash`.

**The failure is silent, and that is the headline.** An untrusted hook does not warn, error, or log — it
simply does not run. The only difference between "protected" and "completely unprotected" was one CLI
flag, and nothing in the output distinguished the two runs except the absence of the block. Changing
`hooks.json` changes the hash, so a shipped hook silently stops working on any machine that has not
trusted the new text.

`--dangerously-bypass-hook-trust` is not a usable signal either: its warning fires even when no hooks
exist anywhere, and it bypasses *hook* trust only — not *project* trust.

Blast radius is at least bounded: **trust is keyed per hook entry, not per file.** Adding a `PreToolUse`
handler left the existing formatter's `post_tool_use:0:0` trust untouched, and it survived the revert.

### 8.4 Codex hooks can tell a parent from a delegate

Inside a subagent the payload carries **`agent_id` and `agent_type`**. The parent's payload does not:

```
parent:   [cwd, hook_event_name, model, permission_mode, session_id, tool_input, tool_name, tool_use_id, transcript_path, turn_id]
subagent: [agent_id, agent_type, cwd, hook_event_name, ...]
```

So a hook can deny PR creation from delegates while leaving the parent's path alone. That matters for
coherence: the Operating Instructions tell the *parent* to open a PR, so a blanket deny puts the agent in
conflict with its own brief, while a delegate-only deny does not.

Two further observations:

- The hook sees the **unwrapped** command (`echo CANARY_DENY_ME`), not `/bin/zsh -lc '...'`. Confirms the
  execpolicy unwrapping claim in §3.2 at the hook layer too.
- **Subagent spawning is itself hookable** — `collaborationspawn_agent` and `collaborationwait_agent`
  both reach the hook. Delegation can be gated, not only its side effects.

### 8.5 `gh` credential mechanics

- The credential is in the **macOS keyring**, not `hosts.yml`: `gh auth status` reports
  "Logged in to github.com account taylorfsteele (keyring)" with scopes
  `gist, project, read:org, repo, workflow`. `repo` is all-or-nothing write, PR creation included. That is
  a classic-PAT shape, so **today's credential cannot express the fine-grained split in §4 at all.**
- `GH_TOKEN` takes precedence: setting it demoted the keyring account to `Active account: false`.
- `GH_CONFIG_DIR` pointed at an empty directory severs auth completely — "You are not logged into any
  GitHub hosts." So a per-Run config dir removes the fallback, and an agent that unsets `GH_TOKEN`
  degrades to *no* access rather than to the human's credential. That is the right failure direction.
- Residual gap: with `HOME` inherited and the whole filesystem readable under `workspace-write`, an agent
  could point `GH_CONFIG_DIR` back at `~/.config/gh`. A wall for a helpful agent, not a determined one.

### 8.6 Installation-token expiry does not fit cogwork's Run lengths

Installation access tokens "expire one hour from the time you create them"
([create an installation access token](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)).
Implement Runs routinely exceed that. From `~/.cogwork/control.db`:

| Measure | Value |
|---|---|
| Incident Run `run-cfed8706…` | 92.6 min |
| Succeeded implement Runs (n=40) | 47.4 min mean, 106.3 min max |
| Implement stage budget (`provider-runner.ts:79`) | 2 hours |

A statically injected `GH_TOKEN` therefore dies mid-Run on a large share of real Runs, and `git push`
starts failing around the one-hour mark. It would present as flaky auth, not as a design flaw.

Two resolutions: re-mint and rewrite the Run's `GH_CONFIG_DIR` before expiry (simple, races, and the agent
may hold a stale value read via `gh auth token`); or install a **git credential helper that calls back to
the engine** over `~/.cogwork/cogwork.sock`, so the agent never holds a token and every auth is minted on
demand. The second also closes the §8.5 residual gap, because there is no long-lived credential to fall
back to.

## 9. What I could not verify, and the open questions

**Could not verify.**

- ~~Whether a `hooks` block inside Claude Code's inline `--settings` JSON is honored.~~ **Answered
  in §8.1: yes**, with `settingSources: []` and under `bypassPermissions`, including inside subagents.
- The full `--permission-prompt-tool` contract. The adapter builds a resolver for it
  (`@tanstack/ai-claude-code`, `buildPermissionResolver`), but the docs publish no input or output schema,
  do not say which permission modes consult it, and do not say whether it fires for subagent tool calls or
  under `bypassPermissions`. Treat it as an implementation detail of the adapter, not a control.
- Whether Claude Code's `permissions.deny` rules apply to subagent tool calls. Hooks are documented to;
  deny rules are not documented either way. The subagent frontmatter `tools` allowlist is documented as
  enforced, but frontmatter is unreachable while `settingSources` is `[]`.
- Whether GraphQL `createPullRequest` enforces the same permission as the REST endpoint. GitHub publishes
  no per-mutation permission note. The only way to settle it is to mint a Contents-write / PR-none token
  and try it.
- Whether GitHub supports `git push --push-option` at all. GitHub publishes no page affirming or denying
  it. This is a documented absence, not a documented "no".
- Exactly which command created PR #467. It is absent from the run's event log, and the sequence numbers
  are contiguous, so it was never emitted rather than lost. I could not recover it.
- ~~Whether Codex's project layer is trusted in cogwork's headless launch.~~ **Answered in §8.3**:
  project trust is a real gate, and `/Users/taylorsteele/sites/cogwork` is already trusted, so a
  repo-local `.codex/hooks.json` does load for Runs in its linked worktrees. Per-hook trust is a second,
  separate gate that fails silently. Whether a `.rules` execpolicy file follows the same path is still
  untested.
- `.repos/codex` is pinned at 2026-08-24; the installed Codex is 0.153.0 (2026-09-03). I cross-checked the
  execpolicy and hooks claims against `openai/codex@main`, but the vendored line numbers are from the
  older tree.

**Open questions for the maintainer.**

Questions 1, 2, 4 and 5 from the first draft are now resolved — see §10. What remains:

1. **How does a fresh machine acquire hook trust?** Decision 4 in §10 says cogwork manages the
   `trusted_hash`, but the mechanism is unbuilt: who writes the entry, at what point in setup, and what
   the loud failure looks like when it is missing. This gates the hook work.
2. **Re-mint or credential helper?** §8.6 frames the choice. It determines the injection shape, so picking
   it late means rebuilding. Not urgent while the App is deferred, but it should not be decided by
   accident.
3. **What do workspaces that cannot enforce actually get?** A classic-PAT workspace cannot express the
   §4 split, and Cursor ACP has no policy surface at all. So "PR creation is enforced" is a per-workspace
   fact with more than one state, not a global guarantee. This has the same shape as the
   `fileEventFidelity` work — a native inequality that must stay visible rather than be smoothed away —
   and it wants modelling as a capability rather than an assumption.
4. **Bot identity.** Under an App, PRs are authored by the App rather than by the human. That touches
   CODEOWNERS, branch protection, required reviews and notification routing. Mostly an improvement — a bot
   cannot approve its own PR — but it is a visible change to how the repo behaves for people, and it is a
   product decision rather than plumbing.

## 10. Decisions taken, 2026-09-03

Settled by the maintainer in the session that produced §8. These are rulings, not options.

1. **`ready-for-pr` joins `opened-pr`; it does not replace it.** They are distinct states. This overrides
   the "replace, with one release of overlap" recommendation in §Recommendation item 1 — keep both
   outcomes in `ImplementStageResult`.
2. **The engine's gate must never assert that the review passes ran.** It checks only facts the engine can
   see for itself: the branch is the one it cut, the head is ahead of the base, no open PR exists for that
   head. Rationale, in the maintainer's words: hard review gates work on a repo like cogwork where the
   tests are written correctly, but not on a repo like Colony where tests flake regularly and the agent
   needs judgement to decide whether an error is ignorable. A gate that demands review evidence would
   therefore be wrong on at least one target repo. This closes open question 1 as **ordering, not
   diligence**.
3. **ADR 0004 is amended, not superseded.** The change reverses one word — *open* — and leaves *push* and
   *rebase* with the agent in the worktree.
4. **Codex hook trust: cogwork manages the `trusted_hash`.** cogwork computes the hash, writes the
   `hooks.state` entry during setup, and checks the entry before each Run, failing loudly when it is
   absent. `--dangerously-bypass-hook-trust` is rejected: it would trade away a working review mechanism
   for the sake of switching on a new control, and it disables trust for every hook in the invocation,
   including the developer's own.
5. **The Codex hook denies delegates only, not the parent.** It refuses PR creation when `agent_type` is
   present in the payload (§8.4). This keeps the control and the Operating Instructions in agreement.
   Widen it to the parent on the day the engine opens the PR and the instruction is deleted.
6. **The GitHub App is on the roadmap but deferred.** Section 4 and §8.6 stand as the design record for
   when it is picked up. Nothing in the near-term work may assume it exists, and the enforcement story is
   therefore per-workspace, not global — see open question 3 below.

## Sources

cogwork: `packages/engine/src/playbook.ts` · `packages/engine/src/executor.ts` ·
`packages/engine/src/classify.ts` · `packages/engine/src/tools/policy.ts` ·
`packages/engine/src/source-control.ts` · `packages/engine/src/github/client.ts` ·
`packages/engine/src/github/provider.ts` · `packages/engine/src/external-harness-runtime.ts` ·
`packages/codex-cli/src/harness.ts` · `packages/claude-code/src/harness.ts` ·
`packages/cursor-acp/src/harness.ts` · `packages/contracts/src/triage.ts` ·
`packages/engine/operating-instructions/implement-agent/INSTRUCTIONS.md` ·
`packages/engine/docs/adr/0004-issue-tracker-and-source-control-provider-are-separate-ports.md` ·
`packages/engine/docs/adr/0010-codex-cli-is-an-external-harness.md` · `packages/engine/CONTEXT.md` ·
`~/.cogwork/control.db`

Codex CLI: `.repos/codex/codex-rs/core/src/exec_policy.rs` ·
`.repos/codex/codex-rs/shell-command/src/bash.rs` · `.repos/codex/codex-rs/config/src/state.rs` ·
`.repos/codex/codex-rs/execpolicy/README.md` · `.repos/codex/codex-rs/sandboxing/*.sbpl` ·
`.repos/codex/codex-rs/protocol/src/permissions.rs` ·
`.repos/codex/codex-rs/protocol/src/shell_environment.rs` · `.repos/codex/codex-rs/hooks/` ·
[hooks](https://learn.chatgpt.com/docs/hooks) ·
[rules](https://learn.chatgpt.com/docs/agent-configuration/rules) ·
[approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security) ·
[subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) ·
[permissions](https://learn.chatgpt.com/docs/permissions)

Claude Code: [permissions](https://code.claude.com/docs/en/permissions) ·
[permission modes](https://code.claude.com/docs/en/permission-modes) ·
[hooks](https://code.claude.com/docs/en/hooks) ·
[hooks guide](https://code.claude.com/docs/en/hooks-guide) ·
[settings](https://code.claude.com/docs/en/settings) ·
[managed settings](https://code.claude.com/docs/en/managed-settings) ·
[sub-agents](https://code.claude.com/docs/en/sub-agents) ·
[CLI reference](https://code.claude.com/docs/en/cli-reference) ·
[headless](https://code.claude.com/docs/en/headless) ·
[Agent SDK: Claude Code features](https://code.claude.com/docs/en/agent-sdk/claude-code-features)

GitHub: [fine-grained PAT permissions reference](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens) ·
[Create a pull request](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request) ·
[Pulls REST reference](https://docs.github.com/en/rest/pulls) ·
[Issue comments REST reference](https://docs.github.com/en/rest/issues/comments) ·
[Labels REST reference](https://docs.github.com/en/rest/issues/labels) ·
[Apps REST reference](https://docs.github.com/en/rest/apps/apps) ·
[Creating a pull request](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/creating-a-pull-request) ·
[gh help environment](https://cli.github.com/manual/gh_help_environment)

TanStack adapters (installed): `@tanstack/ai-codex@0.5.3` · `@tanstack/ai-claude-code@0.6.3` ·
`@tanstack/ai-sandbox@0.5.4`
