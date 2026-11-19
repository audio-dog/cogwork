import type { WorkspaceId, WorkspaceRegistration, WorkspaceUpdate } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { type ScanAuthoringTreesRequest, scanAuthoringTrees } from "./authoring-tree";
import { bootControlStoreLayer, ControlStore, readOnlyControlStoreClientLayer } from "./control-store";
import { Git } from "./git";
import { emptyRegistry, type RegisteredWorkspaceFailure, type RegistryState } from "./projector";
import {
  managementError,
  registrationError,
  workspaceManagementFailure,
  workspaceNotFound,
} from "./registry-errors";
import {
  loadAvailableState,
  loadRegistrationChange,
  type WorkspaceLoadingServices,
} from "./registry-loading";
import { findWorkspaceIssueTrackerBinding } from "./registry-lookup";
import { WorkspaceManagement, type WorkspaceRegistrationChange } from "./registry-management";
import {
  decodeWorkspaceId,
  insertWorkspace,
  persistRegistrationRepository,
  persistStateRepositories,
  rebindWorkspaceRow,
  selectWorkspaceBinding,
  selectWorkspaceRow,
  updateWorkspaceRow,
} from "./registry-rows";
import { readOnlyRegistry, WorkspaceRegistry, type WorkspaceRegistryService } from "./registry-service";

const withoutWorkspace = (state: RegistryState, id: WorkspaceId | undefined) => {
  if (!id) return state;
  return {
    workspaces: state.workspaces.filter((workspace) => workspace.config.id !== id),
    failures: state.failures.filter((failure) => failure.id !== id),
  };
};

const withPreviousRepository = (state: RegistryState, failure: RegisteredWorkspaceFailure) => {
  if (failure.repository || !failure.id) return failure;
  const repository = findWorkspaceIssueTrackerBinding(state, failure.id)?.repository;
  if (!repository) return failure;
  return { ...failure, repository };
};

const withPreviousRepositories = (previous: RegistryState, next: RegistryState) => ({
  ...next,
  failures: next.failures.map((failure) => withPreviousRepository(previous, failure)),
});

const foldRegistration = (state: RegistryState, change: WorkspaceRegistrationChange) => {
  if (change._tag === "Registered") {
    const current = withoutWorkspace(state, change.workspace.config.id);
    return { ...current, workspaces: [...current.workspaces, change.workspace] };
  }
  const failure = withPreviousRepository(state, change.failure);
  const current = withoutWorkspace(state, failure.id);
  return { ...current, failures: [...current.failures, failure] };
};

