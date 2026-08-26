import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import { RiServerLine } from "@remixicon/react";
import type { Contribution } from "../features/configuration-model";
import { resolveEnablement } from "../features/configuration-resolve";
import { visibleContributions } from "../features/customize-places";
import { ListSection, ListSectionBody, ListSectionHeader, ListSectionRows } from "./customize-list";
import { McpServerRow } from "./mcp-server-row";

function troubled(contribution: Contribution) {
  if (contribution.load._tag === "failed") return true;
  if (contribution.readiness?._tag === "not-ready") return true;
  return resolveEnablement(contribution, { workspaceId: contribution.definedIn }).dropped.length > 0;
}

export function McpFacet({ places, query }: { places: readonly string[]; query: string }) {
  const servers = visibleContributions("mcp-server", places, query);
  const attention = servers.filter(troubled);
  const connected = servers.filter((contribution) => !troubled(contribution));

  return (
    <div className="flex flex-col gap-6">
      {attention.length > 0 ? (
        <ListSection>
          <ListSectionHeader title="Needs Attention" count={attention.length} />
          <ListSectionRows>
            {attention.map((contribution) => (
              <McpServerRow key={contribution.id} contribution={contribution} />
            ))}
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
          <ListSectionRows>
            {connected.map((contribution) => (
              <McpServerRow key={contribution.id} contribution={contribution} />
            ))}
          </ListSectionRows>
        )}
      </ListSection>
    </div>
  );
}
