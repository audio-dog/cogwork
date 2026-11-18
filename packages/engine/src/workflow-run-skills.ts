import { PluginContributionLoad } from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import { PluginManager } from "./plugin";
import type { RegisteredWorkspace } from "./projector";

export const makeAdmittedSkills = Effect.gen(function* () {
  const plugins = yield* PluginManager;

  const admittedSkills = Effect.fn("WorkflowRun.admittedSkills")(function* (
    workspace: RegisteredWorkspace | null,
    required: ReadonlyArray<string>,
  ) {
    if (workspace === null) return [];
    const fromPlugins = yield* plugins.contributions(workspace.config.name).pipe(
      Effect.map((contributions) =>
        contributions.filter(({ load }) => PluginContributionLoad.guards.Loaded(load)),
      ),
      Effect.orElseSucceed(() => []),
    );
    const available = [...workspace.contributions, ...fromPlugins].filter(({ kind }) => kind === "skill");
    const contributions = [
      ...available.filter(({ id }) => required.includes(id)),
      ...available.filter(({ id }) => !required.includes(id)),
    ];
    return contributions
      .filter(
        (skill, index) => contributions.findIndex(({ localName }) => localName === skill.localName) === index,
      )
      .map(({ id, localName, file }) => ({ identity: id, name: localName, source: file }));
  });

  return admittedSkills;
});
