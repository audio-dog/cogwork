import type { WorkflowCatalogEntry, WorkflowTemplate } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { workflowCatalogContribution as githubActions } from "./github/adapter";
import { workflowCatalogContribution as linearActions } from "./linear/adapter";
import { slackActionEntries } from "./slack-write";
import { SourceControlProvider } from "./source-control";
import { type TriggerSource, TriggerSources } from "./trigger-source";
import { registeredActionRows } from "./workflow-action-registry";
import type { SystemOptions } from "./workflow-options";

export interface WorkflowCatalogContribution {
  readonly entries: ReadonlyArray<WorkflowCatalogEntry>;
  readonly templates: ReadonlyArray<WorkflowTemplate>;
  readonly options?: ReadonlyArray<SystemOptions>;
}

export class WorkflowCatalogContributions extends Context.Service<
  WorkflowCatalogContributions,
  ReadonlyArray<WorkflowCatalogContribution>
>()("@cogwork/engine/workflow-catalog/WorkflowCatalogContributions") {}

export const firstPartyInstructionPackages = ["triage-agent", "implement-agent", "follow-up-agent"];

export const cogworkWorkflowCatalogContribution: WorkflowCatalogContribution = {
  entries: registeredActionRows.filter(({ system }) => system === null),
  templates: [],
};

const sourceContribution = (source: TriggerSource): WorkflowCatalogContribution => ({
  entries: [...source.entries, ...(source.filters ?? [])],
  templates: [],
  options: source.options ?? [],
});

export const workflowCatalogContributionsLayer = Layer.effect(
  WorkflowCatalogContributions,
  Effect.gen(function* () {
    const sources = yield* TriggerSources;
    const sourceControl = yield* SourceControlProvider;
    return [
      cogworkWorkflowCatalogContribution,
      githubActions,
      linearActions,
      sourceControl.workflowCatalogContribution,
      ...sources.map(sourceContribution),
      { entries: slackActionEntries, templates: [] },
    ];
  }),
);
