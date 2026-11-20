import { type FileContribution, NeedIdentity, RunPlanSubagent } from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { subagentMembers } from "./run-plan";

const need = Schema.decodeSync(NeedIdentity);
const RunPlanSubagents = Schema.Array(RunPlanSubagent);

const subagent = (localName: string, file: string) =>
  ({
    id: `local:user/subagent/${localName}`,
    authority: "local:user",
    kind: "subagent",
    localName,
    file,
  }) satisfies FileContribution;

layer(NodeServices.layer)((it) => {
  it.effect("carries each required Subagent as a decoded member or with the reason it is unavailable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-run-plan-" }));
      const griller = path.join(root, "griller.md");
      const broken = path.join(root, "broken.md");
      const unused = path.join(root, "unused.md");
      yield* fs.writeFileString(
        griller,
        "---\nname: griller\ndescription: Interviews.\ntools: [Read]\nmetadata:\n  model-level: deep\n---\nGrill.\n",
      );
      yield* fs.writeFileString(broken, "---\nname: broken\ndescription: [unclosed\n---\nBroken.\n");
      yield* fs.writeFileString(unused, "---\nname: unused\ndescription: Unused.\n---\nUnused.\n");
      const outside = path.join(root, "outside.md");
      yield* fs.writeFileString(outside, "---\nname: escaped\ndescription: Outside.\n---\nOutside.\n");
      const escaped = path.join(root, "escaped.md");
      yield* fs.symlink(outside, escaped);

      const members = yield* subagentMembers(
        [
          subagent("griller", griller),
          subagent("broken", broken),
          subagent("unused", unused),
          subagent("escaped", escaped),
        ],
        [
          need("local:user/subagent/griller"),
          need("local:user/subagent/broken"),
          need("plugin:gh-review/subagent/reviewer"),
          need("local:user/subagent/escaped"),
          need("local:user/skill/commit"),
        ],
      );

      assert.deepStrictEqual(
        members.map((member) =>
          RunPlanSubagent.guards.Available(member)
            ? { ...member }
            : { _tag: member._tag, identity: member.identity, reason: member.reason },
        ),
        [
          {
            _tag: "Available",
            identity: "local:user/subagent/griller",
            name: "griller",
            source: griller,
            description: "Interviews.",
            tools: ["Read"],
            modelLevel: "deep",
            prompt: "Grill.",
          },
          {
            _tag: "Unavailable",
            identity: "local:user/subagent/broken",
            reason: "the frontmatter is not valid YAML (BAD_INDENT at line 2)",
          },
          {
            _tag: "Unavailable",
            identity: "plugin:gh-review/subagent/reviewer",
            reason: "no Subagent file in this Run's Workspace has this identity",
          },
          {
            _tag: "Unavailable",
            identity: "local:user/subagent/escaped",
            reason: "the file changed to a link after the scan",
          },
        ],
      );
      const encoded = yield* Schema.encodeEffect(RunPlanSubagents)(members);
      assert.deepStrictEqual(yield* Schema.decodeEffect(RunPlanSubagents)(encoded), members);
    }),
  );
});
