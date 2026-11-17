import { type ConnectionSystem, IssueTrackerError } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { Credential } from "./credential-store";
import { GitHubClient } from "./github/client";
import { type GranolaHttpFailure, makeGranolaHttp } from "./granola-http";
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

const sourceFailure = (error: GranolaHttpFailure) =>
  granolaFailure(error.reason === "auth" ? "auth" : "unavailable", error.message);

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
  const body = yield* makeGranolaHttp(client)
    .execute(credential, request)
    .pipe(Effect.mapError(sourceFailure));
  yield* Schema.decodeUnknownEffect(GranolaInitializeResponse)(body).pipe(
    Effect.mapError(() => granolaFailure("unavailable", "Granola returned an invalid initialize response")),
  );
  return null;
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
