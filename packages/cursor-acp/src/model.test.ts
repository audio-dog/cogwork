import { assert, describe, it } from "vitest";

import {
  CursorModelSelectionResult,
  CursorNativeModelIdResult,
  createCursorModelCatalog,
  cursorModelFlag,
  cursorModelSelectionFromNativeId,
  cursorNativeModelId,
  parseCursorModelList,
} from "./model";
import { cursorCatalog, cursorModels } from "./models.generated";

describe("cursorModelFlag", () => {
  it("shell-quotes the translated native model for agent --model", () => {
    assert.strictEqual(cursorModelFlag("claude-opus-4-8-high"), "'claude-opus-4-8-high'");
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

const sampleModelList = [
  "Available models",
  "",
  "auto - Auto (default)",
  "claude-opus-5-low - Claude Opus 5 1M Low",
  "claude-opus-5-low-fast - Claude Opus 5 1M Low Fast",
  "claude-opus-5-high - Claude Opus 5 1M",
  "claude-opus-5-high-fast - Claude Opus 5 1M Fast",
  "claude-opus-5-thinking-high - Claude Opus 5 1M Thinking",
  "claude-opus-5-thinking-high-fast - Claude Opus 5 1M Thinking Fast",
  "future-model-preview - Future Model Preview",
  "",
  "Tip: use --model <id> to switch.",
].join("\n");

describe("createCursorModelCatalog", () => {
  it("decomposes Cursor ids into base models and descriptors", () => {
    const { catalog, opaqueModelIds } = createCursorModelCatalog(sampleModelList, "2026.08.11-e8db854");
    const model = catalog.models.find(({ value }) => value === "claude-opus-5");

    assert.strictEqual(catalog.generatedAgainst, "2026.08.11-e8db854");
    assert.deepStrictEqual(catalog.rawModelIds, parseCursorModelList(sampleModelList));
    assert.deepStrictEqual(
      model?.options?.map(({ id }) => id),
      ["effort", "speed", "context", "thinking"],
    );
    assert.strictEqual(model?.options?.find(({ id }) => id === "effort")?.defaultValue, "high");
    assert.strictEqual(catalog.models.find(({ value }) => value === "auto")?.default, true);
    assert.deepStrictEqual(opaqueModelIds, ["auto", "future-model-preview"]);
  });

  it("keeps a lone id with a reserved suffix opaque", () => {
    const output = ["auto - Auto (default)", "future-high - Future High"].join("\n");
    const { catalog, opaqueModelIds } = createCursorModelCatalog(output, "test");

    assert.deepStrictEqual(opaqueModelIds, ["auto", "future-high"]);
    assert.deepStrictEqual(cursorNativeModelId(catalog, "future-high", {}), {
      _tag: "Success",
      value: "future-high",
    });
    assert.deepStrictEqual(cursorModelSelectionFromNativeId(catalog, "future-high"), {
      _tag: "Success",
      value: { model: "future-high", options: {} },
    });
  });

  it("uses the CLI default entry for descriptor defaults", () => {
    const output = ["model-low - Model Low", "model-high - Model High (default)"].join("\n");
    const { catalog } = createCursorModelCatalog(output, "test");

    assert.strictEqual(catalog.models[0]?.options?.[0]?.defaultValue, "high");
    assert.deepStrictEqual(cursorNativeModelId(catalog, "model", {}), {
      _tag: "Success",
      value: "model-high",
    });
  });

  it("keeps a bare variant distinct from a marked effort default", () => {
    const output = ["model - Model", "model-high - Model High (default)"].join("\n");
    const { catalog } = createCursorModelCatalog(output, "test");

    assert.deepStrictEqual(cursorModelSelectionFromNativeId(catalog, "model"), {
      _tag: "Success",
      value: { model: "model", options: { effort: "medium" } },
    });
    assert.deepStrictEqual(cursorModelSelectionFromNativeId(catalog, "model-high"), {
      _tag: "Success",
      value: { model: "model", options: { effort: "high" } },
    });
  });
});

describe("cursorNativeModelId", () => {
  it("translates every generated model with descriptor defaults", () => {
    const failures = cursorCatalog.models
      .map((model) => cursorNativeModelId(cursorCatalog, model.value, {}))
      .filter(CursorNativeModelIdResult.$is("Failure"));

    assert.deepStrictEqual(failures, []);
  });

  it("round-trips every decomposed raw id through base model selections", () => {
    cursorCatalog.rawModelIds.forEach((nativeId) => {
      const selection = cursorModelSelectionFromNativeId(cursorCatalog, nativeId);
      if (!CursorModelSelectionResult.$is("Success")(selection)) assert.fail(selection.error);

      assert.deepStrictEqual(
        cursorNativeModelId(cursorCatalog, selection.value.model, selection.value.options),
        { _tag: "Success", value: nativeId },
      );
    });
  });

  it("rejects a valid per-axis selection when the native combination is absent", () => {
    const { catalog } = createCursorModelCatalog(sampleModelList, "2026.08.11-e8db854");

    assert.deepStrictEqual(
      cursorNativeModelId(catalog, "claude-opus-5", {
        effort: "low",
        speed: false,
        context: true,
        thinking: true,
      }),
      {
        _tag: "Failure",
        error: "Cursor has no native model id for claude-opus-5 with the selected options",
      },
    );
  });

  it("reports an invalid value for a declared option", () => {
    const { catalog } = createCursorModelCatalog(sampleModelList, "2026.08.11-e8db854");

    assert.deepStrictEqual(cursorNativeModelId(catalog, "claude-opus-5", { effort: "turbo" }), {
      _tag: "Failure",
      error: 'Cursor model claude-opus-5 option effort does not allow "turbo"',
    });
  });

  it("keeps label-derived context in the native option oracle", () => {
    const output = [
      "auto - Auto (default)",
      "gpt-5.5-none - GPT-5.5 1M None",
      "gpt-5.5-none-fast - GPT-5.5 None Fast",
    ].join("\n");
    const { catalog } = createCursorModelCatalog(output, "test");

    assert.deepStrictEqual(cursorModelSelectionFromNativeId(catalog, "gpt-5.5-none"), {
      _tag: "Success",
      value: {
        model: "gpt-5.5",
        options: { effort: "none", speed: false, context: true },
      },
    });
    assert.deepStrictEqual(
      cursorNativeModelId(catalog, "gpt-5.5", { effort: "none", speed: true, context: true }),
      {
        _tag: "Failure",
        error: "Cursor has no native model id for gpt-5.5 with the selected options",
      },
    );
  });

  it("passes an opaque model through only when no options are selected", () => {
    const { catalog } = createCursorModelCatalog(sampleModelList, "2026.08.11-e8db854");

    assert.deepStrictEqual(cursorNativeModelId(catalog, "future-model-preview", {}), {
      _tag: "Success",
      value: "future-model-preview",
    });
    assert.deepStrictEqual(cursorNativeModelId(catalog, "future-model-preview", { speed: true }), {
      _tag: "Failure",
      error: "Cursor model future-model-preview does not declare option speed",
    });
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
