import { assert, describe, it } from "vitest";
import { type CursorAvailableModels, catalogModels } from "./catalog";

const picker = (models: CursorAvailableModels["models"]): CursorAvailableModels => ({ models });

describe("catalogModels", () => {
  it("keeps Cursor's display name beside the base id", () => {
    assert.deepStrictEqual(catalogModels(picker([{ value: " claude-opus-5 ", name: " Claude Opus 5 " }])), [
      { value: "claude-opus-5", label: "Claude Opus 5", options: [] },
    ]);
  });

  it("drops the zero-width padding Cursor puts in some choice names", () => {
    const [model] = catalogModels(
      picker([
        {
          value: "composer-2.5",
          name: "Composer 2.5",
          configOptions: [
            {
              id: "fast",
              name: "Fast",
              type: "select",
              currentValue: "true",
              options: [
                { value: "false", name: "Off" },
                { value: "true", name: "Fast\u200b\u200b" },
              ],
            },
          ],
        },
      ]),
    );

    assert.deepStrictEqual(model?.options?.[0]?.choices, [
      { value: "false", label: "Off" },
      { value: "true", label: "Fast" },
    ]);
  });

  it("carries the value Cursor would use itself as the option's fallback", () => {
    const [model] = catalogModels(
      picker([
        {
          value: "claude-opus-5",
          name: "Claude Opus 5",
          configOptions: [
            {
              id: "effort",
              name: "Effort",
              type: "select",
              currentValue: "high",
              options: [
                { value: "low", name: "Low" },
                { value: "high", name: "High" },
              ],
            },
          ],
        },
      ]),
    );

    assert.deepStrictEqual(model?.options, [
      {
        id: "effort",
        label: "Effort",
        fallback: "high",
        choices: [
          { value: "low", label: "Low" },
          { value: "high", label: "High" },
        ],
      },
    ]);
  });

  it("flattens a grouped select into one list of choices", () => {
    const [model] = catalogModels(
      picker([
        {
          value: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          configOptions: [
            {
              id: "effort",
              name: "Effort",
              type: "select",
              options: [
                { value: "none", name: "None" },
                {
                  options: [
                    { value: "low", name: "Low" },
                    { value: "max", name: "Max" },
                  ],
                },
              ],
            },
          ],
        },
      ]),
    );

    assert.deepStrictEqual(
      model?.options?.[0]?.choices.map(({ value }) => value),
      ["none", "low", "max"],
    );
  });

  it("is not an option when nothing can be picked", () => {
    const [model] = catalogModels(
      picker([
        {
          value: "auto-smart",
          name: "Auto",
          configOptions: [{ id: "thinking", name: "Thinking", type: "select", options: [] }],
        },
      ]),
    );

    assert.deepStrictEqual(model?.options, []);
  });

  it("drops a nameless model and a repeated base id", () => {
    assert.deepStrictEqual(
      catalogModels(
        picker([
          { value: "claude-opus-5", name: "Claude Opus 5" },
          { value: "claude-opus-5", name: "Claude Opus 5 again" },
          { value: "unnamed", name: "   " },
        ]),
      ).map(({ label }) => label),
      ["Claude Opus 5"],
    );
  });
});
