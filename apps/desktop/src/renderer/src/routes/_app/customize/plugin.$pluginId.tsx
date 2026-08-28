import { createFileRoute, redirect } from "@tanstack/react-router";
import { useConfiguration } from "../../../components/configuration-provider";
import { PluginDetail } from "../../../components/plugin-detail";

export const Route = createFileRoute("/_app/customize/plugin/$pluginId")({
  component: PluginRoute,
});

function PluginRoute() {
  const {
    state: { picture },
  } = useConfiguration();
  const { pluginId } = Route.useParams();
  const plugin = picture.plugins.find((entry) => entry.record.pluginId === pluginId);
  if (!plugin) throw redirect({ to: "/customize/$facet", params: { facet: "plugins" } });
  return <PluginDetail plugin={plugin} />;
}
