import type { ConnectionSystem, IssueTrackerError } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

export const layer = Layer.effect(
  ConnectionVerifier,
  Effect.gen(function* () {
    const github = yield* GitHubClient;
    const verifiers = {
      github: (credential: Credential) => github.verifyCredential(credential.token),
      linear: (credential: Credential) => verifyLinear(credential).pipe(Effect.map(() => null)),
      granola: () => Effect.succeed(null),
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
