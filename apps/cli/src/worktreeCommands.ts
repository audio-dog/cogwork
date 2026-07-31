import { Registry, Worktree } from "@clanker-forge/engine";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import { loadFromDisk } from "./loader";
import { defaultConfigHome } from "./paths";
import { worktreeManagerLayer } from "./platform";

class WorkspaceNotFound extends Schema.TaggedErrorClass<WorkspaceNotFound>()("WorkspaceNotFound", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

const configHomeFlag = Flag.string("config-home").pipe(
  Flag.withDescription("Directory of workspace config files"),
  Flag.withDefault(defaultConfigHome),
);

const workspaceFlag = Flag.string("workspace").pipe(Flag.withDescription("Name of the registered workspace"));

const itemFlag = Flag.string("item").pipe(Flag.withDescription("Work item id, e.g. #13"));
const titleFlag = Flag.string("title").pipe(Flag.withDescription("Work item title"));
const branchFlag = Flag.string("branch").pipe(Flag.withDescription("Worktree branch name"));

const findWorkspace = (configHome: string, name: string) =>
  loadFromDisk(configHome).pipe(
    Effect.map((result) => Registry.buildRegistry(result).workspaces.find((w) => w.config.name === name)),
    Effect.flatMap((workspace) =>
      workspace
        ? Effect.succeed(workspace)
        : new WorkspaceNotFound({ detail: `workspace "${name}" not found in ${configHome}` }),
    ),
  );

const runWorktree = <E>(
  options: { readonly configHome: string; readonly workspace: string },
  use: (
    workspace: Registry.RegisteredWorkspace,
    manager: Worktree.WorktreeManagerService,
  ) => Effect.Effect<unknown, E>,
) =>
  Effect.gen(function* () {
    const workspace = yield* findWorkspace(options.configHome, options.workspace);
    const manager = yield* Worktree.WorktreeManager;
    yield* use(workspace, manager);
  }).pipe(
    Effect.provide(worktreeManagerLayer),
    Effect.tapError((error) => Console.error(error instanceof Error ? error.message : String(error))),
  );

const runList = (options: { readonly configHome: string; readonly workspace: string }) =>
  runWorktree(options, (workspace, manager) =>
    manager
      .list(workspace)
      .pipe(
        Effect.flatMap((entries) =>
          Console.log(
            entries.length === 0
              ? "  (no worktrees)"
              : entries.map((entry) => `  ${entry.branch ?? "(detached)"}  ${entry.path}`).join("\n"),
          ),
        ),
      ),
  );

const runEnsure = (options: {
  readonly configHome: string;
  readonly workspace: string;
  readonly item: string;
  readonly title: string;
}) =>
  runWorktree(options, (workspace, manager) =>
    manager
      .ensure(workspace, { id: options.item, title: options.title })
      .pipe(
        Effect.flatMap((result) =>
          Console.log(`${result.created ? "created" : "reused"} ${result.branch} at ${result.path}`),
        ),
      ),
  );

const runRemove = (options: {
  readonly configHome: string;
  readonly workspace: string;
  readonly branch: string;
}) =>
  runWorktree(options, (workspace, manager) =>
    manager.remove(workspace, options.branch).pipe(Effect.andThen(Console.log(`removed ${options.branch}`))),
  );

const listCommand = Command.make("list", {
  configHome: configHomeFlag,
  workspace: workspaceFlag,
}).pipe(Command.withHandler(runList));

const ensureCommand = Command.make("ensure", {
  configHome: configHomeFlag,
  workspace: workspaceFlag,
  item: itemFlag,
  title: titleFlag,
}).pipe(Command.withHandler(runEnsure));

const removeCommand = Command.make("remove", {
  configHome: configHomeFlag,
  workspace: workspaceFlag,
  branch: branchFlag,
}).pipe(Command.withHandler(runRemove));

export const worktreeCommand = Command.make("worktree").pipe(
  Command.withSubcommands([listCommand, ensureCommand, removeCommand]),
);
