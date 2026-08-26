import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { ItemActions, ItemContent, ItemDescription, ItemTitle } from "@cogwork/ui/components/item";
import { RiBox3Line } from "@remixicon/react";
import { useNavigate } from "@tanstack/react-router";
import type { CatalogEntry, InstalledPlugin } from "../features/configuration-model";
import { attentionAction, attentionLine, attentionOf } from "../features/plugins-view";
import { ListRow, ListRowButton, ListRowMedia } from "./customize-list";

function usePluginNavigate(plugin: InstalledPlugin) {
  const navigate = useNavigate();
  return () => navigate({ to: "/customize/plugin/$pluginId", params: { pluginId: plugin.record.pluginId } });
}

export function PluginRow({ plugin }: { plugin: InstalledPlugin }) {
  const open = usePluginNavigate(plugin);
  return (
    <ListRowButton onOpen={open}>
      <ListRowMedia>
        <RiBox3Line />
      </ListRowMedia>
      <ItemContent>
        <ItemTitle>{plugin.name}</ItemTitle>
        <ItemDescription>{plugin.summary}</ItemDescription>
      </ItemContent>
    </ListRowButton>
  );
}

export function PluginAttentionRow({ plugin }: { plugin: InstalledPlugin }) {
  const open = usePluginNavigate(plugin);
  const attention = attentionOf(plugin);
  const action = attentionAction(attention);
  const failed = attention._tag === "load-failed";

  return (
    <ListRowButton onOpen={open}>
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
    </ListRowButton>
  );
}

export function CatalogPluginRow({ entry, added }: { entry: CatalogEntry; added: boolean }) {
  return (
    <ListRow>
      <ListRowMedia>
        <RiBox3Line />
      </ListRowMedia>
      <ItemContent>
        <ItemTitle>{entry.name}</ItemTitle>
        <ItemDescription>{entry.summary}</ItemDescription>
      </ItemContent>
      <ItemActions>
        {added ? (
          <Badge variant="ghost">Added</Badge>
        ) : (
          <Button size="sm" variant="outline">
            Add
          </Button>
        )}
      </ItemActions>
    </ListRow>
  );
}
