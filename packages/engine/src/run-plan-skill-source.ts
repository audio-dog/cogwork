import type { RunPlanContributionMember } from "@cogwork/contracts";
import { parseSkill, renderCatalog, type SkillMetadata, withSkills } from "@tanstack/ai-skills";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";

// withSkills fails setup above 4000 estimated tokens (4 characters each); the Anthropic rendering is the longest.
const catalogCharacterLimit = 16_000;

const fitCatalog = (described: ReadonlyArray<SkillMetadata>) => {
  const fitted = described.filter(
    (_, index) => renderCatalog(described.slice(0, index + 1), "anthropic").length <= catalogCharacterLimit,
  );
  return { fitted, dropped: described.slice(fitted.length).map(({ name }) => name) };
};

export const runPlanSkillsMiddleware = Effect.fn("RunPlanSkillSource.middleware")(function* (
  skills: ReadonlyArray<RunPlanContributionMember>,
) {
  if (skills.length === 0) return [];
  const fs = yield* FileSystem.FileSystem;
  const runPromise = yield* FiberSet.makeRuntimePromise();
  const admitted = new Map(skills.map((skill) => [skill.name, skill]));
  const describe = (skill: RunPlanContributionMember) =>
    fs.readFileString(skill.source).pipe(
      Effect.flatMap((raw) => Effect.try(() => ({ ...parseSkill(raw).metadata, name: skill.name }))),
      Effect.tapError((error) =>
        Effect.logWarning("Skill is not supplied", { skill: skill.identity, message: error.message }),
      ),
      Effect.option,
    );
  return [
    withSkills({
      list: () =>
        runPromise(
          Effect.forEach(skills, describe).pipe(
            Effect.map((described) => fitCatalog(Arr.getSomes(described))),
            Effect.tap(({ dropped }) =>
              dropped.length === 0
                ? Effect.void
                : Effect.logWarning("Skills left out of the catalog limit", { skills: dropped }),
            ),
            Effect.map(({ fitted }) => fitted),
          ),
        ),
      load: (name) => {
        const skill = admitted.get(name);
        return skill
          ? runPromise(fs.readFileString(skill.source))
          : Promise.reject(new Error(`Skill ${name} is not in the Run Plan`));
      },
    }),
  ];
});
