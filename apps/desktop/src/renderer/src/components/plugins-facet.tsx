// The Plugins facet: what is installed, what needs you, and what is on offer.
//
// Grouped by status rather than laid out flat, because a row that needs nothing said about it
// should not compete with one holding staged bytes. A row leads to the Plugin's own page; the
// section header holds the acts that belong to the whole list.

import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cogwork/ui/components/empty";
import { RiAddLine, RiBox3Line, RiDownloadLine, RiErrorWarningLine, RiLoopLeftLine } from "@remixicon/react";
import { useNavigate } from "@tanstack/react-router";
import type { CatalogEntry, InstalledPlugin } from "../features/configuration-model";
import { placeholderConfiguration } from "../features/configuration-placeholder";
import {
  attentionAction,
  attentionLine,
  attentionOf,
  needsAttention,
  sourceLine,
} from "../features/plugins-view";
import { CatalogStatusBadge, IdentityBadge } from "./configuration-atoms";
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
      badge={<IdentityBadge identity={plugin.record.resolvedIdentity} />}
      detail={showAttention ? attentionLine(attention) : sourceLine(plugin)}
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
  const withdrawn = entry.status._tag === "deleted";
  return (
    <ListRow
      icon={<RiDownloadLine />}
      title={entry.name}
      badge={
        <>
          <CatalogStatusBadge status={entry.status} />
          {installed ? <Badge variant="secondary">Installed</Badge> : null}
        </>
      }
      detail={entry.summary}
      trailing={
        installed ? null : (
          // `deleted` bounds what an install may resolve; it never disables what is already there.
          <Button size="sm" variant="outline" disabled={withdrawn}>
            {withdrawn ? "Withdrawn" : "Install"}
          </Button>
        )
      }
    />
  );
}

export function PluginsFacet() {
  const attention = plugins.filter(needsAttention);
  const settled = plugins.filter((plugin) => !needsAttention(plugin));
  const installedEntryIds = plugins
    .map((plugin) => plugin.record.source)
    .filter((source) => source._tag === "catalog")
    .map((source) => source.entryId);

  return (
    <div className="flex flex-col gap-6">
      {attention.length > 0 ? (
        <ListSection title="Needs attention" count={attention.length}>
          <ListRows>
            {attention.map((plugin) => (
              <PluginRow key={plugin.record.pluginId} plugin={plugin} showAttention />
            ))}
          </ListRows>
        </ListSection>
      ) : null}

      <ListSection
        title="Installed"
        count={settled.length}
        action={
          <Button size="sm" variant="outline">
            <RiAddLine data-icon="inline-start" />
            Add from a path
          </Button>
        }
      >
        {settled.length === 0 ? (
          <Empty className="py-8">
            <EmptyHeader>
              <EmptyTitle>Nothing settled</EmptyTitle>
              <EmptyDescription>Every installed Plugin is waiting on you above.</EmptyDescription>
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

      <ListSection
        title="Catalog"
        count={catalog._tag === "never-fetched" ? undefined : catalog.entries.length}
        action={
          <>
            {/* `stale` and `fetched` must not read alike, so the state sits in the header rather
                than in a banner over the list. */}
            <span className="text-xs text-muted-foreground">
              {catalog._tag === "never-fetched"
                ? "Never fetched"
                : catalog._tag === "stale"
                  ? `Stale — last refresh failed ${catalog.lastFailure}`
                  : `Fetched ${catalog.at}`}
            </span>
            <Button size="sm" variant="outline">
              <RiLoopLeftLine data-icon="inline-start" />
              Refresh
            </Button>
          </>
        }
      >
        {catalog._tag === "never-fetched" ? (
          <Empty className="py-8">
            <EmptyHeader>
              <EmptyTitle>The catalog has never been fetched</EmptyTitle>
              <EmptyDescription>
                A refresh runs only when you ask for one — never on a timer, and never on read.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ListRows>
            {catalog.entries.map((entry) => (
              <CatalogRow key={entry.id} entry={entry} installed={installedEntryIds.includes(entry.id)} />
            ))}
          </ListRows>
        )}
      </ListSection>

      {catalog._tag === "stale" ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <RiErrorWarningLine className="size-3.5" />
          Serving the copy fetched {catalog.at}. A refresh that fails after a good load keeps the good load.
        </p>
      ) : null}
    </div>
  );
}
