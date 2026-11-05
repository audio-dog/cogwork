import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decodeSubagentFile } from "./subagent-file";

const file = (frontmatter: string, body = "Grill the plan.") => `---\n${frontmatter}\n---\n\n${body}\n`;

describe("decodeSubagentFile", () => {
  it.effect("decodes the description, tools, Model level, and prompt", () =>
    Effect.gen(function* () {
      const definition = yield* decodeSubagentFile(
        "griller",
        file(
          [
            "name: griller",
            "description: Interviews an understudy.",
            "tools: Read, Grep, Bash",
            "metadata:",
            "  model-level: light",
          ].join("\n"),
        ),
      );

      assert.deepStrictEqual(definition, {
        description: "Interviews an understudy.",
        tools: ["Read", "Grep", "Bash"],
        modelLevel: "light",
        prompt: "Grill the plan.",
      });
    }),
  );

  it.effect("gives a file with no metadata.model-level the Model level standard", () =>
    Effect.gen(function* () {
      const definition = yield* decodeSubagentFile(
        "griller",
        file("name: griller\ndescription: Interviews an understudy.\ntools:\n  - Read"),
      );

      assert.strictEqual(definition.modelLevel, "standard");
      assert.deepStrictEqual(definition.tools, ["Read"]);
    }),
  );

  it.effect.each([
    {
      case: "a missing description",
      text: file("name: griller"),
      reason: /description/,
    },
    {
      case: "a name that does not match the file name",
      text: file("name: grill\ndescription: Interviews."),
      reason: /name "grill" does not match the file name "griller"/,
    },
    {
      case: "an unknown Model level",
      text: file("name: griller\ndescription: Interviews.\nmetadata:\n  model-level: heavy"),
      reason: /model-level/,
    },
    {
      case: "a vendor model",
      text: file("name: griller\ndescription: Interviews.\nmodel: sonnet"),
      reason: /model "sonnet" is a vendor model, not a Model level/,
    },
  ])("rejects $case with the reason", ({ text, reason }) =>
    Effect.gen(function* () {
      const outcome = yield* decodeSubagentFile("griller", text).pipe(
        Effect.match({ onFailure: ({ message }) => message, onSuccess: () => "decoded" }),
      );

      assert.match(outcome, reason);
    }),
  );
});
