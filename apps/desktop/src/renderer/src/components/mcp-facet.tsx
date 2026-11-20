import { defaultContributionEnabled } from "@cogwork/contracts";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import { RiServerLine } from "@remixicon/react";

import {
  authorityLabel,
  type Contribution,
  contributionInstanceKey,
  LoadState,
  McpReadiness,
} from "../features/configuration-model";
import { diagnosticsOf, resolveEnablement, viewOf } from "../features/configuration-resolve";
import { useConfiguration } from "./configuration-provider";
import { FilteredEmpty } from "./customize-empty";
import { useCustomizeFilter } from "./customize-filter";
import { ListSection, ListSectionBody, ListSectionHeader, ListSectionRows } from "./customize-list";
import { McpServerRow } from "./mcp-server-row";

function troubled(contribution: Contribution) {
  if (LoadState.$is("failed")(contribution.load)) return true;
  if (diagnosticsOf(contribution).length > 0) return true;
  const on =
    resolveEnablement(contribution, viewOf(contribution)).effective ??
    defaultContributionEnabled(authorityLabel(contribution.authority));
  return on && McpReadiness.$is("not-ready")(contribution.readiness);
}

export function McpFacet() {
  const {
    meta: { places },
  } = useConfiguration();
  const {
    state: { places: selected, query },
  } = useCustomizeFilter();

  const servers = places.visibleContributions("mcp-server", selected, query);
  const attention = servers.filter(troubled);
  const ready = servers.filter((contribution) => !troubled(contribution));

  if (servers.length === 0) return <FilteredEmpty icon={RiServerLine} label="MCP servers" />;

  return (
    <div className="flex flex-col gap-6">
      {attention.length > 0 ? (
        <ListSection>
          <ListSectionHeader title="Needs Attention" count={attention.length} />
          <ListSectionRows items={attention} keyOf={contributionInstanceKey}>
            {(contribution) => <McpServerRow contribution={contribution} />}
          </ListSectionRows>
        </ListSection>
      ) : null}

      <ListSection>
        <ListSectionHeader title="Ready" count={ready.length} />
        {ready.length === 0 ? (
          <ListSectionBody>
            <Empty className="py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <RiServerLine />
                </EmptyMedia>
                <EmptyTitle>Nothing ready</EmptyTitle>
                <EmptyDescription>Every server needs a look.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </ListSectionBody>
        ) : (
          <ListSectionRows items={ready} keyOf={contributionInstanceKey}>
            {(contribution) => <McpServerRow contribution={contribution} />}
          </ListSectionRows>
        )}
      </ListSection>
    </div>
  );
}
