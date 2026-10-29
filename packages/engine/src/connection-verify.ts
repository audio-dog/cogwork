import { type ConnectionSystem, IssueTrackerError } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type { Credential } from "./credential-store";
import { GitHubClient } from "./github/client";
import { verifyCredential as verifyLinear } from "./linear/client";

// Connection readiness is "established, unrevoked, and usable" (contracts CONTEXT.md). Resolving a
// token locally answers the first two; only the system itself answers the third, so establishment
// asks it once rather than waiting for the first reconcile poll to discover the credential is junk.
// Each adapter probes with the cheapest call that needs no repository, team, or extra scope, and
// classifies through its own existing error mapping so an outage never reads as a bad token.
export interface ConnectionVerifierService {
  readonly verify: (
    system: ConnectionSystem,
    credential: Credential,
  ) => Effect.Effect<string | null, IssueTrackerError>;
}

export class ConnectionVerifier extends Context.Service<ConnectionVerifier, ConnectionVerifierService>()(
  "@cogwork/engine/connection-verify/ConnectionVerifier",
) {}

const granolaEndpoint = "https://mcp.granola.ai/mcp";
const granolaDeadline = "10 seconds";

const granolaFailure = (reason: IssueTrackerError["reason"], message: string) =>
  new IssueTrackerError({ reason, message });

const GranolaInitializeResponse = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Literal(1),
  result: Schema.Struct({
    protocolVersion: Schema.String,
    capabilities: Schema.Record(Schema.String, Schema.Unknown),
    serverInfo: Schema.Struct({ name: Schema.String, version: Schema.String }),
  }),
});

type GranolaBodyReader = (
  response: HttpClientResponse.HttpClientResponse,
) => Effect.Effect<unknown, IssueTrackerError>;

const granolaBodyReaders = new Map<string, GranolaBodyReader>([
  [
    "application/json",
    (response) =>
      response.json.pipe(
        Effect.mapError(() => granolaFailure("unavailable", "Granola returned invalid JSON")),
      ),
  ],
  [
    "text/event-stream",
    (response) =>
      response.stream.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.takeUntil((line) => line === ""),
        Stream.runCollect,
        Effect.mapError(() => granolaFailure("unavailable", "Granola returned an unreadable event stream")),
        Effect.flatMap((lines) => {
          const data = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
          if (data === "") {
            return granolaFailure("unavailable", "Granola returned an empty event stream");
          }
          return Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(data).pipe(
            Effect.mapError(() => granolaFailure("unavailable", "Granola returned invalid event data")),
          );
        }),
      ),
  ],
]);

const isGranolaAuthStatus = (status: number) => status === 401 || status === 403;
const isGranolaFailureStatus = (status: number) => status < 200 || status >= 300;

const granolaStatusFailures = [
  {
    when: isGranolaAuthStatus,
    make: (status: number) => granolaFailure("auth", `Granola returned ${status}`),
  },
  {
    when: isGranolaFailureStatus,
    make: (status: number) => granolaFailure("unavailable", `Granola returned ${status}`),
  },
] satisfies ReadonlyArray<{
  readonly when: (status: number) => boolean;
  readonly make: (status: number) => IssueTrackerError;
}>;

const verifyGranolaResponse = Effect.fn("granola.verifyResponse")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  const statusFailure = granolaStatusFailures.find(({ when }) => when(response.status));
  if (statusFailure) return yield* statusFailure.make(response.status);
  const mediaType = response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const readBody = granolaBodyReaders.get(mediaType);
  if (!readBody) {
    return yield* granolaFailure("unavailable", `Granola returned unsupported content type "${mediaType}"`);
  }
  const body = yield* readBody(response);
  yield* Schema.decodeUnknownEffect(GranolaInitializeResponse)(body).pipe(
    Effect.mapError(() => granolaFailure("unavailable", "Granola returned an invalid initialize response")),
  );
  return null;
});

const verifyGranola = Effect.fn("granola.verifyCredential")(function* (
  client: HttpClient.HttpClient,
  credential: Credential,
) {
  const request = yield* HttpClientRequest.bodyJson(HttpClientRequest.post(granolaEndpoint), {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "cogwork", version: "0.0.1" },
    },
  }).pipe(Effect.mapError(() => granolaFailure("unavailable", "could not build the Granola probe")));
  return yield* client
    .execute(
      request.pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${Redacted.value(credential.token)}`),
        HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
      ),
    )
    .pipe(
      Effect.mapError(() => granolaFailure("unavailable", "Granola could not be reached")),
      Effect.flatMap(verifyGranolaResponse),
      Effect.timeout(granolaDeadline),
      Effect.mapError((error) =>
        error._tag === "IssueTrackerError"
          ? error
          : granolaFailure("unavailable", `Granola did not respond within ${granolaDeadline}`),
      ),
    );
});

export const layer = Layer.effect(
  ConnectionVerifier,
  Effect.gen(function* () {
    const github = yield* GitHubClient;
    const http = yield* HttpClient.HttpClient;
    const verifiers = {
      github: (credential: Credential) => github.verifyCredential(credential.token),
      linear: (credential: Credential) => verifyLinear(credential).pipe(Effect.map(() => null)),
      granola: (credential) => verifyGranola(http, credential),
      slack: (_credential) => Effect.succeed(null),
    } satisfies Record<
      ConnectionSystem,
      (credential: Credential) => Effect.Effect<string | null, IssueTrackerError>
    >;
    return {
      verify: (system, credential) => verifiers[system](credential),
    } satisfies ConnectionVerifierService;
  }),
);

// A verifier that accepts every credential. For tests and for hosts with no network egress; wiring
// it into the daemon would silently restore the hole this service exists to close.
export const acceptingLayer = Layer.succeed(ConnectionVerifier, { verify: () => Effect.succeed(null) });
