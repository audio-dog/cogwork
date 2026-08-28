import type { LocalContribution, LocalContributionAuthority, RunId } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ContextFs, type ContextFsError, type ContextFsService } from "./context-fs";

export type InstructionLayerKind = "rules" | "repo" | "playbook";

export interface InstructionLayer {
  readonly kind: InstructionLayerKind;
  readonly source: string;
  readonly content: string;
}

export interface AssembledContext {
  readonly layers: ReadonlyArray<InstructionLayer>;
  readonly skillPath: string;
  readonly sources: ReadonlyArray<{ readonly source: string; readonly content: string }>;
}

export interface AssembleRequest {
  readonly runId: RunId;
  readonly cwd: string;
  readonly projectRoot: string;
  readonly skill: string;
  readonly contributions: ReadonlyArray<LocalContribution>;
}

export interface ContextAssemblerConfig {
  readonly homeDir: string;
  readonly userAgentsDir: string;
  readonly skillsDir: string;
}

export class ContextAssemblerError extends Schema.TaggedError<ContextAssemblerError>()(
  "ContextAssemblerError",
  {
    skill: Schema.String,
    message: Schema.String,
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

// A skill name becomes a directory segment on both the source and the destination of a recursive
// copy-and-delete, so anything but a single safe segment could escape the skills base.
const safeSkillSegment = /^[A-Za-z0-9._-]+$/;

const isSafeSkill = (skill: string) => skill !== "." && skill !== ".." && safeSkillSegment.test(skill);

const runPathSegment = (runId: RunId) =>
  `run-${Array.from(runId, (character) => character.codePointAt(0)?.toString(16) ?? "").join("-")}`;

const presentLayers = (layers: ReadonlyArray<InstructionLayer | null>) =>
  layers.filter((layer): layer is InstructionLayer => layer !== null);

export interface ContextAssemblerService {
  readonly assemble: (
    request: AssembleRequest,
  ) => Effect.Effect<AssembledContext, ContextFsError | ContextAssemblerError>;
}

export class ContextAssembler extends Context.Service<ContextAssembler, ContextAssemblerService>()(
  "@cogwork/engine/context-assembler/ContextAssembler",
) {}

export const make = (config: ContextAssemblerConfig, fs: ContextFsService): ContextAssemblerService => {
  const nonEmpty = (content: string | null) =>
    content !== null && content.trim().length > 0 ? content : null;

  const readLayer = Effect.fn("ContextAssembler.readLayer")(function* (
    kind: InstructionLayerKind,
    source: string,
  ) {
    const content = nonEmpty(yield* fs.readFile(source));
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
    contributions: ReadonlyArray<LocalContribution>,
    authority: LocalContributionAuthority,
  ) {
    const rules = contributions
      .filter((contribution) => contribution.authority === authority && contribution.kind === "rules")
      .sort((left, right) => left.id.localeCompare(right.id));
    return yield* Effect.forEach(rules, (rule) => readLayer("rules", rule.file)).pipe(
      Effect.map(presentLayers),
    );
  });

  const contributionSources = Effect.fn("ContextAssembler.contributionSources")(function* (
    contributions: ReadonlyArray<LocalContribution>,
  ) {
    const sources = yield* Effect.forEach(
      contributions.filter((contribution) => contribution.kind !== "rules"),
      (contribution) =>
        Effect.map(fs.readFile(contribution.file), (content) =>
          content === null ? [] : [{ source: contribution.file, content }],
        ),
    );
    return sources.flat();
  });

  const playbookLayer = Effect.fn("ContextAssembler.playbookLayer")(function* (
    skill: string,
    skillDir: string,
  ) {
    const layer = yield* readLayer("playbook", joinPath(skillDir, "SKILL.md"));
    if (layer !== null) return layer;
    return yield* new ContextAssemblerError({
      skill,
      message: `playbook skill "${skill}" has no readable SKILL.md at ${skillDir}`,
    });
  });

  return {
    assemble: Effect.fn("ContextAssembler.assemble")(function* (request: AssembleRequest) {
      if (!isSafeSkill(request.skill)) {
        return yield* new ContextAssemblerError({
          skill: request.skill,
          message: `playbook skill name "${request.skill}" is not a single path segment`,
        });
      }
      const skillDir = joinPath(config.skillsDir, request.skill);
      const skillPath = joinPath(
        joinPath(joinPath(config.homeDir, "run-plans"), runPathSegment(request.runId)),
        `skills/${request.skill}`,
      );
      yield* fs.copyDirectory(skillDir, skillPath);
      const playbook = yield* playbookLayer(request.skill, skillPath);
      const rules = yield* userRules();
      const repo = yield* repoLayers(request);
      const repoRules = yield* contributionRules(request.contributions, "local:repo");
      const privateRules = yield* contributionRules(request.contributions, "local:private");
      const sources = yield* contributionSources(request.contributions);
      const layers = [...rules, ...repo, ...repoRules, ...privateRules, playbook];
      return { layers, skillPath, sources } satisfies AssembledContext;
    }),
  };
};

export const layer = (config: ContextAssemblerConfig) =>
  Layer.effect(
    ContextAssembler,
    Effect.map(ContextFs, (fs) => make(config, fs)),
  );
