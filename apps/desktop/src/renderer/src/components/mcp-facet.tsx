// The MCP servers facet.
//
// Grouped by status, not by place. An MCP server is the one contribution kind that can be *broken* —
// it launches a process, speaks a protocol and authenticates — so what matters first is whether the
// Engine can reach it. Everything else in Customize is a file that either parses or does not.
//
// Readiness is the Engine's own conclusion, so it is reported here and edited nowhere. The switch is
// the only thing a person changes, and the dialog behind the row says the rest.

import { Button } from "@cogwork/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import { Switch } from "@cogwork/ui/components/switch";
import { RiServerLine } from "@remixicon/react";
import { draftCellAt, withDraft } from "../features/configuration-draft";
import { type CatalogEntry, type Contribution, scopeCopy } from "../features/configuration-model";
import { placeholderConfiguration } from "../features/configuration-placeholder";
import { enableScopeFor, resolveEnablement } from "../features/configuration-resolve";
import { addedEntryIds } from "../features/plugins-view";
import { useConfigurationDraftStore } from "../store/configuration-draft";
import { ContributionRow } from "./contribution-row";
import { ListRow, ListRows, ListSection } from "./customize-list";

const { contributions, catalog, workspaces } = placeholderConfiguration;

const servers = contributions.filter((contribution) => contribution.kind === "mcp-server");

/** Broken, or dropped before it could be read. Either way the Engine cannot use it. */
function troubled(contribution: Contribution): boolean {
  if (contribution.load._tag === "failed") return true;
  if (contribution.readiness?._tag === "not-ready") return true;
  // Diagnostics come from the file, not from anything unsaved, so this reads the rows as sent.
  return resolveEnablement(contribution, { workspaceId: contribution.definedIn }).dropped.length > 0;
}

function ServerRow({ contribution }: { contribution: Contribution }) {
  const cells = useConfigurationDraftStore((state) => state.cells);
  const setCell = useConfigurationDraftStore((state) => state.setCell);

  const view = { workspaceId: contribution.definedIn };
  const resolved = resolveEnablement(withDraft(contribution, cells), view);
  const target = enableScopeFor(contribution);
  const failed = contribution.load._tag === "failed";
  const on = target ? draftCellAt(contribution, target, cells) === "on" : resolved.effective === true;
  const workspace = workspaces.find((entry) => entry.id === contribution.definedIn);
  const where = `${workspace ? `${workspace.name} · ` : ""}${scopeCopy[contribution.definedAt].name}`;

  const detail = failed
    ? undefined
    : contribution.readiness?._tag === "not-ready"
      ? contribution.readiness.reason
      : on
        ? `Connected · ${where}`
        : `Off · ${where}`;

  return (
    <ContributionRow
      contribution={contribution}
      detail={detail}
      trailing={
        <Switch
          checked={on}
          disabled={failed || target === undefined}
          onCheckedChange={(checked) => {
            if (target) setCell(contribution.id, target, checked ? "on" : "off");
          }}
        />
      }
    />
  );
}

function CatalogRow({ entry }: { entry: CatalogEntry }) {
  return (
    <ListRow
      icon={<RiServerLine />}
      title={entry.name}
      detail={entry.summary}
      trailing={
        <Button size="sm" variant="outline">
          Add
        </Button>
      }
    />
  );
}

export function McpFacet() {
  const attention = servers.filter(troubled);
  const connected = servers.filter((contribution) => !troubled(contribution));
  const added = addedEntryIds();
  const offered = catalog.filter(
    (entry) => entry.contributes.includes("mcp-server") && !added.includes(entry.id),
  );

  return (
    <div className="flex flex-col gap-6">
      {attention.length > 0 ? (
        <ListSection title="Needs Attention" count={attention.length}>
          <ListRows>
            {attention.map((contribution) => (
              <ServerRow key={contribution.id} contribution={contribution} />
            ))}
          </ListRows>
        </ListSection>
      ) : null}

      <ListSection title="Connected" count={connected.length}>
        {connected.length === 0 ? (
          <Empty className="py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <RiServerLine />
              </EmptyMedia>
              <EmptyTitle>Nothing connected</EmptyTitle>
              <EmptyDescription>Every server needs a look.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ListRows>
            {connected.map((contribution) => (
              <ServerRow key={contribution.id} contribution={contribution} />
            ))}
          </ListRows>
        )}
      </ListSection>

      <ListSection title="Catalog" count={offered.length}>
        {offered.length === 0 ? (
          <Empty className="py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <RiServerLine />
              </EmptyMedia>
              <EmptyTitle>You have them all</EmptyTitle>
              <EmptyDescription>Every Plugin with a server is already added.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ListRows>
            {offered.map((entry) => (
              <CatalogRow key={entry.id} entry={entry} />
            ))}
          </ListRows>
        )}
      </ListSection>

      <p className="text-xs text-muted-foreground">
        Whether a server is reachable is the Engine's call, not a setting. The switch says whether you want
        it; the status says whether it works.
      </p>
    </div>
  );
}
