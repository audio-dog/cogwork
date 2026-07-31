import type { HarnessName, TriageRole, WorkspaceConfig } from "@clanker-forge/contracts";

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

export const resolveTriage = (config: WorkspaceConfig): ResolvedStage => {
  const stage = config.playbook?.triage;
  return {
    enabled: stage?.enabled ?? false,
    harness: stage?.harness ?? config.harness.preferred,
    model: stage?.model ?? null,
    skill: stage?.skill ?? "triage",
    promptTemplate: stage?.prompt ?? defaultTriagePrompt,
  };
};

const decisionRoles: ReadonlyArray<TriageRole> = [
  "ready-for-agent",
  "ready-for-human",
  "needs-info",
  "wontfix",
];

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);

const decisionFooter = [
  "",
  "When you are done, write your proposal for the maintainer as your final message.",
  "It will be posted verbatim as a comment on {id}, so write it as the comment body.",
  "End your final message with exactly one line, and nothing after it:",
  `TRIAGE-DECISION: <${decisionRoles.join(" | ")}>`,
].join("\n");

export const buildTriagePrompt = (
  resolved: ResolvedStage,
  item: { readonly id: string; readonly title: string },
) => {
  const values = { id: item.id, title: item.title, skill: resolved.skill };
  return `${fill(resolved.promptTemplate, values)}\n${fill(decisionFooter, values)}`;
};

const decisionPattern = /TRIAGE-DECISION:\s*([a-z-]+)/gi;

export const parseTriageDecision = (text: string): TriageRole | null => {
  const matches = [...text.matchAll(decisionPattern)];
  const last = matches.at(-1)?.[1]?.toLowerCase();
  return decisionRoles.find((role) => role === last) ?? null;
};
