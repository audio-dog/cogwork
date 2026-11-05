import {
  type FileContribution,
  type NeedIdentity,
  type RunPlan,
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

const subagentKind = "subagent";

const isSubagentNeed = (need: NeedIdentity) => need.split("/")[1] === subagentKind;

const unavailable = (need: NeedIdentity, reason: string) =>
  RunPlanSubagent.cases.Unavailable.make({
    identity: need,
    name: need.split("/").at(-1) ?? need,
    source: need,
    reason,
  });

export const subagentMembers = Effect.fn("RunPlan.subagentMembers")(function* (
  contributions: ReadonlyArray<FileContribution>,
  requires: ReadonlyArray<NeedIdentity>,
) {
  const fs = yield* FileSystem.FileSystem;

  const unreadable = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError(() => ({ message: "the file could not be read" })));

  const readContained = (file: string) =>
    unreadable(fs.realPath(file)).pipe(
      Effect.flatMap((canonical) =>
        canonical === file
          ? unreadable(fs.readFileString(file))
          : Effect.fail({ message: "the file changed to a link after the scan" }),
      ),
    );

  const memberOf = (need: NeedIdentity) => {
    const contribution = contributions.find(({ kind, id }) => kind === subagentKind && id === need);
    if (contribution === undefined) {
      return Effect.succeed(unavailable(need, "no Subagent file in this Run's Workspace has this identity"));
    }
    const source = { identity: contribution.id, name: contribution.localName, source: contribution.file };
    return readContained(contribution.file).pipe(
      Effect.flatMap((text) => decodeSubagentFile(contribution.localName, text)),
      Effect.match({
        onFailure: ({ message }) => RunPlanSubagent.cases.Unavailable.make({ ...source, reason: message }),
        onSuccess: (definition) => RunPlanSubagent.cases.Available.make({ ...source, ...definition }),
      }),
    );
  };

  return yield* Effect.forEach(requires.filter(isSubagentNeed), memberOf);
});

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

const deepFreeze = <A>(value: A): A => {
  if (!isObject(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
};

export const freezeRunPlan = (plan: RunPlan) => deepFreeze(plan);
