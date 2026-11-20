# Lint config

After changing a GritQL rule, its fixtures, or the Biome config that registers it, run:

```sh
pnpm --filter @cogwork/lint-config test:rules
```

## Oxlint

`oxlint.config.ts` extends every file in `configs/lint/oxlint/`. Each file in `configs/lint/areas/`
turns one rule group on for one set of files. Its default export is a `LintArea`, the rules and the
exact file list:

```ts
import type { LintArea } from "../../../oxlint.config.ts";

export default {
  files: ["packages/engine/src/**"],
  rules: { "react/refs": "error" },
} satisfies LintArea;
```
