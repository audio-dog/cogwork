import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { RunSummary } from "./run";

const summary = {
  id: "run-1",
  workspace: "acme",
  workItem: "#623",
  operation: "implement",
  harness: "codex",
  branch: null,
  session: null,
  usage: null,
  status: "succeeded",
  startedAtMillis: 1,
  endedAtMillis: 2,
  eventCount: 0,
};

describe("RunSummary", () => {
  it("defaults unpruned history and preserves a prune timestamp", () => {
    const decode = Schema.decodeUnknownSync(RunSummary);

    assert.isNull(decode(summary).eventsPrunedAtMillis);
    assert.strictEqual(decode({ ...summary, eventsPrunedAtMillis: 3 }).eventsPrunedAtMillis, 3);
  });
});
