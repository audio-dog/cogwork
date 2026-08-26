import { createFileRoute, redirect } from "@tanstack/react-router";
import { PluginDetail } from "../../../components/plugin-detail";
import { placeholderConfiguration } from "../../../features/configuration-placeholder";

export const Route = createFileRoute("/_app/customize/$pluginId")({
  beforeLoad: ({ params }) => {
    const known = placeholderConfiguration.plugins.some(
      (plugin) => plugin.record.pluginId === params.pluginId,
    );
    if (!known) throw redirect({ to: "/customize" });
  },
  component: PluginRoute,
});

function PluginRoute() {
  const { pluginId } = Route.useParams();
  const plugin = placeholderConfiguration.plugins.find((entry) => entry.record.pluginId === pluginId);
  if (!plugin) return null;
  return <PluginDetail plugin={plugin} />;
}
