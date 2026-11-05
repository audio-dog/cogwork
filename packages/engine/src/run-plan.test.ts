import { type FileContribution, NeedIdentity } from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { subagentMembers } from "./run-plan";

const need = Schema.decodeSync(NeedIdentity);

const subagent = (localName: string, file: string) =>
  ({
    id: `local:user/subagent/${localName}`,
    authority: "local:user",
    kind: "subagent",
    localName,
    file,
  }) satisfies FileContribution;

layer(NodeServices.layer)((it) => {
  it.effect("carries each required Subagent file as a decoded member or with its reason", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-run-plan-subagents-" });
      const griller = path.join(root, "griller.md");
      const pinned = path.join(root, "pinned.md");
      const unused = path.join(root, "unused.md");
      yield* fs.writeFileString(
        griller,
        "---\nname: griller\ndescription: Interviews.\ntools: [Read]\nmetadata:\n  model-level: deep\n---\nGrill.\n",
      );
      yield* fs.writeFileString(
        pinned,
        "---\nname: pinned\ndescription: Pinned.\nmodel: sonnet\n---\nPin.\n",
      );
      yield* fs.writeFileString(unused, "---\nname: unused\ndescription: Unused.\n---\nUnused.\n");

      const members = yield* subagentMembers(
        [subagent("griller", griller), subagent("pinned", pinned), subagent("unused", unused)],
        [need("local:user/subagent/griller"), need("local:user/subagent/pinned")],
      );

      assert.deepStrictEqual(
        members.map((member) => ({ ...member })),
        [
          {
            identity: "local:user/subagent/griller",
            name: "griller",
            source: griller,
            description: "Interviews.",
            tools: ["Read"],
            modelLevel: "deep",
            prompt: "Grill.",
          },
          {
            identity: "local:user/subagent/pinned",
            name: "pinned",
            source: pinned,
            unavailableReason:
              'model "sonnet" is a vendor model, not a Model level; write metadata.model-level (light, standard, or deep)',
          },
        ],
      );
    }),
  );
});
