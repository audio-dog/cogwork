import { Card } from "@cogwork/ui/components/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@cogwork/ui/components/collapsible";
import { RiSkipForwardLine } from "@remixicon/react";
import type { ReactNode } from "react";
import {
  type NotificationRecord,
  type ParkedItem,
  type WorkflowRef,
  workflowList,
} from "../features/prototype-attention-data";
import { Lane, Lanes } from "./prototype-attention-lanes";
import {
  AnswerChips,
  AppIcon,
  ArtifactTrace,
  ChangedMark,
  cardDescription,
  DismissButton,
  FailureBlock,
  ItemLink,
  LineageTrace,
  NotificationIcon,
  Parked,
  ReasonIcon,
  RefLabel,
  reasonLabel,
  SkippedLines,
  scrollIntoView,
  skippedCounts,
  skippedFor,
  skippedSummary,
  useAttentionView,
  useVisibleNotifications,
  useVisibleParked,
  When,
  WorkflowLine,
} from "./prototype-attention-parts";

/** PROTOTYPE — issue #794, polish P1: close to the reference. Title, two lines, one meta row. */

function QuietCard({
  id,
  media,
  title,
  description,
  meta,
  children,
}: {
  id: string;
  media: ReactNode;
  title: string;
  description: string;
  meta: ReactNode;
  children: ReactNode;
}) {
  const { focus, setFocus } = useAttentionView();
  const open = focus === id;
  return (
    <Card size="sm" className="gap-0 py-0" ref={open ? scrollIntoView : undefined}>
      <Collapsible open={open} onOpenChange={(next) => setFocus(next ? id : null)}>
        <CollapsibleTrigger className="grid w-full grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-2.5 gap-y-1 p-3 text-start outline-none focus-visible:bg-muted/50">
          <span className="flex h-5 items-center">{media}</span>
          <span className="text-sm leading-5 font-medium">{title}</span>
          <span className="col-start-2 line-clamp-2 text-sm text-muted-foreground">{description}</span>
          <span className="col-start-2 mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {meta}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="mx-3 flex flex-col gap-3 border-t py-3">{children}</CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function ParkedQuietCard({ item }: { item: ParkedItem }) {
  const description = cardDescription(item);
  return (
    <QuietCard
      id={item.id}
      media={<ReasonIcon reason={item.reason} />}
      title={item.title}
      description={description}
      meta={
        <>
          <span className="text-foreground">{reasonLabel(item)}</span>
          <span aria-hidden>·</span>
          <When atMillis={item.parkedAtMillis} />
          {item.changedSinceParked && <ChangedMark />}
          <span className="ms-auto" />
          <AppIcon app={item.source} />
          <RefLabel itemRef={item.ref} />
        </>
      }
    >
      <LineageTrace item={item} />
      {description !== item.summary && <p className="text-sm">{item.summary}</p>}
      <FailureBlock item={item} />
      <Parked.Provider item={item}>
        <Parked.Trace />
        <Parked.Prompt />
      </Parked.Provider>
    </QuietCard>
  );
}

function NotificationQuietCard({ notification }: { notification: NotificationRecord }) {
  return (
    <QuietCard
      id={notification.id}
      media={<NotificationIcon />}
      title={notification.title}
      description={notification.summary}
      meta={
        <>
          <When atMillis={notification.atMillis} />
          <span className="ms-auto" />
          <AppIcon app={notification.source} />
          <RefLabel itemRef={notification.ref} />
        </>
      }
    >
      <WorkflowLine workflow={notification.workflow} operation={notification.operation} />
      <AnswerChips answers={notification.answers} />
      <ArtifactTrace artifacts={notification.artifacts} />
      <span className="flex items-center justify-between">
        <ItemLink itemRef={notification.ref} />
        <DismissButton notification={notification} />
      </span>
    </QuietCard>
  );
}

function SkippedQuietCard({ workflow }: { workflow: WorkflowRef }) {
  return (
    <QuietCard
      id={`workflow:${workflow.id}`}
      media={<RiSkipForwardLine className="size-4 text-muted-foreground" />}
      title={workflow.name}
      description={skippedFor(workflow)[0]?.reason ?? ""}
      meta={
        <>
          <span className="text-foreground">{skippedSummary(workflow)}</span>
          <span aria-hidden>·</span>
          <When atMillis={skippedCounts(workflow).latest} />
        </>
      }
    >
      <SkippedLines workflow={workflow} />
    </QuietCard>
  );
}

export function AttentionQuiet() {
  const parked = useVisibleParked();
  const notifications = useVisibleNotifications();
  const skipped = workflowList.filter((workflow) => skippedFor(workflow).length > 0);
  return (
    <Lanes>
      <Lane title="Needs you" count={parked.length}>
        {parked.map((item) => (
          <ParkedQuietCard key={item.id} item={item} />
        ))}
      </Lane>
      <Lane title="Notified" count={notifications.length}>
        {notifications.map((notification) => (
          <NotificationQuietCard key={notification.id} notification={notification} />
        ))}
      </Lane>
      <Lane title="Skipped" count={skipped.length}>
        {skipped.map((workflow) => (
          <SkippedQuietCard key={workflow.id} workflow={workflow} />
        ))}
      </Lane>
    </Lanes>
  );
}
