import { assert, describe, it } from "vitest";
import { applyCursorEffort, cursorModelFlag } from "./model";

describe("applyCursorEffort", () => {
  it("returns the model unchanged when effort is unset", () => {
    assert.strictEqual(applyCursorEffort("claude-opus-4-8", null), "claude-opus-4-8");
    assert.strictEqual(applyCursorEffort("claude-opus-4-8", undefined), "claude-opus-4-8");
  });

  it("adds an effort bracket to a bare model id", () => {
    assert.strictEqual(applyCursorEffort("claude-opus-4-8", "high"), "claude-opus-4-8[effort=high]");
  });

  it("merges effort into an existing bracket list, replacing a prior effort key", () => {
    assert.strictEqual(
      applyCursorEffort("claude-opus-4-8[context=1m,effort=low,fast=false]", "high"),
      "claude-opus-4-8[context=1m,fast=false,effort=high]",
    );
  });
});

describe("cursorModelFlag", () => {
  it("shell-quotes the composed model for agent --model", () => {
    assert.strictEqual(cursorModelFlag("claude-opus-4-8", "high"), "'claude-opus-4-8[effort=high]'");
  });
});
