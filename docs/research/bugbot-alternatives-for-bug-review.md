# Replacing Bugbot: bug-focused review for the implement and follow-up operations

Date: 2026-11-02. All sources accessed on 2026-11-02.

**Scope and method.** The maintainer lost access to Cursor Bugbot: the GitHub app on pull requests
and the `/review-bugbot` skill. This note answers five questions about a replacement. Each answer
uses primary sources only: vendor product docs and pricing pages, vendor engineering posts, the
tools' own repositories (README, `action.yml`, prompts, source), and arXiv papers cited by ID.
Repository snapshots: `anthropics/claude-plugins-official` at `a7ba5b93` (2026-10-30),
`anthropics/claude-code-action` at `d535f517` (2026-10-31), `openai/codex-action` at `13e9c174`
(2026-10-30), `qodo-ai/pr-agent` at `d231b66f` (2026-11-02),
`anthropics/claude-code-security-review` at `0c6a49f1` (2026-02-11), and the vendored
`.repos/codex` at `4aa52f2c` (2026-08-24). I mark a claim **(inference)** when no source states it.
I mark a claim **thin evidence** when only a weak or third-party source supports it. This note
builds on [`review-pipeline-design.md`](./review-pipeline-design.md) and does not repeat it. Read
that note for CriticGPT, bounded loops, and fresh-context reviewers.

The cogwork context: the implement operation's review stage dispatches three report-only reviewers
in parallel — `/code-review`, minimalist, and security-auditor — then runs one fix round and no
re-review ([`implement-agent/INSTRUCTIONS.md`](../../packages/engine/operating-instructions/implement-agent/INSTRUCTIONS.md)).
ADR [0027](../adr/0027-headless-review-is-one-bounded-round-of-report-only-reviewers.md) removed
Bugbot from that fan-out with the line "Bugbot leaves the fan-out — CI owns it." CI no longer owns
it. No reviewer in the fan-out owns correctness bugs outside the spec: security-auditor reports
security only, minimalist reports excess only, and `/code-review` reports standards and spec
fidelity.

---

## TL;DR

