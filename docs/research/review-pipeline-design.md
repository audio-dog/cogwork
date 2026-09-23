# Structuring the in-run code-review stage: what the primary sources actually support

Date: 2026-09-23.

**Scope and method.** Six questions about the review stage that runs inside an autonomous
implementation run (after code is written, before the PR opens), answered against primary sources
only: the [ponytail repository](https://github.com/DietrichGebert/ponytail) itself (README, skill
files, and benchmark writeups, `main` as of this date), Anthropic's engineering blog and Claude
Code docs (`anthropic.com/engineering/*`, `code.claude.com/docs/en/*`), OpenAI's
[A Practical Guide to Building Agents](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)
and Agents SDK docs (`openai.github.io/openai-agents-python/*`), peer-reviewed or arXiv-published
papers cited by arXiv ID, Google's Tricorder paper (ICSE 2015), and first-party tool docs
(Anthropic's `claude-code-security-review` action, Semgrep CI docs). Claims I could not ground in
a primary source are marked **(inference)** or flagged as thin. The current cogwork pipeline this
research is for: `packages/engine/operating-instructions/implement-agent/INSTRUCTIONS.md` runs
code-simplifier after the gate, then rule-reviewer, /adversarial-review (security-auditor +
complexity-skeptic), /review-bugbot, and /code-review, then "implement any findings" with no
round cap.

---

## TL;DR

1. **Ponytail is not a separate simplification pass.** It is an always-on ruleset injected at
   session start and active on every response — simplification happens *during* generation. Its
   `/ponytail-review` command is an on-demand, diff-scoped, **report-only** complexity review that
   explicitly excludes correctness, security, and performance and never applies fixes. Ponytail's
   benchmark claim is that a detailed upfront ruleset beats a *short* upfront prompt (which was
   erratic and dropped a safety guard), not that a post-hoc pass beats upfront instruction.
   cogwork's edit-making code-simplifier pass diverges from its inspiration on both counts.
2. **Focused vs consolidated reviewers: the primary evidence splits.** Decomposed per-criterion
   evaluation beats holistic judging in the research literature (Branch-Solve-Merge +26%
   human-agreement, ChatEval multi-persona referees). But Anthropic's own production experience is
   the counterweight: for their research evaluator they "experimented with multiple judges to
   evaluate each component, but found that a single LLM call with a single prompt … was the most
   consistent"; multi-agent systems burn ~15× chat tokens; and "most coding tasks involve fewer
   truly parallelizable tasks than research."
3. **Critique works when the feedback is external; upfront instruction wins when the knowledge
   fits in the prompt.** Intrinsic self-correction *degrades* reasoning (Huang et al.), and
   folding the feedback prompt's knowledge into the initial instruction beat self-correction in
   their tests. Trained external critics genuinely catch more bugs than human reviewers
   (CriticGPT) but nitpick and hallucinate bugs at much higher rates than humans — measured
   support for the "always finds something" worry. Fresh-context review is vendor-recommended;
   evidence that a *different model* reviews better than a fresh-context same model is thin.
4. **Bound the loop.** Anthropic lists max-iteration stopping conditions as standard agent
   design and scopes the evaluator-optimizer loop to tasks with clear criteria where iteration
   measurably helps. OpenAI's SDK ships `max_turns` → `MaxTurnsExceeded`, and its own LLM-as-judge
   example hard-caps rounds and instructs the judge: "do not go for perfection".
5. **Cheap models for mechanical checks, clean context for reviewers.** Both vendors document
   the cascade: route simple classification-shaped tasks to small models, keep judgment on strong
   models. CriticGPT shows specialization beats scale (a trained critic ≈ 30× pre-training
   compute of naive scale-up). Claude Code's guidance is unambiguous on context: a reviewer in a
   fresh subagent context "sees only the diff and the criteria you give it, not the reasoning that
   produced the change," and "a fresh context improves code review since Claude won't be biased
   toward code it just wrote."
6. **Risk-based selection has precedent as *scoping*, not as *skipping*.** Google's Tricorder and
   Semgrep run analysis on every change but scope it to the diff, dispatch analyzers by what the
   change touches, and enforce a <10% effective false-positive budget with removal of noisy
   analyzers. Anthropic's multi-agent post embeds explicit effort-scaling rules by task
   complexity. I found no primary source that gates *whether* a security review runs on a
   trust-boundary heuristic; the documented practice is always-run, diff-scoped, FP-budgeted.

---

# Question 1 — Ponytail: design and claims

## What ponytail actually is

Ponytail is an **instruction ruleset, not a pipeline stage**. The core skill
([`skills/ponytail/SKILL.md`](https://github.com/DietrichGebert/ponytail/blob/main/skills/ponytail/SKILL.md))
is a persona ("a lazy senior developer… The best code is the code never written") plus a
seven-rung "ladder" the agent climbs *while generating*: does this need to exist at all (YAGNI) →
reuse what the codebase has → stdlib → native platform feature → already-installed dependency →
one line → "only then: the minimum code that works." Its persistence header reads "ACTIVE EVERY
RESPONSE. No drift back to over-building." It is delivered as always-on rule files, plugins, and
session-start hooks for ~20 harnesses ([README](https://github.com/DietrichGebert/ponytail));
in Cursor it injects via `sessionStart` hooks or an always-on `.cursor/rules/ponytail.mdc`.

The constraints are part of the ruleset:

- **Trust boundaries are exempt.** "Never simplify away: input validation at trust boundaries,
  error handling that prevents data loss, security measures, accessibility basics, anything
  explicitly requested" ([`skills/ponytail/SKILL.md`](https://github.com/DietrichGebert/ponytail/blob/main/skills/ponytail/SKILL.md)).
- **Comprehension before laziness.** The ladder "runs *after* you understand the problem, not
  instead of it"; a bug fix must be the root-cause fix.
- **A minimum check survives.** Non-trivial logic "leaves ONE runnable check behind"; the review
  skill repeats that a single smoke test "is the ponytail minimum, not bloat, never flag it for
  deletion."

## The review pass: on-demand, diff-scoped, report-only

`/ponytail-review`
([`skills/ponytail-review/SKILL.md`](https://github.com/DietrichGebert/ponytail/blob/main/skills/ponytail-review/SKILL.md))
is a *complement* to the always-on ruleset, invoked on demand, and its design is tightly bounded:

- **Scope:** the current diff, "over-engineering and complexity only. Correctness bugs, security
  holes, and performance are explicitly out of scope. Route them to a normal review pass."
- **Output:** one line per finding in a fixed format (`L<line>: <tag> <what>. <replacement>.`)
  with five tags (`delete:`, `stdlib:`, `native:`, `yagni:`, `shrink:`), ending with a single
  metric: `net: -<N> lines possible.`
- **Report-only:** "Does not apply the fixes, only lists them."
- **Early exit:** "If there is nothing to cut, say `Lean already. Ship.` and stop." There is no
  loop — one pass, one delete-list.

`/ponytail-audit` is the same design repo-wide, "one-shot report, does not apply fixes"
([`skills/ponytail-audit/SKILL.md`](https://github.com/DietrichGebert/ponytail/blob/main/skills/ponytail-audit/SKILL.md)).

## What ponytail claims — and does not claim

Ponytail **does not claim that a separate simplification pass beats upfront instruction**. Its
central benchmark tests the opposite axis: the always-on ruleset versus (a) no skill, (b) a
terse-prose control skill ("caveman"), and (c) a bare seven-word upfront prompt ("Follow YAGNI
principles, and prefer one-liner solutions"). The
[2026-06-18 agentic writeup](https://github.com/DietrichGebert/ponytail/blob/main/benchmarks/results/2026-06-18-agentic.md)
— rebuilt after a critique of the earlier single-shot benchmark, with headless Claude Code
sessions (Haiku 4.5, n=4) on a real FastAPI+React repo, scored on `git diff` added lines — found:

| arm | LOC (12 feature tasks) | cost | time | safe rate (20 adversarial runs) |
| --- | --: | --: | --: | --: |
| baseline (no skill) | — | — | — | 100% |
| caveman (terse prose) | −20% | +3% | +2% | 100% |
| **ponytail (ruleset)** | **−54%** | **−20%** | **−27%** | **100%** |
| yagni one-liner prompt | −33% | −21% | −30% | **95%** |

The two claims that matter for pipeline design:

1. **A rich ruleset is consistent where a short prompt is erratic.** The one-liner prompt won on
   one task and landed *above* baseline on three others; "the plugin is consistent; the
   seven-word prompt is not." The −54% is the honest mean; per task it runs from ~0% (irreducible
   backend CRUD — "it does not invent savings where there are none") to −94% (date picker, where
   a native input replaces a custom build).
2. **Judgment-free minimization cuts guards.** The only arm that dropped a safety check (a path
   traversal guard, 1 run in 20) was the bare one-liner prompt; ponytail's trust-boundary
   exemption kept the ~3 guard lines. The writeup itself calls the safety result "a floor, not a
   dramatic result."

Honest caveats from the repo's own materials: the benchmark is one model (Haiku 4.5) and n=4;
an independent Cursor-SDK benchmark linked from the
[benchmarks README](https://github.com/DietrichGebert/ponytail/blob/main/benchmarks/README.md)
found ponytail "can also raise tool calls and cost on completion-forced tasks" (the ladder
deliberates every turn); and an independent 480-build benchmark found it "trims everyday
bad-input handling on 5/24 tasks" — the guard-preservation rule is not airtight at the margins.

**Relevance to cogwork (inference):** cogwork's code-simplifier — a separate post-gate subagent
that *edits* code — differs from its inspiration in both placement (post-hoc vs during
generation) and authority (edits vs delete-list). Ponytail's design puts minimalism upstream
where it also saves generation cost and time, and keeps the review artifact cheap, single-shot,
and non-mutating.

---

# Question 2 — Focused single-concern reviewers vs one consolidated reviewer

## Evidence for decomposition

**Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)**
(parallelization/sectioning): "For complex tasks with multiple considerations, LLMs generally
perform better when each consideration is handled by a separate LLM call, allowing focused
attention on each specific aspect." Its worked example of the voting variant is literally this
stage: "Reviewing a piece of code for vulnerabilities, where several different prompts review and
flag the code if they find a problem." The same post's routing section warns that "optimizing for
one kind of input can hurt performance on other inputs" — the argument against one rubric-stuffed
prompt.

**Claude Code [subagents docs](https://code.claude.com/docs/en/sub-agents)**: subagents exist to
"specialize behavior with focused system prompts for specific domains" and run "in its own
context window," returning only the summary — the mechanism cogwork already uses.

**OpenAI [Agents SDK orchestration docs](https://openai.github.io/openai-agents-python/multi_agent/)**:
"Have specialized agents that excel in one task, rather than having a general purpose agent that
is expected to be good at anything." The
[practical guide](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)
gives the split criteria: split when "prompts contain many conditional statements (multiple
if-then-else branches), and prompt templates get difficult to scale," or when tools overlap.

**Decomposed evaluation literature.**
[Branch-Solve-Merge (arXiv:2310.15123)](https://arxiv.org/abs/2310.15123) decomposes LLM response
evaluation into per-criterion branches solved independently and merged; it "improves LLM-human
agreement … by up to absolute 26%" over zero-shot and self-consistency baselines and reduces
position bias by up to 50% — but note the branches are parallel *calls of one model program*, not
independent persona agents. [ChatEval (arXiv:2308.07201)](https://arxiv.org/abs/2308.07201) is
the closest to cogwork's persona fan-out: a "multi-agent referee team" where each agent gets a
distinct persona, which "aligns better with human preferences compared with single-agent-based
approaches," and its ablations "demonstrate the necessity of diverse role prompts" — same prompt
for every agent loses the benefit. [G-Eval (arXiv:2303.16634)](https://arxiv.org/abs/2303.16634)
shows a related smaller move: making one judge expand explicit evaluation criteria into
chain-of-thought evaluation steps improves human correlation over bare scoring.

## Evidence against, and the costs

**Anthropic's own production judge is consolidated.** In
[How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system):
"We experimented with multiple judges to evaluate each component, but found that a single LLM
call with a single prompt outputting scores from 0.0-1.0 and a pass-fail grade was the most
consistent and aligned with human judgements" — a five-criterion rubric (factual accuracy,
citation accuracy, completeness, source quality, tool efficiency) in *one* call. This is the most
directly comparable production data point and it contradicts the fan-out default.

**Fan-out cost is measured.** The same post: agents use ~4× more tokens than chat, and
"multi-agent systems use about 15× more tokens than chats"; they are only economical "where the
value of the task is high enough to pay for the increased performance," and — pointedly — "most
coding tasks involve fewer truly parallelizable tasks than research."

**Duplication and gaps are the documented failure mode of fan-out.** Same post: "Without detailed
task descriptions, agents duplicate work, leave gaps, or fail to find necessary information."
Overlapping reviewer charters (simplifier vs complexity-skeptic) are exactly this shape
**(inference)**.

**Debate-style multi-agent gains may be an inference-cost artifact.**
[Du et al. (arXiv:2305.14325)](https://arxiv.org/abs/2305.14325) report multiagent debate improves
reasoning and factuality, but
[Huang et al. (arXiv:2310.01798)](https://arxiv.org/abs/2310.01798) re-tested it cost-matched:
"its efficacy is no better than self-consistency when considering an equivalent number of
responses."

**Adversarial critics measurably over-report.**
[CriticGPT (arXiv:2407.00215)](https://arxiv.org/abs/2407.00215) quantifies the "always finds
something" effect: "the rate of nitpicks and hallucinated bugs is much higher for models than for
humans," and "the probability of catching a bug increases with the number of claims that a
critique makes … models which hallucinate bugs more often are also more likely to catch
human-inserted and previously detected bugs." Recall and false positives rise together; a persona
prompted to always attack sits at the noisy end of that curve. OpenAI's own
[LLM-as-judge example](https://github.com/openai/openai-agents-python/blob/main/examples/agent_patterns/llm_as_a_judge.py)
even *instructs* the judge to "Never give it a pass on the first try" — forced findings are a
prompt choice, and an avoidable one.

## Verdict

No primary source runs the exact head-to-head cogwork needs (N single-concern reviewer *agents*
vs one consolidated reviewer over the same code diffs). The decomposition literature supports
separating *criteria*; Anthropic's production experience says the separation can live inside one
judge call; ChatEval says if you do run multiple agents, distinct personas are what pay. The cost
side is unambiguous: every additional reviewer multiplies tokens and adds findings whose marginal
precision is lower.

---

# Question 3 — Generate-then-critique vs upfront instruction

## What the papers establish

**Critique loops help when feedback adds information.**
[Self-Refine (arXiv:2303.17651)](https://arxiv.org/abs/2303.17651) — same model generates,
critiques, refines — improves outputs "~20% absolute on average" across 7 tasks (GPT-3.5/GPT-4),
and "up to absolute 13%" on code tasks. Note the tasks where it shines are "tasks with
multifaceted objectives" or "hard-to-define goals, such as enhancing program readability" — the
complexity/style axis, not correctness.

**But intrinsic self-correction degrades reasoning.**
[Huang et al. (arXiv:2310.01798)](https://arxiv.org/abs/2310.01798): without external feedback,
"LLMs struggle to self-correct their responses … at times, their performance even degrades after
self-correction"; prior claimed gains "result from using oracle labels to guide the
self-correction process, and the improvements vanish" without them. The model "is more likely to
modify a correct answer to an incorrect one than to revise an incorrect answer to a correct one."
CriticGPT's related-work section agrees: self-correction succeeds "more clearly when they make
use of additional side-channel information during the correction phase."

**Upfront instruction beats post-hoc critique when the critique carries no new signal.** Huang et
al. directly: where self-correction gains came from a more informative feedback prompt, "simply
integrating the feedback into the initial instruction can yield better results, and
self-correction again decreases performance." Ponytail's benchmark is the coding-agent version of
the same result — the knowledge moved upfront (a detailed ruleset) outperformed both no
instruction and post-hoc anything, at *negative* marginal cost (Question 1).

**External trained critics genuinely find bugs.**
[CriticGPT](https://arxiv.org/abs/2407.00215): critics trained with RLHF "catch more bugs than
human contractors paid for code review"; critiques preferred over human critiques in 63% of
naturally-occurring-bug cases; Human+CriticGPT teams "write more comprehensive critiques …
while simultaneously better avoiding nitpicks and hallucinations" than the model alone.

## The three reviewer placements

- **Same model, same context (self-review).** The weakest configuration in the evidence. Huang et
  al. above; plus a measured bias mechanism:
  [Panickssery et al. (arXiv:2404.13076)](https://arxiv.org/abs/2404.13076) show LLM evaluators
  score their own outputs higher than humans judge them, and fine-tuning reveals "a linear
  correlation between self-recognition capability and the strength of self-preference bias."
  [G-Eval](https://arxiv.org/abs/2303.16634) likewise flags "the potential concern of LLM-based
  evaluators having a bias towards the LLM-generated texts."
- **Fresh-context reviewer (same or unspecified model).** This is what the vendor guidance
  recommends, in plain words.
  [Claude Code best practices](https://www.anthropic.com/engineering/claude-code-best-practices):
  "A fresh context improves code review since Claude won't be biased toward code it just wrote"
  (Writer/Reviewer sessions), and for the in-run version: "A reviewer running in a fresh subagent
  context sees only the diff and the criteria you give it, not the reasoning that produced the
  change, so it evaluates the result on its own terms" — with a bundled `/code-review` skill that
  does exactly this once, returning findings to the implementing session.
- **Different-model reviewer.** Evidence is thin. CriticGPT is a different (specially trained)
  model and works, but the comparison there is critic-vs-human, not critic-vs-fresh-same-model.
  The self-preference mechanism (Panickssery et al.) predicts a different model escapes the bias
  **(inference)** — but no primary source I found measures fresh-context-same-model against
  different-model on code review quality. Claude Code's docs treat cross-model subagents purely
  as a cost lever, not a quality one.

**The strongest external feedback is deterministic.** Both Huang et al. (external feedback works
where intrinsic critique fails) and Anthropic's coding-agent appendix ("Code solutions are
verifiable through automated tests; agents can iterate on solutions using test results as
feedback," [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents))
put tests/typecheck — cogwork's existing hard gate — above LLM opinion as the fix-loop signal.

---

# Question 4 — Bounding the loop

**Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents):**
two separate statements. On agents generally: "it's also common to include stopping conditions
(such as a maximum number of iterations) to maintain control." On the evaluator-optimizer
workflow specifically, it is scoped to tasks where "we have clear evaluation criteria, and when
iterative refinement provides measurable value" — the loop is opt-in per task class, not a
default, and the two fit signs are that articulated feedback demonstrably improves the output and
the LLM can produce such feedback.

**OpenAI Agents SDK:** the runner loop hard-fails on budget: "If we exceed the `max_turns`
passed, we raise a `MaxTurnsExceeded` exception"
([Running agents](https://openai.github.io/openai-agents-python/running_agents/)); `error_handlers`
can convert that into a controlled final output instead of a crash. The
[practical guide](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)
lists "reaching a maximum number of turns" among the normal exit conditions of any run loop.

**OpenAI's own LLM-as-judge pattern** ([`examples/agent_patterns/llm_as_a_judge.py`](https://github.com/openai/openai-agents-python/blob/main/examples/agent_patterns/llm_as_a_judge.py))
shows the concrete shape of a bounded evaluator loop: a structured verdict
(`pass | needs_improvement | fail`), loop-until-pass, an unconditional round cap in automation
(`max_rounds = 3` in auto mode, "stopping after limited rounds"), and — in the judge's own
instructions — "After 5 attempts, you can give it a pass if the story outline is good enough —
**do not go for perfection**." The [OpenAI Agents SDK orchestration docs](https://openai.github.io/openai-agents-python/multi_agent/)
describe the same pattern declaratively: "run the task agent to produce an output, then run an
evaluator agent to assess that output and provide feedback; stop when the evaluator says the
output passes the required criteria."

**Concrete single-bounded-fix-round pattern the sources support (composed, inference):** review
once → implementer fixes → deterministic gate re-runs (tests/typecheck, the external feedback
that works per Huang et al.) → ship, with re-review either skipped or limited to verifying the
named findings, and the judge instructed with an explicit pass bar and an anti-perfection clause.
No primary source recommends unbounded fix→re-review→re-gate cycling; every documented loop has
a cap or a pass-criteria exit, usually both.

---

# Question 5 — Review placement and model choice

## (a) Cheap model for mechanical checks, strong model for judgment

- **Claude Code [subagents docs](https://code.claude.com/docs/en/sub-agents):** an explicit
  purpose of subagents is to "control costs by routing tasks to faster, cheaper models like
  Haiku."
- **Anthropic's routing workflow** ([Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)):
  "Routing easy/common questions to smaller, cost-efficient models like Claude Haiku 4.5 and
  hard/unusual questions to more capable models."
- **OpenAI [practical guide](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf):**
  "Not every task requires the smartest model — a simple retrieval or intent classification task
  may be handled by a smaller, faster model, while harder tasks like deciding whether to approve
  a refund may benefit from a more capable model." Recommended procedure: baseline everything on
  the most capable model, then "try swapping in smaller models to see if they still achieve
  acceptable results … you can diagnose where smaller models succeed or fail."
- **Specialization beats scale for critics.** [CriticGPT](https://arxiv.org/abs/2407.00215):
  CriticGPT "was fine-tuned with less compute than ChatGPT," yet matching its bug-catch rate by
  scale alone "would require around a 30x increase in pre-training compute." The relevant limit:
  in a math setting where finding solutions took far more compute than critiquing them, "critics
  couldn't spot the resulting bugs" — a much weaker critic than the generator does hit a floor on
  hard content.

Mechanical rule-checking (does the diff violate a written, named rule?) is closer to the
classification end of that spectrum, so the vendor cascade guidance applies to it; judgment
review (spec fit, security reasoning) is the "harder tasks" end **(inference — no source
benchmarks rule-checking specifically)**.

## (b) Shared implementer context vs clean context with the diff

Every relevant primary source lands on clean context; none recommends sharing:

- [Claude Code best practices](https://www.anthropic.com/engineering/claude-code-best-practices):
  the adversarial review step exists so that "the agent doing the work isn't the one grading it";
  the reviewer "sees only the diff and the criteria you give it, not the reasoning that produced
  the change, so it evaluates the result on its own terms"; and across sessions, "a fresh context
  improves code review since Claude won't be biased toward code it just wrote."
- [Claude Code subagents docs](https://code.claude.com/docs/en/sub-agents): subagents run "in its
  own context window," used when side work "would flood your main conversation" — context
  isolation is the feature's stated purpose, for "improved context management."
- [Anthropic multi-agent post](https://www.anthropic.com/engineering/multi-agent-research-system):
  "Each subagent also provides separation of concerns — distinct tools, prompts, and exploration
  trajectories — which reduces path dependency."
- The bias literature gives the mechanism: self-preference correlates with self-recognition
  ([Panickssery et al.](https://arxiv.org/abs/2404.13076)); handing the reviewer the implementer's
  reasoning maximizes recognition **(inference)**.

One caveat the clean-context camp doesn't address: a diff-only reviewer lacks the brief. Claude
Code's own recommended prompt shape compensates by passing the plan explicitly ("review the rate
limiter diff against PLAN.md") — clean context does not mean context-free; it means *curated*
inputs (diff + brief + criteria) rather than inherited history.

---

# Question 6 — Risk-based review selection

The precedent from production static-analysis platforms is **always-run but diff-scoped and
noise-budgeted**, with *which analyzers* selected by what the change touches — not skipping
review categories on a risk heuristic:

- **Google Tricorder** ([ICSE 2015](https://research.google/pubs/tricorder-building-a-program-analysis-ecosystem/),
  [PDF](https://static.googleusercontent.com/media/research.google.com/en//pubs/archive/43322.pdf)):
  results surface "at code review time" with a hard noise budget — "We still enforce a very low
  effective false positive rate here (< 10%). Additionally, we only display results for most
  analyses on changed lines by default; this keeps analysis results relevant." An "effective
  false positive" is defined from the developer's side: "any report that they did not want to
  see," even if technically correct. Analyzer *dispatch* is driven by the change: FILES analyzers
  fire on the snapshot's file list, DEPS analyzers on the computed set of affected build targets,
  COMPILATION analyzers per compiled unit — selection by change content is built into the
  architecture. The platform has a "contract with analyzer writers about when we may remove"
  analyzers, developers click NOT USEFUL / PLEASE FIX on every finding, and "we were able to
  remove or improve low-priority checks" from that feedback loop. Pre-submit blocking checks are
  held to a stricter bar: "the effective false positive rate must be essentially zero."
- **Semgrep CI docs** ([Customize your CI job](https://semgrep.dev/docs/deployment/customize-ci-jobs)):
  the standard deployment splits by trigger, not risk: "diff-aware scans, which scan pull
  requests or merge requests in feature branches" against a `SEMGREP_BASELINE_REF`, plus
  scheduled full scans on trunk "at the least intrusive time."
- **Anthropic's [claude-code-security-review action](https://github.com/anthropics/claude-code-security-review)**:
  runs on every PR, but is "Diff-Aware … only analyzes changed files," and ships a dedicated
  false-positive filtering stage that categorically drops FP-prone finding classes (DoS, rate
  limiting, resource exhaustion, "generic input validation without proven impact") — noise
  management by *finding-class exclusion*, tunable per project.
- **Effort scaling by task complexity is vendor-documented for agents generally.**
  [Anthropic's multi-agent post](https://www.anthropic.com/engineering/multi-agent-research-system):
  "Agents struggle to judge appropriate effort for different tasks, so we embedded scaling rules
  in the prompts. Simple fact-finding requires just 1 agent with 3-10 tool calls … complex
  research might use more than 10 subagents" — explicit rules "prevent overinvestment in simple
  queries, which was a common failure mode." The
  [routing workflow](https://www.anthropic.com/engineering/building-effective-agents) (classify,
  then send to specialized handling, including cheaper paths for easy inputs) is the same
  pattern as a pre-review risk classifier.
- **Ponytail's review skill** is itself concern-routed: complexity findings here, "route
  [correctness bugs, security holes] to a normal review pass, not this one"
  ([`skills/ponytail-review/SKILL.md`](https://github.com/DietrichGebert/ponytail/blob/main/skills/ponytail-review/SKILL.md)).

**Where the evidence is thin:** I found no vendor agent guide, Google/Meta publication, or SAST
doc that recommends *skipping* the security pass when a diff doesn't touch trust boundaries. The
documented practice everywhere is: run on every change, but scope the work to the diff, dispatch
analyzers by what the change contains (language/targets), and spend the real engineering effort
on false-positive budgets. A risk classifier that selects reviewers would be a composition of
documented patterns (routing + effort-scaling rules + Tricorder-style dispatch) rather than a
documented pattern itself **(inference)**.

---

# Implications for the option space

The current pipeline (five-plus reviewer passes, edit-making simplifier, unbounded "implement any
findings" rounds) sits at the expensive corner of every tradeoff above: maximal fan-out (~15×
token pattern, low marginal precision per added critic), post-hoc simplification (against
ponytail's own design), and an uncapped loop (against both vendors' explicit guidance). Mapping
the evidence onto the four options:

**(a) Keep all focused reviewers, one bounded fix round.** The bounded round is the
best-supported single change in this list — every documented evaluator loop has a cap and/or a
"do not go for perfection" bar (Question 4), and the deterministic gate is the only re-check the
evidence requires after fixes. But keeping *all* reviewers keeps the duplication (simplifier and
complexity-skeptic share a charter; rule-reviewer overlaps the two-axis standards review) and
keeps paying ~N× tokens for findings whose precision falls as their count rises (CriticGPT's
comprehensiveness/nitpick curve). Capping rounds fixes the wall-time multiplier, not the fan-out
multiplier.

**(b) Consolidate to two reviewers.** Directly supported by Anthropic's production judge result
(one call, five rubric criteria, "most consistent and aligned with human judgements") and OpenAI's
"maximize a single agent's capabilities first," while still honoring the one decomposition the
literature insists on: criteria must be *named and distinct* in the prompt (G-Eval, BSM), and if
multiple agents run, their personas must differ (ChatEval). A natural two-way split the sources
suggest: one mechanical/rules reviewer (classification-shaped, cheap-model eligible per the
cascade guidance) and one judgment reviewer (spec fit + security + design, strong model, clean
context with diff + brief). Risk: BSM's +26% agreement came from *more* decomposition, not less —
consolidation trades some per-criterion focus for consistency and cost; no source measures the
exact midpoint.

**(c) Risk-based selection of reviewers.** Half-supported. Diff-scoping every reviewer and
dispatching by change content (Tricorder's FILES/DEPS/COMPILATION model; cogwork's existing
"composition review only when the diff touches `.tsx`" rule is already this) is solidly
precedented. Skipping the security pass entirely on low-risk diffs is not: the SAST precedent
runs security on every change and manages cost by scoping and FP budgets instead. A cheap
classifier that *scales* review effort (Anthropic's embedded scaling rules) is the defensible
version; a classifier that *zeroes* a concern is the undocumented one — and the classifier itself
becomes a new failure surface **(inference)**.

**(d) Merge simplifier + complexity-skeptic into one report-only minimalist reviewer.** The
option with the cleanest primary-source pedigree, because it is literally ponytail's design:
`/ponytail-review` is one diff-scoped complexity hunter, single-concern, report-only ("does not
apply the fixes"), with an early exit ("Lean already. Ship.") and a single net-lines metric. It
also honors the counter-evidence: report-only avoids an editing pass whose upstream (generation
under a minimalist ruleset) is where ponytail's measured wins actually come from, and merging
kills the one clear charter overlap. The evidence adds two riders: move the minimalist ruleset
*into the implementer's upfront instructions* (ponytail's benchmark, Huang et al.'s
fold-feedback-upfront result) so the reviewer catches residue rather than doing the work, and
keep the trust-boundary/minimum-test exemptions in both places, since judgment-free minimization
measurably cuts guards.

These are compatible: (d) plus the bounded round from (a), with (b)'s consolidation applied to
the remaining correctness/spec/security reviews and (c) limited to diff-scoped dispatch, uses
each pattern only where a primary source actually supports it.

---

## Source list

**Ponytail** (all in [github.com/DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail),
`main` @ 2026-09-23): `README.md`; `skills/ponytail/SKILL.md`; `skills/ponytail-review/SKILL.md`;
`skills/ponytail-audit/SKILL.md`; `benchmarks/README.md`;
`benchmarks/results/2026-06-18-agentic.md`.

**Vendor docs and engineering posts:**
[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
(Anthropic, 2024-12-19);
[How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
(Anthropic, 2025-06-13);
[Claude Code: subagents](https://code.claude.com/docs/en/sub-agents);
[Claude Code best practices](https://www.anthropic.com/engineering/claude-code-best-practices);
[A Practical Guide to Building Agents](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)
(OpenAI); [Agents SDK: running agents](https://openai.github.io/openai-agents-python/running_agents/);
[Agents SDK: orchestration](https://openai.github.io/openai-agents-python/multi_agent/);
[`llm_as_a_judge.py` example](https://github.com/openai/openai-agents-python/blob/main/examples/agent_patterns/llm_as_a_judge.py);
[claude-code-security-review action](https://github.com/anthropics/claude-code-security-review);
[Semgrep: customize your CI job](https://semgrep.dev/docs/deployment/customize-ci-jobs).

**Papers:** Self-Refine ([arXiv:2303.17651](https://arxiv.org/abs/2303.17651)); Huang et al.,
Large Language Models Cannot Self-Correct Reasoning Yet
([arXiv:2310.01798](https://arxiv.org/abs/2310.01798)); CriticGPT, LLM Critics Help Catch LLM
Bugs ([arXiv:2407.00215](https://arxiv.org/abs/2407.00215)); G-Eval
([arXiv:2303.16634](https://arxiv.org/abs/2303.16634)); Branch-Solve-Merge
([arXiv:2310.15123](https://arxiv.org/abs/2310.15123)); ChatEval
([arXiv:2308.07201](https://arxiv.org/abs/2308.07201)); Du et al., Improving Factuality and
Reasoning through Multiagent Debate ([arXiv:2305.14325](https://arxiv.org/abs/2305.14325));
Panickssery et al., LLM Evaluators Recognize and Favor Their Own Generations
([arXiv:2404.13076](https://arxiv.org/abs/2404.13076)); Sadowski et al., Tricorder: Building a
Program Analysis Ecosystem ([ICSE 2015](https://research.google/pubs/tricorder-building-a-program-analysis-ecosystem/),
[PDF](https://static.googleusercontent.com/media/research.google.com/en//pubs/archive/43322.pdf)).
