import {
  type ConnectionReadiness,
  ConnectionSystem,
  type ConnectionSystem as ConnectionSystemType,
  ContentRevision,
  DeclaredVersion,
  FileContributionKind,
  type PluginContribution,
  PluginFailure,
  type PluginInstall,
  type PluginItem,
  type PluginMcpServer,
  type PluginMutationResult,
  type PluginOverview,
  type PrincipalId,
  pluginContributionId,
  TrimmedNonEmptyString,
  type WorkspaceId,
} from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";

import { ConnectionStore } from "./connection";
import { ControlStore } from "./control-store";

const CatalogEntry = Schema.Struct({
  pluginId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  bundle: TrimmedNonEmptyString,
});
type CatalogEntry = typeof CatalogEntry.Type;

const CatalogDocument = Schema.Struct({ plugins: Schema.Array(CatalogEntry) });

const ManifestContribution = Schema.Struct({
  kind: FileContributionKind,
  localName: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  file: TrimmedNonEmptyString,
});
type ManifestContribution = typeof ManifestContribution.Type;

const OptionalTrimmedNonEmptyString = Schema.optionalKey(Schema.String).pipe(
  Schema.decodeTo(Schema.optionalKey(TrimmedNonEmptyString), {
    decode: SchemaGetter.transformOptional(Option.filter((value) => value.trim() !== "")),
    encode: SchemaGetter.passthrough(),
  }),
);

const PluginManifest = Schema.Struct({
  pluginId: TrimmedNonEmptyString,
  version: OptionalTrimmedNonEmptyString,
  provenance: TrimmedNonEmptyString,
  authRecipe: Schema.Unknown,
  requiredConnections: Schema.Array(ConnectionSystem),
  contributions: Schema.Array(ManifestContribution),
});
type PluginManifest = typeof PluginManifest.Type;

const McpServerFile = Schema.Struct({
  endpoint: TrimmedNonEmptyString,
  secret: Schema.optionalKey(Schema.Struct({ env: TrimmedNonEmptyString })),
});

const decodeCatalog = Schema.decodeUnknownEffect(Schema.fromJsonString(CatalogDocument));
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginManifest));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeMcpServer = Schema.decodeUnknownEffect(McpServerFile);
const bareEnvironmentInterpolation = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;

export interface PluginManagerConfig {
  readonly catalogPath: string;
  readonly provisionRoot: string;
}

