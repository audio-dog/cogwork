import {
  type FileContributionKind,
  type LocalContribution,
  type LocalContributionAuthority,
  localContributionId,
  type WorkspaceId,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";

export interface ScanAuthoringTreesRequest {
  readonly workspace: WorkspaceId;
  readonly repoRoot: string;
  readonly cogworkHome: string;
  readonly userAgentsDir?: string;
}

interface TreeSpec {
  readonly authority: LocalContributionAuthority;
  readonly boundary: string;
  readonly root: string;
}

interface FlatKindSpec {
  readonly kind: FileContributionKind;
  readonly directory: string;
  readonly extension: string;
  readonly disableModelInvocation?: true;
}

const flatKinds: ReadonlyArray<FlatKindSpec> = [
  { kind: "mcp-server", directory: "mcp", extension: ".json" },
  { kind: "rules", directory: "rules", extension: ".md" },
  { kind: "skill", directory: "commands", extension: ".md", disableModelInvocation: true },
  { kind: "subagent", directory: "subagents", extension: ".md" },
];

const localNameFrom = (file: string, extension: string) => file.slice(0, -extension.length);

const isCanonicalLocalName = (localName: string) => localName.length > 0 && localName === localName.trim();

const isAbsentPath = (error: PlatformError) =>
  error.reason._tag === "NotFound" || error.reason._tag === "BadResource";

const contribution = (
  authority: LocalContributionAuthority,
  kind: FileContributionKind,
  localName: string,
  file: string,
  disableModelInvocation?: true,
) =>
  ({
    id: localContributionId(authority, kind, localName),
    authority,
    kind,
    localName,
    file,
    ...(disableModelInvocation ? { disableModelInvocation } : {}),
  }) satisfies LocalContribution;

const firstOfEachId = (contributions: ReadonlyArray<LocalContribution>) =>
  contributions.filter(
    (candidate, index) => contributions.findIndex(({ id }) => id === candidate.id) === index,
  );

export const scanAuthoringTrees = Effect.fn("AuthoringTree.scan")(function* (
  request: ScanAuthoringTreesRequest,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const readDirectory = (target: string) =>
    fs.readDirectory(target).pipe(Effect.catchIf(isAbsentPath, () => Effect.succeed([])));

  const realPath = (target: string) =>
    fs.realPath(target).pipe(Effect.catchIf(isAbsentPath, () => Effect.succeed(null)));

  const isWithin = (boundary: string, target: string) => {
    const relative = path.relative(boundary, target);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };

  const containedFile = Effect.fn("AuthoringTree.containedFile")(function* (
    boundary: string,
    target: string,
  ) {
    const canonical = yield* realPath(target);
    if (canonical === null || !isWithin(boundary, canonical)) return null;
    const info = yield* fs.stat(canonical);
    return info.type === "File" ? canonical : null;
  });

  const scanFlatKind = Effect.fn("AuthoringTree.scanFlatKind")(function* (
    tree: TreeSpec,
    spec: FlatKindSpec,
  ) {
    const directory = path.join(tree.root, spec.directory);
    const names = yield* readDirectory(directory);
    const entries = yield* Effect.forEach(
      names
        .filter(
          (name) =>
            name.endsWith(spec.extension) && isCanonicalLocalName(localNameFrom(name, spec.extension)),
        )
        .sort(),
      (name) =>
        containedFile(tree.root, path.join(directory, name)).pipe(
          Effect.map((file) => (file === null ? [] : [{ file, name }])),
        ),
    );
    return entries
      .flat()
      .map(({ file, name }) =>
        contribution(
          tree.authority,
          spec.kind,
          localNameFrom(name, spec.extension),
          file,
          spec.disableModelInvocation,
        ),
      );
  });

  const scanSkills = Effect.fn("AuthoringTree.scanSkills")(function* (tree: TreeSpec) {
    const directory = path.join(tree.root, "skills");
    const names = (yield* readDirectory(directory)).filter(isCanonicalLocalName).sort();
    const entries = yield* Effect.forEach(names, (name) =>
      containedFile(tree.root, path.join(directory, name, "SKILL.md")).pipe(
        Effect.map((file) => (file === null ? [] : [{ file, name }])),
      ),
    );
    return entries.flat().map(({ file, name }) => contribution(tree.authority, "skill", name, file));
  });

  const scanTree = Effect.fn("AuthoringTree.scanTree")(function* (tree: TreeSpec) {
    const [boundary, root] = yield* Effect.all([realPath(tree.boundary), realPath(tree.root)]);
    if (boundary === null || root === null || !isWithin(boundary, root)) return [];
    const canonicalTree = { ...tree, boundary, root };
    const [skills, ...flat] = yield* Effect.all([
      scanSkills(canonicalTree),
      ...flatKinds.map((kind) => scanFlatKind(canonicalTree, kind)),
    ]);
    return firstOfEachId([...skills, ...flat.flat()]);
  });

  const userTree: ReadonlyArray<TreeSpec> = request.userAgentsDir
    ? [{ authority: "local:user", boundary: request.userAgentsDir, root: request.userAgentsDir }]
    : [];
  const trees: ReadonlyArray<TreeSpec> = [
    ...userTree,
    {
      authority: "local:repo",
      boundary: request.repoRoot,
      root: path.join(request.repoRoot, ".agents"),
    },
    {
      authority: "local:private",
      boundary: request.cogworkHome,
      root: path.join(request.cogworkHome, "workspaces", request.workspace),
    },
  ];
  const scanned = yield* Effect.forEach(trees, scanTree);
  return scanned.flat().toSorted((left, right) => left.id.localeCompare(right.id));
});
