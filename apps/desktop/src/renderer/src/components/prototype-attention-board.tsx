import { Badge } from "@cogwork/ui/components/badge";
import { Card } from "@cogwork/ui/components/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@cogwork/ui/components/collapsible";
import type { ReactNode } from "react";
import {
  type NotificationRecord,
  type ParkedItem,
  type SkippedRecord,
  workflowList,
} from "../features/prototype-attention-data";
import {
  AnswerChips,
  AppIcon,
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
  scrollIntoView,
  skippedFor,
  useFocus,
  useVisibleNotifications,
  useVisibleParked,
  When,
  WorkflowTag,
} from "./prototype-attention-parts";

/** PROTOTYPE — issue #794, variant A: one column per thing the person does; a card opens in place. */

function Column({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="flex min-h-0 flex-col gap-2 rounded-xl bg-muted/40 p-2">
      <h2 className="flex items-center gap-2 px-1 pt-1 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        {title}
        <Badge variant="secondary">{count}</Badge>
      </h2>
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">{children}</div>
    </section>
  );
}

function ParkedCard({ item }: { item: ParkedItem }) {
  const { focus, setFocus } = useFocus();
  const open = focus === item.id;
  const detail = reasonDetail(item.reason);
  return (
    <Card size="sm" ref={open ? scrollIntoView : undefined}>
      <Collapsible
        open={open}
        onOpenChange={(next) => setFocus(next ? item.id : null)}
        className="flex flex-col gap-3"
      >
        <CollapsibleTrigger className="flex flex-col gap-1.5 px-3 text-start outline-none">
          <span className="flex items-start gap-2">
            <ReasonIcon reason={item.reason} className="mt-0.5" />
            <span className="text-sm leading-snug font-medium">{item.title}</span>
          </span>
          <WorkflowTag workflow={item.workflow} operation={item.operation} />
          <span className="flex items-center gap-2">
            <span className="truncate text-xs">{reasonTitle(item)}</span>
            {item.changedSinceParked && <ChangedBadge />}
            <span className="ms-auto" />
            <When atMillis={item.parkedAtMillis} />
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-3 border-t px-3 pt-3">
          {detail && detail !== item.summary && <p className="text-xs text-destructive">{detail}</p>}
          <p className="text-sm">{item.summary}</p>
          <LineageTrail item={item} />
          <AnswerChips answers={item.answers} />
          <Parked.Provider item={item}>
            <Parked.Plan />
            <Parked.Commands />
          </Parked.Provider>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function NotificationCard({ notification }: { notification: NotificationRecord }) {
  const { focus } = useFocus();
  return (
    <Card size="sm" ref={focus === notification.id ? scrollIntoView : undefined}>
      <div className="flex flex-col gap-2 px-3">
        <span className="flex items-start gap-2">
          <NotificationIcon className="mt-0.5" />
          <span className="text-sm leading-snug font-medium">{notification.title}</span>
        </span>
        <WorkflowTag workflow={notification.workflow} operation={notification.operation} />
        <p className="text-sm">{notification.summary}</p>
        <AnswerChips answers={notification.answers} />
        <ArtifactLinks artifacts={notification.artifacts} />
        <span className="flex items-center gap-2">
          <ItemLink itemRef={notification.ref} />
          <When atMillis={notification.atMillis} />
          <span className="ms-auto" />
          <DismissButton notification={notification} />
        </span>
      </div>
    </Card>
  );
}

function SkippedLine({ record }: { record: SkippedRecord }) {
  return (
    <li className="flex items-start gap-2">
      <AppIcon app={record.app} className="mt-0.5" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm">{record.what}</span>
        <span className="text-xs text-muted-foreground">{record.reason}</span>
      </span>
    </li>
  );
}

function SkippedCards() {
  return workflowList.map((workflow) => {
    const records = skippedFor(workflow);
    if (records.length === 0) return null;
    return (
      <Card key={workflow.id} size="sm">
        <div className="flex flex-col gap-2 px-3">
          <WorkflowTag workflow={workflow} />
          <ul className="flex flex-col gap-2">
            {records.map((record) => (
              <SkippedLine key={record.id} record={record} />
            ))}
          </ul>
        </div>
      </Card>
    );
  });
}

export function AttentionBoard() {
  const parked = useVisibleParked();
  const notifications = useVisibleNotifications();
  const approvals = parked.filter((item) => item.reason.tag === "awaiting-approval");
  const parks = parked.filter((item) => item.reason.tag !== "awaiting-approval");
  const skippedCount = workflowList.flatMap(skippedFor).length;
  return (
    <div className="grid h-full min-h-0 auto-cols-[minmax(17rem,1fr)] grid-flow-col gap-3 overflow-x-auto px-6 pb-6">
      <Column title="Approve" count={approvals.length}>
        {approvals.map((item) => (
          <ParkedCard key={item.id} item={item} />
        ))}
      </Column>
      <Column title="Parked" count={parks.length}>
        {parks.map((item) => (
          <ParkedCard key={item.id} item={item} />
        ))}
      </Column>
      <Column title="Notified" count={notifications.length}>
        {notifications.map((notification) => (
          <NotificationCard key={notification.id} notification={notification} />
        ))}
      </Column>
      <Column title="Skipped" count={skippedCount}>
        <SkippedCards />
      </Column>
    </div>
  );
}