export const layer = (controlStorePath: string, userAgentsDir: string) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const random = yield* SecureRandom.SecureRandom;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* Git;
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ControlStore;
      const managementGate = Semaphore.makeUnsafe(1);
      const cogworkHome = path.dirname(controlStorePath);
      const authoringRoots = { cogworkHome, userAgentsDir };
      const privateWorkspaceRoot = path.join(cogworkHome, "workspaces");
      const loadingServices = {
        fileSystem: fs,
        path,
        remoteUrl: git.remoteUrl,
        scanAuthoringTrees: (request: ScanAuthoringTreesRequest) =>
          scanAuthoringTrees(request).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          ),
      } satisfies WorkspaceLoadingServices;
      const ensureWritableStore = Effect.fn("WorkspaceManagement.ensureWritableStore")(function* (
        workspace: WorkspaceId,
        operation: string,
      ) {
        if (store.health !== "unavailable") return;
        return yield* workspaceManagementFailure(workspace, operation, store.message);
      });
      const loadState = Effect.fn("WorkspaceRegistry.loadState")(function* () {
        if (store.health === "unavailable") return emptyRegistry;
        return yield* loadAvailableState(sql, loadingServices, authoringRoots);
      });
      const initial = yield* loadState();
      yield* store.withWrite(persistStateRepositories(sql, initial));
      const cell = yield* Ref.make({ state: initial, revision: 0 });
      const commitChange = Effect.fn("WorkspaceRegistry.commitChange")(
        (change: WorkspaceRegistrationChange) =>
          Ref.modify(cell, (current) => [
            change,
            {
              state: foldRegistration(current.state, change),
              revision: current.revision + 1,
            },
          ]),
      );
      const commitRemoval = (workspace: WorkspaceId) =>
        Ref.modify(cell, (current) => [
          workspace,
          {
            state: withoutWorkspace(current.state, workspace),
            revision: current.revision + 1,
          },
        ]);
      const commitRefresh = Effect.fn("WorkspaceRegistry.commitRefresh")(function* (
        expectedRevision: number,
        state: RegistryState,
      ) {
        const current = yield* Ref.get(cell);
        if (current.revision !== expectedRevision) return current.state;
        const next = withPreviousRepositories(current.state, state);
        yield* persistStateRepositories(sql, next);
        yield* Ref.set(cell, { state: next, revision: current.revision + 1 });
        return next;
      });
      const registry: WorkspaceRegistryService = {
        state: Ref.get(cell).pipe(Effect.map((current) => current.state)),
        refresh: Ref.get(cell).pipe(
          Effect.flatMap(({ revision }) =>
            loadState().pipe(
              Effect.flatMap((state) => store.withWrite(commitRefresh(revision, state))),
              Effect.mapError((error) => registrationError(error)),
            ),
          ),
        ),
      };
      const register = Effect.fn("WorkspaceManagement.register")(function* (
        registration: WorkspaceRegistration,
      ) {
        if (store.health === "unavailable") return yield* registrationError(store.message);
        if (!path.isAbsolute(registration.checkoutPath)) {
          return yield* registrationError("Workspace checkout path must be absolute");
        }
        const normalizedRegistration = {
          ...registration,
          checkoutPath: path.resolve(registration.checkoutPath),
        };
        const row = yield* store.withWrite(
          selectWorkspaceBinding(sql, normalizedRegistration.checkoutPath).pipe(
            Effect.mapError((error) => registrationError(error)),
            Effect.flatMap((existing) => {
              if (existing) {
                return registrationError(`Workspace checkout path is already registered as ${existing.id}`);
              }
              return random.uuidV7().pipe(
                Effect.flatMap(decodeWorkspaceId),
                Effect.mapError((error) => registrationError(error)),
              );
            }),
            Effect.flatMap((id) =>
              insertWorkspace(sql, id, normalizedRegistration).pipe(
                Effect.mapError((error) => registrationError(error)),
              ),
            ),
          ),
        );
        const change = yield* loadRegistrationChange(loadingServices, row, authoringRoots);
        return yield* store.withWrite(
          persistRegistrationRepository(sql, change).pipe(
            Effect.flatMap(commitChange),
            Effect.mapError((error) => registrationError(error)),
          ),
        );
      });
      const rebind = Effect.fn("WorkspaceManagement.rebind")(function* (
        workspace: WorkspaceId,
        checkoutPath: string,
      ) {
        yield* ensureWritableStore(workspace, "re-bind workspace");
        if (!path.isAbsolute(checkoutPath)) {
          return yield* workspaceManagementFailure(
            workspace,
            "re-bind workspace",
            "Workspace checkout path must be absolute",
          );
        }
        const normalizedPath = path.resolve(checkoutPath);
        const row = yield* store
          .withWrite(rebindWorkspaceRow(sql, workspace, normalizedPath))
          .pipe(Effect.mapError(managementError(workspace, "re-bind workspace")));
        const change = yield* loadRegistrationChange(loadingServices, row, authoringRoots);
        return yield* store.withWrite(
          persistRegistrationRepository(sql, change).pipe(
            Effect.flatMap(commitChange),
            Effect.mapError(managementError(workspace, "re-bind workspace")),
          ),
        );
      });
      const update = Effect.fn("WorkspaceManagement.update")(function* (
        workspace: WorkspaceId,
        workspaceUpdate: WorkspaceUpdate,
      ) {
        yield* ensureWritableStore(workspace, "update workspace");
        const row = yield* store
          .withWrite(sql.withTransaction(updateWorkspaceRow(sql, workspace, workspaceUpdate)))
          .pipe(Effect.mapError(managementError(workspace, "update workspace")));
        const change = yield* loadRegistrationChange(loadingServices, row, authoringRoots);
        return yield* store.withWrite(
          persistRegistrationRepository(sql, change).pipe(
            Effect.flatMap(commitChange),
            Effect.mapError(managementError(workspace, "update workspace")),
          ),
        );
      });
      const deregisterStoredWorkspace = Effect.fn("WorkspaceManagement.deregisterStoredWorkspace")(function* (
        workspace: WorkspaceId,
      ) {
        const row = yield* selectWorkspaceRow(sql, workspace);
        if (!row) return yield* workspaceNotFound(workspace);
        yield* sql.withTransaction(
          sql`DELETE FROM contribution_settings
              WHERE scope = 'private-workspace-overlay'
                AND workspace = ${workspace}`.pipe(
            Effect.andThen(sql`DELETE FROM operation_settings
                WHERE scope = 'private-workspace-overlay'
                  AND workspace = ${workspace}`),
            Effect.andThen(sql`DELETE FROM workspaces WHERE id = ${workspace}`),
            Effect.andThen(
              fs.remove(path.join(privateWorkspaceRoot, workspace), {
                recursive: true,
                force: true,
              }),
            ),
          ),
        );
        return yield* commitRemoval(workspace);
      });
      const deregister = Effect.fn("WorkspaceManagement.deregister")(function* (workspace: WorkspaceId) {
        yield* ensureWritableStore(workspace, "deregister workspace");
        return yield* store
          .withWrite(deregisterStoredWorkspace(workspace))
          .pipe(Effect.mapError(managementError(workspace, "deregister workspace")));
      });
      return Context.make(WorkspaceRegistry, registry).pipe(
        Context.add(WorkspaceManagement, {
          register: (registration) => managementGate.withPermits(1)(register(registration)),
          update: (workspace, workspaceUpdate) =>
            managementGate.withPermits(1)(update(workspace, workspaceUpdate)),
          deregister: (workspace) => managementGate.withPermits(1)(deregister(workspace)),
          rebind: (workspace, checkoutPath) => managementGate.withPermits(1)(rebind(workspace, checkoutPath)),
        }),
      );
    }),
  );

export const layerAt = (storePath: string, userAgentsDir = `${storePath}.agents`) => {
  const store = bootControlStoreLayer(storePath);
  return layer(storePath, userAgentsDir).pipe(Layer.provideMerge(store));
};

export const readOnlyLayerAt = (storePath: string) =>
  Layer.effect(
    WorkspaceRegistry,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* Git;
      const sql = yield* SqlClient.SqlClient;
      const loadingServices = {
        fileSystem: fs,
        path,
        remoteUrl: git.remoteUrl,
        scanAuthoringTrees: (request: ScanAuthoringTreesRequest) =>
          scanAuthoringTrees(request).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          ),
      } satisfies WorkspaceLoadingServices;
      return readOnlyRegistry(
        yield* loadAvailableState(sql, loadingServices, { cogworkHome: path.dirname(storePath) }),
      );
    }).pipe(Effect.mapError(registrationError)),
  ).pipe(Layer.provide(readOnlyControlStoreClientLayer(storePath)));
