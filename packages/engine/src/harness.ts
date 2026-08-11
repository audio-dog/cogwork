import type { AgUiEvent, HarnessName, SessionId } from "@clanker-forge/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { ResolvedMcpSkill } from "./mcp-skill";
import { SessionStore, type SessionStoreService } from "./session-store";

export type { AgUiEvent } from "@clanker-forge/contracts";
export type { ResolvedMcpSkill } from "./mcp-skill";

export interface HarnessRequest {
  readonly harness: HarnessName;
  readonly checkoutPath: string;
  readonly session: SessionId | null;
  readonly prompt: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly mcpSkills: ReadonlyArray<ResolvedMcpSkill>;
}

export class HarnessError extends Schema.TaggedErrorClass<HarnessError>()("HarnessError", {
  reason: Schema.Literals(["unknown-harness", "launch", "turn"]),
  retryable: Schema.Boolean,
  message: Schema.String,
}) {}

export interface HarnessRunner {
  readonly name: HarnessName;
  readonly run: (request: HarnessRequest) => Stream.Stream<AgUiEvent, HarnessError, SessionStore>;
}

export interface HarnessService {
  readonly run: (request: HarnessRequest) => Stream.Stream<AgUiEvent, HarnessError>;
}

export class Harness extends Context.Service<Harness, HarnessService>()("@clanker-forge/engine/harness") {}

const unknownHarness = (harness: HarnessName) =>
  new HarnessError({
    reason: "unknown-harness",
    retryable: false,
    message: `no harness runner registered for ${harness}`,
  });

export const make = (
  runners: ReadonlyArray<HarnessRunner>,
  sessionStore: SessionStoreService,
): HarnessService => {
  const registry = new Map(runners.map((runner) => [runner.name as string, runner]));
  return {
    run: (request) => {
      const runner = registry.get(request.harness);
      const stream = runner ? runner.run(request) : Stream.fail(unknownHarness(request.harness));
      return Stream.provideService(stream, SessionStore, sessionStore);
    },
  };
};

export const layer = (runners: ReadonlyArray<HarnessRunner>) =>
  Layer.effect(
    Harness,
    Effect.map(SessionStore, (sessionStore) => make(runners, sessionStore)),
  );
