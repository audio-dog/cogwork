import type {
  FollowUpResultOutcome,
  ImplementResultOutcome,
  LifecycleStage,
  McpSkill,
  OperationNeed,
  TriageResultRole,
  WorkspaceConfig,
} from "@cogwork/contracts";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import { day } from "./time";

export type OperationOutcome = Data.TaggedEnum<{
  Triaged: { readonly result: TriageResultRole };
  Implemented: { readonly result: "opened-pr" };
  PullRequestReady: { readonly result: "ready-for-pr" };
  FollowedUp: { readonly result: Exclude<FollowUpResultOutcome, "stuck"> };
  Failed: { readonly result: "stuck"; readonly retryable: boolean };
}>;
export const OperationOutcome = Data.taggedEnum<OperationOutcome>();

type SuccessfulOperationOutcomeTag = Exclude<OperationOutcome["_tag"], "Failed">;
type OperationOutcomeFor<Tag extends SuccessfulOperationOutcomeTag> = Extract<
  OperationOutcome,
  { readonly _tag: Tag | "Failed" }
>;

type StageOutcomeTable<Outcome extends string, SuccessTag extends SuccessfulOperationOutcomeTag> = {
  readonly outcomes: ReadonlyArray<OperationOutcomeFor<SuccessTag> & { readonly result: Outcome }>;
};

export interface OperationOutcomeTables {
  readonly triage: StageOutcomeTable<TriageResultRole, "Triaged">;
  readonly implement: StageOutcomeTable<ImplementResultOutcome, "Implemented" | "PullRequestReady">;
  readonly "follow-up": StageOutcomeTable<FollowUpResultOutcome, "FollowedUp">;
}

export type OperationOutcomeTable = OperationOutcomeTables[LifecycleStage];

export interface OperationDefinition<Stage extends LifecycleStage = LifecycleStage> {
  readonly skill: string;
  readonly promptTemplate: string;
  readonly resumeMaxAgeMillis: number | null;
  readonly resumeMaxTokens: number | null;
  readonly mcpSkills: ReadonlyArray<McpSkill>;
  readonly needs: ReadonlyArray<OperationNeed>;
  readonly outcomeTable: OperationOutcomeTables[Stage];
}

const defaultTriagePrompt = [
  'You are running the triage playbook for work item {id} ("{title}") in this repository checkout.',
  "Follow the `{skill}` skill to triage {id}: read the issue and its comments, explore the codebase,",
  "verify the claim where you can, and decide the correct next state.",
  "Read the checkout, never write to it: leave every file exactly as you found it.",
].join("\n");

const defaultImplementPrompt = [
  'You are running the implement playbook for work item {id} ("{title}") in this repository checkout.',
  "You are on a fresh branch dedicated to {id}, with no human in the session.",
  "Follow the `{skill}` skill to implement {id}: read the issue and its comments as the brief, make the change,",
  "pass the local gate, commit, and prepare the pull request title and body for the engine.",
].join("\n");

const defaultFollowUpPrompt = [
  'You are running the follow-up playbook for the pull request that resolves work item {id} ("{title}").',
  "You are in the worktree on that PR's branch, with no human in the session.",
  "Follow the `{skill}` skill to move the PR forward: read the PR's failing checks and any human review",
  "comments, make the fix, pass the local gate, and push to the same branch.",
  "Never merge the PR and never resolve review threads — a human gates the code.",
  "Linear history for this repository is {linearHistory}.",
].join("\n");

interface StageDefaults<Stage extends LifecycleStage> {
  readonly skill: string;
  readonly promptTemplate: string;
  readonly resumeMaxAgeMillis: number | null;
  readonly resumeMaxTokens: number | null;
  readonly needs: ReadonlyArray<OperationNeed>;
  readonly outcomeTable: OperationOutcomeTables[Stage];
}

const nonRetryableFailure = OperationOutcome.Failed({
  result: "stuck",
  retryable: false,
});

const triageOutcomes = [
  OperationOutcome.Triaged({ result: "ready-for-agent" }),
  OperationOutcome.Triaged({ result: "needs-info" }),
  OperationOutcome.Triaged({ result: "ready-for-human" }),
  OperationOutcome.Triaged({ result: "wontfix" }),
] satisfies OperationOutcomeTables["triage"]["outcomes"];

const implementOutcomes = [
  OperationOutcome.Implemented({ result: "opened-pr" }),
  OperationOutcome.PullRequestReady({ result: "ready-for-pr" }),
  nonRetryableFailure,
] satisfies OperationOutcomeTables["implement"]["outcomes"];

const followUpOutcomes = [
  OperationOutcome.FollowedUp({ result: "pushed" }),
  OperationOutcome.FollowedUp({ result: "noop" }),
  nonRetryableFailure,
] satisfies OperationOutcomeTables["follow-up"]["outcomes"];

export const operationOutcomeTables = {
  triage: { outcomes: triageOutcomes },
  implement: { outcomes: implementOutcomes },
  "follow-up": { outcomes: followUpOutcomes },
} satisfies OperationOutcomeTables;