export interface PluginManagerService {
  readonly overview: Effect.Effect<PluginOverview, PluginFailure>;
  readonly install: (
    pluginId: string,
    principal: PrincipalId,
  ) => Effect.Effect<PluginMutationResult, PluginFailure>;
  readonly uninstall: (pluginId: string) => Effect.Effect<PluginMutationResult, PluginFailure>;
  readonly contributions: (
    workspace: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<PluginContribution>, PluginFailure>;
}

export class PluginManager extends Context.Service<PluginManager, PluginManagerService>()(
  "@cogwork/engine/plugin/PluginManager",
) {}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const failure = (operation: string, pluginId: string | null, file: string | null, error: unknown) =>
  new PluginFailure({ operation, pluginId, file, message: messageOf(error) });

const isWithin = (path: Path.Path, boundary: string, target: string) => {
  const relative = path.relative(boundary, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const hasBareEnvironmentInterpolation = (value: unknown): boolean => {
  if (typeof value === "string") return bareEnvironmentInterpolation.test(value);
  if (Array.isArray(value)) return value.some(hasBareEnvironmentInterpolation);
  if (value === null || typeof value !== "object") return false;
  return Object.values(value).some(hasBareEnvironmentInterpolation);
};

const resolvedIdentity = (manifest: PluginManifest) =>
  `${manifest.pluginId}@${manifest.version ?? manifest.provenance}`;

const provenanceStamp = (manifest: PluginManifest) =>
  manifest.version
    ? DeclaredVersion.make({ source: `plugin:${manifest.pluginId}`, version: manifest.version })
    : ContentRevision.make({ source: `plugin:${manifest.pluginId}`, revision: manifest.provenance });

const uniqueContributionIds = (manifest: PluginManifest) => {
  const ids = manifest.contributions.map((entry) =>
    pluginContributionId(manifest.pluginId, entry.kind, entry.localName),
  );
  return new Set(ids).size === ids.length ? ids : null;
};

const missingReadiness = (system: string) =>
  ({
    _tag: "NotReady",
    reason: `${system} Connection is not established`,
  }) satisfies ConnectionReadiness;

const installedContributionsOf = (plugins: readonly PluginItem[]) =>
  plugins.flatMap((plugin) => (plugin.record ? plugin.contributions : []));

const loadedContribution = (
  pluginId: string,
  pointer: ManifestContribution,
  file: string,
  mcpServer?: PluginMcpServer,
): PluginContribution => ({
  id: pluginContributionId(pluginId, pointer.kind, pointer.localName),
  authority: `plugin:${pluginId}`,
  kind: pointer.kind,
  localName: pointer.localName,
  summary: pointer.summary,
  file,
  load: { _tag: "Loaded", ...(mcpServer ? { mcpServer } : {}) },
});

const failedContribution = (
  pluginId: string,
  pointer: ManifestContribution,
  file: string,
  reason: string,
): PluginContribution => ({
  id: pluginContributionId(pluginId, pointer.kind, pointer.localName),
  authority: `plugin:${pluginId}`,
  kind: pointer.kind,
  localName: pointer.localName,
  summary: pointer.summary,
  file,
  load: { _tag: "Failed", reason },
});

export const make = Effect.fn("PluginManager.make")(function* (config: PluginManagerConfig) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* ControlStore;
  const connections = yield* ConnectionStore;
  const catalogRoot = path.dirname(config.catalogPath);

  const readFile = Effect.fn("PluginManager.readFile")(function* (
    operation: string,
    pluginId: string | null,
    file: string,
  ) {
    return yield* fs
      .readFileString(file)
      .pipe(Effect.mapError((error) => failure(operation, pluginId, file, error)));
  });

  const readCatalog = Effect.fn("PluginManager.readCatalog")(function* () {
    const content = yield* readFile("read Plugin catalog", null, config.catalogPath);
    const document = yield* decodeCatalog(content).pipe(
      Effect.mapError((error) => failure("read Plugin catalog", null, config.catalogPath, error)),
    );
    const ids = document.plugins.map((entry) => entry.pluginId);
    if (new Set(ids).size !== ids.length) {
      return yield* failure("read Plugin catalog", null, config.catalogPath, "duplicate Plugin id");
    }
    return document.plugins;
  });

  const bundlePathOf = Effect.fn("PluginManager.bundlePath")(function* (entry: CatalogEntry) {
    const bundlePath = path.resolve(catalogRoot, entry.bundle);
    if (isWithin(path, catalogRoot, bundlePath)) return bundlePath;
    return yield* failure(
      "read Plugin catalog",
      entry.pluginId,
      config.catalogPath,
      "bundle escapes catalog",
    );
  });

  const loadManifest = Effect.fn("PluginManager.loadManifest")(function* (
    entry: CatalogEntry,
    bundlePath: string,
  ) {
    const file = path.join(bundlePath, "plugin.json");
    const content = yield* readFile("load Plugin manifest", entry.pluginId, file);
    const manifest = yield* decodeManifest(content).pipe(
      Effect.mapError((error) => failure("load Plugin manifest", entry.pluginId, file, error)),
    );
    if (manifest.pluginId !== entry.pluginId) {
      return yield* failure(
        "load Plugin manifest",
        entry.pluginId,
        file,
        "manifest Plugin id does not match catalog",
      );
    }
    if (uniqueContributionIds(manifest) !== null) return manifest;
    return yield* failure("load Plugin manifest", entry.pluginId, file, "duplicate contribution identity");
  });

  const loadMcpServer = Effect.fn("PluginManager.loadMcpServer")(function* (pluginId: string, file: string) {
    const content = yield* readFile("load Plugin contribution", pluginId, file);
    const json = yield* decodeJson(content).pipe(
      Effect.mapError((error) => failure("load Plugin contribution", pluginId, file, error)),
    );
    if (hasBareEnvironmentInterpolation(json)) {
      return yield* failure(
        "load Plugin contribution",
        pluginId,
        file,
        "bare environment interpolation is inadmissible; use a structured env reference",
      );
    }
    const decoded = yield* decodeMcpServer(json).pipe(
      Effect.mapError((error) => failure("load Plugin contribution", pluginId, file, error)),
    );
    return { endpoint: decoded.endpoint, secretEnv: decoded.secret?.env ?? null };
  });

  const loadMarkdown = Effect.fn("PluginManager.loadMarkdown")(function* (pluginId: string, file: string) {
    const content = yield* readFile("load Plugin contribution", pluginId, file);
    if (content.trim() !== "") return;
    return yield* failure("load Plugin contribution", pluginId, file, "file is empty");
  });

  const loadRequirement = Effect.fn("PluginManager.loadRequirement")(function* (
    pluginId: string,
    file: string,
    requirement: ConnectionSystemType,
  ) {
    const connection = yield* connections
      .findSystem(requirement)
      .pipe(Effect.mapError((error) => failure("load Plugin contribution", pluginId, file, error)));
    const readiness = connection
      ? yield* connections.readiness(connection.id)
      : missingReadiness(requirement);
    return { connection, readiness };
  });

  const contributionsOf = Effect.fn("PluginManager.contributionsOf")(function* (
    manifest: PluginManifest,
    bundlePath: string,
  ) {
    const requirements = yield* Effect.forEach(manifest.requiredConnections, (requirement) =>
      loadRequirement(manifest.pluginId, bundlePath, requirement),
    );
    const credentialAvailable = requirements.every((requirement) => requirement.readiness._tag === "Ready");
    const connectionId = requirements[0]?.connection?.id;
    return yield* Effect.forEach(manifest.contributions, (pointer) => {
      const file = path.resolve(bundlePath, pointer.file);
      return Effect.gen(function* () {
        if (!isWithin(path, bundlePath, file)) {
          return yield* failure("load Plugin contribution", manifest.pluginId, file, "file escapes bundle");
        }
        const canonicalBundle = yield* fs.realPath(bundlePath);
        const canonicalFile = yield* fs.realPath(file);
        if (!isWithin(path, canonicalBundle, canonicalFile)) {
          return yield* failure("load Plugin contribution", manifest.pluginId, file, "file escapes bundle");
        }
        if (pointer.kind !== "mcp-server") {
          yield* loadMarkdown(manifest.pluginId, canonicalFile);
          return loadedContribution(manifest.pluginId, pointer, canonicalFile);
        }
        const loaded = yield* loadMcpServer(manifest.pluginId, canonicalFile);
        const mcpServer = {
          ...loaded,
          credentialAvailable,
          ...(connectionId ? { connectionId } : {}),
        };
        return loadedContribution(manifest.pluginId, pointer, canonicalFile, mcpServer);
      }).pipe(
        Effect.match({
          onFailure: (error) => failedContribution(manifest.pluginId, pointer, file, error.message),
          onSuccess: (contribution) => contribution,
        }),
      );
    });
  });

  const itemFrom = Effect.fn("PluginManager.itemFrom")(function* (
    entry: CatalogEntry,
    record: PluginInstall | null,
  ) {
    const item: Pick<PluginItem, "pluginId" | "name" | "summary" | "record"> = {
      pluginId: entry.pluginId,
      name: entry.name,
      summary: entry.summary,
      record,
    };
    const source = record
      ? path.join(config.provisionRoot, record.resolvedIdentity)
      : yield* bundlePathOf(entry);
    return yield* loadManifest(entry, source).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.succeed({
            ...item,
            resolvedIdentity: record?.resolvedIdentity ?? null,
            provenanceStamp: null,
            requiredConnections: [],
            contributions: [],
            manifestFailure: error.message,
          } satisfies PluginItem),
        onSuccess: (manifest) =>
          Effect.map(
            record ? contributionsOf(manifest, source) : Effect.succeed([]),
            (contributions) =>
              ({
                ...item,
                resolvedIdentity: resolvedIdentity(manifest),
                provenanceStamp: provenanceStamp(manifest),
                requiredConnections: manifest.requiredConnections,
                contributions,
                manifestFailure: null,
              }) satisfies PluginItem,
          ),
      }),
    );
  });

