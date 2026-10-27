import { Badge } from "@cogwork/ui/components/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@cogwork/ui/components/collapsible";
import { Item, ItemGroup } from "@cogwork/ui/components/item";
import { RiArrowRightSLine } from "@remixicon/react";
import type { ReactNode } from "react";
import { type NotificationRecord, type ParkedItem, workflowList } from "../features/prototype-attention-data";
import {
  AnswerChips,
  ArtifactLinks,
  ChangedBadge,
  DismissButton,
  ItemLink,
  LineageTrail,
  NotificationIcon,
  Parked,
  ReasonIcon,
  reasonDetail,
  reasonTitle,
  SkippedRow,
  scrollIntoView,
  skippedFor,
  useFocus,
  useVisibleNotifications,
  useVisibleParked,
  When,
  WorkflowTag,
} from "./prototype-attention-parts";

/** PROTOTYPE — issue #794, variant B: one list by urgency; a row opens in place. */

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        {title}
        <Badge variant="secondary">{count}</Badge>
      </h2>
      {children}
    </section>
  );
}

function ParkedRow({ item }: { item: ParkedItem }) {
  const { focus, setFocus } = useFocus();
  const open = focus === item.id;
  const detail = reasonDetail(item.reason);
  return (
    <Item variant="outline" className="p-0" ref={open ? scrollIntoView : undefined}>
      <Collapsible
        open={open}
        onOpenChange={(next) => setFocus(next ? item.id : null)}
        className="flex w-full flex-col"
      >
        <CollapsibleTrigger className="flex w-full flex-col gap-1 px-3 py-2.5 text-start outline-none">
          <span className="flex w-full items-center gap-2">
            <ReasonIcon reason={item.reason} />
            <span className="min-w-0 truncate text-sm font-medium">{item.title}</span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{item.ref}</span>
            <span className="ms-auto" />
            <WorkflowTag workflow={item.workflow} operation={item.operation} />
            <When atMillis={item.parkedAtMillis} />
          </span>
          <span className="flex w-full items-center gap-2 ps-6 text-xs">
            <span className="shrink-0">{reasonTitle(item)}</span>
            {detail && <span className="min-w-0 truncate text-muted-foreground">{detail}</span>}
            {item.changedSinceParked && <ChangedBadge />}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-3 border-t px-3 py-3 ps-9">
          <LineageTrail item={item} />
          <p className="text-sm">{item.summary}</p>
          <AnswerChips answers={item.answers} />
          <Parked.Provider item={item}>
            <Parked.Plan />
            <Parked.Commands />
          </Parked.Provider>
        </CollapsibleContent>
      </Collapsible>
    </Item>
  );
}

function NotificationRow({ notification }: { notification: NotificationRecord }) {
  const { focus } = useFocus();
  return (
    <Item
      variant="outline"
      className="flex-col items-stretch gap-1.5"
      ref={focus === notification.id ? scrollIntoView : undefined}
    >
      <span className="flex w-full items-center gap-2">
        <NotificationIcon />
        <span className="min-w-0 truncate text-sm font-medium">{notification.title}</span>
        <ItemLink itemRef={notification.ref} />
        <span className="ms-auto" />
        <WorkflowTag workflow={notification.workflow} operation={notification.operation} />
        <When atMillis={notification.atMillis} />
      </span>
      <p className="ps-6 text-sm">{notification.summary}</p>
      <span className="flex items-center gap-2 ps-6">
        <AnswerChips answers={notification.answers} />
        <ArtifactLinks artifacts={notification.artifacts} />
        <span className="ms-auto" />
        <DismissButton notification={notification} />
      </span>
    </Item>
  );
}

function SkippedByWorkflow() {
  return workflowList.map((workflow) => {
    const records = skippedFor(workflow);
    if (records.length === 0) return null;
    return (
      <Collapsible key={workflow.id} className="rounded-lg border">
        <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-start outline-none">
          <RiArrowRightSLine className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
          <WorkflowTag workflow={workflow} />
          <Badge variant="secondary">{records.length}</Badge>
        </CollapsibleTrigger>
        <CollapsibleContent className="divide-y border-t px-3">
          {records.map((record) => (
            <SkippedRow key={record.id} record={record} />
          ))}
        </CollapsibleContent>
      </Collapsible>
    );
  });
}

export function AttentionList() {
  const parked = useVisibleParked();
  const notifications = useVisibleNotifications();
  const skippedCount = workflowList.flatMap(skippedFor).length;
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 pb-6">
      <Section title="Needs you" count={parked.length}>
        <ItemGroup className="gap-2">
          {parked.map((item) => (
            <ParkedRow key={item.id} item={item} />
          ))}
        </ItemGroup>
      </Section>
      <Section title="Notifications" count={notifications.length}>
        <ItemGroup className="gap-2">
          {notifications.map((notification) => (
            <NotificationRow key={notification.id} notification={notification} />
          ))}
        </ItemGroup>
      </Section>
      <Section title="Skipped" count={skippedCount}>
        <div className="flex flex-col gap-2">
          <SkippedByWorkflow />
        </div>
      </Section>
    </div>
  );
}
