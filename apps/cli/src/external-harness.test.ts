import { HarnessName } from "@cogwork/contracts";
import { Harness } from "@cogwork/engine";
import { assert, describe, layer } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { harnessRunners } from "./rpc";

const externalProfiles = [
  {
    name: Schema.decodeSync(HarnessName)("claude"),
    session: { affinity: "sandbox-lineage", fork: true, humanAttach: false },
    structuredOutput: "native",
    policyFidelity: "profile-only",
    fileEventFidelity: "terminal-only",
    usageQuality: "metered",
    journal: true,
    takeover: true,
  },
  {
    name: Schema.decodeSync(HarnessName)("codex"),
    session: { affinity: "runtime-host", fork: false, humanAttach: "codex-cli" },
    structuredOutput: "native",
    policyFidelity: "none",
    fileEventFidelity: "best-effort",
    usageQuality: "metered",
    journal: true,
    takeover: true,
  },
  {
    name: Schema.decodeSync(HarnessName)("cursor"),
    session: { affinity: "runtime-host", fork: false, humanAttach: false },
    structuredOutput: "prompt-and-parse",
    policyFidelity: "none",
    fileEventFidelity: "absent",
    usageQuality: "estimated",
    journal: false,
    takeover: false,
  },
] as const;

describe("harness registration", () => {
  layer(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))((it) => {
    it.effect("registers the owned and external Harnesses when no replay fixture is configured", () =>
      Effect.gen(function* () {
        const runners = yield* harnessRunners;
        assert.deepStrictEqual(
          runners.map((runner) => runner.name),
          ["provider", "cursor", "claude", "codex"],
        );
      }),
    );

    it.effect("publishes intentional native inequalities through the Harness service", () =>
      Effect.gen(function* () {
        const harness = Harness.make(yield* harnessRunners);

        for (const { name, ...expected } of externalProfiles) {
          const profile = harness.capabilities(name);
          assert.deepNestedInclude(profile, expected);
        }
      }),
    );
  });

  layer(
    ConfigProvider.layer(
      ConfigProvider.fromEnv({ env: { COGWORK_REPLAY_FIXTURE: "/tmp/replay-fixture.json" } }),
    ),
  )((it) => {
    it.effect("registers replay when its fixture is configured", () =>
      Effect.gen(function* () {
        const runners = yield* harnessRunners;
        assert.deepStrictEqual(
          runners.map((runner) => runner.name),
          ["provider", "cursor", "claude", "codex", "replay"],
        );
      }),
    );
  });
});
