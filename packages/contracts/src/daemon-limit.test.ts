import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { DaemonLimits, DaemonLimitUpdate, maxSchedulerLimit } from "./daemon";

const decodeUpdate = Schema.decodeUnknownSync(DaemonLimitUpdate);
const decodeLimits = Schema.decodeUnknownSync(DaemonLimits);

describe("DaemonLimitUpdate", () => {
  it("accepts each limit key with an expected revision", () => {
    assert.deepStrictEqual(decodeUpdate({ key: "global-concurrency", value: 8, expectedRevision: 2 }), {
      key: "global-concurrency",
      value: 8,
      expectedRevision: 2,
    });
    assert.deepStrictEqual(
      decodeUpdate({ key: "per-workspace-concurrency", value: 3, expectedRevision: 2 }),
      {
        key: "per-workspace-concurrency",
        value: 3,
        expectedRevision: 2,
      },
    );
    assert.deepStrictEqual(
      decodeUpdate({ key: "daily-budget", value: maxSchedulerLimit, expectedRevision: 2 }),
      {
        key: "daily-budget",
        value: maxSchedulerLimit,
        expectedRevision: 2,
      },
    );
  });

  it("rejects invalid values", () => {
    assert.throws(() => decodeUpdate({ key: "global-concurrency", value: 0, expectedRevision: 0 }));
    assert.throws(() => decodeUpdate({ key: "per-workspace-concurrency", value: -1, expectedRevision: 0 }));
    assert.throws(() =>
      decodeUpdate({ key: "daily-budget", value: maxSchedulerLimit + 1, expectedRevision: 0 }),
    );
    assert.throws(() => decodeUpdate({ key: "daily-budget", value: 2.5, expectedRevision: 0 }));
    assert.throws(() => decodeUpdate({ key: "daily-budget", value: 2, expectedRevision: -1 }));
  });
});

describe("DaemonLimits", () => {
  it("decodes the typed durable row", () => {
    assert.deepStrictEqual(
      decodeLimits({
        globalConcurrency: 8,
        perWorkspaceConcurrency: 3,
        dailyBudget: 20,
        revision: 4,
      }),
      {
        globalConcurrency: 8,
        perWorkspaceConcurrency: 3,
        dailyBudget: 20,
        revision: 4,
      },
    );
  });
});
