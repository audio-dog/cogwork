import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ContextFs, type ContextFsError, type ContextFsService } from "./context-fs";

export type InstructionLayerKind = "global" | "repo" | "playbook";

// Array order is precedence: the runner renders these in order, so a later layer refines an earlier
// one (global → repo → playbook). Reordering silently changes which instructions win.
export interface InstructionLayer {
  readonly kind: InstructionLayerKind;
  readonly source: string;
  readonly content: string;
}

export interface AssembledContext {
  readonly layers: ReadonlyArray<InstructionLayer>;
  readonly skillPath: string;
}

export interface AssembleRequest {
  readonly cwd: string;
  readonly projectRoot: string;
  readonly skill: string;
}

export interface ContextAssemblerConfig {
  readonly homeDir: string;
  readonly skillsDir: string;
}

export class ContextAssemblerError extends Schema.TaggedErrorClass<ContextAssemblerError>()(
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
    return layers.filter((layer): layer is InstructionLayer => layer !== null);
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
      const skillPath = joinPath(joinPath(config.homeDir, "skills"), request.skill);
      const playbook = yield* playbookLayer(request.skill, skillDir);
      yield* fs.copyDirectory(skillDir, skillPath);
      const global = yield* readLayer("global", joinPath(config.homeDir, "AGENTS.md"));
      const repo = yield* repoLayers(request);
      const layers = [...(global ? [global] : []), ...repo, playbook];
      return { layers, skillPath } satisfies AssembledContext;
    }),
  };
};

export const layer = (config: ContextAssemblerConfig) =>
  Layer.effect(
    ContextAssembler,
    Effect.map(ContextFs, (fs) => make(config, fs)),
  );
