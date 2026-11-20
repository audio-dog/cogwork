import {
  type FileContribution,
  RunId,
  RunPlanInstruction,
  RunPlanResource,
  WorkflowNodeId,
  WorkspaceId,
} from "@cogwork/contracts";
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

interface WriteCall {
  readonly target: string;
  readonly content: string;
}

interface StubFsOptions {
  readonly directories?: ReadonlyArray<string>;
  readonly removals?: Ref.Ref<ReadonlyArray<string>>;
  readonly writes?: Ref.Ref<ReadonlyArray<WriteCall>>;
}

const config = {
  homeDir: "/home/.cogwork",
  userAgentsDir: "/home/.agents",
  operatingInstructionsDir: "/engine/operating-instructions",
};

const request: AssembleRequest = {
  runId: Schema.decodeSync(RunId)("run-context-test"),
  workspace: Schema.decodeSync(WorkspaceId)("gh"),
  cwd: "/repos/app/packages/web",
  projectRoot: "/repos/app",
  operatingInstructions: "implement-agent",
  contributions: [],
};
const workflowNodeId = Schema.decodeSync(WorkflowNodeId);

const workspaceOverrideDir = "/home/.cogwork/workspaces/gh/operating-instructions/implement-agent";
const engineInstructions = {
  "/engine/operating-instructions/implement-agent/INSTRUCTIONS.md": "engine instructions",
};

const stubFs = (
  files: Record<string, string>,
  copies: Ref.Ref<ReadonlyArray<CopyCall>>,
  { directories = [], removals, writes }: StubFsOptions = {},
): ContextFsService => ({
  directoryExists: (target) =>
    Effect.succeed(
      directories.includes(target) || Object.keys(files).some((file) => file.startsWith(`${target}/`)),
    ),
  readFile: (target) =>
    Ref.get(copies).pipe(
      Effect.map((calls) => {
        const copy = calls.findLast(({ dest }) => target === dest || target.startsWith(`${dest}/`));
        const resolved = copy ? `${copy.source}${target.slice(copy.dest.length)}` : target;
        return files[resolved] ?? null;
      }),
    ),
  readDirectory: (target, options) =>
    Ref.get(copies).pipe(
      Effect.map((calls) => {
        const copy = calls.findLast(({ dest }) => target === dest || target.startsWith(`${dest}/`));
        const resolved = copy ? `${copy.source}${target.slice(copy.dest.length)}` : target;
        const entries = Object.keys(files)
          .filter((file) => file.startsWith(`${resolved}/`))
          .map((file) => file.slice(resolved.length + 1));
        const mountedEntries = calls
          .filter(({ dest }) => dest.startsWith(`${target}/`))
          .flatMap(({ source, dest }) =>
            Object.keys(files)
              .filter((file) => file.startsWith(`${source}/`))
              .map((file) => `${dest.slice(target.length + 1)}/${file.slice(source.length + 1)}`),
          );
        return [...entries, ...mountedEntries].filter((name) => options?.recursive || !name.includes("/"));
      }),
    ),
  writeFile: (target, content) =>
    writes ? Ref.update(writes, (calls) => [...calls, { target, content }]) : Effect.void,
  copyDirectory: (source, dest) => Ref.update(copies, (xs) => [...xs, { source, dest }]),
  removeDirectory: (target) =>
    removals ? Ref.update(removals, (targets) => [...targets, target]) : Effect.void,
});

