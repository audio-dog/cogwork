import { assert, describe, it } from "vitest";
import { applyCursorEffort, cursorModelFlag, parseCursorModelList } from "./model";
import { cursorModels } from "./models.generated";

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

describe("parseCursorModelList", () => {
  it("reads ids from agent --list-models output, ignoring headings and the trailing tip", () => {
    const output = [
      "Available models",
      "",
      "auto - Auto (default)",
      "composer-2.5 - Composer 2.5",
      "",
      "Tip: use --model <id> (or /model <id> in interactive mode) to switch.",
    ].join("\n");
    assert.deepStrictEqual(parseCursorModelList(output), ["auto", "composer-2.5"]);
  });
});

describe("cursorModels", () => {
  it("carries unique, flag-safe ids for config to select from", () => {
    assert.include(cursorModels, "auto");
    assert.deepStrictEqual(
      cursorModels.filter((id) => /\s/.test(id)),
      [],
    );
    assert.strictEqual(new Set(cursorModels).size, cursorModels.length);
  });
});
