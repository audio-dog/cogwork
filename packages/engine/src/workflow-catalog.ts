import type { WorkflowCatalogEntry, WorkflowTemplate } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { issueTrackerWorkflowCatalogContribution } from "./issue-workflow-catalog";
import { SourceControlProvider } from "./source-control";
import { type TriggerSource, TriggerSources } from "./trigger-source";
import { registeredActionRowsFor } from "./workflow-action-registry";
import { issueTrackerApps } from "./workflow-actions-issue";
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
  entries: registeredActionRowsFor(null),
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
      ...issueTrackerApps.map(issueTrackerWorkflowCatalogContribution),
      sourceControl.workflowCatalogContribution,
      ...sources.map(sourceContribution),
      { entries: registeredActionRowsFor("slack"), templates: [] },
    ];
  }),
);
