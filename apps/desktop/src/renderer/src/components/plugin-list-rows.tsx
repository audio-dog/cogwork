import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { ItemActions, ItemContent, ItemDescription, ItemTitle } from "@cogwork/ui/components/item";
import { RiBox3Line } from "@remixicon/react";
import { useNavigate } from "@tanstack/react-router";

import type { CatalogPlugin, InstalledPlugin } from "../features/configuration-model";
import { attentionAction, attentionLine, PluginAttention } from "../features/plugins-view";
import { useConfiguration } from "./configuration-provider";
import { ListRow, ListRowMedia, ListRowOpen } from "./customize-list";

function usePluginNavigate(plugin: InstalledPlugin) {
  const navigate = useNavigate();
  return () => navigate({ to: "/customize/plugin/$pluginId", params: { pluginId: plugin.record.pluginId } });
}

export function PluginRow({ plugin }: { plugin: InstalledPlugin }) {
  const open = usePluginNavigate(plugin);
  return (
    <ListRow>
      <ListRowOpen label={`Open ${plugin.name}`} onClick={open} />
      <ListRowMedia>
        <RiBox3Line />
      </ListRowMedia>
      <ItemContent>
        <ItemTitle>{plugin.name}</ItemTitle>
        <ItemDescription>{plugin.summary}</ItemDescription>
      </ItemContent>
    </ListRow>
  );
}

export function PluginAttentionRow({ plugin }: { plugin: InstalledPlugin }) {
  const open = usePluginNavigate(plugin);
  const {
    meta: { plugins },
  } = useConfiguration();
  const attention = plugins.attentionOf(plugin);
  const action = attentionAction(attention);
  const failed =
    PluginAttention.$is("load-failed")(attention) || PluginAttention.$is("manifest-failed")(attention);

  return (
    <ListRow>
      <ListRowOpen label={`Open ${plugin.name}`} onClick={open} />
      <ListRowMedia status={failed ? "error" : "attention"}>
        <RiBox3Line />
      </ListRowMedia>
      <ItemContent>
        <ItemTitle>{plugin.name}</ItemTitle>
        <ItemDescription>{attentionLine(attention)}</ItemDescription>
      </ItemContent>
      {action ? (
        <ItemActions>
          <Badge variant={failed ? "destructive" : "secondary"}>{action}</Badge>
        </ItemActions>
      ) : null}
    </ListRow>
  );
}

export function PluginCatalogRow({ plugin }: { plugin: CatalogPlugin }) {
  const {
    actions: { installPlugin },
  } = useConfiguration();
  return (
    <ListRow>
      <ListRowMedia>
        <RiBox3Line />
      </ListRowMedia>
      <ItemContent>
        <ItemTitle>{plugin.name}</ItemTitle>
        <ItemDescription>{plugin.manifestFailure ?? plugin.summary}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button
          size="sm"
          variant="outline"
          disabled={plugin.manifestFailure !== null}
          onClick={() => installPlugin(plugin.pluginId)}
        >
          Install
        </Button>
      </ItemActions>
    </ListRow>
  );
}
