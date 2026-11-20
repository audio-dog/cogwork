# 0038 — Oxlint and Oxfmt replace Biome, and official rules win over our own

- **Status:** accepted
- **Date:** 2026-11-19

## Context

Biome 2.5 did all formatting and linting. Its `recommended` preset ran with a few preference rules,
the React Compiler rule, and 12 GritQL plugin files with 40 diagnostics. Most of those plugin rules
were Effect rules that we copied from a Biome pack while Effect v4 was in beta. The ecosystem is
moving to Oxlint and Oxfmt: Vite, Vitest, Effect, and three TanStack repositories use them. Effect
now ships an official rule set, `@effect/tsgo`, that runs inside Oxlint.

## Decision

1. **Oxfmt formats and Oxlint lints.** Biome is removed. The configuration files are
   `oxfmt.config.ts` and `oxlint.config.ts`. The script names `format-and-lint`,
   `format-and-lint:fix`, and `format-and-lint:unsafe`, and the CI checks `format-and-lint` and
   `lint-rule-fixtures`, keep their names.
2. **The formatter keeps our options and turns on the sort features.** These are `printWidth` 110,
   spaces, double quotes, `sortImports`, `sortTailwindcss`, and `sortPackageJson`. One reformat
   commit is listed in `.git-blame-ignore-revs`.
3. **Lint starts from Oxlint's defaults, not from a copy of Biome's `recommended` preset.** Over the
   defaults we turn on:
   - the `react` plugin and `react/rules-of-hooks`, for the React Compiler rules;
   - `jsx-a11y`;
   - `vitest` on test files only, for the test rules we prefer. Oxlint has no `vitest/no-export`, so
     "no exports from a test file" is a rule in our own plugin. The `jest` plugin is not used;
   - `unicorn/filename-case` as kebab-case, off under `**/routes/**`.

   The `import` plugin stays off. CSS and JSON are not linted.
4. **Type-aware linting is on.** We use the setup that both Effect's Oxlint guide and the oxc docs
   give:
   - `effect-tsgo patch --oxlint` in `prepare`, with the `oxlint-tsgolint` backend;
   - the `@effect/tsgo` `strict` preset, plus more Effect rules raised to error;
   - `diagnostics: false` in the tsconfig plugin, so that each Effect diagnostic is reported only
     once, by Oxlint;
   - the patched `tsc` still runs in `typecheck`, for type errors.

   `tsrs` is not installed until it is stable and `@effect/tsgo` supports it.
5. **Official rules win.** When two rules cover the same problem, the one with the higher priority
   stays on and the other goes off. The order is:
   1. `@effect/tsgo` (`effecttsgo/*`);
   2. anti-slop, copied into the repo with its own setup instructions, with its Effect rules on;
   3. `@shekohex/oxc-effect`, from its `core` preset;
   4. our own Oxlint plugin, written in TypeScript with `definePlugin`.

   One exception: when a higher-priority rule runs on fewer files than a lower-priority rule, the
   lower-priority rule stays on. A pack rule that conflicts with an official rule goes off; for
   example, shekohex `no-effect-as` conflicts with tsgo `mapConstToAs`. Our plugin keeps only the
   rules that no pack has.
6. **Versions are the latest, pinned exactly.** Oxlint JS plugins are alpha and outside semver, so
   an upgrade is a deliberate bump that runs the rule fixtures again. `oxlint` and
   `oxlint-tsgolint` move only to versions that the installed `@effect/tsgo` lists, so these three
   upgrade together.
7. **Lint violations are fixed, not suppressed.** A suppression that no longer applies fails the
   lint (`reportUnusedDisableDirectives`).
8. **Every enabled rule is an error.** A pack rule that its preset marks as a warning is raised to
   error, because a warning never fails CI and so never stops an agent.
9. **Scope.** Tests are in scope for every rule. The Effect rules (`effecttsgo/*`, shekohex, and the
   anti-slop Effect group) and the type-aware rules do not run on `**/*.mjs`: those files have no
   types and do not use Effect.
10. **A second, stricter tier follows the swap.** After Biome is gone:
    - the four Effect rules that the old tsconfig turned off come on: `lazyEffect`,
      `strictEffectProvide`, `strictBooleanExpressions`, and `unstableApiUsage`. `unstableApiUsage`
      takes `allowedUnstableApis` with the unstable modules the repo already uses, so a new unstable
      API is a visible decision;
    - every `@effect/tsgo` rule that `strict` leaves off comes on, except deprecated rules and rules
      that need a package list. The `maintainers` preset stays off: Cogwork is not a published
      library;
    - the Oxlint `suspicious`, `perf`, and `pedantic` categories come on, and the type-aware rules
      outside `correctness`;
    - from `restriction`, only the rules the code already passes and a short list of safety rules
      come on;
    - from `style`, only rules that encode `CODING_STANDARDS.md` come on. The rest stay at Oxlint's
      default.

    In every tier we exclude a rule only when it is a false positive on a TypeScript or Effect
    idiom (for example `no-underscore-dangle` on `_tag`), when it repeats or contradicts an official
    rule, when it conflicts with Oxfmt, or when it is the direct opposite of a rule we turn on.
11. **Rules turn on area by area.** Oxlint has no baseline file. A ticket fixes one rule group in one
    package or directory and turns the group on for that area through an `overrides` glob, so CI is
    green after each ticket. When the last area is clean, the glob becomes a global rule.

## Considered Options

- **Copy Biome's `recommended` preset into Oxlint rule by rule.** Rejected: we prefer each tool's
  defaults to an imitation of the old tool.
- **Keep our own rule when a pack covers it only in part.** Rejected: the Effect maintainers and the
  pack authors know Effect better than we do. Where they draw a narrower line, we take their line.
  The cost: `switch` statements, IIFEs, and nested `Effect.gen` that is not yielded directly become
  legal in places where our old rules banned them.
- **Run the Effect diagnostics in the patched `tsc`, as Effect's own repository does.** Rejected:
  Effect's Oxlint guide recommends Oxlint, and that gives one place for every rule. The cost is the
  version lockstep in decision 6.
- **Run `ast-grep` next to Oxlint for the pattern rules**, as opencode does. Rejected: it keeps a
  second linter.
- **Turn on the whole `style` and `restriction` categories.** Rejected: they are lists of opposite
  choices, not levels of strictness. `style` has 42,125 hits, mostly taste (`one-var`, `sort-keys`),
  and three of its rules fight Oxfmt. `restriction` bans features that `CODING_STANDARDS.md`
  requires, such as optional chaining.

## Consequences

- `jsx-a11y` and the React rules change the accessibility and hooks coverage. The old a11y
  suppressions are converted or deleted.
- The rules raised to error, and the new pack rules, report violations across the codebase. The
  migration fixes them.
- ADR [0022](./0022-a-sensor-lives-where-its-signal-is-produced.md) rejected a rule that caps tests
  per file because GritQL could not count. A JS plugin rule can count, so that option is open again.
- The rule fixtures still run the real linter (kept by ADR
  [0040](./0040-the-test-suite-cost-sensor-is-removed.md)), but in one run over all fixtures, not
  one process for each fixture.
