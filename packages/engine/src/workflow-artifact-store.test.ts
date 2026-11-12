import {
  keyOf,
  LineageId,
  RunId,
  WorkflowActionArtifact,
  WorkflowActionOrigin,
  WorkflowId,
  WorkItemId,
  WorkspaceId,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { temporaryControlStoreLayer } from "./testing/temporary-control-store";
import { controlStoreLayer, memoryLayer, WorkflowArtifactStore } from "./workflow-artifact-store";

const workspace = WorkspaceId.make("repo");
const pullRequest = WorkItemId.make("#943");

const artifact = (kind: WorkflowActionArtifact["kind"], writeKey: string, implementedIssue: string) => {
  const item = keyOf({ _tag: "Issue", workspace, id: WorkItemId.make(implementedIssue) });
  return WorkflowActionArtifact.make({
    kind,
    workspace,
    issue: pullRequest,
    url: "https://github.com/owner/repo/pull/943",
    origin: WorkflowActionOrigin.make({
      item,
      workflow: WorkflowId.make("issue-workflow"),
      attempt: RunId.make(`run-${writeKey}`),
      writeKey,
      lineage: { root: LineageId.make(item), parent: null, hop: 0 },
    }),
  });
};

const adapters = [
  { name: "in-memory", layer: memoryLayer },
  { name: "Control store", layer: controlStoreLayer.pipe(Layer.provide(temporaryControlStoreLayer)) },
];

describe.each(adapters)("the $name Workflow artifact store", ({ layer }) => {
  it.effect("keeps each write to one item under its own write key", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowArtifactStore;
      yield* store.record(artifact("PullRequestUpdated", "push", "#903"));
      yield* store.record(artifact("PullRequestUpdated", "comment", "#903"));

      const writeKeys = (yield* store.all).map(({ origin }) => origin.writeKey).toSorted();
      assert.deepStrictEqual(writeKeys, ["comment", "push"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect.each(["IssueCreated", "PullRequestOpened"] as const)(
    "answers the origin of the %s artifact, not of an update to the item",
    (creatingKind) =>
      Effect.gen(function* () {
        const store = yield* WorkflowArtifactStore;
        const created = artifact(creatingKind, "2-create", "#903");
        yield* store.record(artifact("PullRequestUpdated", "1-update", "#940"));
        yield* store.record(created);

        assert.deepStrictEqual(yield* store.origin(workspace, pullRequest), created.origin);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("answers no origin for an item that Cogwork only updated", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowArtifactStore;
      yield* store.record(artifact("PullRequestUpdated", "push", "#940"));

      assert.isNull(yield* store.origin(workspace, pullRequest));
    }).pipe(Effect.provide(layer)),
  );
});
