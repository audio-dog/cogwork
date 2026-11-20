import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { findWorkspace } from "./registry-lookup";
import { WorkspaceManagement } from "./registry-management";
import { WorkspaceRegistry } from "./registry-service";
import { githubRegistration, makeCheckout, registryLayerAt } from "./workspace-registry-fixtures";

layer(Layer.merge(NodeServices.layer, NodeCrypto.layerSecureRandom))((it) => {
  it.effect("admits only registered repository and WorkspaceId-private Authoring trees", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-authoring-" });
      const storePath = path.join(root, "control.db");
      const firstCheckout = yield* makeCheckout(root, "first");
      const secondCheckout = yield* makeCheckout(root, "second");
      const unregisteredCheckout = yield* makeCheckout(root, "unregistered");
      const repoSkill = path.join(firstCheckout, ".agents", "skills", "shared", "SKILL.md");
      yield* fs.makeDirectory(path.dirname(repoSkill), { recursive: true });
      yield* fs.writeFileString(repoSkill, "repo Skill");
      const ignoredSkill = path.join(unregisteredCheckout, ".agents", "skills", "ignored", "SKILL.md");
      yield* fs.makeDirectory(path.dirname(ignoredSkill), { recursive: true });
      yield* fs.writeFileString(ignoredSkill, "unregistered Skill");

      const registryContext = yield* Layer.build(registryLayerAt(storePath));
      const management = Context.get(registryContext, WorkspaceManagement);
      const liveRegistry = Context.get(registryContext, WorkspaceRegistry);
      const firstChange = yield* management.register(githubRegistration("first", firstCheckout));
      const secondChange = yield* management.register(githubRegistration("second", secondCheckout));
      if (firstChange._tag === "Failed" || secondChange._tag === "Failed") {
        return assert.fail("expected valid Workspace inputs to register");
      }
      const privateSkill = path.join(
        root,
        "workspaces",
        firstChange.workspace.config.id,
        "skills",
        "shared",
        "SKILL.md",
      );
      yield* fs.makeDirectory(path.dirname(privateSkill), { recursive: true });
      yield* fs.writeFileString(privateSkill, "private Skill");
      yield* liveRegistry.refresh;

      const state = yield* liveRegistry.state;
      const first = findWorkspace(state, firstChange.workspace.config.id);
      const second = findWorkspace(state, secondChange.workspace.config.id);
      assert.deepStrictEqual(
        first?.contributions?.map((entry) => entry.id),
        ["local:private/skill/shared", "local:repo/skill/shared"],
      );
      assert.deepStrictEqual(second?.contributions, []);
      assert.isFalse(
        state.workspaces.some(
          (workspace) => workspace.contributions?.some((entry) => entry.localName === "ignored") ?? false,
        ),
      );
    }),
  );

  it.effect("publishes user Authoring tree contributions with each registered workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-user-authoring-" });
      const storePath = path.join(root, "control.db");
      const userAgentsDir = path.join(root, ".agents");
      const checkoutPath = yield* makeCheckout(root, "user-tree");
      const userSkill = path.join(userAgentsDir, "skills", "commit", "SKILL.md");
      yield* fs.makeDirectory(path.dirname(userSkill), { recursive: true });
      yield* fs.writeFileString(userSkill, "user Skill");

      const registryContext = yield* Layer.build(registryLayerAt(storePath, userAgentsDir));
      const management = Context.get(registryContext, WorkspaceManagement);
      const change = yield* management.register(githubRegistration("user-tree", checkoutPath));
      if (change._tag === "Failed") return assert.fail("expected registration to succeed");

      assert.deepStrictEqual(
        change.workspace.contributions.map((entry) => entry.id),
        ["local:user/skill/commit"],
      );
    }),
  );
});
