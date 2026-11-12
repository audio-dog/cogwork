import type { FileContribution, RunId, WorkflowOperation, WorkspaceId } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ContextFs, type ContextFsError, type ContextFsService } from "./context-fs";

export type InstructionLayerKind = "rules" | "repo" | "operating-instructions";

export interface InstructionLayer {
  readonly kind: InstructionLayerKind;
  readonly source: string;
  readonly content: string;
}

export interface AssembledContext {
  readonly layers: ReadonlyArray<InstructionLayer>;
  readonly operatingInstructionsName: string;
  readonly operatingInstructionsPath: string;
  readonly operatingInstructionResources: ReadonlyArray<{
    readonly source: string;
    readonly content: string;
  }>;
  readonly sources: ReadonlyArray<{ readonly source: string; readonly content: string }>;
}

export type WorkflowOperatingInstructions = Pick<
  WorkflowOperation,
  "instructionPackage" | "instruction" | "questions" | "hints"
>;

export interface AssembleRequest {
  readonly runId: RunId;
  readonly workspace: WorkspaceId;
  readonly cwd: string;
  readonly projectRoot: string;
  readonly operatingInstructions: string | WorkflowOperatingInstructions;
  readonly contributions: ReadonlyArray<FileContribution>;
}

export interface ContextAssemblerConfig {
  readonly homeDir: string;
  readonly userAgentsDir: string;
  readonly operatingInstructionsDir: string;
}