1. **Bugbot is a find-then-filter pipeline, not one prompt.** Its launch design ran eight parallel
   passes over a shuffled diff, kept only bugs that several passes found, then ran a validator
   model and deduplicated against earlier runs. Later versions became one agent that pulls context
   with tools. Cursor measures quality as *resolution rate*, the share of findings fixed at merge:
   52% to over 70%
   ([Cursor, 2026-01-15](https://cursor.com/blog/building-bugbot)).
2. **Every vendor converges on two stages: find, then verify each finding.** Claude Code Review,
   Anthropic's open `code-review` plugin, Anthropic's security panel, Bugbot, and PR-Agent all
   put a separate check between a candidate and a posted comment. This is a **convergence**, not
   a standard. The checks differ: per-finding validator agents, a three-voter refutation panel,
   confidence scores with a threshold, or majority vote.
3. **The strongest verifier is a test, and it costs recall.** Filtering patches with generated
   tests more than doubled precision (to 47.8%) at 20% recall
   ([SWT-Bench, arXiv:2406.12952](https://arxiv.org/abs/2406.12952)). An LLM reproduced only about
   a third of real bug reports as tests
   ([LIBRO, arXiv:2209.11515](https://arxiv.org/abs/2209.11515)). A test-only gate drops real bugs
   that a test cannot express.
4. **Independent passes raise recall more than precision.** Aggregating ten independent reviews
   raised recall by 118.83% and F1 by 43.67% on real pull requests, and the best single-pass F1
   was about 19%
   ([SWR-Bench, arXiv:2509.01494](https://arxiv.org/abs/2509.01494)). Field studies find that
   concise comments with a code suggestion get acted on more, and that more comments per pull
   request lower their average relevance
   ([arXiv:2508.18771](https://arxiv.org/abs/2508.18771),
   [arXiv:2607.21997](https://arxiv.org/abs/2607.21997),
   [arXiv:2604.24450](https://arxiv.org/abs/2604.24450)).
5. **CI-side options exist, but few fit a personal private repo and the wake path at once.** The
   wake path needs a *top-level inline comment on a diff line* from an exact login
   ([`feedback.ts`](../../packages/engine/src/github/feedback.ts)). Codex cloud review (ChatGPT
   Plus or higher) and `claude-code-action` with the `code-review` plugin both post that shape.
   Claude Code Review needs a Team or Enterprise plan. `codex-action` and PR-Agent post a
   pull-request-level comment by default.
6. **Recommendation: add a report-only `bug-hunter` reviewer, and verify its findings with the
   fix round's existing red proof.** Bug review is how this repo builds Cogwork, not a Cogwork
   feature, so the brief lives in the repo (`docs/agents/bug-hunt.md`) and `AGENTS.md` adds the
   reviewer. The stock package gains only a generic line: a repo's own guidance may add reviewers
   to the round. A blocking bug finding gets a failing test before a fix; a finding whose test does
   not fail gets *won't-fix* with the passing run as the reason. This amends ADR 0027. A CI-side
   reviewer stays optional workspace data: one Bot allowlist entry.

---

# Question 1 — What Bugbot does, mechanically

This section defines what a replacement must reproduce.

## Trigger and scope

- **Trigger.** Bugbot runs on every pull request update, or when a person comments `cursor review`
  or `bugbot run`. It ignores those commands when a bot account posts them
  ([Bugbot docs](https://cursor.com/docs/bugbot)).
- **Incremental by default.** Bugbot reviews only the changes since its previous review. A setting
  turns on a full-diff review on every push ([Bugbot docs](https://cursor.com/docs/bugbot)).
- **Limits.** Bugbot skips a pull request above its size limit and asks for a split. It leaves out
  files marked `linguist-generated`. It does not read files that look like credentials, such as
  `.env` or `*.pem` ([Bugbot docs](https://cursor.com/docs/bugbot)).
- **Effort.** Usage-based plans choose `low`, `default`, `high`, or `smart`. Higher effort "can
  find more bugs" and costs more ([Bugbot docs](https://cursor.com/docs/bugbot)).

## Context it uses

- **Prior comments.** Bugbot reads top-level and inline pull request comments "to avoid duplicate
  suggestions and build on prior feedback" ([Bugbot docs](https://cursor.com/docs/bugbot)).
- **Rules files.** Bugbot merges Team Rules, the root `.cursor/BUGBOT.md`, every nested
  `.cursor/BUGBOT.md` found upward from a changed file, learned rules, and manual rules into one
  rules block. Cursor project rules (`.cursor/rules/*.mdc`) do **not** apply. Each rule is cut at
  30,000 characters, and the combined block is capped at 100,000
  ([Bugbot docs](https://cursor.com/docs/bugbot)).
- **Config from the base branch.** Bugbot reads `.cursor/config/bugbot.yaml` from the base branch,
  "so a PR cannot change how Bugbot reviews itself" ([Bugbot docs](https://cursor.com/docs/bugbot)).
- **Repository reach.** The current design is "fully agentic": the agent "could reason over the
  diff, call tools, and decide where to dig deeper," and "consistently pulled in the additional
  context it needed at runtime" ([Cursor blog](https://cursor.com/blog/building-bugbot)). The docs
  do not state a whole-repository index **(thin evidence on exact scope)**.

## How it filters false positives

The launch pipeline, in Cursor's words ([Cursor blog](https://cursor.com/blog/building-bugbot)):

1. Run eight parallel passes with randomized diff order.
2. Combine similar bugs into one bucket.
3. Use majority voting to filter out bugs found during only one pass.
4. Merge each bucket into a single clear description.
5. Filter out unwanted categories, such as compiler warnings or documentation errors.
6. Run results through a validator model to catch false positives.
7. Dedupe against bugs posted from previous runs.

The agentic redesign changed the prompting direction. Earlier versions "needed to restrain the
models to minimize false positives," but the agent "was too cautious," so Cursor "shifted to
aggressive prompts that encouraged the agent to investigate every suspicious pattern"
([Cursor blog](https://cursor.com/blog/building-bugbot)). Cursor names "letting Bugbot run code to
verify its own bug reports" as a *future* capability, not a shipped one.

**The metric.** Resolution rate is an LLM judgment, at merge time, of which reported bugs the
author fixed. Across 40 experiments it rose from 52% to over 70%, while bugs flagged per run rose
from 0.4 to 0.7 ([Cursor blog](https://cursor.com/blog/building-bugbot)). Cursor also evaluates
offline on BugBench, "a curated benchmark of real code diffs with human annotated bugs." The
benchmark is not public **(thin evidence for any outside comparison)**.

## How it posts results

- Findings arrive as comments "with explanations and fix suggestions"
  ([Bugbot docs](https://cursor.com/docs/bugbot)). On cogwork, every finding was a top-level inline
  comment on a diff line, and Bugbot posted no review when it found nothing
  ([`trusted-bot-wake-signal.md`](../spec/trusted-bot-wake-signal.md)).
- A check named `Cursor Bugbot` concludes `neutral` when it finds issues, unless the team turns on
  fail-on-unresolved ([Bugbot docs](https://cursor.com/docs/bugbot)).
- A PR summary goes into the description or a comment. On cogwork that comment carries
  `<!-- CURSOR_SUMMARY -->` and wakes nothing
  ([`trusted-bot-wake-signal.md`](../spec/trusted-bot-wake-signal.md)).
- `/review-bugbot` stores the reviewed diff's patch ID, so the GitHub app skips a pull request with
  the same patch ([Bugbot docs](https://cursor.com/docs/bugbot)).

## What a replacement must reproduce

From the above **(inference)**: scope findings to code the diff introduced; read surrounding code,
not only the diff; take repository rules from a file the pull request cannot change; put an
independent check between a candidate and a posted finding; post each finding once, as a
top-level comment on a diff line; and dedupe against findings from earlier pushes.

---

# Question 2 — CI-side and PR-side replacements

The follow-up operation wakes when an allowlisted bot "opens a new thread on a line of the diff"
([`packages/contracts/CONTEXT.md`](../../packages/contracts/CONTEXT.md), Bot allowlist). The code
tests three things: the login is on the list, the comment has no thread parent, and its
`subject_type` is `line` ([`feedback.ts`](../../packages/engine/src/github/feedback.ts)). An entry
with the `:any` suffix takes every comment that bot writes. That suffix also takes summaries, which
is the false-wake problem the spec exists to fix. So a tool fits best when it posts each finding as
a top-level line comment under one stable login.

## Comparison

| Tool | Bug focus | Top-level line comments | Auth and cost | Personal private repo | Rules file | False-positive controls | Login |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code Review | Correctness by default | Yes | Team or Enterprise plan; token-billed usage credits | Only through a Team or Enterprise org | `REVIEW.md`, `CLAUDE.md` (base branch) | Verify stage; severity rank | Not documented |
| `claude-code-action` + `code-review` plugin | Bugs and `CLAUDE.md` rules | Yes, with `--comment` | API key, or OAuth token for Pro/Max | Yes | `CLAUDE.md` | Per-issue validator agents | `claude[bot]` |
| Codex cloud code review | P0 and P1 only | Yes (standard review) | ChatGPT Plus or higher; not API key | Yes | `AGENTS.md` `## Code Review Rules` | P0/P1 filter | `chatgpt-codex-connector[bot]` |
| `openai/codex-action` | Your prompt | No (example posts one PR comment) | OpenAI API key | Yes | Your prompt; `AGENTS.md` | Your prompt | GitHub Actions token login (inference) |
| GitHub Copilot code review | Bugs, security, style | Yes | Copilot Pro or higher; AI credits per review | Yes | `.github/copilot-instructions.md`, `AGENTS.md` (head branch) | Effort level | Thin evidence |
| CodeRabbit | General, with profiles | Yes | Free on public repos; $24–30 per developer per month | Paid plan | `.coderabbit.yaml`; reads `AGENTS.md` | `quiet` / `chill` / `assertive` | Not verified |
| Greptile | Logic, syntax, style types | Yes | Free: 1 developer, 50 credits per month | Yes | `.greptile/`, `greptile.json` | `strictness` 1–3; learns from reactions | Not verified |
| Graphite Agent | "Real bugs" | Likely (inference) | Hobby free (limited); $20–40 per seat | Hobby plan | Custom rules | Comment filters | Not verified |
| Qodo PR-Agent (open source) | Your config | Only with `inline_key_issues=true` | Any LLM key through LiteLLM | Yes | `.pr_agent.toml` | Self-reflection score, threshold | GitHub Actions token login (inference) |

## Notes per tool

**Claude Code Review (Anthropic, managed).** "Several agents read each change alongside the
surrounding code." A review runs four stages: find, verify ("checks the candidate findings against
the code and filters out false positives"), rank, post. It "focuses on correctness: bugs that would
break production, not formatting preferences or missing test coverage." It posts inline comments, a
summary, and a `Claude Code Review` check that never fails
([Code Review](https://code.claude.com/docs/en/code-review)). It reads `REVIEW.md` "from the base or
default branch and never from the pull request's own changes"
([Code Review](https://code.claude.com/docs/en/code-review)). Later reviews focus on new changes and
resolve their own earlier threads when fixed
([pull requests](https://code.claude.com/docs/en/code-review-pull-requests)). It is for Team and
Enterprise plans, billed on token usage through usage credits
([costs](https://code.claude.com/docs/en/code-review-costs)). The docs do not name the comment login
**(thin evidence)**. It does not build or run code
([Code Review](https://code.claude.com/docs/en/code-review)).

**Anthropic's open `code-review` plugin, run in `claude-code-action`.** The command runs two
`CLAUDE.md` compliance agents and two bug agents in parallel. One bug agent reads only the diff for
"obvious bugs"; the other looks for "security issues, incorrect logic" in the changed code. Then
"for each issue found … launch parallel subagents to validate the issue," and it drops every issue
the validators do not confirm. It flags only code that will not compile, logic that "will
definitely produce wrong results regardless of inputs," and quotable rule violations. With
`--comment`, it posts one inline comment per issue
([`code-review.md`](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-review/commands/code-review.md)).
The plugin's README still describes a 0–100 confidence score with an 80 threshold; the command file
now uses validator agents instead
([README](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-review/README.md)).
The action installs plugins through its `plugins` input and accepts `anthropic_api_key` or
`claude_code_oauth_token` ([`action.yml`](https://github.com/anthropics/claude-code-action/blob/main/action.yml)).
"Pro and Max users can generate this by running `claude setup-token`"
([setup](https://github.com/anthropics/claude-code-action/blob/main/docs/setup.md)). Comments appear
as `claude[bot]` with the built-in app; a custom `github_token` changes the login
([FAQ](https://github.com/anthropics/claude-code-action/blob/main/docs/faq.md)). The inline comment
tool buffers unconfirmed comments and classifies them after the session, to stop test comments from
subagents reaching the pull request
([solutions](https://github.com/anthropics/claude-code-action/blob/main/docs/solutions.md)).

**Codex cloud code review (OpenAI).** Codex "posts a standard GitHub code review focused on serious
issues" and "flags only P0 and P1 issues" on GitHub. The doc's example shows
`chatgpt-codex-connector bot` with an inline finding titled `[P1] …`. Rules go in a
`## Code Review Rules` section of the nearest `AGENTS.md`. Automatic review is a setting; manual
review is `@codex review`
([Codex GitHub review](https://developers.openai.com/codex/integrations/github)). The feature is in
Plus and higher plans; an API key gives "No cloud-based features (GitHub code review, Slack, etc.)"
([Codex pricing](https://developers.openai.com/codex/pricing)). The docs do not describe a
verification stage or cross-push dedupe **(thin evidence on false-positive controls beyond the
P0/P1 filter)**.

**`openai/codex-action`.** The action needs an API key. Its README example "takes the output from
Codex and posts it as a comment on the PR" with `issues.createComment`
([README](https://github.com/openai/codex-action/blob/main/README.md)). That is a pull-request-level
comment, so it wakes nothing without `:any`. A workflow can use `output-schema` to get structured
findings and post line comments itself
([`action.yml`](https://github.com/openai/codex-action/blob/main/action.yml)) **(inference: that
workflow is yours to write and maintain)**.

**GitHub Copilot code review.** Copilot reviews "from multiple angles," gathers full project context
through GitHub Actions runners, and offers Lite, Balanced, and Max effort, estimated at $0.25, $1.50,
and $10 per review on average. Automatic review of a user's own pull requests is in Copilot Pro,
Pro+, and Max. Copilot reads custom instructions, agent instructions, and skills **from the head
branch** ([Copilot code review](https://docs.github.com/en/copilot/concepts/agents/code-review)).
For cogwork, an implement Run writes the head branch, so a Run could change the rules its own review
reads **(inference)**. Third-party reports say inline comments come from the login `Copilot` and the
review from `copilot-pull-request-reviewer[bot]`
([gumptionchain#273](https://github.com/gumptionthomas/gumptionchain/pull/273)) **(thin evidence)**.

**CodeRabbit.** Reviews are free on public repositories; private repositories need a paid plan from
$24 per developer per month billed yearly
([pricing](https://www.coderabbit.ai/pricing)). `reviews.profile` is `quiet`, `chill` (default), or
`assertive` ([configuration](https://docs.coderabbit.ai/reference/configuration)). It reads
`AGENTS.md`, `CLAUDE.md`, and `.cursorrules` as guidelines
([path instructions](https://docs.coderabbit.ai/guides/review-instructions)). It also has a CLI that
"integrates with Cursor, Codex, Gemini … and other AI agents"
([IDE and CLI](https://docs.coderabbit.ai/overview/ide-cli-review)).

**Greptile.** The free Starter plan gives one developer 50 credits per month; a base review costs
one credit ([pricing](https://www.greptile.com/pricing)). `strictness` runs from 1 (verbose) to 3
(critical only), and `commentTypes` can drop `style`
([nitpickiness](https://www.greptile.com/docs/code-review/controlling-nitpickiness)). It reads
"the first and last commit of every PR to see which comments were addressed" and lowers the
priority of comment kinds nobody fixes
([nitpicks](https://www.greptile.com/docs/how-greptile-works/nitpicks)).

**Graphite Agent.** Graphite says its reviews focus "on real bugs — not just style"
([AI reviews](https://graphite.com/docs/ai-reviews)). The Hobby plan is free "for individuals
reviewing agent-generated code in personal repos," with limited reviews
([Graphite blog](https://graphite.com/blog/introducing-graphite-agent-and-pricing),
[plans](https://graphite.com/docs/billing-plans)). Graphite's Agents feature "is powered by Cursor
Cloud Agents" ([Agents](https://graphite.com/docs/agents)). The docs do not say whether the reviewer
shares Bugbot's infrastructure or account rules **(thin evidence; check before you rely on it while
Cursor access is lost)**.

**Qodo PR-Agent.** MIT-licensed, community-maintained, and runs as a GitHub Action with any model
through LiteLLM ([README](https://github.com/qodo-ai/pr-agent/blob/main/README.md)). `/improve`
scores each suggestion 0–10 in a self-reflection pass and drops suggestions below
`suggestions_score_threshold`; the reflection prompt gives 0 to a wrong suggestion
([`configuration.toml`](https://github.com/qodo-ai/pr-agent/blob/main/pr_agent/settings/configuration.toml),
[reflect prompt](https://github.com/qodo-ai/pr-agent/blob/main/pr_agent/settings/code_suggestions/pr_code_suggestions_reflect_prompts.toml)).
Inline review findings need `inline_key_issues=true`; committable inline suggestions need
`committable_code_suggestions=true`
([`configuration.toml`](https://github.com/qodo-ai/pr-agent/blob/main/pr_agent/settings/configuration.toml)).

**Also found, not evaluated.** Gemini Code Assist on GitHub summarizes and reviews pull requests
([Google docs](https://developers.google.com/gemini-code-assist/docs/review-github-code)). The page I
read covers the enterprise version only **(thin evidence on a free tier)**.

## What changes in cogwork for any CI-side tool

- The workspace adds the tool's exact login to `sourceControl.botAllowlist`. This is data, not code
  ([`source-control-target.ts`](../../packages/engine/src/github/source-control-target.ts)).
- Before you add a login, read the first real review through the GitHub API. Confirm the login, and
  confirm that each finding has no `in_reply_to_id` and has `subject_type: line`. Seven of the nine
  logins above are not in primary docs, and no doc states `subject_type` for any tool.
- A tool that posts at pull-request level needs `:any`, which brings back false wakes. Each false
  wake is a full follow-up Run and counts toward `noProgressAfterRound`
  ([`trusted-bot-wake-signal.md`](../spec/trusted-bot-wake-signal.md)).

---

# Question 3 — In-run bug review that works on all three Harnesses

## What the vendors publish about bug-finding prompts

**OpenAI's Codex review rubric** is the most explicit published bar
([`rubric.md`](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/review/rubric.md)).
A finding must "meaningfully impact the accuracy, performance, security, or maintainability," be
"discrete and actionable," be "introduced in the commit (pre-existing bugs should not be flagged),"
be something "the author of the original PR would likely fix," and not "rely on unstated
assumptions." It adds: "it is not enough to speculate that a change may disrupt another part of the
codebase … one must identify the other parts of the code that are provably affected." A comment
must state "the scenarios, environments, or inputs that are necessary for the bug to arise." On
volume: "If there is no finding that a person would definitely love to see and fix, prefer
outputting no findings." The output is JSON with a per-finding `confidence_score` and a P0–P3
priority. The Codex CLI runs this review non-interactively as `codex review --base <branch>`
([`cli.rs`](https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs)).

**Anthropic's `code-review` plugin** names its false-positive list: pre-existing issues, code that
"appears to be a bug but is actually correct," pedantic nitpicks, issues "a linter will catch," and
general quality concerns. It tells finders: "If you are not certain an issue is real, do not flag
it" ([`code-review.md`](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-review/commands/code-review.md)).

**Anthropic's security review action** filters in three steps: the finder reports only at
confidence 0.7 or higher; hard exclusion rules drop categories such as denial of service and rate
limiting; then one model call per finding decides `keep_finding`
([`prompts.py`](https://github.com/anthropics/claude-code-security-review/blob/main/claudecode/prompts.py),
[`findings_filter.py`](https://github.com/anthropics/claude-code-security-review/blob/main/claudecode/findings_filter.py)).

**Anthropic's Claude Security panel** is the most complete verify step published. Each candidate
gets three read-only voters, one per lens: REACHABILITY, IMPACT, DEFENSES. Each voter is told to
"try to disprove it" and to "Default to FALSE_POSITIVE," but also "do not invent a defense to kill a
finding" ([`scan-verifier.md`](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/claude-security/agents/scan-verifier.md)).
Code, not a model, keeps a finding only when all three votes arrive and at least two say
TRUE_POSITIVE. The panel can lower severity but never raise it. A flaw that reads the same before
the change gets PREDATES_CHANGE
([`scan.js`](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/claude-security/workflows/scan.js)).
This is *Models are for intelligence; the engine is for everything else* in a vendor's own code
([technical disposition](../agents/technical-disposition.md)).

**Bugbot** reverses one instinct. An agent that pulls its own context became too cautious under
restraining prompts; aggressive search prompts plus a separate filter worked better
([Cursor blog](https://cursor.com/blog/building-bugbot)). Search wide; report narrow.

## Techniques with evidence

| Technique | Evidence | Strength |
| --- | --- | --- |
| Separate verify step per finding | Bugbot validator; Claude Code Review verify stage; plugin validators; security panel | Convergence of four vendor designs; no published ablation |
| Several independent passes plus vote | Bugbot eight passes, majority vote; SWR-Bench recall +118.83% at n=10 ([arXiv:2509.01494](https://arxiv.org/abs/2509.01494)) | Measured; gain is mostly recall |
| Shuffled diff order per pass | Bugbot: "nudged the model toward different lines of reasoning" | One vendor, qualitative |
| Confidence score and threshold | Codex rubric; security action at 0.7; PR-Agent 0–10 | Vendor practice; no published calibration |
| Diff plus surrounding code | Claude Code Review; Bugbot agentic context; Codex "provably affected" rule | Vendor practice |
| Failing test as proof | SWT-Bench: precision more than doubled ([arXiv:2406.12952](https://arxiv.org/abs/2406.12952)); Bugbot plans it | Measured for patch filtering, not for review findings |
| Different model reviews | SWR-Bench tests cross-model aggregation ("Multi-Agg") | **Thin evidence**: no separate cross-model number I could extract |

## How reviewers reach a Run today

The reviewer definitions are per-Harness files that the sync toolkit writes outside the repo:
`~/.claude/agents/*.md`, `~/.codex/agents/*.toml` (with `sandbox_mode = "read-only"`), and
`~/.cursor/agents/*.md` (with `readonly: true`). `/code-review` is a skill in `~/.agents/skills` and
`~/.claude/skills`. ADR [0031](../adr/0031-the-test-value-bar-ships-with-the-operating-instructions.md)
names the consequence: "The minimalist's brief is an ambient subagent definition, so the resource
travels in the dispatch." The engine-owned path that reaches every Workspace and Harness is a shared
resource that `context-assembler.ts` copies into each stock package, as it does for
`test-value/TEST-VALUE.md` (ADR 0031). The repo-owned path that reaches every Harness in one
Workspace is a doc in the repo that its `AGENTS.md` names. A repo Subagent file does not reach a
Run: the engine scans `<repo>/.agents/subagents/` into the Run Plan, but the external Harnesses do
not project Subagents
([`external-harness-runtime.ts`](../../packages/engine/src/external-harness-runtime.ts)).

Two Harness facts limit a nested verify step:

- Claude Code lets a subagent spawn subagents "up to three layers below the main conversation," and
  names "a reviewer subagent that dispatches a verifier per finding" as the use case
  ([subagents](https://code.claude.com/docs/en/sub-agents)).
- I found no equivalent statement for Codex or Cursor subagents **(thin evidence)**. The shipped
  `/code-review` skill already tells its axes "Neither axis delegates further"
  (`~/.claude/skills/code-review/SKILL.md` on the maintainer's machine).

So a portable design does not rely on nested dispatch **(inference)**.

Two Claude-only facts matter for naming. Claude Code bundles its own `/code-review`; "a project or
personal skill named `code-review` runs in place of the bundled one," and `/review` "keeps running
the bundled review" ([local review](https://code.claude.com/docs/en/code-review-local)). The
maintainer's skill therefore shadows Anthropic's on the Claude Code Harness. Neither command exists
on Codex or Cursor, so neither is a portable bug reviewer.

## A harness-agnostic bug-hunter brief

Composed from the sources above **(inference)**. It matches the shape of the existing personas:
one question, an evidence rule, a hunt log, and a verdict.

- **One question:** what input or sequence makes this change produce a wrong result?
- **Scope:** only behavior the diff introduces or worsens (Codex rubric; plugin).
- **Search wide.** Read every changed file in full. Read the callers and callees of each changed
  symbol. Investigate every suspicious pattern (Bugbot).
- **Report narrow.** Report a finding only when you can name the input, the path, and the wrong
  result, each at a `file:line` (Codex rubric; security panel).
- **Try to disprove each candidate before you report it.** Refute only with a guard you read
  (security panel).
- **Exclude:** style, what the typecheck or linter catches, pre-existing bugs, missing test coverage,
  and speculative effects on unnamed code (plugin; Codex rubric).
- **Write a failing test sketch** for each finding a test can express: the test name, the input,
  and the assertion that fails today.
- **Severity:** blocking (wrong result on a reachable path) or nit. Most findings are nits.
- **Hunt log:** say "hunted, found nothing" per category, as the other personas do.
- **Model level:** `standard`. Bug-finding is judgment work, not classification
  (ADR [0028](../adr/0028-subagent-model-choice-is-a-named-level-not-a-pinned-model.md)).

---

# Question 4 — What raises bug recall without flooding false positives

- **Recall and noise rise together in one critic.** CriticGPT found that "the probability of
  catching a bug increases with the number of claims," and that models hallucinate more bugs than
  humans ([arXiv:2407.00215](https://arxiv.org/abs/2407.00215), covered in the prior note).
- **Independent passes help recall most.** On 1,000 real pull requests, the best single-pass F1 was
  about 19%. Ten aggregated passes raised recall by 118.83% and F1 by 43.67%. The authors still name
  precision as "a key priority"; n=5 was the cost sweet spot
  ([SWR-Bench, arXiv:2509.01494](https://arxiv.org/abs/2509.01494)). Majority vote over sampled
  answers is the general form ([self-consistency, arXiv:2203.11171](https://arxiv.org/abs/2203.11171)).
- **Execution beats opinion as a filter.** Filtering generated fixes with generated tests "more
  than doubles the precision of SWE-Agent to 47.8%," at 20% recall
  ([SWT-Bench, arXiv:2406.12952](https://arxiv.org/abs/2406.12952)). LIBRO reproduced 33.5% of
  Defects4J bugs as tests from their reports, and guessed which of its attempts worked with 71.4%
  accuracy ([arXiv:2209.11515](https://arxiv.org/abs/2209.11515)). A test gate is precise and
  lossy.
- **Self-correction without external signal degrades.** Huang et al. found models change correct
  answers to wrong ones more often than the reverse
  ([arXiv:2310.01798](https://arxiv.org/abs/2310.01798)). A verifier needs new evidence — code it
  reads, or a test it runs — not a second opinion of the same text.
- **Field data on what developers act on.** Across 22,000 comments from 16 AI review actions, 0.9% to
  19.2% of valid AI comments led to code changes, against 60% for human comments. Concise comments,
  comments with code, manually triggered reviews, and hunk-level tools did better
  ([arXiv:2508.18771](https://arxiv.org/abs/2508.18771)). In 54,791 agent review comments, Cursor's
  were resolved at 67.2% and Codex's at 54.8%; an inline code suggestion was the strongest predictor
  of resolution ([arXiv:2607.21997](https://arxiv.org/abs/2607.21997)). More bot comments per pull
  request went with lower average relevance and longer resolution times
  ([arXiv:2604.24450](https://arxiv.org/abs/2604.24450)). These studies use human readers; a
  follow-up Run is not a human reader **(inference: the transfer to an agent fixer is unmeasured)**.

---

# Question 5 — Fit with cogwork's design

The constraints: ADR 0027's one bounded round, report-only reviewers, and the perfection guard on
the reviewer; ADR 0028's Model levels; *Explicit over ambient*; and the wake path's shape test. The
cost figures are relative, because no source measures cogwork Runs with a bug reviewer
**(inference throughout this section)**. ADR 0027's retro is the baseline: wall time is roughly turn
count, and review consumed 45–90% of it before the bound.

## (a) A fourth in-run `bug-hunter` in the parallel fan-out

- **Run cost.** Reviewers run in parallel, so wall time grows only if the bug-hunter is the slowest
  reviewer. It reads callers, so it likely is. Tokens grow by one reviewer context. The fix round
  grows by the blocking findings it reports.
- **False-positive risk.** Medium to high. It is one pass with no independent check. The fix round
  says "Fix every blocking finding," so a false blocking finding turns into a wrong code change.
- **Portability.** Good if the brief ships as an engine resource. Same as the other personas if it
  ships as ambient definitions.
- **Repo changes.** Implement Operating Instructions, `playbook.test.ts`, ADR 0027. ADR 0031's
  "three-review bound" wording reads as a reviewer-count bound and needs a note.

## (b) A CI-side PR reviewer; the follow-up operation fixes bugs

- **Run cost.** Zero in the implement Run. Each wake is a full follow-up Run, including the full
  build ([follow-up Operating Instructions](../../packages/engine/operating-instructions/follow-up-agent/INSTRUCTIONS.md)).
  Vendor fees apply.
- **False-positive risk.** Set by the vendor's filter. The follow-up treats a bot finding as context
  it may decline, so a false finding costs a Run, not a wrong change. A false wake still spends one
  of the no-progress rounds.
- **Portability.** Full for Runs; the reviewer is outside the Harness. It adds vendor lock-in and an
  account the maintainer must keep.
- **Repo changes.** Allowlist data only for tools that post top-level line comments. A workflow file
  for action-based tools. The wake spec's Bugbot examples go stale, but its rule is vendor-neutral.

## (c) Both

- **Run cost.** The sum of (a) and (b). Duplicate findings arrive twice: once in the fix round and
  again as a wake.
- **False-positive risk.** Each layer keeps its own risk. A CI reviewer from a different vendor gives
  cross-model review by construction, but its benefit is **thin evidence**.
- **Portability.** As (a) and (b).
- **Repo changes.** As (a) and (b).

## (d) Verify-then-report pipeline

Find candidates, then confirm each one with evidence before it counts.

- **Run cost.** Highest if verification is a second dispatch: k candidates × v voters, after the
  finder returns, on the critical path. Low if verification is the fix round's red proof, which the
  gate already runs: one test run per blocking finding, the same price ADR 0031 accepted per new
  contract.
- **False-positive risk.** Lowest. A test that does not go red is evidence against the finding.
  Recall falls where a test cannot express the bug (LIBRO's two thirds).
- **Portability.** A nested verifier fan-out is proven only on Claude Code. A test in the fix round
  works on every Harness, because every Run already runs tests.
- **Repo changes.** As (a), plus a fix-round rule for bug-hunter findings.

## Recommendation

**Take (a) with the low-cost form of (d): add a fourth report-only `bug-hunter` reviewer to the
parallel fan-out, and verify each of its blocking findings with a failing test in the one fix
round.**

How it works:

1. **The brief is repo content.** Bug review is part of how this repo builds Cogwork, not a
   product feature, so the brief lives at `docs/agents/bug-hunt.md`, and the repo's `AGENTS.md`
   adds the reviewer to every review of a diff. An earlier draft of this note shipped the brief as
   an engine shared resource beside `test-value/TEST-VALUE.md`. That made every Cogwork user's
   implement Runs carry this repo's process, so the draft was dropped.
2. **The carrier is a repo doc, not a Subagent file.** The engine scans `<repo>/.agents/subagents/`
   into the Run Plan, but the external Harnesses project no Subagents
   ([`external-harness-runtime.ts`](../../packages/engine/src/external-harness-runtime.ts),
   `externalHarnessDeclaration.projectedMembers`). Every Harness reads `AGENTS.md`, and the Run's
   worktree holds the doc, so the dispatch hands the reviewer the doc's path.
3. **The stock package gains one generic line.** The review round dispatches its three reviewers
   plus each reviewer the repo's own guidance adds. Without that line, an `AGENTS.md` reviewer
   contradicts "Dispatch three reviews", which outranks it.
4. The bug-hunter reports per the brief in Question 3. Each finding carries a failing test sketch
   where a test can express the bug.
5. In the fix round, the implementer writes the test for each blocking bug-hunter finding first and
   runs it on the reviewed code. A red test is recorded as a Mutation whose named break is the
   finding (`Mutation: B1 unfixed`). A test that passes refutes the finding, which gets *won't-fix*
   with the passing run as the reason. A finding no test can express gets a judgment call. The
   existing red sources and dispositions carry all three cases, so the stock text needs no new
   ones.
6. Nothing else changes: one round, no re-review, report-only reviewers, the perfection guard.

Why, against the technical disposition:

- **Build the environment, not the prompt.** The red proof is a deterministic check the gate
  already owns. It verifies findings without a new stage.
- **The engine constrains the model.** The fix round's disposition rule decides a finding's fate
  from a test result, not from a second model's opinion.
- **The ask bounds the design.** The ask is that the *implement strategy* finds and fixes bugs. A CI
  reviewer finds them after the pull request opens, and the fix lands in a later Run.
- **Fix the class, not the instance.** The lost reviewer is a missing concern in the fan-out, not a
  missing vendor. Naming the concern keeps the pipeline vendor-neutral.
- **Cost against correctness is an open fork** in the disposition. This shape is cheap on both
  sides, so it does not force that fork.

**ADR to amend: [0027](../adr/0027-headless-review-is-one-bounded-round-of-report-only-reviewers.md).**
The amendment is generic: a repo's own guidance may add reviewers to the round, and the three stay.
The one-round bound stays. ADR 0027 did not drop the bug review; it moved it to CI. A repo-added
reviewer puts the same concern back where a Run can act on it. ADR
[0031](../adr/0031-the-test-value-bar-ships-with-the-operating-instructions.md) needs no change:
the stock round keeps three reviewers and two red sources.

**What stays optional.** A CI-side reviewer remains one Bot allowlist entry. If the maintainer has
ChatGPT Plus or higher, Codex cloud review fits the wake shape, costs no API key, posts only P0 and
P1, and reads `AGENTS.md` rules. Read its login from the first review before you add it. That choice
needs no ADR and no code.

**Rejected or deferred.**

- *Shell out to `codex review` from any Run.* It gives cross-model review, but it needs an installed
  and signed-in Codex CLI. That is ambient, and it fails on a clean machine.
- *A nested three-voter panel per finding.* It is proven on Claude Code only. Revisit when a second
  Harness documents nested subagents.
- *Several shuffled bug-hunter passes with a vote.* It is measured to raise recall, but it multiplies
  the slowest reviewer. Revisit if the fix round's refuted-finding rate stays low and misses appear in
  human review.

---

## Thin evidence and unverified claims

- Bugbot's exact repository context scope; the docs describe agentic tool use, not an index.
- BugBench results; the benchmark is not public.
- The comment login of Claude Code Review; not in its docs.
- Copilot's logins (`Copilot` for inline comments, `copilot-pull-request-reviewer[bot]` for reviews);
  third-party reports only.
- The logins of CodeRabbit, Greptile, and Graphite; not verified.
- `github-actions[bot]` as the login for `codex-action` and PR-Agent workflows that use the default
  token; not verified against GitHub docs.
- Codex cloud review's false-positive controls beyond the P0/P1 filter, and its cross-push dedupe.
- Whether Graphite Agent depends on Cursor accounts or Bugbot infrastructure.
- A free individual tier for Gemini Code Assist on GitHub.
- Nested subagent support on Codex and Cursor.
- Any measured benefit of a different model reviewing over a fresh-context same model.
- Whether each tool's findings carry `subject_type: line` with no thread parent, which the wake
  path requires.
- All Run wall-time and token estimates in Question 5.
- The transfer of human acceptance-rate studies to an agent that fixes findings.

---

## Source list

**Cursor:** [Bugbot docs](https://cursor.com/docs/bugbot);
[Building a better Bugbot](https://cursor.com/blog/building-bugbot) (2026-01-15).

**Anthropic:** [Code Review](https://code.claude.com/docs/en/code-review);
[Code Review costs](https://code.claude.com/docs/en/code-review-costs);
[Code Review on a pull request](https://code.claude.com/docs/en/code-review-pull-requests);
[Customize Code Review](https://code.claude.com/docs/en/code-review-customize);
[Set up Code Review](https://code.claude.com/docs/en/code-review-setup);
[Review locally with /code-review](https://code.claude.com/docs/en/code-review-local);
[Ultrareview](https://code.claude.com/docs/en/ultrareview);
[Subagents](https://code.claude.com/docs/en/sub-agents);
`anthropics/claude-plugins-official`:
[`code-review.md`](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-review/commands/code-review.md),
[code-review README](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-review/README.md),
[`scan-verifier.md`](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/claude-security/agents/scan-verifier.md),
[`scan.js`](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/claude-security/workflows/scan.js);
`anthropics/claude-code-action`: [`action.yml`](https://github.com/anthropics/claude-code-action/blob/main/action.yml),
[setup](https://github.com/anthropics/claude-code-action/blob/main/docs/setup.md),
[FAQ](https://github.com/anthropics/claude-code-action/blob/main/docs/faq.md),
[solutions](https://github.com/anthropics/claude-code-action/blob/main/docs/solutions.md);
`anthropics/claude-code-security-review`:
[`prompts.py`](https://github.com/anthropics/claude-code-security-review/blob/main/claudecode/prompts.py),
[`findings_filter.py`](https://github.com/anthropics/claude-code-security-review/blob/main/claudecode/findings_filter.py).

**OpenAI:** [Review GitHub pull requests with Codex](https://developers.openai.com/codex/integrations/github);
[Codex pricing](https://developers.openai.com/codex/pricing);
[`rubric.md`](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/review/rubric.md);
[`exec/src/cli.rs`](https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs);
`openai/codex-action`: [README](https://github.com/openai/codex-action/blob/main/README.md),
[`action.yml`](https://github.com/openai/codex-action/blob/main/action.yml).

**GitHub:** [Copilot code review](https://docs.github.com/en/copilot/concepts/agents/code-review).
Third-party, thin: [gumptionchain#273](https://github.com/gumptionthomas/gumptionchain/pull/273).

**Other vendors:** CodeRabbit [pricing](https://www.coderabbit.ai/pricing),
[configuration](https://docs.coderabbit.ai/reference/configuration),
[path instructions](https://docs.coderabbit.ai/guides/review-instructions),
[IDE and CLI](https://docs.coderabbit.ai/overview/ide-cli-review); Greptile
[pricing](https://www.greptile.com/pricing),
[controlling nitpickiness](https://www.greptile.com/docs/code-review/controlling-nitpickiness),
[reducing nitpicks](https://www.greptile.com/docs/how-greptile-works/nitpicks); Graphite
[AI reviews](https://graphite.com/docs/ai-reviews), [plans](https://graphite.com/docs/billing-plans),
[Graphite Agent post](https://graphite.com/blog/introducing-graphite-agent-and-pricing),
[Agents](https://graphite.com/docs/agents); Qodo PR-Agent
[README](https://github.com/qodo-ai/pr-agent/blob/main/README.md),
[`configuration.toml`](https://github.com/qodo-ai/pr-agent/blob/main/pr_agent/settings/configuration.toml),
[reflect prompt](https://github.com/qodo-ai/pr-agent/blob/main/pr_agent/settings/code_suggestions/pr_code_suggestions_reflect_prompts.toml);
Google [Gemini Code Assist on GitHub](https://developers.google.com/gemini-code-assist/docs/review-github-code).

**Papers:** CriticGPT ([arXiv:2407.00215](https://arxiv.org/abs/2407.00215)); SWR-Bench
([arXiv:2509.01494](https://arxiv.org/abs/2509.01494)); Does AI Code Review Lead to Code Changes?
([arXiv:2508.18771](https://arxiv.org/abs/2508.18771)); "Go Home Copilot, You're Drunk"
([arXiv:2607.21997](https://arxiv.org/abs/2607.21997)); Reviewer bots on agentic pull requests
([arXiv:2604.24450](https://arxiv.org/abs/2604.24450)); SWT-Bench
([arXiv:2406.12952](https://arxiv.org/abs/2406.12952)); LIBRO
([arXiv:2209.11515](https://arxiv.org/abs/2209.11515)); Huang et al., Large Language Models Cannot
Self-Correct Reasoning Yet ([arXiv:2310.01798](https://arxiv.org/abs/2310.01798)); Wang et al.,
Self-Consistency ([arXiv:2203.11171](https://arxiv.org/abs/2203.11171)).

**This repo:** [`implement-agent/INSTRUCTIONS.md`](../../packages/engine/operating-instructions/implement-agent/INSTRUCTIONS.md);
[`follow-up-agent/INSTRUCTIONS.md`](../../packages/engine/operating-instructions/follow-up-agent/INSTRUCTIONS.md);
ADRs [0027](../adr/0027-headless-review-is-one-bounded-round-of-report-only-reviewers.md),
[0028](../adr/0028-subagent-model-choice-is-a-named-level-not-a-pinned-model.md),
[0031](../adr/0031-the-test-value-bar-ships-with-the-operating-instructions.md);
[`trusted-bot-wake-signal.md`](../spec/trusted-bot-wake-signal.md);
[`feedback.ts`](../../packages/engine/src/github/feedback.ts);
[`source-control-target.ts`](../../packages/engine/src/github/source-control-target.ts);
[technical disposition](../agents/technical-disposition.md); [product](../agents/product.md).
