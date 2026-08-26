import { Badge } from "@cogwork/ui/components/badge";
import { ItemActions, ItemContent, ItemDescription, ItemTitle } from "@cogwork/ui/components/item";
import { RiBox3Line } from "@remixicon/react";
import { useNavigate } from "@tanstack/react-router";
import type { InstalledPlugin } from "../features/configuration-model";
import { attentionAction, attentionLine } from "../features/plugins-view";
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
  const failed = attention._tag === "load-failed";

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
