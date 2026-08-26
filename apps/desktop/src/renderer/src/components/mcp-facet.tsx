import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import { RiServerLine } from "@remixicon/react";
import type { Contribution } from "../features/configuration-model";
import { diagnosticsOf } from "../features/configuration-resolve";
import { useConfiguration } from "./configuration-provider";
import { useCustomizeFilter } from "./customize-filter";
import { ListSection, ListSectionBody, ListSectionHeader, ListSectionRows } from "./customize-list";
import { McpServerRow } from "./mcp-server-row";

/** Whether a server needs a look. Like a diagnostic, this is a fact about the server, not the view. */
function troubled(contribution: Contribution) {
  if (contribution.load._tag === "failed") return true;
  if (contribution.readiness?._tag === "not-ready") return true;
  return diagnosticsOf(contribution).length > 0;
}

const contributionKey = (contribution: Contribution) => contribution.id;

export function McpFacet() {
  const {
    meta: { places },
  } = useConfiguration();
  const {
    state: { places: selected, query },
  } = useCustomizeFilter();

  const servers = places.visibleContributions("mcp-server", selected, query);
  const attention = servers.filter(troubled);
  const connected = servers.filter((contribution) => !troubled(contribution));

  return (
    <div className="flex flex-col gap-6">
      {attention.length > 0 ? (
        <ListSection>
          <ListSectionHeader title="Needs Attention" count={attention.length} />
          <ListSectionRows items={attention} keyOf={contributionKey}>
            {(contribution) => <McpServerRow contribution={contribution} />}
          </ListSectionRows>
        </ListSection>
      ) : null}

      <ListSection>
        <ListSectionHeader title="Connected" count={connected.length} />
        {connected.length === 0 ? (
          <ListSectionBody>
            <Empty className="py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <RiServerLine />
                </EmptyMedia>
                <EmptyTitle>Nothing connected</EmptyTitle>
                <EmptyDescription>Every server needs a look.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </ListSectionBody>
        ) : (
          <ListSectionRows items={connected} keyOf={contributionKey}>
            {(contribution) => <McpServerRow contribution={contribution} />}
          </ListSectionRows>
        )}
      </ListSection>
    </div>
  );
}
