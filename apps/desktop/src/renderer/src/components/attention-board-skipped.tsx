import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@cogwork/ui/components/item";
import { RiSkipForwardLine } from "@remixicon/react";
import { type SkippedRecord, skippedSummary, type WorkflowRef } from "../features/workflow-parks";
import { AttentionCard, CatalogGlyph, RelativeTime } from "./attention-board-card";

export function SkippedCard({
  workflow,
  records,
}: {
  workflow: WorkflowRef;
  records: readonly SkippedRecord[];
}) {
  const latest = Math.max(...records.map((record) => record.atMillis));
  return (
    <AttentionCard.Root id={`workflow:${workflow.id}`}>
      <AttentionCard.Summary>
        <AttentionCard.Title icon={<RiSkipForwardLine className="size-4 shrink-0 text-muted-foreground" />}>
          {workflow.name}
        </AttentionCard.Title>
        <AttentionCard.Description>{records[0]?.reason}</AttentionCard.Description>
        <AttentionCard.Meta>
          <span className="text-foreground">{skippedSummary(records)}</span>
          <span aria-hidden>·</span>
          <RelativeTime atMillis={latest} />
        </AttentionCard.Meta>
      </AttentionCard.Summary>
      <AttentionCard.Detail>
        <ItemGroup className="gap-1">
          {records.map((record) => (
            <Item key={record.id} size="xs">
              <ItemMedia variant="icon">
                <CatalogGlyph app={record.app} />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{record.what}</ItemTitle>
                <ItemDescription>{record.reason}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <RelativeTime atMillis={record.atMillis} />
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      </AttentionCard.Detail>
    </AttentionCard.Root>
  );
}
