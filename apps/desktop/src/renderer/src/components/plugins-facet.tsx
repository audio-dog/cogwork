import { Alert, AlertDescription, AlertTitle } from "@cogwork/ui/components/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import { RiBox3Line } from "@remixicon/react";

import type { InstalledPlugin } from "../features/configuration-model";
import { pluginFailureTitle, useConfiguration } from "./configuration-provider";
import { SearchEmpty } from "./customize-empty";
import { useCustomizeFilter } from "./customize-filter";
import { ListSection, ListSectionBody, ListSectionHeader, ListSectionRows } from "./customize-list";
import { PluginAttentionRow, PluginCatalogRow, PluginRow } from "./plugin-list-rows";

const matches = (query: string, ...fields: readonly string[]) => {
  const needle = query.trim().toLowerCase();
  return needle === "" || fields.join(" ").toLowerCase().includes(needle);
};

const pluginKey = (plugin: InstalledPlugin) => plugin.record.pluginId;

function LoadingPlugins() {
  return (
    <Empty className="py-16">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <RiBox3Line />
        </EmptyMedia>
        <EmptyTitle>Loading Plugins</EmptyTitle>
        <EmptyDescription>Waiting for the daemon.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function NoPluginsInstalled() {
  return (
    <Empty className="py-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <RiBox3Line />
        </EmptyMedia>
        <EmptyTitle>No Plugins installed</EmptyTitle>
        <EmptyDescription>Install one from the Catalog below.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function AllInstalledPluginsNeedAttention() {
  return (
    <Empty className="py-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <RiBox3Line />
        </EmptyMedia>
        <EmptyTitle>All installed Plugins need attention</EmptyTitle>
        <EmptyDescription>Resolve them in Needs Attention above.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function PluginsFacet() {
  const {
    state: { picture },
    meta: { plugins: pluginAxis, notices, pluginFailure, pluginLoadState },
  } = useConfiguration();
  const {
    state: { query },
  } = useCustomizeFilter();

  const found = picture.plugins.filter((plugin) => matches(query, plugin.name, plugin.summary));
  const attention = found.filter(pluginAxis.needsAttention);
  const settled = found.filter((plugin) => !pluginAxis.needsAttention(plugin));
  const catalog = picture.catalogPlugins.filter((plugin) => matches(query, plugin.name, plugin.summary));
  const installedEmpty = attention.length > 0 ? <AllInstalledPluginsNeedAttention /> : <NoPluginsInstalled />;

  const empty = found.length === 0 && catalog.length === 0;
  if (empty && pluginLoadState === "loading") return <LoadingPlugins />;
  if (empty && !pluginFailure) return <SearchEmpty icon={RiBox3Line} label="Plugins" />;

  return (
    <div className="flex flex-col gap-6">
      {notices.length > 0 ? (
        <Alert>
          <AlertTitle>Plugin removed</AlertTitle>
          <AlertDescription>{notices.join(" ")}</AlertDescription>
        </Alert>
      ) : null}
      {pluginFailure ? (
        <Alert variant="destructive">
          <AlertTitle>{pluginFailureTitle(pluginFailure)}</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">{pluginFailure.message}</AlertDescription>
        </Alert>
      ) : null}

      <ListSection>
        <ListSectionHeader title="Needs Attention" count={attention.length} />
        {attention.length > 0 ? (
          <ListSectionRows items={attention} keyOf={pluginKey}>
            {(plugin) => <PluginAttentionRow plugin={plugin} />}
          </ListSectionRows>
        ) : (
          <ListSectionBody>
            <Empty className="py-8">
              <EmptyHeader>
                <EmptyTitle>Nothing needs attention</EmptyTitle>
              </EmptyHeader>
            </Empty>
          </ListSectionBody>
        )}
      </ListSection>

      <ListSection>
        <ListSectionHeader title="Installed" count={settled.length} />
        {settled.length === 0 ? (
          <ListSectionBody>{installedEmpty}</ListSectionBody>
        ) : (
          <ListSectionRows items={settled} keyOf={pluginKey}>
            {(plugin) => <PluginRow plugin={plugin} />}
          </ListSectionRows>
        )}
      </ListSection>

      <ListSection>
        <ListSectionHeader title="Catalog" count={catalog.length} />
        {catalog.length > 0 ? (
          <ListSectionRows items={catalog} keyOf={(plugin) => plugin.pluginId}>
            {(plugin) => <PluginCatalogRow plugin={plugin} />}
          </ListSectionRows>
        ) : (
          <ListSectionBody>
            <Empty className="py-8">
              <EmptyHeader>
                <EmptyTitle>Catalog empty</EmptyTitle>
              </EmptyHeader>
            </Empty>
          </ListSectionBody>
        )}
      </ListSection>
    </div>
  );
}
