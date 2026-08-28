import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useConfiguration } from "../../../components/configuration-provider";
import { PluginDetail } from "../../../components/plugin-detail";

export const Route = createFileRoute("/_app/customize/plugin/$pluginId")({
  component: PluginRoute,
});

function PluginRoute() {
  const {
    state: { picture },
  } = useConfiguration();
  const pluginId = Route.useParams().pluginId;
  const plugin = picture.plugins.find((candidate) => candidate.record.pluginId === pluginId);
  if (!plugin) return <Navigate to="/customize/$facet" params={{ facet: "plugins" }} replace />;
  return <PluginDetail plugin={plugin} />;
}
