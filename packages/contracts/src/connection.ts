import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, WorkspaceId } from "./base-schemas";

export const ConnectionSystem = Schema.Literals(["github", "linear", "granola"]);
export type ConnectionSystem = typeof ConnectionSystem.Type;

export const ConnectionId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^(github|linear|granola)\/.+$/),
).pipe(Schema.brand("ConnectionId"));
export type ConnectionId = typeof ConnectionId.Type;

export const ConnectionBindingId = Schema.Union([ConnectionId, Schema.Literal("unbound")]);
export type ConnectionBindingId = typeof ConnectionBindingId.Type;

export const ConnectionStatus = Schema.Literals(["established", "revoked"]);
export type ConnectionStatus = typeof ConnectionStatus.Type;

export class Connection extends Schema.Class<Connection>("Connection")({
  id: ConnectionId,
  system: ConnectionSystem,
  account: TrimmedNonEmptyString,
  status: ConnectionStatus,
}) {}

export const ConnectionSource = Schema.TaggedUnion({
  Env: { name: TrimmedNonEmptyString },
  ApiKey: { key: Schema.RedactedFromValue(TrimmedNonEmptyString) },
  GitHubCli: {},
  Stored: {},
});
export type ConnectionSource = typeof ConnectionSource.Type;

export const ConnectionEstablishment = Schema.Union([
  Schema.Struct({ system: Schema.Literal("github"), source: ConnectionSource }),
  Schema.Struct({
    system: Schema.Literal("linear"),
    account: TrimmedNonEmptyString,
    source: ConnectionSource,
  }),
  Schema.Struct({
    system: Schema.Literal("granola"),
    account: TrimmedNonEmptyString,
    source: ConnectionSource,
  }),
]).pipe(Schema.toTaggedUnion("system"));
export type ConnectionEstablishment = typeof ConnectionEstablishment.Type;

export const ConnectionReadiness = Schema.TaggedUnion({
  Ready: {},
  NotReady: { reason: TrimmedNonEmptyString },
});
export type ConnectionReadiness = typeof ConnectionReadiness.Type;

export const ConnectionItem = Schema.Struct({
  system: ConnectionSystem,
  connection: Schema.NullOr(Connection),
  readiness: ConnectionReadiness,
});
export type ConnectionItem = typeof ConnectionItem.Type;

export const ConnectionOverview = Schema.Struct({
  connections: Schema.Array(ConnectionItem),
});
export type ConnectionOverview = typeof ConnectionOverview.Type;

export const ConnectionMutationResult = Schema.Struct({
  overview: ConnectionOverview,
  danglingWorkspaces: Schema.Array(WorkspaceId),
});
export type ConnectionMutationResult = typeof ConnectionMutationResult.Type;

export class ConnectionFailure extends Schema.TaggedError<ConnectionFailure>()("ConnectionFailure", {
  operation: TrimmedNonEmptyString,
  connectionId: Schema.NullOr(ConnectionId),
  message: TrimmedNonEmptyString,
}) {}

export class ConnectionNotReady extends Schema.TaggedError<ConnectionNotReady>()("ConnectionNotReady", {
  connectionId: Schema.NullOr(ConnectionId),
  message: TrimmedNonEmptyString,
}) {}

const decodeConnectionId = Schema.decodeSync(ConnectionId);

export const connectionIdOf = (system: ConnectionSystem, account: string) =>
  decodeConnectionId(`${system}/${account}`);

export const connectionSystemOf = (connectionId: string) => {
  const system = connectionId.split("/", 1)[0];
  return ConnectionSystem.literals.find((candidate) => candidate === system) ?? null;
};

export const connectionAccountOf = (connectionId: string) =>
  connectionId.slice(connectionId.indexOf("/") + 1);
