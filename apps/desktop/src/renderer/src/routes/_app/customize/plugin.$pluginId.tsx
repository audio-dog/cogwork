import { createFileRoute, redirect } from "@tanstack/react-router";
import { PluginDetail } from "../../../components/plugin-detail";
import { placeholderConfiguration } from "../../../features/configuration-placeholder";

const findPlugin = (pluginId: string) =>
  placeholderConfiguration.plugins.find((plugin) => plugin.record.pluginId === pluginId);

export const Route = createFileRoute("/_app/customize/plugin/$pluginId")({
  beforeLoad: ({ params }) => {
    if (findPlugin(params.pluginId)) return;
    throw redirect({ to: "/customize/$facet", params: { facet: "plugins" } });
  },
  component: PluginRoute,
});

function PluginRoute() {
  const plugin = findPlugin(Route.useParams().pluginId);
  if (!plugin) return null;
  return <PluginDetail plugin={plugin} />;
}
