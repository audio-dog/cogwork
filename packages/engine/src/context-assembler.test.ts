import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { type AssembleRequest, make, repoDirsFrom } from "./context-assembler";
import type { ContextFsService } from "./context-fs";

interface CopyCall {
  readonly source: string;
  readonly dest: string;
}

const config = { homeDir: "/home/.clanker-forge", skillsDir: "/engine/skills" };

const request: AssembleRequest = {
  cwd: "/repos/app/packages/web",
  projectRoot: "/repos/app",
  skill: "implement-agent",
};

const stubFs = (
  files: Record<string, string>,
  copies: Ref.Ref<ReadonlyArray<CopyCall>>,
): ContextFsService => ({
  readFile: (target) => Effect.succeed(files[target] ?? null),
  copyDirectory: (source, dest) => Ref.update(copies, (xs) => [...xs, { source, dest }]),
});

describe("repoDirsFrom", () => {
  it("walks project-root-first down to the worktree cwd", () => {
    assert.deepStrictEqual(
      [...repoDirsFrom("/repos/app/packages/web", "/repos/app")],
      ["/repos/app", "/repos/app/packages", "/repos/app/packages/web"],
    );
  });

  it("returns a single directory when cwd is the project root", () => {
    assert.deepStrictEqual([...repoDirsFrom("/repos/app", "/repos/app")], ["/repos/app"]);
  });

  it("ignores trailing slashes on both ends", () => {
    assert.deepStrictEqual(
      [...repoDirsFrom("/repos/app/packages/", "/repos/app/")],
      ["/repos/app", "/repos/app/packages"],
    );
  });

  it("falls back to the cwd alone when it sits outside the project root", () => {
    assert.deepStrictEqual([...repoDirsFrom("/somewhere/else", "/repos/app")], ["/somewhere/else"]);
  });
});

describe("ContextAssembler.assemble", () => {
  it.effect("yields global, repo, and playbook layers in precedence order", () =>
    Effect.gen(function* () {
      const copies = yield* Ref.make<ReadonlyArray<CopyCall>>([]);
      const assembler = make(
        config,
        stubFs(
          {
            "/home/.clanker-forge/AGENTS.md": "global rules",
            "/repos/app/AGENTS.md": "repo root rules",
            "/repos/app/packages/web/AGENTS.md": "web package rules",
            "/engine/skills/implement-agent/SKILL.md": "implement skill body",
          },
          copies,
        ),
      );

      const assembled = yield* assembler.assemble(request);

      assert.deepStrictEqual(
        [...assembled.layers],
        [
          { kind: "global", source: "/home/.clanker-forge/AGENTS.md", content: "global rules" },
          { kind: "repo", source: "/repos/app/AGENTS.md", content: "repo root rules" },
          { kind: "repo", source: "/repos/app/packages/web/AGENTS.md", content: "web package rules" },
          {
            kind: "playbook",
            source: "/engine/skills/implement-agent/SKILL.md",
            content: "implement skill body",
          },
        ],
      );
    }),
  );

  it.effect("skips a missing global file and repo levels with no AGENTS.md", () =>
    Effect.gen(function* () {
      const copies = yield* Ref.make<ReadonlyArray<CopyCall>>([]);
      const assembler = make(
        config,
        stubFs(
          {
            "/repos/app/packages/web/AGENTS.md": "web package rules",
            "/engine/skills/implement-agent/SKILL.md": "implement skill body",
          },
          copies,
        ),
      );

      const assembled = yield* assembler.assemble(request);

      assert.deepStrictEqual(
        assembled.layers.map((layer) => layer.kind),
        ["repo", "playbook"],
      );
    }),
  );

  it.effect("treats a whitespace-only AGENTS.md as absent", () =>
    Effect.gen(function* () {
      const copies = yield* Ref.make<ReadonlyArray<CopyCall>>([]);
      const assembler = make(
        config,
        stubFs(
          {
            "/repos/app/AGENTS.md": "   \n\t  ",
            "/engine/skills/implement-agent/SKILL.md": "implement skill body",
          },
          copies,
        ),
      );

      const assembled = yield* assembler.assemble({ ...request, cwd: "/repos/app" });

      assert.deepStrictEqual(
        assembled.layers.map((layer) => layer.kind),
        ["playbook"],
      );
    }),
  );

  it.effect("provisions the skill directory host-side and keeps the worktree clean", () =>
    Effect.gen(function* () {
      const copies = yield* Ref.make<ReadonlyArray<CopyCall>>([]);
      const assembler = make(
        config,
        stubFs({ "/engine/skills/implement-agent/SKILL.md": "implement skill body" }, copies),
      );

      const assembled = yield* assembler.assemble(request);

      assert.strictEqual(assembled.skillPath, "/home/.clanker-forge/skills/implement-agent");
      assert.deepStrictEqual(yield* Ref.get(copies), [
        { source: "/engine/skills/implement-agent", dest: "/home/.clanker-forge/skills/implement-agent" },
      ]);
      assert.isTrue(assembled.skillPath.startsWith(config.homeDir));
      assert.isFalse(assembled.skillPath.startsWith(request.projectRoot));
      assert.isFalse(assembled.skillPath.startsWith(request.cwd));
    }),
  );

  it.effect("fails when the playbook skill has no readable SKILL.md", () =>
    Effect.gen(function* () {
      const copies = yield* Ref.make<ReadonlyArray<CopyCall>>([]);
      const assembler = make(config, stubFs({ "/repos/app/AGENTS.md": "repo root rules" }, copies));

      const error = yield* Effect.flip(assembler.assemble(request));

      assert.strictEqual(error._tag, "ContextAssemblerError");
      assert.include(error.message, "implement-agent");
    }),
  );

  it.effect("does not provision when the playbook skill is missing", () =>
    Effect.gen(function* () {
      const copies = yield* Ref.make<ReadonlyArray<CopyCall>>([]);
      const assembler = make(config, stubFs({}, copies));

      yield* Effect.flip(assembler.assemble(request));

      assert.deepStrictEqual(yield* Ref.get(copies), []);
    }),
  );

  it.effect("rejects a skill name that would escape the skills base, without touching the filesystem", () =>
    Effect.gen(function* () {
      const copies = yield* Ref.make<ReadonlyArray<CopyCall>>([]);
      const files = { "/engine/skills/../../etc/SKILL.md": "somebody else's file" };
      const assembler = make(config, stubFs(files, copies));

      const error = yield* Effect.flip(assembler.assemble({ ...request, skill: "../../etc" }));

      assert.strictEqual(error._tag, "ContextAssemblerError");
      assert.include(error.message, "single path segment");
      assert.deepStrictEqual(yield* Ref.get(copies), []);
    }),
  );

  it.effect("rejects a skill name containing a path separator", () =>
    Effect.gen(function* () {
      const copies = yield* Ref.make<ReadonlyArray<CopyCall>>([]);
      const assembler = make(config, stubFs({}, copies));

      const error = yield* Effect.flip(assembler.assemble({ ...request, skill: "nested/skill" }));

      assert.strictEqual(error._tag, "ContextAssemblerError");
      assert.deepStrictEqual(yield* Ref.get(copies), []);
    }),
  );
});
