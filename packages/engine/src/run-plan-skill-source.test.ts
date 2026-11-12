import { RunPlanContributionMember } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { runPlanSkillSource } from "./run-plan-skill-source";

const files = new Map([
  [
    "/repo/.agents/skills/release/SKILL.md",
    "---\nname: release-notes\ndescription: Cut a release.\n---\n# Release\nTag, then publish.",
  ],
]);

const read = (file: string) => {
  const content = files.get(file);
  return content === undefined ? Promise.reject(new Error(`no file ${file}`)) : Promise.resolve(content);
};

const release = RunPlanContributionMember.make({
  identity: "local:repo/skill/release",
  name: "release",
  source: "/repo/.agents/skills/release/SKILL.md",
});

describe("runPlanSkillSource", () => {
  it.effect("lists each admitted Skill under its Run Plan name and loads its body", () =>
    Effect.gen(function* () {
      const source = runPlanSkillSource([release], read);

      const catalog = yield* Effect.promise(() => source.list());
      const body = yield* Effect.promise(() => source.load("release"));

      assert.deepStrictEqual(
        catalog.map(({ name, description }) => ({ name, description })),
        [{ name: "release", description: "Cut a release." }],
      );
      assert.include(body, "Tag, then publish.");
    }),
  );

  it.effect("refuses a Skill name the Run Plan does not admit", () =>
    Effect.gen(function* () {
      const source = runPlanSkillSource([release], read);

      const refusal = yield* Effect.flip(Effect.tryPromise(() => source.load("release-notes")));

      assert.include(String(refusal.cause), "Skill release-notes is not in the Run Plan");
    }),
  );
});
