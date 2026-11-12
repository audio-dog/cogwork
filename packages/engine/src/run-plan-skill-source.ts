import type { RunPlanContributionMember } from "@cogwork/contracts";
import { parseSkill, type SkillSource, withSkills } from "@tanstack/ai-skills";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";

export const runPlanSkillSource = (
  skills: ReadonlyArray<RunPlanContributionMember>,
  read: (file: string) => Promise<string>,
): SkillSource => {
  const admitted = new Map(skills.map((skill) => [skill.name, skill]));
  return {
    list: () =>
      Promise.all(
        skills.map(({ name, source }) => read(source).then((raw) => ({ ...parseSkill(raw).metadata, name }))),
      ),
    load: (name) => {
      const skill = admitted.get(name);
      return skill ? read(skill.source) : Promise.reject(new Error(`Skill ${name} is not in the Run Plan`));
    },
  };
};

export const runPlanSkillsMiddleware = Effect.fn("RunPlanSkillSource.middleware")(function* (
  skills: ReadonlyArray<RunPlanContributionMember>,
) {
  if (skills.length === 0) return [];
  const fs = yield* FileSystem.FileSystem;
  const runPromise = yield* FiberSet.makeRuntimePromise();
  return [withSkills(runPlanSkillSource(skills, (file) => runPromise(fs.readFileString(file))))];
});
