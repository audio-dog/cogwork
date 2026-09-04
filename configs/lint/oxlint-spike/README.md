# Oxlint JavaScript plugin spike

Issue: [#481](https://github.com/colonylabs/cogwork/issues/481)

## Result

Recommend a full Oxlint migration spike. Do not keep two production linters. The five-rule result
shows one fixed JavaScript-plugin startup cost and no measurable cost for rules two through five.
This is the shared traversal behavior that Biome's Grit plugins lack.

Oxlint's five-rule average is 0.074 CPU-seconds per rule. This is slightly above the issue's
0.05-second bar because the average assigns the fixed startup cost across only five rules. The
one-rule and five-rule wall medians are equal at 0.28 seconds, and the CPU medians differ by 0.02
seconds in Oxlint's favor. The added four rules therefore stay inside measurement noise. If that
slope holds, 27 rules remain far below the two-second target.

## Method

- Oxlint 1.81.0 and Biome 2.5.11.
- Apple M5 Pro, 18 logical CPUs, Node.js 24.20.0.
- 504 tracked JavaScript and TypeScript files. Rule fixtures and generated TypeScript files are
  excluded. Every scenario receives the same file list.
- One warm-up per scenario, then nine measured rounds.
- Scenario order rotates each round.
- `/usr/bin/time -p` supplies wall, user, and system time. CPU is user plus system time.
- Biome's five rules are standalone Grit plugin files, not the production grouped plugins.
- Built-in rules are disabled on both sides.

Run with `pnpm benchmark:oxlint-spike -- 9`.

## Medians

| Scenario | Wall (s) | CPU (s) |
| --- | ---: | ---: |
| Oxlint, zero custom rules | 0.08 | 0.13 |
| Oxlint, `no-switch` only | 0.28 | 0.52 |
| Oxlint, all five rules | 0.28 | 0.50 |
| Biome, zero custom rules | 0.14 | 0.35 |
| Biome, all five rules | 2.21 | 16.24 |

| Derived cost | Wall/rule (s) | CPU/rule (s) |
| --- | ---: | ---: |
| Oxlint, five-rule average | 0.040 | 0.074 |
| Oxlint, rules 2–5 | below resolution | below resolution |
| Biome, five-rule average | 0.414 | 3.178 |

Oxlint's five-rule average uses about 43 times less CPU than Biome's representative five-rule set.
The one-rule and five-rule Oxlint medians are effectively flat after startup.

## Port readability

- `no-switch`, `no-runtime-runfork`, and `no-iife-wrapper` map directly to short node visitors.
- `no-effect-sync-throw` needs an ancestor walk and duplicate-report guard instead of Grit's subtree
  predicate.
- `no-wire-union-tag-comparison` is longer, but its family, import, property, and tag relations are
  explicit data rather than repeated pattern branches.

The JavaScript is more verbose for subtree matching, but all five rules remain reviewable. Existing
valid and invalid fixtures pass against both implementations.

## Risks and next step

Oxlint JavaScript plugins remain alpha and outside semantic-version guarantees. That is the main
build-gate risk. A migration must port all rules, repoint all fixtures, verify severity and reach,
and replace Biome rather than adding a permanent second linter. Benchmark the complete port before
switching production configuration. The result is strong enough that pricing ast-grep is not the
next step.
