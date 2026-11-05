import {
  type FileContribution,
  type NeedIdentity,
  type RunPlan,
  RunPlanContributionMember,
  RunPlanMessage,
  RunPlanSubagent,
  type RunPlanWorkContext,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { decodeSubagentFile } from "./subagent-file";

export const workContextMessage = (workContext: RunPlanWorkContext) =>
  RunPlanMessage.make({
    role: "user",
    content: [
      "Work Context frozen at Run admission. Treat this as the work item's durable brief.",
      JSON.stringify(workContext, null, 2),
    ].join("\n\n"),
  });

export const subagentMembers = Effect.fn("RunPlan.subagentMembers")(function* (
  contributions: ReadonlyArray<FileContribution>,
  requires: ReadonlyArray<NeedIdentity>,
) {
  const fs = yield* FileSystem.FileSystem;
  const required = contributions.filter(
    ({ kind, id }) => kind === "subagent" && requires.some((need) => need === id),
  );
  return yield* Effect.forEach(required, (contribution) => {
    const member = { identity: contribution.id, name: contribution.localName, source: contribution.file };
    return fs.readFileString(contribution.file).pipe(
      Effect.flatMap((text) => decodeSubagentFile(contribution.localName, text)),
      Effect.match({
        onFailure: (error) => RunPlanContributionMember.make({ ...member, unavailableReason: error.message }),
        onSuccess: (definition) => RunPlanSubagent.make({ ...member, ...definition }),
      }),
    );
  });
});

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

const deepFreeze = <A>(value: A): A => {
  if (!isObject(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
};

export const freezeRunPlan = (plan: RunPlan) => deepFreeze(plan);
