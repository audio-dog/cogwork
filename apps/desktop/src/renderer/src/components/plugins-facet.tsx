import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import { RiBox3Line } from "@remixicon/react";
import type { InstalledPlugin } from "../features/configuration-model";
import { useConfiguration } from "./configuration-provider";
import { SearchEmpty } from "./customize-empty";
import { useCustomizeFilter } from "./customize-filter";
import { ListSection, ListSectionBody, ListSectionHeader, ListSectionRows } from "./customize-list";
import { PluginAttentionRow, PluginRow } from "./plugin-list-rows";

const matches = (query: string, ...fields: readonly string[]) => {
  const needle = query.trim().toLowerCase();
  return needle === "" || fields.join(" ").toLowerCase().includes(needle);
};

const pluginKey = (plugin: InstalledPlugin) => plugin.record.pluginId;

export function PluginsFacet() {
  const {
    state: { picture },
    meta: { plugins: pluginAxis },
  } = useConfiguration();
  const {
    state: { query },
  } = useCustomizeFilter();

  const found = picture.plugins.filter((plugin) => matches(query, plugin.name, plugin.summary));
  const attention = found.filter(pluginAxis.needsAttention);
  const settled = found.filter((plugin) => !pluginAxis.needsAttention(plugin));

  // "Everything's in the list above" is only true when there is a list above.
  if (found.length === 0) return <SearchEmpty icon={RiBox3Line} label="Plugins" />;

  return (
    <div className="flex flex-col gap-6">
      {attention.length > 0 ? (
        <ListSection>
          <ListSectionHeader title="Needs Attention" count={attention.length} />
          <ListSectionRows items={attention} keyOf={pluginKey}>
            {(plugin) => <PluginAttentionRow plugin={plugin} />}
          </ListSectionRows>
        </ListSection>
      ) : null}

      <ListSection>
        <ListSectionHeader title="Installed" count={settled.length} />
        {settled.length === 0 ? (
          <ListSectionBody>
            <Empty className="py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <RiBox3Line />
                </EmptyMedia>
                <EmptyTitle>Nothing to show</EmptyTitle>
                <EmptyDescription>Everything's in the list above.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </ListSectionBody>
        ) : (
          <ListSectionRows items={settled} keyOf={pluginKey}>
            {(plugin) => <PluginRow plugin={plugin} />}
          </ListSectionRows>
        )}
      </ListSection>
    </div>
  );
}