const assertInvalidWorkspaceOverride = (files: Record<string, string>, options?: StubFsOptions) =>
  Effect.gen(function* () {
    const copies = yield* Ref.make<ReadonlyArray<CopyCall>>([]);
    const assembler = make(config, stubFs(files, copies, options));

    const error = yield* Effect.flip(assembler.assemble(request));

    assert.strictEqual(error._tag, "ContextAssemblerError");
    assert.strictEqual(
      error._tag === "ContextAssemblerError" ? error.source : null,
      `${workspaceOverrideDir}/INSTRUCTIONS.md`,
    );
    assert.include(error.message, `${workspaceOverrideDir}/INSTRUCTIONS.md`);
    assert.deepStrictEqual(yield* Ref.get(copies), []);
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
            "/engine/operating-instructions/implement-agent/INSTRUCTIONS.md": "implement instructions body",
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
            kind: "operating-instructions",
            source:
              "/home/.cogwork/run-plans/run-72-75-6e-2d-63-6f-6e-74-65-78-74-2d-74-65-73-74/operating-instructions/implement-agent/INSTRUCTIONS.md",
            content: "implement instructions body",
          },
        ],
      );
    }),
  );

  it.effect("places repository, private, and Plugin Rules before Operating Instructions", () =>
    Effect.gen(function* () {
      const copies = yield* Ref.make<ReadonlyArray<CopyCall>>([]);
      const repoRule = "/repos/app/.agents/rules/style.md";
      const privateRule = "/home/.cogwork/workspaces/ws/rules/private.md";
      const pluginRule = "/home/.cogwork/plugins/linear/rules/issues.md";
      const assembler = make(
        config,
        stubFs(
          {
            "/home/.agents/rules/global.md": "global rules",
            "/repos/app/AGENTS.md": "repo instructions",
            [repoRule]: "repo rules",
            [privateRule]: "private rules",
            [pluginRule]: "plugin rules",
            "/engine/operating-instructions/implement-agent/INSTRUCTIONS.md": "implement instructions body",
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
          {
            id: "plugin:linear/rules/issues",
            authority: "plugin:linear",
            kind: "rules",
            localName: "issues",
            file: pluginRule,
          },
        ],
      });

      assert.deepStrictEqual(
        assembled.layers.map((layer) => layer.content),
        [
          "global rules",
          "repo instructions",
          "repo rules",
          "private rules",
          "plugin rules",
          "implement instructions body",
        ],
      );
    }),
  );

  it.effect("reads each Rules contribution once", () =>
    Effect.gen(function* () {
      const copies = yield* Ref.make<ReadonlyArray<CopyCall>>([]);
      const reads = yield* Ref.make(0);
      const rule = "/repos/app/.agents/rules/style.md";
      const base = stubFs(
        { "/engine/operating-instructions/implement-agent/INSTRUCTIONS.md": "operating-instructions" },
        copies,
      );
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
            "/engine/operating-instructions/implement-agent/INSTRUCTIONS.md": "implement instructions body",
          },
          copies,
        ),
      );

      const assembled = yield* assembler.assemble(request);

      assert.deepStrictEqual(
        assembled.layers.map((layer) => layer.kind),
        ["repo", "operating-instructions"],
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
            "/engine/operating-instructions/implement-agent/INSTRUCTIONS.md": "implement instructions body",
          },
          copies,
        ),
      );

      const assembled = yield* assembler.assemble({ ...request, cwd: "/repos/app" });

      assert.deepStrictEqual(
        assembled.layers.map((layer) => layer.kind),
        ["operating-instructions"],
      );
    }),
  );

  it.effect("fails when an admitted contribution has no readable source", () =>
    Effect.gen(function* () {
      const copies = yield* Ref.make<ReadonlyArray<CopyCall>>([]);
      const assembler = make(
        config,
        stubFs({ "/engine/operating-instructions/implement-agent/INSTRUCTIONS.md": "instructions" }, copies),
      );
      const contribution = {
        id: "local:private/skill/missing",
        authority: "local:private",
        kind: "skill",
        localName: "missing",
        file: "/home/.cogwork/workspaces/ws/skills/missing/SKILL.md",
      } satisfies FileContribution;

      const error = yield* Effect.flip(assembler.assemble({ ...request, contributions: [contribution] }));

      assert.strictEqual(error._tag === "ContextAssemblerError" ? error.source : null, contribution.file);
      assert.include(error.message, contribution.id);
    }),
  );

  it.effect("provisions Operating Instructions host-side and keeps the worktree clean", () =>
    Effect.gen(function* () {
      const copies = yield* Ref.make<ReadonlyArray<CopyCall>>([]);
      const assembler = make(
        config,
        stubFs(
          {
            "/engine/operating-instructions/implement-agent/INSTRUCTIONS.md": "implement instructions body",
            "/engine/operating-instructions/implement-agent/GUIDE.md": "guide body",
            "/engine/operating-instructions/implement-agent/examples/example.md": "example body",
          },
          copies,
        ),
      );

      const assembled = yield* assembler.assemble(request);

      assert.strictEqual(
        assembled.operatingInstructionsPath,
        "/home/.cogwork/run-plans/run-72-75-6e-2d-63-6f-6e-74-65-78-74-2d-74-65-73-74/operating-instructions/implement-agent",
      );
      assert.deepStrictEqual(yield* Ref.get(copies), [
        {
          source: "/engine/operating-instructions/implement-agent",
          dest: "/home/.cogwork/run-plans/run-72-75-6e-2d-63-6f-6e-74-65-78-74-2d-74-65-73-74/operating-instructions/implement-agent",
        },
        {
          source: "/engine/operating-instructions/shared/test-value",
          dest: "/home/.cogwork/run-plans/run-72-75-6e-2d-63-6f-6e-74-65-78-74-2d-74-65-73-74/operating-instructions/implement-agent/test-value",
        },
      ]);
      assert.isTrue(assembled.operatingInstructionsPath.startsWith(config.homeDir));
      assert.isFalse(assembled.operatingInstructionsPath.startsWith(request.projectRoot));
      assert.isFalse(assembled.operatingInstructionsPath.startsWith(request.cwd));
      assert.deepStrictEqual(assembled.operatingInstructionResources, [
        {
          source: `${assembled.operatingInstructionsPath}/GUIDE.md`,
          content: "guide body",
        },
        {
          source: `${assembled.operatingInstructionsPath}/examples/example.md`,
          content: "example body",
        },
      ]);
    }),
  );

  it.effect("builds the Workflow Operating Instructions ladder and host entry point", () =>
    Effect.gen(function* () {
      const copies = yield* Ref.make<ReadonlyArray<CopyCall>>([]);
      const writes = yield* Ref.make<ReadonlyArray<WriteCall>>([]);
      const assembler = make(
        config,
        stubFs(
          {
            "/engine/operating-instructions/implement-agent/INSTRUCTIONS.md": "package entry point",
            "/engine/operating-instructions/implement-agent/GUIDE.md": "package guide",
            "/engine/operating-instructions/shared/test-value/TEST-VALUE.md": "test-value bar",
          },
          copies,
          { writes },
        ),
      );

      const assembled = yield* assembler.assemble({
        ...request,
        operatingInstructions: {
          instructionPackage: "implement-agent",
          instruction: "Keep the change focused.",
          questions: [
            {
              id: workflowNodeId("decision"),
              text: "What should happen?",
              choices: [
                { id: workflowNodeId("ship"), name: "Ship it" },
                { id: workflowNodeId("stop"), name: "Stop" },
              ],
            },
          ],
          hints: [{ field: "summary", text: "Keep it short." }],
        },
      });

      assert.deepStrictEqual(
        assembled.layers.slice(-5).map(({ source, content }) => ({ source, content })),
        [
          {
            source: `${assembled.operatingInstructionsPath}/INSTRUCTIONS.md`,
            content: "package entry point",
          },
          {
            source: "Workflow Operation inline instruction",
            content: "Keep the change focused.",
          },
          {
            source: "Engine Workflow framing",
            content:
              "Use the Work Context as the brief.\nReturn the answer through the structured result.\nCogwork performs the output actions.",
          },
          {
            source: "Workflow Operation questions",
            content: "Questions:\n- `decision`: What should happen?\n  - `ship`: Ship it\n  - `stop`: Stop",
          },
          {
            source: "Workflow Operation input hints",
            content: "Input hints:\n- `summary`: Keep it short.",
          },
        ],
      );
      assert.deepStrictEqual(assembled.operatingInstructionResources, [
        { source: `${assembled.operatingInstructionsPath}/GUIDE.md`, content: "package guide" },
        {
          source: `${assembled.operatingInstructionsPath}/test-value/TEST-VALUE.md`,
          content: "test-value bar",
        },
      ]);
      assert.deepStrictEqual(yield* Ref.get(writes), [
        {
          target: `${assembled.operatingInstructionsPath}/INSTRUCTIONS.md`,
          content: assembled.layers
            .slice(-5)
            .map(({ content }) => content)
            .join("\n\n"),
        },
      ]);
    }),
  );

  it.effect("builds host Operating Instructions without a package", () =>
    Effect.gen(function* () {
      const copies = yield* Ref.make<ReadonlyArray<CopyCall>>([]);
      const writes = yield* Ref.make<ReadonlyArray<WriteCall>>([]);
      const assembler = make(config, stubFs({}, copies, { writes }));

      const assembled = yield* assembler.assemble({
        ...request,
        operatingInstructions: {
          instructionPackage: null,
          instruction: "Summarize the item.",
          questions: [],
          hints: [],
        },
      });

      assert.strictEqual(
        assembled.operatingInstructionsPath,
        "/home/.cogwork/run-plans/run-72-75-6e-2d-63-6f-6e-74-65-78-74-2d-74-65-73-74/operating-instructions/workflow-operation",
      );
      assert.deepStrictEqual(
        assembled.layers.slice(-2).map(({ content }) => content),
        [
          "Summarize the item.",
          "Use the Work Context as the brief.\nReturn the answer through the structured result.\nCogwork performs the output actions.",
        ],
      );
      assert.deepStrictEqual(assembled.operatingInstructionResources, []);
      assert.deepStrictEqual(yield* Ref.get(copies), []);
      assert.lengthOf(yield* Ref.get(writes), 1);
    }),
  );

  it.effect.each(["implement-agent", "follow-up-agent"])(
    "provisions the shared test-value resource for %s",
    (operatingInstructions) =>
      Effect.gen(function* () {
        const copies = yield* Ref.make<ReadonlyArray<CopyCall>>([]);
        const assembler = make(
          config,
          stubFs(
            {
              [`/engine/operating-instructions/${operatingInstructions}/INSTRUCTIONS.md`]: `${operatingInstructions} instructions`,
              "/engine/operating-instructions/shared/test-value/TEST-VALUE.md": "test-value bar",
            },
            copies,
          ),
        );

        const assembled = yield* assembler.assemble({ ...request, operatingInstructions });

        assert.deepStrictEqual(yield* Ref.get(copies), [
          {
            source: `/engine/operating-instructions/${operatingInstructions}`,
            dest: assembled.operatingInstructionsPath,
          },
          {
            source: "/engine/operating-instructions/shared/test-value",
            dest: `${assembled.operatingInstructionsPath}/test-value`,
          },
        ]);
        assert.deepStrictEqual(assembled.operatingInstructionResources, [
          {
            source: `${assembled.operatingInstructionsPath}/test-value/TEST-VALUE.md`,
            content: "test-value bar",
          },
        ]);
      }),
  );

  it.effect("replaces Operating Instructions with the Workspace override", () =>
    Effect.gen(function* () {
      const copies = yield* Ref.make<ReadonlyArray<CopyCall>>([]);
      const assembler = make(
        config,
        stubFs(
          {
            ...engineInstructions,
            [`${workspaceOverrideDir}/INSTRUCTIONS.md`]: "workspace instructions",
            [`${workspaceOverrideDir}/GUIDE.md`]: "workspace guide",
          },
          copies,
        ),
      );

      const assembled = yield* assembler.assemble(request);

      assert.deepStrictEqual(assembled.layers.at(-1), {
        kind: "operating-instructions",
        source: `${workspaceOverrideDir}/INSTRUCTIONS.md`,
        content: "workspace instructions",
      });
      assert.deepStrictEqual(assembled.operatingInstructionResources, [
        { source: `${workspaceOverrideDir}/GUIDE.md`, content: "workspace guide" },
      ]);
      assert.deepStrictEqual(yield* Ref.get(copies), [
        { source: workspaceOverrideDir, dest: assembled.operatingInstructionsPath },
      ]);
    }),
  );

  it.effect("fails when a Workspace override has no INSTRUCTIONS.md", () =>
    assertInvalidWorkspaceOverride(engineInstructions, { directories: [workspaceOverrideDir] }),
  );

  it.effect("fails when a Workspace override has a whitespace-only INSTRUCTIONS.md", () =>
    assertInvalidWorkspaceOverride({
      ...engineInstructions,
      [`${workspaceOverrideDir}/INSTRUCTIONS.md`]: " \n\t ",
    }),
  );

  it.effect("trims file content so every layer and resource satisfies the Run Plan contract", () =>
    Effect.gen(function* () {
      const copies = yield* Ref.make<ReadonlyArray<CopyCall>>([]);
      const assembler = make(
        config,
        stubFs(
          {
            "/home/.agents/rules/global.md": "global rules\n",
            "/repos/app/AGENTS.md": "repo root rules\n\n",
            "/engine/operating-instructions/implement-agent/INSTRUCTIONS.md": "implement instructions body\n",
            "/engine/operating-instructions/implement-agent/GUIDE.md": "guide body\n",
            "/engine/operating-instructions/implement-agent/BLANK.md": "\n  \n",
          },
          copies,
        ),
      );

      const assembled = yield* assembler.assemble(request);

      assert.deepStrictEqual(
        assembled.layers.map(({ content }) => content),
        ["global rules", "repo root rules", "implement instructions body"],
      );
      assert.deepStrictEqual(assembled.operatingInstructionResources, [
        { source: `${assembled.operatingInstructionsPath}/GUIDE.md`, content: "guide body" },
      ]);
      assert.deepStrictEqual(
        assembled.layers.map((layer) => RunPlanInstruction.make({ ...layer }).content),
        ["global rules", "repo root rules", "implement instructions body"],
      );
      assert.deepStrictEqual(
        assembled.operatingInstructionResources.map((resource) => RunPlanResource.make(resource).content),
        ["guide body"],
      );
    }),
  );

  it.effect("removes the isolated run directory during cleanup", () =>
    Effect.gen(function* () {
      const copies = yield* Ref.make<ReadonlyArray<CopyCall>>([]);
      const removals = yield* Ref.make<ReadonlyArray<string>>([]);
      const assembler = make(config, stubFs({}, copies, { removals }));

      yield* assembler.cleanup(request.runId);

      assert.deepStrictEqual(yield* Ref.get(removals), [
        "/home/.cogwork/run-plans/run-72-75-6e-2d-63-6f-6e-74-65-78-74-2d-74-65-73-74",
      ]);
    }),
  );

  it.effect("fails when Operating Instructions have no readable INSTRUCTIONS.md", () =>
    Effect.gen(function* () {
      const copies = yield* Ref.make<ReadonlyArray<CopyCall>>([]);
      const assembler = make(config, stubFs({ "/repos/app/AGENTS.md": "repo root rules" }, copies));

      const error = yield* Effect.flip(assembler.assemble(request));

      assert.strictEqual(error._tag, "ContextAssemblerError");
      assert.include(error.message, "implement-agent");
      assert.deepStrictEqual(yield* Ref.get(copies), []);
    }),
  );

  it.effect("fails when the isolated Operating Instructions copy has no INSTRUCTIONS.md", () =>
    Effect.gen(function* () {
      const copies = yield* Ref.make<ReadonlyArray<CopyCall>>([]);
      const base = stubFs(
        { "/engine/operating-instructions/implement-agent/INSTRUCTIONS.md": "operating-instructions" },
        copies,
      );
      const assembler = make(config, {
        ...base,
        readFile: (target) =>
          target.startsWith(`${config.homeDir}/run-plans/`) ? Effect.succeed(null) : base.readFile(target),
      });

      const error = yield* Effect.flip(assembler.assemble(request));

      assert.strictEqual(error._tag, "ContextAssemblerError");
      assert.lengthOf(yield* Ref.get(copies), 1);
    }),
  );

  it.effect("rejects an Operating Instructions name that would escape its base", () =>
    Effect.gen(function* () {
      const copies = yield* Ref.make<ReadonlyArray<CopyCall>>([]);
      const files = { "/engine/operating-instructions/../../etc/INSTRUCTIONS.md": "somebody else's file" };
      const assembler = make(config, stubFs(files, copies));

      const error = yield* Effect.flip(
        assembler.assemble({ ...request, operatingInstructions: "../../etc" }),
      );

      assert.strictEqual(error._tag, "ContextAssemblerError");
      assert.include(error.message, "single path segment");
      assert.deepStrictEqual(yield* Ref.get(copies), []);
    }),
  );

  it.effect("rejects an Operating Instructions name containing a path separator", () =>
    Effect.gen(function* () {
      const copies = yield* Ref.make<ReadonlyArray<CopyCall>>([]);
      const assembler = make(config, stubFs({}, copies));

      const error = yield* Effect.flip(
        assembler.assemble({ ...request, operatingInstructions: "nested/package" }),
      );

      assert.strictEqual(error._tag, "ContextAssemblerError");
      assert.deepStrictEqual(yield* Ref.get(copies), []);
    }),
  );
});
