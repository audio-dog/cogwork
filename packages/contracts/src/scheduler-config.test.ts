import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { maxSchedulerLimit, SchedulerConfigUpdate } from "./daemon";

const decode = Schema.decodeUnknownSync(SchedulerConfigUpdate);

describe("SchedulerConfigUpdate", () => {
  it("accepts a partial update with a single field", () => {
    assert.deepStrictEqual(decode({ globalLimit: 8 }), { globalLimit: 8 });
  });

  it("accepts the largest allowed value", () => {
    assert.deepStrictEqual(decode({ dailyBudget: maxSchedulerLimit }), {
      dailyBudget: maxSchedulerLimit,
    });
  });

  it("rejects zero and negative limits", () => {
    assert.throws(() => decode({ globalLimit: 0 }));
    assert.throws(() => decode({ perWorkspaceLimit: -1 }));
  });

  it("rejects a value above the cap", () => {
    assert.throws(() => decode({ globalLimit: maxSchedulerLimit + 1 }));
  });

  it("rejects a non-integer limit", () => {
    assert.throws(() => decode({ dailyBudget: 2.5 }));
  });
});
