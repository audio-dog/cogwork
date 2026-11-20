import { Config, Effect } from "effect";
import { defineConfig } from "vitest/config";

import { TestCountReporter } from "./test-count-reporter.ts";

export const localWorkerLimit = (isCi: boolean) => (isCi ? undefined : 1);

export default defineConfig({
  test: {
    // Vitest 4 excludes only node_modules and .git by default, so tests must stay scoped to sources.
    include: ["src/**/*.test.{ts,tsx}"],
    maxWorkers: localWorkerLimit(Effect.runSync(Config.Boolean("CI").pipe(Config.withDefault(false)))),
    reporters: ["default", new TestCountReporter()],
  },
});
