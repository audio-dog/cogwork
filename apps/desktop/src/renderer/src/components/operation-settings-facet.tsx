import type { ControlStore } from "@cogwork/contracts";
import { Badge } from "@cogwork/ui/components/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import { ItemActions, ItemContent, ItemDescription, ItemTitle } from "@cogwork/ui/components/item";
import { RiSettings3Line } from "@remixicon/react";
import { useBoard } from "../features/activity-session";
import {
  operationSettingDisplayRows,
  operationSettingDisplaySections,
} from "../features/operation-settings-view";
import { ListRow, ListRowMedia, ListSection, ListSectionHeader, ListSectionRows } from "./customize-list";

function OperationSettingRows({ controlStore }: { controlStore: ControlStore }) {
  return (
    <div className="flex flex-col gap-6">
      {operationSettingDisplaySections(controlStore).map((section) => {
        const rows = operationSettingDisplayRows(controlStore, section.context);
        return (
          <ListSection key={section.key}>
            <ListSectionHeader title={section.label} count={rows.length} />
            <ListSectionRows items={rows} keyOf={(row) => row.setting}>
              {(row) => (
                <ListRow>
                  <ListRowMedia>
                    <RiSettings3Line />
                  </ListRowMedia>
                  <ItemContent>
                    <ItemTitle>{row.label}</ItemTitle>
                    <ItemDescription>
                      {row.rawRows === 1 ? "1 raw row" : `${row.rawRows} raw rows`}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Badge variant="outline">{row.value}</Badge>
                  </ItemActions>
                </ListRow>
              )}
            </ListSectionRows>
          </ListSection>
        );
      })}
    </div>
  );
}

function LoadingOperationSettings() {
  return (
    <Empty className="py-16">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <RiSettings3Line />
        </EmptyMedia>
        <EmptyTitle>Loading Operation settings</EmptyTitle>
        <EmptyDescription>Waiting for the daemon.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function DisconnectedOperationSettings() {
  return (
    <Empty className="py-16">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <RiSettings3Line />
        </EmptyMedia>
        <EmptyTitle>Operation settings unavailable</EmptyTitle>
        <EmptyDescription>Reconnect to the daemon.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function MissingOperationSettings() {
  return (
    <Empty className="py-16">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <RiSettings3Line />
        </EmptyMedia>
        <EmptyTitle>Operation settings unavailable</EmptyTitle>
        <EmptyDescription>No Control store picture.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function OperationSettingsFacet() {
  const result = useBoard();
  if (result._tag === "Initial") return <LoadingOperationSettings />;
  if (result._tag === "Failure") return <DisconnectedOperationSettings />;
  if (result.board.controlStore === null) return <MissingOperationSettings />;
  return <OperationSettingRows controlStore={result.board.controlStore} />;
}
