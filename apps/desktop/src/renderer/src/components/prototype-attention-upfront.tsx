import { Card } from "@cogwork/ui/components/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@cogwork/ui/components/collapsible";
import { RiArrowDownSLine, RiSkipForwardLine } from "@remixicon/react";
import type { ReactNode } from "react";
import {
  type NotificationRecord,
  type ParkedItem,
  type WorkflowRef,
  workflowList,
} from "../features/prototype-attention-data";
import { usePrototypeAttention } from "../features/prototype-attention-store";
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
  reasonLabel,
  SkippedLines,
  scrollIntoView,
  skippedFor,
  skippedSummary,
  useAttentionView,
  useVisibleNotifications,
  useVisibleParked,
  When,
  WorkflowLine,
} from "./prototype-attention-parts";

/** PROTOTYPE — issue #794, polish P3: the plan and the commands show on the card; opening adds the detail. */

function UpfrontHeader({ media, title, when }: { media: ReactNode; title: string; when: number }) {
  return (
    <CollapsibleTrigger className="group flex w-full items-start gap-2.5 text-start outline-none">
      <span className="flex h-5 items-center">{media}</span>
      <span className="min-w-0 flex-1 text-sm leading-5 font-medium">{title}</span>
      <When atMillis={when} />
      <RiArrowDownSLine className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
    </CollapsibleTrigger>
  );
}

function ParkedUpfrontCard({ item }: { item: ParkedItem }) {
  const { focus, setFocus } = useAttentionView();
  const editing = usePrototypeAttention((state) => state.modes[item.id] === "edit");
  const open = focus === item.id || editing;
  const description = cardDescription(item);
  return (
    <Card size="sm" className="gap-0 py-0" ref={open ? scrollIntoView : undefined}>
      <Parked.Provider item={item}>
        <Collapsible
          open={open}
          onOpenChange={(next) => setFocus(next ? item.id : null)}
          className="flex flex-col gap-2.5 p-3"
        >
          <UpfrontHeader
            media={<ReasonIcon reason={item.reason} />}
            title={item.title}
            when={item.parkedAtMillis}
          />
          <div className="flex flex-col gap-2.5 ps-6.5">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="text-foreground">{reasonLabel(item)}</span>
              <span aria-hidden>·</span>
              <span className="truncate">{item.workflow.name}</span>
              {item.changedSinceParked && <ChangedMark />}
            </span>
            <p className="line-clamp-2 text-sm text-muted-foreground">{description}</p>
            {!open && <Parked.Outline />}
            <CollapsibleContent className="flex flex-col gap-3">
              <Provenance item={item} />
              {description !== item.summary && <p className="text-sm">{item.summary}</p>}
              <Parked.Timeline />
            </CollapsibleContent>
            <Parked.Commands />
          </div>
        </Collapsible>
      </Parked.Provider>
    </Card>
  );
}

function NotificationUpfrontCard({ notification }: { notification: NotificationRecord }) {
  const { focus, setFocus } = useAttentionView();
  const open = focus === notification.id;
  return (
    <Card size="sm" className="gap-0 py-0" ref={open ? scrollIntoView : undefined}>
      <Collapsible
        open={open}
        onOpenChange={(next) => setFocus(next ? notification.id : null)}
        className="flex flex-col gap-2.5 p-3"
      >
        <UpfrontHeader media={<NotificationIcon />} title={notification.title} when={notification.atMillis} />
        <div className="flex flex-col gap-2.5 ps-6.5">
          <p className="text-sm text-muted-foreground">{notification.summary}</p>
          <CollapsibleContent className="flex flex-col gap-3">
            <WorkflowLine workflow={notification.workflow} operation={notification.operation} />
            <AnswerChips answers={notification.answers} />
          </CollapsibleContent>
          <span className="flex items-center gap-2">
            <ItemLink itemRef={notification.ref} />
            <ArtifactLinks artifacts={notification.artifacts} />
            <span className="ms-auto" />
            <DismissButton notification={notification} />
          </span>
        </div>
      </Collapsible>
    </Card>
  );
}

function SkippedUpfrontCard({ workflow }: { workflow: WorkflowRef }) {
  return (
    <Card size="sm" className="gap-2.5 p-3">
      <span className="flex items-center gap-2.5">
        <RiSkipForwardLine className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{workflow.name}</span>
        <span className="text-xs text-muted-foreground">{skippedSummary(workflow)}</span>
      </span>
      <div className="ps-6.5">
        <SkippedLines workflow={workflow} />
      </div>
    </Card>
  );
}

export function AttentionUpfront() {
  const parked = useVisibleParked();
  const notifications = useVisibleNotifications();
  const skipped = workflowList.filter((workflow) => skippedFor(workflow).length > 0);
  return (
    <Lanes>
      <Lane title="Needs you" count={parked.length}>
        {parked.map((item) => (
          <ParkedUpfrontCard key={item.id} item={item} />
        ))}
      </Lane>
      <Lane title="Notified" count={notifications.length}>
        {notifications.map((notification) => (
          <NotificationUpfrontCard key={notification.id} notification={notification} />
        ))}
      </Lane>
      <Lane title="Skipped" count={skipped.length}>
        {skipped.map((workflow) => (
          <SkippedUpfrontCard key={workflow.id} workflow={workflow} />
        ))}
      </Lane>
    </Lanes>
  );
}
