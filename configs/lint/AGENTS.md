# Lint config

After changing a GritQL rule, an Oxlint plugin rule in `oxlint-plugin/`, their fixtures, or the
`biome.json` or `oxlint.config.ts` that registers them, run:

```sh
pnpm --filter @cogwork/lint-config test:rules
```
