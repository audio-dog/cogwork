import base from "@cogwork/test-config";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ["*.test.mjs"],
      restoreMocks: true,
    },
  }),
);
