import {
  type Git,
  type Projector,
  Registry,
  RegistryLookup,
  RegistryService,
  Worktree,
} from "@cogwork/engine";
import * as Console from "effect/Console";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { defaultControlStorePath } from "./paths";
import { gitLayer, worktreeManagerLayer } from "./platform";

class WorktreeWorkspaceNotFound extends Data.TaggedError("WorktreeWorkspaceNotFound")<{
  readonly detail: string;
}> {
  override get message() {
    return this.detail;
  }
}

const controlStoreFlag = Flag.String("control-store").pipe(
  Flag.withDescription("Path to the machine-local Control store"),
  Flag.withDefault(defaultControlStorePath),
);

const workspaceFlag = Flag.String("workspace").pipe(
  Flag.withDescription("WorkspaceId of the registered workspace"),
);

const itemFlag = Flag.String("item").pipe(Flag.withDescription("Work item id, e.g. #13"));
const titleFlag = Flag.String("title").pipe(Flag.withDescription("Work item title"));
const branchFlag = Flag.String("branch").pipe(Flag.withDescription("Worktree branch name"));

const findWorkspace = Effect.fn("worktree.findWorkspace")(function* (id: string) {
  const registry = yield* (yield* RegistryService.WorkspaceRegistry).state;
  const workspace = RegistryLookup.findWorkspace(registry, id);
  if (!workspace) {
    return yield* new WorktreeWorkspaceNotFound({ detail: `workspace "${id}" not found` });
  }
  return workspace;
});

const runWorktree = <E>(
  options: { readonly controlStore: string; readonly workspace: string },
  use: (
    workspace: Projector.RegisteredWorkspace,
    manager: Worktree.WorktreeManagerService,
  ) => Effect.Effect<unknown, E>,
) =>
  Effect.gen(function* () {
    const workspace = yield* findWorkspace(options.workspace);
    const manager = yield* Worktree.WorktreeManager;
    yield* use(workspace, manager);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        worktreeManagerLayer,
        Registry.readOnlyLayerAt(options.controlStore).pipe(Layer.provide(gitLayer)),
      ),
    ),
    Effect.tapError((error) => Console.error(error instanceof Error ? error.message : String(error))),
  );

const formatWorktrees = (entries: ReadonlyArray<Git.WorktreeEntry>) =>
  entries.length === 0
    ? "  (no worktrees)"
    : entries.map((entry) => `  ${entry.branch ?? "(detached)"}  ${entry.path}`).join("\n");

const runList = (options: { readonly controlStore: string; readonly workspace: string }) =>
  runWorktree(options, (workspace, manager) =>
    manager.list(workspace).pipe(Effect.flatMap((entries) => Console.log(formatWorktrees(entries)))),
  );

const runEnsure = (options: {
  readonly controlStore: string;
  readonly workspace: string;
  readonly item: string;
  readonly title: string;
}) =>
  runWorktree(options, (workspace, manager) =>
    manager.ensure(workspace, { id: options.item, title: options.title }).pipe(
      Effect.flatMap((result) =>
        Console.log(`${result.created ? "created" : "reused"} ${result.branch} at ${result.path}`),
      ),
      Effect.scoped,
    ),
  );

const runRemove = (options: {
  readonly controlStore: string;
  readonly workspace: string;
  readonly branch: string;
}) =>
  runWorktree(options, (workspace, manager) =>
    manager.remove(workspace, options.branch).pipe(Effect.andThen(Console.log(`removed ${options.branch}`))),
  );

const listCommand = Command.make("list", {
  controlStore: controlStoreFlag,
  workspace: workspaceFlag,
}).pipe(Command.withHandler(runList));

const ensureCommand = Command.make("ensure", {
  controlStore: controlStoreFlag,
  workspace: workspaceFlag,
  item: itemFlag,
  title: titleFlag,
}).pipe(Command.withHandler(runEnsure));

const removeCommand = Command.make("remove", {
  controlStore: controlStoreFlag,
  workspace: workspaceFlag,
  branch: branchFlag,
}).pipe(Command.withHandler(runRemove));

export const worktreeCommand = Command.make("worktree").pipe(
  Command.withSubcommands([listCommand, ensureCommand, removeCommand]),
);
