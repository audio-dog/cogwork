import type { FileContribution, RunId, WorkspaceId } from "@cogwork/contracts";
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
  readonly operatingInstructionsPath: string;
  readonly operatingInstructionResources: ReadonlyArray<{
    readonly source: string;
    readonly content: string;
  }>;
  readonly sources: ReadonlyArray<{ readonly source: string; readonly content: string }>;
}

export interface AssembleRequest {
  readonly runId: RunId;
  readonly workspace: WorkspaceId;
  readonly cwd: string;
  readonly projectRoot: string;
  readonly operatingInstructions: string;
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
    request: AssembleRequest,
  ) {
    const workspaceDir = joinPath(joinPath(config.homeDir, "workspaces"), request.workspace);
    const overrideDir = joinPath(
      joinPath(workspaceDir, "operating-instructions"),
      request.operatingInstructions,
    );
    if (yield* fs.directoryExists(overrideDir)) {
      return {
        packageDir: overrideDir,
        provenanceDir: overrideDir,
        errorSource: joinPath(overrideDir, "INSTRUCTIONS.md"),
      };
    }
    return {
      packageDir: joinPath(config.operatingInstructionsDir, request.operatingInstructions),
      provenanceDir: null,
      errorSource: request.operatingInstructions,
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

  return {
    assemble: Effect.fn("ContextAssembler.assemble")(function* (request: AssembleRequest) {
      if (!isSafePathSegment(request.operatingInstructions)) {
        return yield* new ContextAssemblerError({
          source: request.operatingInstructions,
          message: `Operating Instructions name "${request.operatingInstructions}" is not a single path segment`,
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
      const source = yield* operatingInstructionsSource(request);
      const operatingInstructionsPath = joinPath(
        runPath(request.runId),
        `operating-instructions/${request.operatingInstructions}`,
      );
      yield* operatingInstructionsLayer(request.operatingInstructions, source.packageDir, source.errorSource);
      yield* fs.copyDirectory(source.packageDir, operatingInstructionsPath);
      const provisionedInstructions = yield* operatingInstructionsLayer(
        request.operatingInstructions,
        operatingInstructionsPath,
        request.operatingInstructions,
      );
      const sharedBundles =
        source.provenanceDir === null ? (sharedResourceBundles[request.operatingInstructions] ?? []) : [];
      yield* Effect.forEach(sharedBundles, (bundle) =>
        fs.copyDirectory(
          joinPath(joinPath(config.operatingInstructionsDir, "shared"), bundle),
          joinPath(operatingInstructionsPath, bundle),
        ),
      );
      const provisionedResources = yield* operatingInstructionResources(operatingInstructionsPath);
      const sourcePath = (provisionedPath: string) =>
        provenancePath(source.provenanceDir, operatingInstructionsPath, provisionedPath);
      const operatingInstructions = {
        ...provisionedInstructions,
        source: sourcePath(provisionedInstructions.source),
      };
      const resources = provisionedResources.map((resource) => ({
        ...resource,
        source: sourcePath(resource.source),
      }));
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
      const layers = [
        ...rules,
        ...repo,
        ...repoRules,
        ...privateRules,
        ...pluginRules,
        operatingInstructions,
      ];
      return {
        layers,
        operatingInstructionsPath,
        operatingInstructionResources: resources,
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
