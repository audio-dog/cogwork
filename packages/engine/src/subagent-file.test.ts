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

  it.effect("gives the Model level standard to a file with no metadata.model-level or model: inherit", () =>
    Effect.gen(function* () {
      const definition = yield* decodeSubagentFile(
        "griller",
        file("name: griller\ndescription: Interviews an understudy.\nmodel: inherit\ntools:\n  - Read"),
      );

      assert.strictEqual(definition.modelLevel, "standard");
      assert.deepStrictEqual(definition.tools, ["Read"]);
    }),
  );

  it.effect.each([
    {
      case: "a missing description",
      text: file("name: griller"),
      reason: /^the frontmatter does not decode at description$/,
    },
    {
      case: "a name that does not match the file name",
      text: file("name: grill\ndescription: Interviews."),
      reason: /name "grill" does not match the file name "griller"/,
    },
    {
      case: "an unknown Model level",
      text: file("name: griller\ndescription: Interviews.\nmetadata:\n  model-level: heavy"),
      reason: /^the frontmatter does not decode at metadata\.model-level$/,
    },
    {
      case: "frontmatter that is not valid YAML",
      text: file("name: griller\ndescription: [unclosed"),
      reason: /^the frontmatter is not valid YAML \(\w+ at line \d+\)$/,
    },
    {
      case: "a vendor model",
      text: file("name: griller\ndescription: Interviews.\nmodel: sonnet"),
      reason: /model "sonnet" is a vendor model, not a Model level/,
    },
    {
      case: "a cyclic model alias, without a crash",
      text: file("name: griller\ndescription: Interviews.\nmodel: &a [*a]"),
      reason: /^the frontmatter does not decode at model$/,
    },
    {
      case: "a description built from aliases, without its value in the reason",
      text: file("name: griller\nshared: &a [one, two, three]\ndescription: [*a, *a, *a]"),
      reason: /^the frontmatter does not decode at description$/,
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
