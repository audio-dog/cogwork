import type { ConnectionItem, ConnectionOverview, ConnectionSystem } from "@cogwork/contracts";

const workspaceConnectionChoice = (item: ConnectionItem, bindings: readonly string[]) => {
  if (!item.connection) return [];
  if (item.readiness._tag === "Ready") return [item.connection];
  if (bindings.includes(item.connection.id)) return [item.connection];
  return [];
};

export const workspaceConnectionChoices = (
  overview: ConnectionOverview | null | undefined,
  bindings: readonly string[],
) => overview?.connections.flatMap((item) => workspaceConnectionChoice(item, bindings)) ?? [];

const connectionSystemLabels: Record<ConnectionSystem, string> = {
  github: "GitHub",
  linear: "Linear",
  granola: "Granola",
};

export const connectionSystemLabel = (system: ConnectionSystem) => connectionSystemLabels[system];

// Tone travels with the label because the badge that renders it has to agree with the copy: every
// caller that shows one shows the other.
export const connectionStatus = (item: ConnectionItem) => {
  if (!item.connection) return { label: "Not connected", tone: "neutral" } as const;
  if (item.readiness._tag === "Ready") return { label: "Connected", tone: "positive" } as const;
  return { label: "Needs re-connect", tone: "warning" } as const;
};

export const connectionAction = (item: ConnectionItem) => {
  if (!item.connection) return "establish";
  if (item.readiness._tag === "Ready") return "none";
  return "re-connect";
};

export { pluginRequiringConnection as pluginRequiring } from "@cogwork/contracts";
