import { type WorkflowCatalogEntry, WorkflowCatalogKey, type WorkflowTemplate } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { workflowCatalogContribution as githubActions } from "./github/adapter";
import { workflowCatalogContribution as linearActions } from "./linear/adapter";
import { slackActionEntries } from "./slack-write";
import { SourceControlProvider } from "./source-control";
import { type TriggerSource, TriggerSources } from "./trigger-source";
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

const cogworkAction = (key: string, name: string, agentInputs: ReadonlyArray<string>) =>
  ({
    key: Schema.decodeSync(WorkflowCatalogKey)(key),
    name,
    kind: "action",
    system: null,
    connection: null,
    requires: [],
    parameters: [],
    itemKind: null,
    actsOn: ["*"],
    requiresWorkspace: false,
    permissionProfile: "read-only",
    agentInputs,
    emits: [],
  }) satisfies WorkflowCatalogEntry;

export const cogworkWorkflowCatalogContribution: WorkflowCatalogContribution = {
  entries: [
    cogworkAction("cogwork.notify", "Notify me", ["notification"]),
    cogworkAction("cogwork.wait-for-approval", "Wait for my approval", ["approval_request"]),
    cogworkAction("cogwork.withdraw-pending-approval", "Withdraw the pending approval", []),
    cogworkAction("cogwork.hand-to-me", "Hand to me", ["hand_off"]),
    cogworkAction("cogwork.stop", "Stop", []),
  ],
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