  const overview = Effect.fn("PluginManager.overview")(function* () {
    const entries = yield* readCatalog();
    const picture = yield* store.picture.pipe(
      Effect.mapError((error) => failure("read Plugin installs", null, null, error)),
    );
    const plugins = yield* Effect.forEach(entries, (entry) =>
      itemFrom(entry, picture.pluginInstalls.find((record) => record.pluginId === entry.pluginId) ?? null),
    );
    const requirements = plugins.flatMap((plugin) =>
      plugin.requiredConnections.map((connection) => ({ connection, pluginId: plugin.pluginId })),
    );
    const duplicate = requirements.find(
      (requirement, index) =>
        requirements.findIndex((candidate) => candidate.connection === requirement.connection) !== index,
    );
    if (duplicate) {
      return yield* failure(
        "read Plugin catalog",
        duplicate.pluginId,
        config.catalogPath,
        `multiple first-party Plugins require the ${duplicate.connection} Connection`,
      );
    }
    return { plugins } satisfies PluginOverview;
  });

  const retainedConnectionNotices = Effect.fn("PluginManager.retainedConnectionNotices")(function* (
    item: PluginItem,
  ) {
    const retained = yield* Effect.forEach(item.requiredConnections, (requirement) =>
      Effect.gen(function* () {
        const connection = yield* connections
          .findSystem(requirement)
          .pipe(Effect.mapError((error) => failure("uninstall Plugin", item.pluginId, null, error)));
        return connection?.status === "established" ? requirement : null;
      }),
    );
    return retained.flatMap((connection) =>
      connection ? [`The ${connection} Connection remains established.`] : [],
    );
  });

