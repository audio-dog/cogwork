import * as Schema from "effect/Schema";
import { makeBrand, TrimmedNonEmptyString, WorkspaceId } from "./base-schemas";

export const ConnectionId = makeBrand("ConnectionId");
export type ConnectionId = typeof ConnectionId.Type;

export const ConnectionSystem = Schema.Literals(["github", "linear"]);
export type ConnectionSystem = typeof ConnectionSystem.Type;

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
  Stored: {},
});
export type ConnectionSource = typeof ConnectionSource.Type;

export const ConnectionEstablishment = Schema.Struct({
  system: ConnectionSystem,
  account: TrimmedNonEmptyString,
  source: ConnectionSource,
});
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
  pluginId: Schema.NullOr(TrimmedNonEmptyString),
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
  connectionId: ConnectionId,
  message: TrimmedNonEmptyString,
}) {}

const decodeConnectionId = Schema.decodeSync(ConnectionId);

export const connectionIdOf = (system: ConnectionSystem, account: string) =>
  decodeConnectionId(`${system}/${account}`);

export const connectionSystemOf = (connectionId: string) => {
  const system = connectionId.split("/", 1)[0];
  return system === "github" || system === "linear" ? system : null;
};

export const connectionAccountOf = (connectionId: string) =>
  connectionId.slice(connectionId.indexOf("/") + 1);
