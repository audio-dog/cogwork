import type { WorkItemRef } from "@cogwork/contracts";
import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@cogwork/ui/components/trace";
import { RiArrowRightUpLine, RiBellLine } from "@remixicon/react";

import { plural } from "../features/format";
import { safeHref } from "../features/safe-href";
import {
  type Answer,
  type Artifact,
  type NotificationRecord,
  type SourceRef,
  workflowLabel,
} from "../features/workflow-parks";
import { AppIcon, AttentionCard, CatalogGlyph, RelativeTime, SourceLabel } from "./attention-board-card";
import { useAttention } from "./attention-board-context";

function ItemLink({ item, source }: { item: WorkItemRef; source: SourceRef }) {
  const {
    actions: { openItem },
  } = useAttention();
  return (
    <Button size="xs" variant="link" className="px-0" onClick={() => openItem(item)}>
      <SourceLabel source={source} />
    </Button>
  );
}

function AnswerChips({ answers }: { answers: readonly Answer[] }) {
  if (answers.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {answers.map((answer) => (
        <Badge key={answer.question} variant="secondary">
          <span className="font-mono">
            {answer.question}: {answer.choice}
          </span>
        </Badge>
      ))}
    </span>
  );
}

function ArtifactLine({ artifact }: { artifact: Artifact }) {
  return (
    <TraceLine>
      <TraceIcon>
        <CatalogGlyph app={artifact.app} />
      </TraceIcon>
      <TraceTitle>
        {artifact.label}
        <span className="sr-only"> (opens in a new tab)</span>
      </TraceTitle>
      <TraceIcon>
        <RiArrowRightUpLine />
      </TraceIcon>
    </TraceLine>
  );
}

function ArtifactTrace({ artifacts }: { artifacts: readonly Artifact[] }) {
  if (artifacts.length === 0) return null;
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceTitle>{`Created ${plural(artifacts.length, "artifact")}`}</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <Trace>
          {artifacts.map((artifact) => {
            const href = safeHref(artifact.url);
            if (!href) return <ArtifactLine key={artifact.label} artifact={artifact} />;
            return (
              <a key={artifact.label} href={href} target="_blank" rel="noreferrer">
                <ArtifactLine artifact={artifact} />
              </a>
            );
          })}
        </Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

export function NotificationCard({ notification }: { notification: NotificationRecord }) {
  const {
    actions: { dismiss },
  } = useAttention();
  return (
    <AttentionCard.Root id={notification.id}>
      <AttentionCard.Summary>
        <AttentionCard.Title icon={<RiBellLine className="size-4 shrink-0 text-muted-foreground" />}>
          {notification.title}
        </AttentionCard.Title>
        <AttentionCard.Description>{notification.summary}</AttentionCard.Description>
        <AttentionCard.Meta>
          <RelativeTime atMillis={notification.atMillis} />
          <span className="ms-auto" />
          <AppIcon app={notification.source.app} />
          <SourceLabel source={notification.source} />
        </AttentionCard.Meta>
      </AttentionCard.Summary>
      <AttentionCard.Detail>
        <span className="text-xs text-muted-foreground">
          {workflowLabel(notification.workflow, notification.operation)}
        </span>
        <AnswerChips answers={notification.answers} />
        <ArtifactTrace artifacts={notification.artifacts} />
        <span className="flex items-center justify-between">
          <ItemLink item={notification.item} source={notification.source} />
          <Button size="sm" variant="ghost" onClick={() => dismiss(notification)}>
            Dismiss
          </Button>
        </span>
      </AttentionCard.Detail>
    </AttentionCard.Root>
  );
}
