import { WorkspaceId } from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { scanAuthoringTrees } from "./authoring-tree";

const workspace = Schema.decodeSync(WorkspaceId)("workspace-1");

const writeFile = Effect.fn("test.writeAuthoringFile")(function* (file: string, content = "content") {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, content);
});

layer(NodeServices.layer)((it) => {
  it.effect("scans registered repository and private Authoring trees as distinct identities", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-authoring-tree-" });
      const repoRoot = path.join(root, "repo");
      const cogworkHome = path.join(root, ".cogwork");
      const userAgentsDir = path.join(root, ".agents");
      yield* writeFile(path.join(userAgentsDir, "skills", "commit", "SKILL.md"));
      yield* writeFile(path.join(userAgentsDir, "mcp", "review.json"));
      yield* writeFile(path.join(repoRoot, ".agents", "skills", "release", "SKILL.md"));
      yield* writeFile(path.join(repoRoot, ".agents", "rules", "style.md"));
      yield* writeFile(path.join(repoRoot, ".agents", "agents", "reviewer.md"));
      yield* writeFile(path.join(userAgentsDir, "agents", "griller.md"));
      yield* writeFile(path.join(userAgentsDir, "subagents", "retired.md"));
      yield* writeFile(path.join(cogworkHome, "workspaces", workspace, "agents", "triager.md"));
      yield* writeFile(path.join(repoRoot, ".agents", "mcp", "tools.json"));
      yield* writeFile(path.join(cogworkHome, "workspaces", workspace, "skills", "release", "SKILL.md"));

      const contributions = yield* scanAuthoringTrees({
        workspace,
        repoRoot,
        cogworkHome,
        userAgentsDir,
      });

      assert.deepStrictEqual(
        contributions.map(({ id }) => id),
        [
          "local:private/skill/release",
          "local:private/subagent/triager",
          "local:repo/mcp/tools",
          "local:repo/rules/style",
          "local:repo/skill/release",
          "local:repo/subagent/reviewer",
          "local:user/mcp/review",
          "local:user/skill/commit",
          "local:user/subagent/griller",
        ],
      );
    }),
  );

  it.effect("ignores unsupported and nested files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-authoring-filter-" });
      const repoRoot = path.join(root, "repo");
      const cogworkHome = path.join(root, ".cogwork");
      yield* writeFile(path.join(repoRoot, ".agents", "rules", "notes.txt"));
      yield* writeFile(path.join(repoRoot, ".agents", "rules", ".md"));
      yield* writeFile(path.join(repoRoot, ".agents", "rules", " style.md"));
      yield* writeFile(path.join(repoRoot, ".agents", "rules", "nested", "ignored.md"));
      yield* writeFile(path.join(repoRoot, ".agents", "skills", "README.md"));
      yield* writeFile(path.join(repoRoot, ".agents", "skills", "   ", "SKILL.md"));
      yield* writeFile(path.join(repoRoot, ".agents", "skills", " release ", "SKILL.md"));
      yield* writeFile(path.join(repoRoot, ".agents", "skills", "missing", "README.md"));

      const contributions = yield* scanAuthoringTrees({
        workspace,
        repoRoot,
        cogworkHome,
        userAgentsDir: path.join(root, ".agents"),
      });

      assert.deepStrictEqual(contributions, []);
    }),
  );

  it.effect("does not follow contribution files outside their Authoring tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-authoring-containment-" });
      const repoRoot = path.join(root, "repo");
      const rules = path.join(repoRoot, ".agents", "rules");
      const outside = path.join(root, "outside.md");
      yield* writeFile(outside, "host secret");
      yield* fs.makeDirectory(rules, { recursive: true });
      yield* fs.symlink(outside, path.join(rules, "escaped.md"));

      const contributions = yield* scanAuthoringTrees({
        workspace,
        repoRoot,
        cogworkHome: path.join(root, ".cogwork"),
        userAgentsDir: path.join(root, ".agents"),
      });

      assert.deepStrictEqual(contributions, []);
    }),
  );
});
