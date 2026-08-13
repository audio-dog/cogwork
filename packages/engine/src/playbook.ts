import type {
  HarnessName,
  LifecycleStage,
  McpSkill,
  PlaybookStageConfig,
  TriageRole,
  WorkspaceConfig,
} from "@cogwork/contracts";

export interface ResolvedStage {
  readonly enabled: boolean;
  readonly harness: HarnessName;
  readonly model: string | null;
  readonly effort: string | null;
  readonly skill: string;
  readonly promptTemplate: string;
  readonly resumeMaxAgeMillis: number | null;
  readonly resumeMaxTokens: number | null;
  readonly mcpSkills: ReadonlyArray<McpSkill>;
}

const dayMillis = 86_400_000;

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

const defaultFollowUpPrompt = [
  'You are running the follow-up playbook for the pull request that resolves work item {id} ("{title}").',
  "You are in the worktree on that PR's branch, with no human in the session.",
  "Follow the `{skill}` skill to move the PR forward: read the PR's failing checks and any human review",
  "comments, make the fix, pass the local gate, and push to the same branch.",
  "Never merge the PR and never resolve review threads — a human gates the code.",
  "Linear history for this repository is {linearHistory}.",
].join("\n");

interface StageDefaults {
  readonly skill: string;
  readonly promptTemplate: string;
  readonly resumeMaxAgeMillis: number | null;
  readonly resumeMaxTokens: number | null;
}

const resolveStageConfig = (
  config: WorkspaceConfig,
  stage: PlaybookStageConfig | undefined,
  defaults: StageDefaults,
): ResolvedStage => ({
  enabled: stage?.enabled ?? false,
  harness: stage?.harness ?? config.harness.preferred,
  model: stage?.model ?? null,
  effort: stage?.effort ?? null,
  skill: stage?.skill ?? defaults.skill,
  promptTemplate: stage?.prompt ?? defaults.promptTemplate,
  resumeMaxAgeMillis: stage?.resumeMaxAgeMillis ?? defaults.resumeMaxAgeMillis,
  resumeMaxTokens: stage?.resumeMaxTokens ?? defaults.resumeMaxTokens,
  mcpSkills: config.mcpSkills ?? [],
});

export const resolveTriage = (config: WorkspaceConfig) =>
  resolveStageConfig(config, config.playbook?.triage, {
    skill: "triage-agent",
    promptTemplate: defaultTriagePrompt,
    resumeMaxAgeMillis: null,
    resumeMaxTokens: null,
  });

export const resolveImplement = (config: WorkspaceConfig) =>
  resolveStageConfig(config, config.playbook?.implement, {
    skill: "implement-agent",
    promptTemplate: defaultImplementPrompt,
    resumeMaxAgeMillis: null,
    resumeMaxTokens: null,
  });

export const resolveFollowUp = (config: WorkspaceConfig) =>
  resolveStageConfig(config, config.playbook?.["follow-up"], {
    skill: "follow-up-agent",
    promptTemplate: defaultFollowUpPrompt,
    resumeMaxAgeMillis: dayMillis,
    resumeMaxTokens: null,
  });

const stageResolvers: Partial<Record<LifecycleStage, (config: WorkspaceConfig) => ResolvedStage>> = {
  triage: resolveTriage,
  implement: resolveImplement,
  "follow-up": resolveFollowUp,
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
  resolved: ResolvedStage,
  item: PromptItem,
  footer: string,
  extra: Record<string, string> = {},
) => {
  const values = { id: item.id, title: item.title, skill: resolved.skill, ...extra };
  return `${fill(resolved.promptTemplate, values)}\n${communicationStyle}\n${fill(footer, values)}`;
};

const parseLastSentinel = <A extends string>(pattern: RegExp, valid: ReadonlyArray<A>, text: string) => {
  const last = [...text.matchAll(pattern)].at(-1)?.[1]?.toLowerCase();
  return valid.find((value) => value === last) ?? null;
};

