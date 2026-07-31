import type {
  HarnessName,
  LifecycleStage,
  PlaybookStageConfig,
  TriageRole,
  WorkspaceConfig,
} from "@clanker-forge/contracts";

export interface ResolvedStage {
  readonly enabled: boolean;
  readonly harness: HarnessName;
  readonly model: string | null;
  readonly skill: string;
  readonly promptTemplate: string;
}

const defaultTriagePrompt = [
  'You are running the triage playbook for work item {id} ("{title}") in this repository checkout.',
  "Follow the `{skill}` skill to triage {id}: read the issue and its comments, explore the codebase,",
  "verify the claim where you can, and decide the correct next state.",
].join("\n");

const defaultImplementPrompt = [
  'You are running the implement playbook for work item {id} ("{title}") in this repository checkout.',
  "You are on a fresh branch dedicated to {id}, with no human in the session.",
  "Follow the `{skill}` skill to implement {id}: read the issue and its comments as the brief, make the change,",
  "pass the local gate, commit, and open a pull request that references {id}.",
].join("\n");

const resolveStageConfig = (
  config: WorkspaceConfig,
  stage: PlaybookStageConfig | undefined,
  defaults: { readonly skill: string; readonly promptTemplate: string },
): ResolvedStage => ({
  enabled: stage?.enabled ?? false,
  harness: stage?.harness ?? config.harness.preferred,
  model: stage?.model ?? null,
  skill: stage?.skill ?? defaults.skill,
  promptTemplate: stage?.prompt ?? defaults.promptTemplate,
});

export const resolveTriage = (config: WorkspaceConfig) =>
  resolveStageConfig(config, config.playbook?.triage, {
    skill: "triage-agent",
    promptTemplate: defaultTriagePrompt,
  });

export const resolveImplement = (config: WorkspaceConfig) =>
  resolveStageConfig(config, config.playbook?.implement, {
    skill: "implement-agent",
    promptTemplate: defaultImplementPrompt,
  });

const stageResolvers: Partial<Record<LifecycleStage, (config: WorkspaceConfig) => ResolvedStage>> = {
  triage: resolveTriage,
  implement: resolveImplement,
};

export const resolveStage = (config: WorkspaceConfig, stage: LifecycleStage) =>
  stageResolvers[stage]?.(config) ?? null;

export const runnable = (config: WorkspaceConfig, stage: LifecycleStage) =>
  resolveStage(config, stage)?.enabled ?? false;

const decisionRoles: ReadonlyArray<TriageRole> = [
  "ready-for-agent",
  "ready-for-human",
  "needs-info",
  "wontfix",
];

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);

interface PromptItem {
  readonly id: string;
  readonly title: string;
}

const buildPrompt = (resolved: ResolvedStage, item: PromptItem, footer: string) => {
  const values = { id: item.id, title: item.title, skill: resolved.skill };
  return `${fill(resolved.promptTemplate, values)}\n${fill(footer, values)}`;
};

const parseLastSentinel = <A extends string>(pattern: RegExp, valid: ReadonlyArray<A>, text: string) => {
  const last = [...text.matchAll(pattern)].at(-1)?.[1]?.toLowerCase();
  return valid.find((value) => value === last) ?? null;
};

const decisionFooter = [
  "",
  "When you are done, write your proposal for the maintainer as your final message.",
  "It will be posted verbatim as a comment on {id}, so write it as the comment body.",
  "End your final message with exactly one line, and nothing after it:",
  `TRIAGE-DECISION: <${decisionRoles.join(" | ")}>`,
].join("\n");

const decisionPattern = /TRIAGE-DECISION:\s*([a-z-]+)/gi;

export const buildTriagePrompt = (resolved: ResolvedStage, item: PromptItem) =>
  buildPrompt(resolved, item, decisionFooter);

export const parseTriageDecision = (text: string) => parseLastSentinel(decisionPattern, decisionRoles, text);

export type ImplementResult = "opened-pr" | "blocked";

const implementResults: ReadonlyArray<ImplementResult> = ["opened-pr", "blocked"];

const implementFooter = [
  "",
  "End your final message with exactly one line, and nothing after it:",
  "IMPLEMENT-RESULT: <opened-pr | blocked>",
  "Use `opened-pr` only when you opened a pull request that references {id}; otherwise use `blocked`.",
].join("\n");

const implementResultPattern = /IMPLEMENT-RESULT:\s*([a-z-]+)/gi;

export const buildImplementPrompt = (resolved: ResolvedStage, item: PromptItem) =>
  buildPrompt(resolved, item, implementFooter);

export const parseImplementResult = (text: string) =>
  parseLastSentinel(implementResultPattern, implementResults, text);