  const provision = Effect.fn("PluginManager.provision")(function* (bundlePath: string, identity: string) {
    yield* fs.makeDirectory(config.provisionRoot, { recursive: true, mode: 0o700 });
    const destination = path.resolve(config.provisionRoot, identity);
    if (!isWithin(path, config.provisionRoot, destination)) {
      return yield* failure("provision Plugin", null, destination, "identity escapes provision root");
    }
    if (yield* fs.exists(destination)) return destination;
    const staging = yield* fs.makeTempDirectory({
      directory: config.provisionRoot,
      prefix: ".install-",
    });
    yield* fs
      .copy(bundlePath, staging, { overwrite: true })
      .pipe(
        Effect.andThen(fs.rename(staging, destination)),
        Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
      );
    return destination;
  });

  const install = Effect.fn("PluginManager.install")(function* (pluginId: string, principal: PrincipalId) {
    return yield* store.withWrite(
      Effect.gen(function* () {
        const entries = yield* readCatalog();
        const entry = entries.find((candidate) => candidate.pluginId === pluginId);
        if (!entry)
          return yield* failure("install Plugin", pluginId, config.catalogPath, "Plugin is not in catalog");
        const bundlePath = yield* bundlePathOf(entry);
        const manifest = yield* loadManifest(entry, bundlePath);
        const identity = resolvedIdentity(manifest);
        const contributions = yield* contributionsOf(manifest, bundlePath);
        yield* provision(bundlePath, identity).pipe(
          Effect.mapError((error) => failure("provision Plugin", pluginId, bundlePath, error)),
        );
        const installedAtMillis = yield* Clock.currentTimeMillis;
        yield* store
          .installPlugin(
            { pluginId, resolvedIdentity: identity, principal, installedAtMillis },
            manifest.contributions.map((pointer) =>
              pluginContributionId(pluginId, pointer.kind, pointer.localName),
            ),
            contributions.flatMap((contribution) =>
              contribution.kind === "mcp-server" && contribution.load._tag === "Loaded"
                ? [contribution.id]
                : [],
            ),
          )
          .pipe(Effect.mapError((error) => failure("install Plugin", pluginId, null, error)));
        return { overview: yield* overview(), notices: [] } satisfies PluginMutationResult;
      }),
    );
  });

