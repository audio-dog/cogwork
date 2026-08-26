import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import { RiBox3Line } from "@remixicon/react";
import { placeholderConfiguration } from "../features/configuration-placeholder";
import { addedEntryIds, needsAttention } from "../features/plugins-view";
import { ListSection, ListSectionBody, ListSectionHeader, ListSectionRows } from "./customize-list";
import { CatalogPluginRow, PluginAttentionRow, PluginRow } from "./plugin-list-rows";

const { plugins, catalog } = placeholderConfiguration;

export function PluginsFacet() {
  const attention = plugins.filter(needsAttention);
  const settled = plugins.filter((plugin) => !needsAttention(plugin));
  const added = addedEntryIds();

  return (
    <div className="flex flex-col gap-6">
      {attention.length > 0 ? (
        <ListSection>
          <ListSectionHeader title="Needs Attention" count={attention.length} />
          <ListSectionRows>
            {attention.map((plugin) => (
              <PluginAttentionRow key={plugin.record.pluginId} plugin={plugin} />
            ))}
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
          <ListSectionRows>
            {settled.map((plugin) => (
              <PluginRow key={plugin.record.pluginId} plugin={plugin} />
            ))}
          </ListSectionRows>
        )}
      </ListSection>

      <ListSection>
        <ListSectionHeader title="Catalog" count={catalog.length} />
        <ListSectionRows>
          {catalog.map((entry) => (
            <CatalogPluginRow key={entry.id} entry={entry} added={added.includes(entry.id)} />
          ))}
        </ListSectionRows>
      </ListSection>
    </div>
  );
}
