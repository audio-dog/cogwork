import {
  type WorkflowCatalogEntry,
  WorkflowCatalogKey,
  type WorkflowOptionList,
  type WorkflowTemplate,
  type WorkspaceId,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { workflowCatalogContribution as githubActions } from "./github/adapter";
import { workflowCatalogContribution as linearActions } from "./linear/adapter";
import { slackActionEntries } from "./slack-write";
import { type TriggerSource, TriggerSources } from "./trigger-source";

export interface WorkflowCatalogContribution {
  readonly entries: ReadonlyArray<WorkflowCatalogEntry>;
  readonly templates: ReadonlyArray<WorkflowTemplate>;
  readonly listOptions?: (
    entry: WorkflowCatalogKey,
    parameter: string,
    workspaces: ReadonlyArray<WorkspaceId>,
  ) => Effect.Effect<WorkflowOptionList>;
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
  entries: source.entries,
  templates: [],
  listOptions: (entry, parameter, workspaces) => {
    const reads = workspaces.length === 0 ? [undefined] : workspaces;
    return Effect.forEach(reads, (workspace) => source.listOptions(entry, parameter, workspace)).pipe(
      Effect.map((listed) => {
        const byValue = listed.flat().reduce((options, option) => {
          const current = options.get(option.value);
          return options.set(option.value, {
            ...option,
            listedIn: [...new Set([...(current?.listedIn ?? []), ...option.listedIn])],
          });
        }, new Map<string, WorkflowOptionList[number]>());
        return [...byValue.values()];
      }),
      Effect.catchTag("SourceFailure", () => Effect.succeed([])),
    );
  },
});

const slackActionContribution = (sources: ReadonlyArray<TriggerSource>): WorkflowCatalogContribution => ({
  entries: slackActionEntries,
  templates: [],
  listOptions: (entry, parameter) =>
    sources
      .find(({ id }) => id === "slack")
      ?.listOptions(entry, parameter)
      .pipe(Effect.catchTag("SourceFailure", () => Effect.succeed([]))) ?? Effect.succeed([]),
});

export const workflowCatalogContributionsLayer = Layer.effect(
  WorkflowCatalogContributions,
  Effect.map(TriggerSources, (sources) => [
    cogworkWorkflowCatalogContribution,
    githubActions,
    linearActions,
    ...sources.map(sourceContribution),
    slackActionContribution(sources),
  ]),
);