  const reclaim = Effect.fn("PluginManager.reclaim")(function* (record: PluginInstall) {
    const installedPath = path.resolve(config.provisionRoot, record.resolvedIdentity);
    if (!isWithin(path, config.provisionRoot, installedPath)) {
      return yield* failure(
        "reclaim Plugin",
        record.pluginId,
        installedPath,
        "identity escapes provision root",
      );
    }
    if (!(yield* fs.exists(installedPath))) return null;
    const reclaimer = path.join(config.provisionRoot, ".reclaim");
    yield* fs.makeDirectory(reclaimer, { recursive: true, mode: 0o700 });
    const target = path.join(reclaimer, `${record.resolvedIdentity}--${record.installedAtMillis}`);
    yield* fs.rename(installedPath, target);
    return { installedPath, target };
  });

  const restore = Effect.fn("PluginManager.restore")(function* (
    reclaimed: { readonly installedPath: string; readonly target: string } | null,
  ) {
    if (!reclaimed) return;
    yield* fs.rename(reclaimed.target, reclaimed.installedPath);
  });

  const uninstall = Effect.fn("PluginManager.uninstall")(function* (pluginId: string) {
    return yield* store.withWrite(
      Effect.gen(function* () {
        const before = yield* overview();
        const item = before.plugins.find((candidate) => candidate.pluginId === pluginId);
        if (!item?.record) {
          return yield* failure("uninstall Plugin", pluginId, null, "Plugin is not installed");
        }
        const reclaimed = yield* reclaim(item.record).pipe(
          Effect.mapError((error) => failure("reclaim Plugin", pluginId, null, error)),
        );
        yield* store.uninstallPlugin(pluginId).pipe(
          Effect.mapError((error) => failure("uninstall Plugin", pluginId, null, error)),
          Effect.onExit((exit) => {
            if (Exit.isSuccess(exit)) return Effect.void;
            return restore(reclaimed).pipe(
              Effect.mapError((restoreError) =>
                failure("restore Plugin", pluginId, reclaimed?.installedPath ?? null, restoreError),
              ),
            );
          }),
        );
        return {
          overview: yield* overview(),
          notices: yield* retainedConnectionNotices(item),
        } satisfies PluginMutationResult;
      }),
    );
  });

  if (store.health === "available") {
    const availableStore = store;
    yield* availableStore.picture.pipe(
      Effect.flatMap((picture) =>
        Effect.forEach(
          picture.pluginInstalls,
          (record) =>
            Effect.gen(function* () {
              const entries = yield* readCatalog();
              const entry = entries.find((candidate) => candidate.pluginId === record.pluginId);
              if (!entry) return;
              const bundlePath = yield* bundlePathOf(entry);
              const manifest = yield* loadManifest(entry, bundlePath);
              const identity = resolvedIdentity(manifest);
              if (identity === record.resolvedIdentity) return;
              const contributions = yield* contributionsOf(manifest, bundlePath);
              yield* provision(bundlePath, identity);
              const installedAtMillis = yield* Clock.currentTimeMillis;
              yield* availableStore.withWrite(
                availableStore.installPlugin(
                  { ...record, resolvedIdentity: identity, installedAtMillis },
                  manifest.contributions.map((pointer) =>
                    pluginContributionId(record.pluginId, pointer.kind, pointer.localName),
                  ),
                  contributions.flatMap((contribution) =>
                    contribution.kind === "mcp-server" && contribution.load._tag === "Loaded"
                      ? [contribution.id]
                      : [],
                  ),
                ),
              );
              yield* reclaim(record);
            }).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Plugin update was not adopted", {
                  pluginId: record.pluginId,
                  message: messageOf(error),
                }),
              ),
            ),
          { discard: true },
        ),
      ),
      Effect.mapError((error) => failure("load Plugin installs", null, null, error)),
    );
  }

  return {
    overview: overview(),
    install,
    uninstall,
    contributions: () =>
      overview().pipe(
        Effect.map((overview) => installedContributionsOf(overview.plugins)),
        Effect.mapError((error) => failure("read Plugin contributions", null, null, error)),
      ),
  } satisfies PluginManagerService;
});

export const pluginManagerLayer = (config: PluginManagerConfig) => Layer.effect(PluginManager, make(config));