const decisionFooter = [
  "",
  "When you are done, write your proposal for the maintainer as your final message.",
  "It will be published verbatim on {id} inside the single comment cogwork keeps there,",
  "so write it as that comment body.",
  "End your final message with exactly one line, and nothing after it:",
  `TRIAGE-DECISION: <${decisionRoles.join(" | ")}>`,
].join("\n");

const decisionPattern = /TRIAGE-DECISION:\s*([a-z-]+)/gi;

export const buildTriagePrompt = (resolved: ResolvedStage, item: PromptItem) =>
  buildPrompt(resolved, item, decisionFooter);

export const parseTriageDecision = (text: string) => parseLastSentinel(decisionPattern, decisionRoles, text);

const dispositionPattern = /Disposition\**\s*:\s*\**\s*([a-z-]+)/gi;

export const parseTriageDisposition = (text: string) =>
  parseLastSentinel(dispositionPattern, decisionRoles, text);

export type TriageDecisionSource = "sentinel" | "disposition" | "default";

export interface TriageDecision {
  readonly role: TriageRole;
  readonly source: TriageDecisionSource;
  readonly sentinel: TriageRole | null;
  readonly disposition: TriageRole | null;
}

const decisionSource = (
  sentinel: TriageRole | null,
  disposition: TriageRole | null,
): TriageDecisionSource => {
  if (sentinel) return "sentinel";
  if (disposition) return "disposition";
  return "default";
};

export const resolveTriageDecision = (text: string): TriageDecision => {
  const sentinel = parseTriageDecision(text);
  const disposition = parseTriageDisposition(text);
  return {
    sentinel,
    disposition,
    source: decisionSource(sentinel, disposition),
    role: sentinel ?? disposition ?? "ready-for-human",
  };
};

export type ImplementResult = "opened-pr" | "stuck";

const implementResults: ReadonlyArray<ImplementResult> = ["opened-pr", "stuck"];

const implementFooter = [
  "",
  "Only one pull request should ever exist for this branch. Before opening one, check whether a pull",
  "request for this branch is already open; if it is, push your work to that one instead of opening another.",
  "End your final message with exactly one line, and nothing after it:",
  "IMPLEMENT-RESULT: <opened-pr | stuck>",
  "Use `opened-pr` when a pull request that references {id} is open for this branch — whether you opened it",
  "or pushed to one that already existed; otherwise use `stuck`.",
].join("\n");

const implementResultPattern = /IMPLEMENT-RESULT:\s*([a-z-]+)/gi;

export const buildImplementPrompt = (resolved: ResolvedStage, item: PromptItem) =>
  buildPrompt(resolved, item, implementFooter);

export const buildContinuationNudge = (worktreePath: string) =>
  [
    "You were interrupted part-way through the task above and this session has just been resumed.",
    `Nothing has changed except that time passed. Inspect ${worktreePath} to see how far you got, then`,
    "continue from exactly where you stopped. Do not start over and do not redo completed work. If a pull",
    "request for this branch already exists, keep using it and never open a second one. If the task is",
    "already complete, say COMPLETE and stop.",
  ].join("\n");

export const parseImplementResult = (text: string) =>
  parseLastSentinel(implementResultPattern, implementResults, text);

export type FollowUpResult = "pushed" | "stuck";

const followUpResults: ReadonlyArray<FollowUpResult> = ["pushed", "stuck"];

const followUpFooter = [
  "",
  "End your final message with exactly one line, and nothing after it:",
  "FOLLOWUP-RESULT: <pushed | stuck>",
  "Use `pushed` only when you pushed a fix to the PR's branch; otherwise use `stuck`.",
].join("\n");

const followUpResultPattern = /FOLLOWUP-RESULT:\s*([a-z-]+)/gi;

export const buildFollowUpPrompt = (resolved: ResolvedStage, item: PromptItem, linearHistory: boolean) =>
  buildPrompt(resolved, item, followUpFooter, {
    linearHistory: linearHistory ? "required" : "not required",
  });

export const parseFollowUpResult = (text: string) =>
  parseLastSentinel(followUpResultPattern, followUpResults, text);
