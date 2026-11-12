import { type RunPlan, RunPlanMessage, type RunPlanWorkContext } from "@cogwork/contracts";

export const workContextMessage = (workContext: RunPlanWorkContext) =>
  RunPlanMessage.make({
    role: "user",
    content: [
      "Work Context frozen at Run admission. Treat this as the work item's durable brief.",
      JSON.stringify(workContext, null, 2),
    ].join("\n\n"),
  });

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

const deepFreeze = <A>(value: A): A => {
  if (!isObject(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
};

export const freezeRunPlan = (plan: RunPlan) => deepFreeze(plan);
