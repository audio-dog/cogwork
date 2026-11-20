import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import { RiBox3Line } from "@remixicon/react";
import { createFileRoute, Navigate } from "@tanstack/react-router";

import { useConfiguration } from "../../../components/configuration-provider";
import { PluginDetail } from "../../../components/plugin-detail";
import { PluginDetailState, pluginDetailOf } from "../../../features/plugin-configuration";

export const Route = createFileRoute("/_app/customize/plugin/$pluginId")({
  component: PluginRoute,
});

function PluginRoute() {
  const {
    state: { picture },
    meta: { pluginLoadState },
  } = useConfiguration();
  const pluginId = Route.useParams().pluginId;
  const detail = pluginDetailOf(picture.plugins, pluginId, pluginLoadState);
  return PluginDetailState.$match(detail, {
    Loading: () => <LoadingPluginDetail />,
    Failed: () => <FailedPluginDetail />,
    Missing: () => <Navigate to="/customize/$facet" params={{ facet: "plugins" }} replace />,
    Ready: ({ plugin }) => <PluginDetail plugin={plugin} />,
  });
}

function LoadingPluginDetail() {
  return (
    <Empty className="py-16">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <RiBox3Line />
        </EmptyMedia>
        <EmptyTitle>Loading Plugin</EmptyTitle>
        <EmptyDescription>Waiting for the daemon.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function FailedPluginDetail() {
  return (
    <Empty className="py-16">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <RiBox3Line />
        </EmptyMedia>
        <EmptyTitle>Plugin unavailable</EmptyTitle>
        <EmptyDescription>Reconnect to the daemon.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
