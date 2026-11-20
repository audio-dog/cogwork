import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ControlStoreFailure } from "./daemon";

describe("ControlStoreFailure", () => {
  it("keeps legacy wire failures retryable", () => {
    const failure = Schema.decodeSync(ControlStoreFailure)({
      _tag: "ControlStoreFailure",
      operation: "read Control store",
      message: "unavailable",
    });

    assert.isTrue(failure.retryable);
  });
});
