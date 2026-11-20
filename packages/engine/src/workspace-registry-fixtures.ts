import { WorkspaceRegistration } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { Git, type GitService } from "./git";
import { layerAt, readOnlyLayerAt } from "./registry";

export const registration = Schema.decodeSync(WorkspaceRegistration);

export const githubRegistration = (name: string, checkoutPath: string) =>
  registration({
    displayName: name,
    checkoutPath,
    issueTracker: { type: "github" },
    linearHistory: false,
  });

const gitService = (remoteUrl: GitService["remoteUrl"]) =>
  ({
    fetch: () => Effect.die("unused"),
    remoteBranchExists: () => Effect.die("unused"),
    addWorktree: () => Effect.die("unused"),
    removeWorktree: () => Effect.die("unused"),
    listWorktrees: () => Effect.die("unused"),
    fastForward: () => Effect.die("unused"),
    divergence: () => Effect.die("unused"),
    operationInProgress: () => Effect.die("unused"),
    recordedOperation: () => Effect.die("unused"),
    recordOperation: () => Effect.die("unused"),
    rebase: () => Effect.die("unused"),
    remoteUrl,
    blockPush: () => Effect.die("unused"),
    allowPush: () => Effect.die("unused"),
    pushBranch: () => Effect.die("unused"),
  }) satisfies GitService;

export const gitLayerFor = (remoteUrl: GitService["remoteUrl"]) => Layer.succeed(Git, gitService(remoteUrl));

export const testGitLayer = gitLayerFor(() => Effect.succeed("git@github.com:acme/repo.git"));

export class RemoteUrls extends Context.Service<RemoteUrls, Ref.Ref<Map<string, string>>>()(
  "@cogwork/engine/workspace-registry-fixtures/RemoteUrls",
) {
  static readonly layer = Layer.effect(RemoteUrls, Ref.make(new Map<string, string>()));
}

export const remoteUrlsGitLayer = Layer.effect(
  Git,
  Effect.gen(function* () {
    const remotes = yield* RemoteUrls;
    return gitService((checkoutPath, remote) =>
      Ref.get(remotes).pipe(
        Effect.flatMap((values) => {
          const remoteUrl = values.get(`${checkoutPath}:${remote}`);
          return remoteUrl
            ? Effect.succeed(remoteUrl)
            : Effect.die(`unexpected remote ${remote} at ${checkoutPath}`);
        }),
      ),
    );
  }),
);

export const registryLayerAt = (storePath: string, userAgentsDir?: string) =>
  layerAt(storePath, userAgentsDir).pipe(Layer.provide(testGitLayer));

export const readOnlyRegistryLayerAt = (storePath: string) =>
  readOnlyLayerAt(storePath).pipe(Layer.provide(testGitLayer));

export const makeCheckout = Effect.fn("test.makeCheckout")(function* (root: string, name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const checkoutPath = path.join(root, name);
  yield* fs.makeDirectory(path.join(checkoutPath, ".agents"), { recursive: true });
  return checkoutPath;
});

export const makeProbedCheckout = Effect.fn("test.makeProbedCheckout")(function* (
  root: string,
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const checkoutPath = yield* makeCheckout(root, name);
  const rulesPath = path.join(checkoutPath, ".agents", "rules");
  yield* fs.makeDirectory(rulesPath, { recursive: true });
  yield* fs.writeFileString(
    path.join(rulesPath, "project.md"),
    '---\ndescription: project\nglobs: "**/*"\nalwaysApply: true\n---\nProject rules',
  );
  return checkoutPath;
});
