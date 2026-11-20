import { describe, expect, it } from "vitest";

import { runStatusLabel } from "./run-status";

describe("runStatusLabel", () => {
  it("names an engine pull request decline", () => {
    expect(runStatusLabel.declined).toBe("PR creation declined");
  });
});
