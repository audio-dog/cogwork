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
  ArtifactLinks,
  ChangedMark,
  cardDescription,
  DismissButton,
  ItemLink,
  NotificationIcon,
  Parked,
  Provenance,
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
} from "./prototype-attention-parts";

/** PROTOTYPE — issue #794, polish P2: one row per card until it opens; the reason is the only label. */

function CompactCard({
  id,
  media,
  title,
  when,
  meta,
  children,
}: {
  id: string;
  media: ReactNode;
  title: string;
  when: number;
  meta: ReactNode;
  children: ReactNode;
}) {
  const { focus, setFocus } = useAttentionView();
  const open = focus === id;
  return (
    <Card size="sm" className="gap-0 py-0" ref={open ? scrollIntoView : undefined}>
      <Collapsible open={open} onOpenChange={(next) => setFocus(next ? id : null)}>
        <CollapsibleTrigger className="flex w-full flex-col gap-0.5 px-3 py-2 text-start outline-none focus-visible:bg-muted/50">
          <span className="flex w-full items-center gap-2">
            {media}
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
            <When atMillis={when} />
          </span>
          <span className="flex min-w-0 items-center gap-1.5 ps-6 text-xs text-muted-foreground">{meta}</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-3 px-3 pt-1 pb-3 ps-9">
          {children}
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function ParkedCompactCard({ item }: { item: ParkedItem }) {
  const description = cardDescription(item);
  return (
    <CompactCard
      id={item.id}
      media={<ReasonIcon reason={item.reason} />}
      title={item.title}
      when={item.parkedAtMillis}
      meta={
        <>
          <span className="text-foreground">{reasonLabel(item)}</span>
          <RefLabel itemRef={item.ref} />
          {item.changedSinceParked && <ChangedMark />}
        </>
      }
    >
      <p className="text-sm">{description}</p>
      {description !== item.summary && <p className="text-sm text-muted-foreground">{item.summary}</p>}
      <Parked.Provider item={item}>
        <Parked.Panel />
        <Provenance item={item} />
        <Parked.Commands />
      </Parked.Provider>
    </CompactCard>
  );
}

function NotificationCompactCard({ notification }: { notification: NotificationRecord }) {
  return (
    <CompactCard
      id={notification.id}
      media={<NotificationIcon />}
      title={notification.title}
      when={notification.atMillis}
      meta={<span className="truncate">{notification.workflow.name}</span>}
    >
      <p className="text-sm">{notification.summary}</p>
      <AnswerChips answers={notification.answers} />
      <ArtifactLinks artifacts={notification.artifacts} />
      <span className="flex items-center justify-between">
        <ItemLink itemRef={notification.ref} />
        <DismissButton notification={notification} />
      </span>
    </CompactCard>
  );
}

function SkippedCompactCard({ workflow }: { workflow: WorkflowRef }) {
  return (
    <CompactCard
      id={`workflow:${workflow.id}`}
      media={<RiSkipForwardLine className="size-4 shrink-0 text-muted-foreground" />}
      title={workflow.name}
      when={skippedCounts(workflow).latest}
      meta={<span>{skippedSummary(workflow)}</span>}
    >
      <SkippedLines workflow={workflow} />
    </CompactCard>
  );
}

export function AttentionCompact() {
  const parked = useVisibleParked();
  const notifications = useVisibleNotifications();
  const skipped = workflowList.filter((workflow) => skippedFor(workflow).length > 0);
  return (
    <Lanes>
      <Lane title="Needs you" count={parked.length}>
        {parked.map((item) => (
          <ParkedCompactCard key={item.id} item={item} />
        ))}
      </Lane>
      <Lane title="Notified" count={notifications.length}>
        {notifications.map((notification) => (
          <NotificationCompactCard key={notification.id} notification={notification} />
        ))}
      </Lane>
      <Lane title="Skipped" count={skipped.length}>
        {skipped.map((workflow) => (
          <SkippedCompactCard key={workflow.id} workflow={workflow} />
        ))}
      </Lane>
    </Lanes>
  );
}
