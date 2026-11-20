import { DatabaseSync } from "node:sqlite";

import {
  localOwner,
  MachineReadiness,
  Principal,
  WorkflowCatalogEntry,
  WorkflowDocument,
  WorkspaceId,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { clockEntries, clockSource } from "./clock-source";
import { bootControlStoreLayer } from "./control-store";
import * as DaemonEventBus from "./daemon-event-bus";
import { githubSourceControlActionEntries } from "./github/provider";
import { slackReviewTemplate } from "./github/provider-slack-review-template";
import { githubPullRequestEntries } from "./github/pull-request-trigger-source";
import { granolaWorkflowCatalogContribution } from "./granola-source";
import * as Harness from "./harness";
import { issueTrackerWorkflowCatalogContribution } from "./issue-workflow-catalog";
import { slackEntries } from "./slack-source";
import { trackerTriggerEntries, trackerTriggerFilters } from "./tracker-trigger-source";
import { SourceFailure } from "./trigger-source";
import { Workflows, layer as workflowsLayer } from "./workflow";
import { registeredActionRowsFor } from "./workflow-action-registry";
import {
  cogworkWorkflowCatalogContribution,
  type WorkflowCatalogContribution,
  WorkflowCatalogContributions,
} from "./workflow-catalog";
import * as MachineReadinessSource from "./workflow-machine-readiness";

const decodeDocument = Schema.decodeUnknownSync(WorkflowDocument);
const decodeEntry = Schema.decodeUnknownSync(WorkflowCatalogEntry);
export const machine = Schema.decodeSync(MachineReadiness)({
  workspaces: [{ id: "cogwork", binds: ["github"] }],
  connections: [
    { system: "github", ready: true, reason: null },
    { system: "granola", ready: false, reason: "Granola login expired" },
  ],
  harnesses: [],
  defaultHarness: null,
  readyNeeds: [],
});

const triggerContribution: WorkflowCatalogContribution = {
  entries: [
    decodeEntry({
      key: "github.issue-opened",
      name: "Issue opened",
      kind: "trigger",
      system: "github",
      connection: "github/main",
      requires: [],
      parameters: [],
      itemKind: "issue",
      actsOn: [],
      requiresWorkspace: false,
      workspaceSource: null,
      permissionProfile: "read-only",
      agentInputs: [],
      emits: [],
    }),
  ],
  templates: [slackReviewTemplate],
};

const clockContribution: WorkflowCatalogContribution = {
  entries: clockEntries,
  templates: [],
  options: clockSource.options ?? [],
};

const githubReviewContribution: WorkflowCatalogContribution = {
  entries: [...githubSourceControlActionEntries, ...slackEntries, ...registeredActionRowsFor("slack")],
  templates: [],
};

export const unreachableWorkspace = Schema.decodeSync(WorkspaceId)("unreachable");
export const labelWorkspaces = [
  Schema.decodeSync(WorkspaceId)("first"),
  Schema.decodeSync(WorkspaceId)("second"),
] as const;
const githubLabelOptions: WorkflowCatalogContribution = {
  entries: [],
  templates: [],
  options: [
    {
      system: "github",
      readers: {
        label: (workspace) =>
          workspace === unreachableWorkspace
            ? Effect.fail(
                new SourceFailure({
                  source: "github",
                  reason: "unavailable",
                  retryAfterMillis: null,
                  message: "GitHub unavailable",
                }),
              )
            : Effect.succeed(
                ["needs-triage", workspace ?? "none"].map((value) => ({
                  value,
                  name: value,
                  listedIn: workspace === undefined ? [] : [workspace],
                })),
              ),
      },
    },
  ],
};

export const document = decodeDocument({
  name: "Complete",
  workspaces: { _tag: "Every" },
  triggers: [{ id: "start", entry: "github.issue-opened", parameters: [], start: "run" }],
  operations: [
    {
      id: "run",
      name: "Run",
      instructionPackage: null,
      instruction: "Do the work.",
      permissionProfile: "read-only",
      requires: [],
      model: { harness: null, model: null, options: [] },
      forEach: null,
      questions: [],
      transitions: [{ when: [], actions: [{ entry: "cogwork.stop", parameters: [] }], handOff: null }],
      hints: [],
    },
  ],
});

export const incompleteDocument = decodeDocument({ ...document, triggers: [] });

export const temporaryStore = Effect.fn("test.temporaryWorkflowsStore")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workflows-" });
  return path.join(dir, "control.db");
});

const catalogLayer = Layer.succeed(WorkflowCatalogContributions, [
  cogworkWorkflowCatalogContribution,
  issueTrackerWorkflowCatalogContribution("github"),
  issueTrackerWorkflowCatalogContribution("linear"),
  { entries: githubSourceControlActionEntries, templates: [] },
  {
    entries: [
      ...trackerTriggerEntries("github"),
      ...trackerTriggerFilters("github"),
      ...githubPullRequestEntries,
    ],
    templates: [],
  },
  { entries: [...trackerTriggerEntries("linear"), ...trackerTriggerFilters("linear")], templates: [] },
  triggerContribution,
  granolaWorkflowCatalogContribution,
  githubReviewContribution,
  clockContribution,
  githubLabelOptions,
]);

export const testLayer = (
  storePath: string,
  busLayer: Layer.Layer<DaemonEventBus.DaemonEventBus> = DaemonEventBus.layer,
) => {
  const controlStore = bootControlStoreLayer(storePath);
  const readiness = MachineReadinessSource.testLayer(machine);
  const harness = Harness.layer([]);
  const workflows = workflowsLayer.pipe(
    Layer.provide(catalogLayer),
    Layer.provide(readiness),
    Layer.provide(Layer.mergeAll(controlStore, busLayer, harness)),
  );
  return Layer.mergeAll(workflows, busLayer, controlStore, readiness, Layer.succeed(Principal, localOwner));
};

export const withWorkflows = <A, E, R>(
  storePath: string,
  use: (workflows: typeof Workflows.Service) => Effect.Effect<A, E, R>,
) => Effect.flatMap(Workflows, use).pipe(Effect.provide(testLayer(storePath)));

export const corruptStoredRow = (storePath: string, id: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new DatabaseSync(storePath)),
    (database) =>
      Effect.sync(() => database.prepare("UPDATE workflows SET enabled = 2 WHERE id = ?").run(id)),
    (database) => Effect.sync(() => database.close()),
  );
