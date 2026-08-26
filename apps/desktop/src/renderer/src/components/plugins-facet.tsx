// The Plugins facet: what is on, what needs you, and what else ships with cogwork.
//
// Every Plugin is first-party. There is no marketplace, no update to stage, decline or pin, and no
// catalog to fetch — the catalog is a document in the app. So the only states a row can be in are
// *fine*, *its file will not load*, and *its setup is unfinished*.

import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import { RiBox3Line } from "@remixicon/react";
import { useNavigate } from "@tanstack/react-router";
import type { CatalogEntry, InstalledPlugin } from "../features/configuration-model";
import { placeholderConfiguration } from "../features/configuration-placeholder";
import { attentionAction, attentionLine, attentionOf, needsAttention } from "../features/plugins-view";
import { ListRow, ListRows, ListSection } from "./customize-list";

const { plugins, catalog } = placeholderConfiguration;

function PluginRow({ plugin, showAttention }: { plugin: InstalledPlugin; showAttention: boolean }) {
  const navigate = useNavigate();
  const attention = attentionOf(plugin);
  const action = attentionAction(attention);
  const failed = attention._tag === "load-failed";

  return (
    <ListRow
      icon={<RiBox3Line />}
      status={showAttention ? (failed ? "error" : "attention") : "ok"}
      title={plugin.name}
      detail={showAttention ? attentionLine(attention) : plugin.summary}
      trailing={
        showAttention && action ? (
          <Button size="sm" variant={failed ? "outline" : "default"}>
            {action}
          </Button>
        ) : null
      }
      onOpen={() => navigate({ to: "/customize/$pluginId", params: { pluginId: plugin.record.pluginId } })}
    />
  );
}

function CatalogRow({ entry, installed }: { entry: CatalogEntry; installed: boolean }) {
  return (
    <ListRow
      icon={<RiBox3Line />}
      title={entry.name}
      detail={entry.summary}
      trailing={
        installed ? (
          <Badge variant="ghost">Added</Badge>
        ) : (
          <Button size="sm" variant="outline">
            Add
          </Button>
        )
      }
    />
  );
}

export function PluginsFacet() {
  const attention = plugins.filter(needsAttention);
  const settled = plugins.filter((plugin) => !needsAttention(plugin));
  const added = plugins
    .map((plugin) => plugin.record.source)
    .filter((source) => source._tag === "catalog")
    .map((source) => source.entryId);

  return (
    <div className="flex flex-col gap-6">
      {attention.length > 0 ? (
        <ListSection title="Needs you" count={attention.length}>
          <ListRows>
            {attention.map((plugin) => (
              <PluginRow key={plugin.record.pluginId} plugin={plugin} showAttention />
            ))}
          </ListRows>
        </ListSection>
      ) : null}

      <ListSection title="Added" count={settled.length}>
        {settled.length === 0 ? (
          <Empty className="py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <RiBox3Line />
              </EmptyMedia>
              <EmptyTitle>Every Plugin needs something</EmptyTitle>
              <EmptyDescription>They are all in the list above.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ListRows>
            {settled.map((plugin) => (
              <PluginRow key={plugin.record.pluginId} plugin={plugin} showAttention={false} />
            ))}
          </ListRows>
        )}
      </ListSection>

      <ListSection title="Ships with cogwork" count={catalog.length}>
        <ListRows>
          {catalog.map((entry) => (
            <CatalogRow key={entry.id} entry={entry} installed={added.includes(entry.id)} />
          ))}
        </ListRows>
      </ListSection>

      <p className="text-xs text-muted-foreground">
        {/* Worth stating on the page, because the shape of the list depends on it. */}
        Every Plugin is built by us and ships with cogwork. Adding one turns on what it contributes; it does
        not download anything.
      </p>
    </div>
  );
}
