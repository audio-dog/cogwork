import { assert, describe, it } from "vitest";
import { applyCursorModelOptions, cursorModelFlag, parseCursorModelList } from "./model";
import { cursorModels } from "./models.generated";

describe("applyCursorModelOptions", () => {
  it("returns the base id unchanged when nothing is selected", () => {
    assert.strictEqual(applyCursorModelOptions("claude-opus-5", []), "claude-opus-5");
  });

  it("writes one selected option as a bracket parameter", () => {
    assert.strictEqual(
      applyCursorModelOptions("claude-opus-5", [{ option: "effort", value: "high" }]),
      "claude-opus-5[effort=high]",
    );
  });

  it("writes every selected option in one bracket list", () => {
    assert.strictEqual(
      applyCursorModelOptions("claude-opus-5", [
        { option: "effort", value: "high" },
        { option: "fast", value: "false" },
        { option: "context", value: "1m" },
      ]),
      "claude-opus-5[effort=high,fast=false,context=1m]",
    );
  });

  it("replaces a parameter the base id already carries", () => {
    assert.strictEqual(
      applyCursorModelOptions("claude-opus-5[context=1m,effort=low,fast=false]", [
        { option: "effort", value: "high" },
      ]),
      "claude-opus-5[context=1m,fast=false,effort=high]",
    );
  });

  it("writes one parameter per option, taking the last value given for it", () => {
    assert.strictEqual(
      applyCursorModelOptions("claude-opus-5", [
        { option: "effort", value: "low" },
        { option: "effort", value: "high" },
      ]),
      "claude-opus-5[effort=high]",
    );
  });

  it("drops an option with no value rather than writing an empty parameter", () => {
    assert.strictEqual(
      applyCursorModelOptions("claude-opus-5", [
        { option: "effort", value: "  " },
        { option: "fast", value: "true" },
      ]),
      "claude-opus-5[fast=true]",
    );
  });
});

describe("cursorModelFlag", () => {
  it("shell-quotes the composed model for agent --model", () => {
    assert.strictEqual(
      cursorModelFlag("claude-opus-5", [{ option: "effort", value: "high" }]),
      "'claude-opus-5[effort=high]'",
    );
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
    assert.include(cursorModels, "auto-smart");
    assert.deepStrictEqual(
      cursorModels.filter((id) => /\s/.test(id)),
      [],
    );
    assert.strictEqual(new Set(cursorModels).size, cursorModels.length);
  });
});
