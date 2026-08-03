---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Before writing any code, read every file in `~/sites/clanker-forge/packages/sync/assets/rules/*` (e.g. `global.md`, `react.md`). These are my personal rules and are authoritative: follow them for the entire task, in addition to (not instead of) any repo-specific rules (`AGENTS.md`/`CLAUDE.md`, `.specify/memory/constitution*.md`, `.cursor/rules/*`). If a personal rule and a repo rule genuinely conflict, follow the stricter one and flag the conflict to me.

Implement the work described by the user in the spec or tickets.

Use /tdd where possible, at pre-agreed seams.

When writing React code, always invoke the /react-composition-patterns and /react-no-use-effect skills.

Run typechecking regularly, single test files regularly, and the full test suite and full build once at the end.

Once done, run the code-simplifier agent in a subagent to refine the implementation, then use /code-review to review the work.

Then, in separate subagents run the rule-reviewer agent, the /adversarial-review skill, and the /review-bugbot skill and fix any findings. When you invoke the rule-reviewer agent, explicitly instruct it to load and enforce `~/sites/clanker-forge/packages/sync/assets/rules/*` alongside the repo rules, so my personal rules are checked as blocking violations.

Commit your work to the current branch using the /git-master skill.