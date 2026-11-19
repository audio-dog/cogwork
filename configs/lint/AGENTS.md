# Lint config

After changing a GritQL rule, its fixtures, or the Biome config that registers it, run:

```sh
pnpm --filter @cogwork/lint-config test:rules
```

Run the same command after changing a rule in our Oxlint plugin (`oxlint-plugin/`), its fixtures, or
`oxlint/cogwork.ts`, which loads the plugin and turns its rules on. The command runs `oxlint` once over
the fixtures of every Oxlint rule. A new plugin rule needs an entry in `oxlint/cogwork.ts`, a case in
`oxlintRuleCases` in `tests/rules.test.mjs`, and an `invalid-example.ts` and a `valid-example.ts`
fixture.
