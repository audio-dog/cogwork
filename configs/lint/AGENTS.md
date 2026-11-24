# Lint config

After changing a GritQL rule, an Oxlint plugin rule in `oxlint-plugin/`, their fixtures, or the
`biome.json` or `oxlint.config.ts` that registers them, run:

```sh
pnpm --filter @cogwork/lint-config test:rules
```

An Oxlint plugin rule is a `defineRule` from `@oxlint/plugins` in `oxlint-plugin/rules/`. Register it
in `oxlint-plugin/index.ts`, enable it as `cogwork/<rule>` in `oxlint.config.ts`, put each report
message in `meta.messages`, and add a case and fixtures to `tests/rules.test.mjs`.
