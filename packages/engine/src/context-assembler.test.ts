import { RunId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { type AssembleRequest, make, repoDirsFrom } from "./context-assembler";
import type { ContextFsService } from "./context-fs";

interface CopyCall {
  readonly source: string;
  readonly dest: string;
}

const config = { homeDir: "/home/.cogwork", userAgentsDir: "/home/.agents", skillsDir: "/engine/skills" };

const request: AssembleRequest = {
  runId: Schema.decodeSync(RunId)("run-context-test"),
  cwd: "/repos/app/packages/web",
  projectRoot: "/repos/app",
  skill: "implement-agent",
  contributions: [],
};

const stubFs = (
  files: Record<string, string>,
  copies: Ref.Ref<ReadonlyArray<CopyCall>>,
): ContextFsService => ({
  readFile: (target) =>
    Ref.get(copies).pipe(
      Effect.map((calls) => {
        const copy = calls.findLast(({ dest }) => target === dest || target.startsWith(`${dest}/`));
        const resolved = copy ? `${copy.source}${target.slice(copy.dest.length)}` : target;
        return files[resolved] ?? null;
      }),
    ),
  readDirectory: (target) =>
    Effect.succeed(
      Object.keys(files)
        .filter((file) => file.startsWith(`${target}/`))
        .map((file) => file.slice(target.length + 1))
        .filter((name) => !name.includes("/")),
    ),
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
  it.effect("yields user Rules, repo, and playbook layers in precedence order", () =>
    Effect.gen(function* () {
      const copies = yield* Ref.make<ReadonlyArray<CopyCall>>([]);
      const assembler = make(
        config,
        stubFs(
          {
            "/home/.agents/rules/global.md": "global rules",
            "/home/.agents/rules/react.md": "react rules",
            "/home/.agents/rules/notes.txt": "not a Rule",
            "/home/.agents/rules/nested/ignored.md": "nested Rule",
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
          { kind: "rules", source: "/home/.agents/rules/global.md", content: "global rules" },
          { kind: "rules", source: "/home/.agents/rules/react.md", content: "react rules" },
          { kind: "repo", source: "/repos/app/AGENTS.md", content: "repo root rules" },
          { kind: "repo", source: "/repos/app/packages/web/AGENTS.md", content: "web package rules" },
          {
            kind: "playbook",
            source:
              "/home/.cogwork/run-plans/run-72-75-6e-2d-63-6f-6e-74-65-78-74-2d-74-65-73-74/skills/implement-agent/SKILL.md",
            content: "implement skill body",
          },
        ],
      );
    }),
  );

  it.effect("places repository and private Rules between repo instructions and the playbook", () =>
    Effect.gen(function* () {
      const copies = yield* Ref.make<ReadonlyArray<CopyCall>>([]);
      const repoRule = "/repos/app/.agents/rules/style.md";
      const privateRule = "/home/.cogwork/workspaces/ws/rules/private.md";
      const assembler = make(
        config,
        stubFs(
          {
            "/home/.agents/rules/global.md": "global rules",
            "/repos/app/AGENTS.md": "repo instructions",
            [repoRule]: "repo rules",
            [privateRule]: "private rules",
            "/engine/skills/implement-agent/SKILL.md": "implement skill body",
          },
          copies,
        ),
      );

      const assembled = yield* assembler.assemble({
        ...request,
        contributions: [
          {
            id: "local:private/rules/private",
            authority: "local:private",
            kind: "rules",
            localName: "private",
            file: privateRule,
          },
          {
            id: "local:repo/rules/style",
            authority: "local:repo",
            kind: "rules",
            localName: "style",
            file: repoRule,
          },
        ],
      });

      assert.deepStrictEqual(
        assembled.layers.map((layer) => layer.content),
        ["global rules", "repo instructions", "repo rules", "private rules", "implement skill body"],
      );
    }),
  );

  it.effect("reads each Rules contribution once", () =>
    Effect.gen(function* () {
      const copies = yield* Ref.make<ReadonlyArray<CopyCall>>([]);
      const reads = yield* Ref.make(0);
      const rule = "/repos/app/.agents/rules/style.md";
      const base = stubFs({ "/engine/skills/implement-agent/SKILL.md": "playbook" }, copies);
      const assembler = make(config, {
        ...base,
        readFile: (target) =>
          target === rule
            ? Ref.update(reads, (count) => count + 1).pipe(Effect.map(() => "rule content"))
            : base.readFile(target),
      });

      const assembled = yield* assembler.assemble({
        ...request,
        contributions: [
          {
            id: "local:repo/rules/style",
            authority: "local:repo",
            kind: "rules",
            localName: "style",
            file: rule,
          },
        ],
      });

      assert.strictEqual(yield* Ref.get(reads), 1);
      assert.deepStrictEqual(assembled.sources, []);
    }),
  );

  it.effect("skips absent user Rules and repo levels with no AGENTS.md", () =>
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

      assert.strictEqual(
        assembled.skillPath,
        "/home/.cogwork/run-plans/run-72-75-6e-2d-63-6f-6e-74-65-78-74-2d-74-65-73-74/skills/implement-agent",
      );
      assert.deepStrictEqual(yield* Ref.get(copies), [
        {
          source: "/engine/skills/implement-agent",
          dest: "/home/.cogwork/run-plans/run-72-75-6e-2d-63-6f-6e-74-65-78-74-2d-74-65-73-74/skills/implement-agent",
        },
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

  it.effect("fails when the isolated playbook copy has no SKILL.md", () =>
    Effect.gen(function* () {
      const copies = yield* Ref.make<ReadonlyArray<CopyCall>>([]);
      const assembler = make(config, stubFs({}, copies));

      yield* Effect.flip(assembler.assemble(request));

      assert.lengthOf(yield* Ref.get(copies), 1);
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