const resolveStageConfig = <Stage extends LifecycleStage>(
  config: WorkspaceConfig,
  defaults: StageDefaults<Stage>,
) => ({
  ...defaults,
  mcpSkills: config.mcpSkills ?? [],
});

export const resolveTriage = (config: WorkspaceConfig) =>
  resolveStageConfig<"triage">(config, {
    skill: "triage-agent",
    promptTemplate: defaultTriagePrompt,
    resumeMaxAgeMillis: null,
    resumeMaxTokens: null,
    needs: [],
    outcomeTable: operationOutcomeTables.triage,
  });

export const resolveImplement = (config: WorkspaceConfig) =>
  resolveStageConfig<"implement">(config, {
    skill: "implement-agent",
    promptTemplate: defaultImplementPrompt,
    resumeMaxAgeMillis: null,
    resumeMaxTokens: null,
    needs: [],
    outcomeTable: operationOutcomeTables.implement,
  });

export const resolveFollowUp = (config: WorkspaceConfig) =>
  resolveStageConfig<"follow-up">(config, {
    skill: "follow-up-agent",
    promptTemplate: defaultFollowUpPrompt,
    resumeMaxAgeMillis: Duration.toMillis(day),
    resumeMaxTokens: null,
    needs: [],
    outcomeTable: operationOutcomeTables["follow-up"],
  });

const stageResolvers: {
  readonly [Stage in LifecycleStage]: (config: WorkspaceConfig) => OperationDefinition<Stage>;
} = {
  triage: resolveTriage,
  implement: resolveImplement,
  "follow-up": resolveFollowUp,
};

export const resolveStage = <Stage extends LifecycleStage>(config: WorkspaceConfig, stage: Stage) =>
  stageResolvers[stage](config);

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);

interface PromptItem {
  readonly id: string;
  readonly title: string;
}

const communicationStyle = [
  "",
  "When you write for a person to read — your triage proposal, the pull request title and description,",
  "review or follow-up comments — explain it like you're talking to a sharp colleague who's tired, not",
  "like you're writing documentation.",
  "",
  "- Prefer plain words over jargon. If a term of art is genuinely the right word, use it, but don't stack three of them in one sentence.",
  "- Shorter sentences, one idea each. Longer is fine when it makes the point easier to read — dense is worse than long.",
  "- Warm and conversational beats precise and mechanical. It's okay to sound like a person.",
  "- When a concept is genuinely abstract, an occasional analogy earns its place. Use them sparingly — one or two at most, or none land.",
  "- Say the main thing, then the one caveat that actually matters. Don't pack a paragraph with five qualifications.",
  "- For a long or hard write-up, add a short **Bottom line:** near the end that stands on its own. Most don't need one.",
].join("\n");

const buildPrompt = (
  resolved: OperationDefinition,
  item: PromptItem,
  footer: string | null,
  extra: Record<string, string> = {},
) => {
  const values = { id: item.id, title: item.title, skill: resolved.skill, ...extra };
  return [
    fill(resolved.promptTemplate, values),
    communicationStyle,
    ...(footer === null ? [] : [fill(footer, values)]),
  ].join("\n");
};

export const buildTriagePrompt = (resolved: OperationDefinition, item: PromptItem) =>
  buildPrompt(resolved, item, null);

const implementFooter = [
  "",
  "Push the prepared branch. The engine opens the pull request after it verifies that branch. Do not open one yourself.",
  "Return a ready-for-pr result with the title and body the engine should use.",
].join("\n");

export const buildImplementPrompt = (resolved: OperationDefinition, item: PromptItem) =>
  buildPrompt(resolved, item, implementFooter);

export const buildContinuationNudge = (worktreePath: string) =>
  [
    "You were interrupted part-way through the task above and this session has just been resumed.",
    `Nothing has changed except that time passed. Inspect ${worktreePath} to see how far you got, then`,
    "treat the prepared Worktree as ground truth, including files already written. Do not trust the ragged tail",
    "of the interrupted native transcript over that state. Then",
    "continue from exactly where you stopped. Do not start over and do not redo completed work. When the task",
    "is complete, push the prepared branch and prepare the pull request title and body for the engine. Then say COMPLETE and stop.",
  ].join("\n");

export const buildFollowUpPrompt = (
  resolved: OperationDefinition,
  item: PromptItem,
  linearHistory: boolean,
) =>
  buildPrompt(resolved, item, null, {
    linearHistory: linearHistory ? "required" : "not required",
  });

export const buildOperationPrompt = (
  resolved: OperationDefinition,
  item: PromptItem & { readonly stage: LifecycleStage },
  linearHistory: WorkspaceConfig["linearHistory"],
) => {
  if (item.stage === "implement") return buildImplementPrompt(resolved, item);
  if (item.stage === "follow-up") return buildFollowUpPrompt(resolved, item, linearHistory);
  return buildTriagePrompt(resolved, item);
};
