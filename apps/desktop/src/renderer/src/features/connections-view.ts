import type { ConnectionItem } from "@cogwork/contracts";

export const connectionStatus = (item: ConnectionItem) => {
  if (!item.connection) return "Not connected";
  return item.readiness._tag === "Ready" ? "Established" : "Needs re-connect";
};

export const connectionAction = (item: ConnectionItem) => {
  if (!item.connection) return "establish";
  if (item.readiness._tag === "Ready") return "none";
  return "re-connect";
};

export const connectionPluginLabel = (item: ConnectionItem) =>
  item.pluginId ? `Plugin: ${item.pluginId}` : "No Plugin";
