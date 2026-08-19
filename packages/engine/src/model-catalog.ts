import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

export const catalogEndpoint = "https://models.dev/api.json";

export const defaultTtlMillis = 5 * 60_000;

const CatalogModelEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
});

const CatalogProviderEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  models: Schema.Record(Schema.String, CatalogModelEntry),
});

export const CatalogApi = Schema.Record(Schema.String, CatalogProviderEntry);
export type CatalogApi = typeof CatalogApi.Type;

const decodeCatalog = Schema.decodeUnknownEffect(CatalogApi);

export interface CatalogModel {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
}

export class CatalogError extends Schema.TaggedError<CatalogError>()("CatalogError", {
  message: Schema.String,
}) {}

export interface CatalogSource {
  readonly fetch: Effect.Effect<CatalogApi, CatalogError>;
}

export interface ModelCatalogService {
  readonly models: (
    providerIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<CatalogModel>, CatalogError>;
}

export class ModelCatalog extends Context.Service<ModelCatalog, ModelCatalogService>()(
  "@cogwork/engine/model-catalog/ModelCatalog",
) {}

const modelsFor = (api: CatalogApi, providerIds: ReadonlyArray<string>) =>
  providerIds.flatMap((providerId): ReadonlyArray<CatalogModel> => {
    const provider = api[providerId];
    if (!provider) return [];
    return Object.values(provider.models)
      .map((model) => ({ provider: providerId, id: model.id, name: model.name ?? model.id }))
      .sort((left, right) => left.id.localeCompare(right.id));
  });

interface CatalogSnapshot {
  readonly at: number;
  readonly api: CatalogApi;
}

export const makeService = Effect.fn("ModelCatalog.make")(function* (
  source: CatalogSource,
  ttlMillis: number = defaultTtlMillis,
) {
  const cache = yield* Ref.make<CatalogSnapshot | null>(null);

  const currentApi = Effect.fn("ModelCatalog.currentApi")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(cache);
    if (cached && now - cached.at < ttlMillis) return cached.api;
    return yield* source.fetch.pipe(
      Effect.tap((api) => Ref.set(cache, { at: now, api })),
      Effect.catch((error) =>
        cached
          ? Effect.logWarning("serving a stale model catalog; refresh failed", {
              message: error.message,
            }).pipe(Effect.map(() => cached.api))
          : Effect.fail(error),
      ),
    );
  });

  const models = Effect.fn("ModelCatalog.models")(function* (providerIds: ReadonlyArray<string>) {
    const api = yield* currentApi();
    return modelsFor(api, providerIds);
  });

  return { models } satisfies ModelCatalogService;
});

export const httpSource = (
  client: HttpClient.HttpClient,
  endpoint: string = catalogEndpoint,
): CatalogSource => ({
  fetch: Effect.gen(function* () {
    const response = yield* client
      .execute(HttpClientRequest.get(endpoint))
      .pipe(
        Effect.mapError(
          (error) => new CatalogError({ message: `could not reach the model catalog: ${error.message}` }),
        ),
      );
    if (response.status !== 200) {
      return yield* new CatalogError({ message: `the model catalog returned HTTP ${response.status}` });
    }
    const body = yield* response.json.pipe(
      Effect.mapError(() => new CatalogError({ message: "the model catalog returned an unreadable body" })),
    );
    return yield* decodeCatalog(body).pipe(
      Effect.mapError(() => new CatalogError({ message: "the model catalog returned an unexpected shape" })),
    );
  }).pipe(Effect.withSpan("ModelCatalog.httpFetch")),
});

export const layer = Layer.effect(
  ModelCatalog,
  Effect.flatMap(HttpClient.HttpClient, (client) => makeService(httpSource(client))),
);