export class ContextAssemblerError extends Schema.TaggedError<ContextAssemblerError>()(
  "ContextAssemblerError",
  {
    source: Schema.String,
    message: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

const trimTrailing = (path: string) => path.replace(/\/+$/, "");

const normalizeDir = (path: string) => trimTrailing(path) || "/";

const joinPath = (base: string, segment: string) => `${trimTrailing(base)}/${segment}`;

const parentDir = (path: string) => {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
};

const climb = (dir: string, root: string): ReadonlyArray<string> =>
  dir === root || dir === "/" ? [dir] : [...climb(parentDir(dir), root), dir];

// Bounded at `projectRoot` on purpose: a cwd outside it must not walk `AGENTS.md` from above the
// project, so an out-of-root cwd reads its own directory alone.
export const repoDirsFrom = (cwd: string, projectRoot: string) => {
  const from = normalizeDir(cwd);
  const root = normalizeDir(projectRoot);
  const within = from === root || from.startsWith(`${root}/`);
  return within ? climb(from, root) : [from];
};

// The package name becomes a directory segment on both sides of recursive copy-and-delete.
const safePathSegment = /^[A-Za-z0-9._-]+$/;

const isSafePathSegment = (segment: string) =>
  segment !== "." && segment !== ".." && safePathSegment.test(segment);

const sharedResourceBundles: Readonly<Record<string, ReadonlyArray<string>>> = {
  "follow-up-agent": ["test-value"],
  "implement-agent": ["test-value"],
};

const workflowInstructionFraming = [
  "Use the Work Context as the brief.",
  "Return the answer through the structured result.",
  "Cogwork performs the output actions.",
].join("\n");

const workflowQuestionContent = (questions: WorkflowOperatingInstructions["questions"]) =>
  [
    "Questions:",
    ...questions.flatMap((question) => [
      `- \`${question.id}\`: ${question.text}`,
      ...question.choices.map((choice) => `  - \`${choice.id}\`: ${choice.name}`),
    ]),
  ].join("\n");

const workflowHintContent = (hints: WorkflowOperatingInstructions["hints"]) =>
  ["Input hints:", ...hints.map((hint) => `- \`${hint.field}\`: ${hint.text}`)].join("\n");

const workflowInstructionLayers = (instructions: WorkflowOperatingInstructions) => {
  const inline = instructions.instruction.trim();
  const layers = [
    { source: "Workflow Operation inline instruction", content: inline },
    {
      source: "Engine Workflow framing",
      content: workflowInstructionFraming,
    },
    {
      source: "Workflow Operation questions",
      content: instructions.questions.length > 0 ? workflowQuestionContent(instructions.questions) : "",
    },
    {
      source: "Workflow Operation input hints",
      content: instructions.hints.length > 0 ? workflowHintContent(instructions.hints) : "",
    },
  ];
  return layers
    .filter(({ content }) => content.length > 0)
    .map(
      ({ source, content }) =>
        ({ kind: "operating-instructions", source, content }) satisfies InstructionLayer,
    );
};

const instructionPackageOf = (instructions: AssembleRequest["operatingInstructions"]) =>
  typeof instructions === "string" ? instructions : instructions.instructionPackage;

const generatedInstructionLayers = (instructions: AssembleRequest["operatingInstructions"]) =>
  typeof instructions === "string" ? [] : workflowInstructionLayers(instructions);

const runPathSegment = (runId: RunId) =>
  `run-${Array.from(runId, (character) => character.codePointAt(0)?.toString(16) ?? "").join("-")}`;

const presentLayers = (layers: ReadonlyArray<InstructionLayer | null>) =>
  layers.filter((layer): layer is InstructionLayer => layer !== null);

export interface ContextAssemblerService {
  readonly assemble: (
    request: AssembleRequest,
  ) => Effect.Effect<AssembledContext, ContextFsError | ContextAssemblerError>;
  readonly cleanup: (runId: RunId) => Effect.Effect<void, ContextFsError>;
}

export class ContextAssembler extends Context.Service<ContextAssembler, ContextAssemblerService>()(
  "@cogwork/engine/context-assembler/ContextAssembler",
) {}

export const make = (config: ContextAssemblerConfig, fs: ContextFsService): ContextAssemblerService => {
  const runPath = (runId: RunId) => joinPath(joinPath(config.homeDir, "run-plans"), runPathSegment(runId));

  const trimmedContent = (content: string | null) => {
    const trimmed = content?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
  };

  const readLayer = Effect.fn("ContextAssembler.readLayer")(function* (
    kind: InstructionLayerKind,
    source: string,
  ) {
    const content = trimmedContent(yield* fs.readFile(source));
    return content === null ? null : ({ kind, source, content } satisfies InstructionLayer);
  });

  const repoLayers = Effect.fn("ContextAssembler.repoLayers")(function* (request: AssembleRequest) {
    const dirs = repoDirsFrom(request.cwd, request.projectRoot);
    const layers = yield* Effect.forEach(dirs, (dir) => readLayer("repo", joinPath(dir, "AGENTS.md")));
    return presentLayers(layers);
  });

  const userRules = Effect.fn("ContextAssembler.userRules")(function* () {
    const rulesDir = joinPath(config.userAgentsDir, "rules");
    const files = yield* fs.readDirectory(rulesDir);
    return yield* Effect.forEach(files.filter((file) => file.endsWith(".md")).sort(), (file) =>
      readLayer("rules", joinPath(rulesDir, file)),
    ).pipe(Effect.map(presentLayers));
  });

  const contributionRules = Effect.fn("ContextAssembler.contributionRules")(function* (
    contributions: ReadonlyArray<FileContribution>,
    authority: FileContribution["authority"],
  ) {
    const rules = contributions
      .filter((contribution) => contribution.authority === authority && contribution.kind === "rules")
      .sort((left, right) => left.id.localeCompare(right.id));
    return yield* Effect.forEach(rules, (rule) =>
      Effect.gen(function* () {
        const layer = yield* readLayer("rules", rule.file);
        if (layer !== null) return layer;
        return yield* new ContextAssemblerError({
          source: rule.file,
          message: `Contribution ${rule.id} has no readable source at ${rule.file}`,
          retryable: false,
        });
      }),
    );
  });

  const contributionSources = Effect.fn("ContextAssembler.contributionSources")(function* (
    contributions: ReadonlyArray<FileContribution>,
  ) {
    return yield* Effect.forEach(
      contributions.filter((contribution) => contribution.kind !== "rules"),
      (contribution) =>
        Effect.gen(function* () {
          const content = yield* fs.readFile(contribution.file);
          if (content !== null) return { source: contribution.file, content };
          return yield* new ContextAssemblerError({
            source: contribution.file,
            message: `Contribution ${contribution.id} has no readable source at ${contribution.file}`,
            retryable: false,
          });
        }),
    );
  });

  const operatingInstructionsLayer = Effect.fn("ContextAssembler.operatingInstructionsLayer")(function* (
    name: string,
    packageDir: string,
    errorSource: string,
  ) {
    const instructionPath = joinPath(packageDir, "INSTRUCTIONS.md");
    const layer = yield* readLayer("operating-instructions", instructionPath);
    if (layer !== null) return layer;
    return yield* new ContextAssemblerError({
      source: errorSource,
      message: `Operating Instructions "${name}" have no readable INSTRUCTIONS.md at ${instructionPath}`,
      retryable: false,
    });
  });

  const operatingInstructionsSource = Effect.fn("ContextAssembler.operatingInstructionsSource")(function* (
    workspace: WorkspaceId,
    instructionPackage: string,
  ) {
    const workspaceDir = joinPath(joinPath(config.homeDir, "workspaces"), workspace);
    const overrideDir = joinPath(joinPath(workspaceDir, "operating-instructions"), instructionPackage);
    if (yield* fs.directoryExists(overrideDir)) {
      return {
        packageDir: overrideDir,
        provenanceDir: overrideDir,
        errorSource: joinPath(overrideDir, "INSTRUCTIONS.md"),
      };
    }
    return {
      packageDir: joinPath(config.operatingInstructionsDir, instructionPackage),
      provenanceDir: null,
      errorSource: instructionPackage,
    };
  });

  const operatingInstructionResources = Effect.fn("ContextAssembler.operatingInstructionResources")(
    function* (packageDir: string) {
      const names = (yield* fs.readDirectory(packageDir, { recursive: true }))
        .filter((name) => name !== "INSTRUCTIONS.md")
        .sort();
      const resources = yield* Effect.forEach(names, (name) =>
        Effect.map(fs.readFile(joinPath(packageDir, name)), (content) => {
          const trimmed = trimmedContent(content);
          return trimmed === null ? [] : [{ source: joinPath(packageDir, name), content: trimmed }];
        }),
      );
      return resources.flat();
    },
  );

  const provenancePath = (provenanceDir: string | null, provisionedDir: string, source: string) => {
    if (provenanceDir === null) return source;
    return joinPath(provenanceDir, source.slice(provisionedDir.length + 1));
  };

  const provisionOperatingInstructions = Effect.fn("ContextAssembler.provisionOperatingInstructions")(
    function* (request: AssembleRequest, instructionPackage: string, operatingInstructionsPath: string) {
      const source = yield* operatingInstructionsSource(request.workspace, instructionPackage);
      yield* operatingInstructionsLayer(instructionPackage, source.packageDir, source.errorSource);
      yield* fs.copyDirectory(source.packageDir, operatingInstructionsPath);
      const provisionedInstructions = yield* operatingInstructionsLayer(
        instructionPackage,
        operatingInstructionsPath,
        instructionPackage,
      );
      const sharedBundles =
        source.provenanceDir === null ? (sharedResourceBundles[instructionPackage] ?? []) : [];
      yield* Effect.forEach(sharedBundles, (bundle) =>
        fs.copyDirectory(
          joinPath(joinPath(config.operatingInstructionsDir, "shared"), bundle),
          joinPath(operatingInstructionsPath, bundle),
        ),
      );
      const provisionedResources = yield* operatingInstructionResources(operatingInstructionsPath);
      const sourcePath = (provisionedPath: string) =>
        provenancePath(source.provenanceDir, operatingInstructionsPath, provisionedPath);
      return {
        layer: { ...provisionedInstructions, source: sourcePath(provisionedInstructions.source) },
        resources: provisionedResources.map((resource) => ({
          ...resource,
          source: sourcePath(resource.source),
        })),
      };
    },
  );

  return {
    assemble: Effect.fn("ContextAssembler.assemble")(function* (request: AssembleRequest) {
      const instructionPackage = instructionPackageOf(request.operatingInstructions);
      if (instructionPackage !== null && !isSafePathSegment(instructionPackage)) {
        return yield* new ContextAssemblerError({
          source: instructionPackage,
          message: `Operating Instructions name "${instructionPackage}" is not a single path segment`,
          retryable: false,
        });
      }
      if (!isSafePathSegment(request.workspace)) {
        return yield* new ContextAssemblerError({
          source: request.workspace,
          message: `Workspace identity "${request.workspace}" is not a single path segment`,
          retryable: false,
        });
      }
      const operatingInstructionsName = instructionPackage ?? "workflow-operation";
      const operatingInstructionsPath = joinPath(
        runPath(request.runId),
        `operating-instructions/${operatingInstructionsName}`,
      );
      const provisioned = instructionPackage
        ? yield* provisionOperatingInstructions(request, instructionPackage, operatingInstructionsPath)
        : { layer: null, resources: [] };
      const workflowLayers = generatedInstructionLayers(request.operatingInstructions);
      const operatingLayers = presentLayers([provisioned.layer, ...workflowLayers]);
      if (typeof request.operatingInstructions !== "string") {
        yield* fs.writeFile(
          joinPath(operatingInstructionsPath, "INSTRUCTIONS.md"),
          operatingLayers.map(({ content }) => content).join("\n\n"),
        );
      }
      const rules = yield* userRules();
      const repo = yield* repoLayers(request);
      const repoRules = yield* contributionRules(request.contributions, "local:repo");
      const privateRules = yield* contributionRules(request.contributions, "local:private");
      const sources = yield* contributionSources(request.contributions);
      const pluginAuthorities = [
        ...new Set(
          request.contributions.flatMap((contribution) =>
            contribution.authority.startsWith("plugin:") ? [contribution.authority] : [],
          ),
        ),
      ].sort();
      const pluginRules = yield* Effect.forEach(pluginAuthorities, (authority) =>
        contributionRules(request.contributions, authority),
      ).pipe(Effect.map((groups) => groups.flat()));
      const layers = [...rules, ...repo, ...repoRules, ...privateRules, ...pluginRules, ...operatingLayers];
      return {
        layers,
        operatingInstructionsName,
        operatingInstructionsPath,
        operatingInstructionResources: provisioned.resources,
        sources,
      } satisfies AssembledContext;
    }),
    cleanup: (runId) => fs.removeDirectory(runPath(runId)),
  };
};

export const layer = (config: ContextAssemblerConfig) =>
  Layer.effect(
    ContextAssembler,
    Effect.map(ContextFs, (fs) => make(config, fs)),
  );
