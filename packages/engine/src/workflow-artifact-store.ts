import {
  ControlStoreFailure,
  type LineageId,
  WorkflowActionArtifact,
  type WorkflowActionOrigin,
  type WorkItemId,
  type WorkspaceId,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ControlStore } from "./control-store";

export interface WorkflowArtifactStoreService {
  readonly record: (artifact: WorkflowActionArtifact) => Effect.Effect<void, ControlStoreFailure>;
  readonly all?: Effect.Effect<ReadonlyArray<WorkflowActionArtifact>, ControlStoreFailure>;
  readonly byLineage: (
    root: LineageId,
  ) => Effect.Effect<ReadonlyArray<WorkflowActionArtifact>, ControlStoreFailure>;
  readonly origin: (
    workspace: WorkspaceId,
    issue: WorkItemId,
  ) => Effect.Effect<WorkflowActionOrigin | null, ControlStoreFailure>;
}

export class WorkflowArtifactStore extends Context.Service<
  WorkflowArtifactStore,
  WorkflowArtifactStoreService
>()("@cogwork/engine/workflow-artifact-store/WorkflowArtifactStore") {}

const artifactKey = (artifact: WorkflowActionArtifact) => artifact.origin.writeKey;
const snapshot = (artifact: WorkflowActionArtifact) =>
  Schema.encodeEffect(WorkflowActionArtifact)(artifact).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(WorkflowActionArtifact)),
    Effect.mapError((error) =>
      ControlStoreFailure.make({
        operation: "snapshot Workflow artifact",
        message: String(error),
        retryable: false,
      }),
    ),
  );

export const makeMemory = Effect.gen(function* () {
  const artifacts = yield* Ref.make<ReadonlyMap<string, WorkflowActionArtifact>>(new Map());
  return {
    record: (artifact) =>
      snapshot(artifact).pipe(
        Effect.flatMap((stored) =>
          Ref.update(artifacts, (current) => new Map(current).set(artifactKey(stored), stored)),
        ),
      ),
    all: Ref.get(artifacts).pipe(Effect.map((current) => [...current.values()])),
    byLineage: (root) =>
      Ref.get(artifacts).pipe(
        Effect.map((current) => [...current.values()].filter(({ origin }) => origin.lineage.root === root)),
      ),
    origin: (workspace, issue) =>
      Ref.get(artifacts).pipe(
        Effect.map(
          (current) =>
            [...current.values()].find(
              (artifact) => artifact.workspace === workspace && artifact.issue === issue,
            )?.origin ?? null,
        ),
      ),
  } satisfies WorkflowArtifactStoreService;
});

export const memoryLayer = Layer.effect(WorkflowArtifactStore, makeMemory);

const StoredArtifact = Schema.Struct({ artifact: Schema.String });
type StoredArtifact = typeof StoredArtifact.Type;
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(StoredArtifact));
const ArtifactJson = Schema.fromJsonString(WorkflowActionArtifact);
const decodeArtifact = Schema.decodeUnknownEffect(ArtifactJson);
const encodeArtifact = Schema.encodeEffect(ArtifactJson);
const failure = (operation: string) => (error: unknown) =>
  ControlStoreFailure.make({
    operation,
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  });

export const makeControlStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ControlStore;
  const read = <E, R>(query: Effect.Effect<ReadonlyArray<StoredArtifact>, E, R>) =>
    query.pipe(
      Effect.flatMap(decodeRows),
      Effect.flatMap((rows) => Effect.forEach(rows, ({ artifact }) => decodeArtifact(artifact))),
    );
  return {
    record: (artifact) =>
      snapshot(artifact).pipe(
        Effect.flatMap((stored) => encodeArtifact(stored)),
        Effect.flatMap((encoded) =>
          store.withWrite(sql`
            INSERT INTO workflow_action_artifacts (root, write_key, workspace, issue, artifact)
            VALUES (
              ${artifact.origin.lineage.root}, ${artifact.origin.writeKey},
              ${artifact.workspace}, ${artifact.issue}, ${encoded}
            )
            ON CONFLICT (write_key) DO UPDATE SET artifact = excluded.artifact
          `),
        ),
        Effect.asVoid,
        Effect.mapError(failure("record Workflow artifact")),
      ),
    all: read(sql<StoredArtifact>`SELECT artifact FROM workflow_action_artifacts ORDER BY write_key`).pipe(
      Effect.mapError(failure("read Workflow artifacts")),
    ),
    byLineage: (root) =>
      read(sql<StoredArtifact>`
        SELECT artifact FROM workflow_action_artifacts WHERE root = ${root} ORDER BY write_key
      `).pipe(Effect.mapError(failure("read Workflow artifacts"))),
    origin: (workspace, issue) =>
      read(sql<StoredArtifact>`
        SELECT artifact FROM workflow_action_artifacts
        WHERE workspace = ${workspace} AND issue = ${issue}
        LIMIT 1
      `).pipe(
        Effect.map((artifacts) => artifacts.at(0)?.origin ?? null),
        Effect.mapError(failure("read Workflow artifact origin")),
      ),
  } satisfies WorkflowArtifactStoreService;
});

export const controlStoreLayer = Layer.effect(WorkflowArtifactStore, makeControlStore);
