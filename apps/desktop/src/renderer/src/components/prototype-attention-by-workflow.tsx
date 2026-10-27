import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@cogwork/ui/components/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@cogwork/ui/components/collapsible";
import { Separator } from "@cogwork/ui/components/separator";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@cogwork/ui/components/sheet";
import { RiArrowRightSLine } from "@remixicon/react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  lineageRoot,
  type NotificationRecord,
  type ParkedItem,
  type WorkflowRef,
  workflowList,
} from "../features/prototype-attention-data";
import {
  AnswerChips,
  AppIcon,
  ArtifactLinks,
  ChangedBadge,
  DismissButton,
  ItemLink,
  LineageTimeline,
  NotificationIcon,
  Parked,
  ReasonIcon,
  reasonDetail,
  reasonTitle,
  SkippedRow,
  skippedFor,
  useFocus,
  useVisibleNotifications,
  useVisibleParked,
  When,
} from "./prototype-attention-parts";

/** PROTOTYPE — issue #794, variant D: each Workflow shows what it parked, notified, and skipped. */

const foreignOrigin = (item: ParkedItem) =>
  item.lineage.find((hop) => hop.kind === "operation" && hop.workflow !== item.workflow.name)?.workflow ??
  null;

function Row({ onOpen, media, children }: { onOpen: () => void; media: ReactNode; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-muted/50"
    >
      {media}
      {children}
    </button>
  );
}

function ParkedLine({ item }: { item: ParkedItem }) {
  const { setFocus } = useFocus();
  const origin = foreignOrigin(item);
  return (
    <Row onOpen={() => setFocus(item.id)} media={<ReasonIcon reason={item.reason} />}>
      <span className="min-w-0 truncate">{item.title}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{reasonTitle(item)}</span>
      {origin && (
        <Badge variant="outline" className="font-normal">
          {origin}
        </Badge>
      )}
      {item.changedSinceParked && <ChangedBadge />}
      <span className="ms-auto" />
      <span className="shrink-0 font-mono text-xs text-muted-foreground">{item.ref}</span>
      <When atMillis={item.parkedAtMillis} />
    </Row>
  );
}

function NotificationLine({ notification }: { notification: NotificationRecord }) {
  const { setFocus } = useFocus();
  return (
    <Row onOpen={() => setFocus(notification.id)} media={<NotificationIcon />}>
      <span className="min-w-0 truncate">{notification.title}</span>
      <span className="ms-auto" />
      <span className="shrink-0 font-mono text-xs text-muted-foreground">{notification.ref}</span>
      <When atMillis={notification.atMillis} />
    </Row>
  );
}

function WorkflowCard({
  workflow,
  parked,
  notifications,
}: {
  workflow: WorkflowRef;
  parked: readonly ParkedItem[];
  notifications: readonly NotificationRecord[];
}) {
  const skipped = skippedFor(workflow);
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {workflow.name}
          <span className="font-mono text-xs font-normal text-muted-foreground">r{workflow.revision}</span>
        </CardTitle>
        <CardAction>
          <Button
            size="sm"
            variant="ghost"
            nativeButton={false}
            render={<Link to="/workflows/$workflowId" params={{ workflowId: workflow.id }} />}
          >
            Edit
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {parked.map((item) => (
          <ParkedLine key={item.id} item={item} />
        ))}
        {notifications.map((notification) => (
          <NotificationLine key={notification.id} notification={notification} />
        ))}
        {skipped.length > 0 && (
          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1 px-2 py-1.5 text-xs text-muted-foreground">
              <RiArrowRightSLine className="size-4 transition-transform group-data-panel-open:rotate-90" />
              Skipped
              <Badge variant="secondary">{skipped.length}</Badge>
            </CollapsibleTrigger>
            <CollapsibleContent className="divide-y px-2">
              {skipped.map((record) => (
                <SkippedRow key={record.id} record={record} />
              ))}
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  );
}

function ParkedSheetBody({ item }: { item: ParkedItem }) {
  const detail = reasonDetail(item.reason);
  const root = lineageRoot(item);
  return (
    <Parked.Provider item={item}>
      <SheetHeader className="gap-1.5">
        <SheetTitle>{item.title}</SheetTitle>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <ReasonIcon reason={item.reason} />
          <span className="text-foreground">{reasonTitle(item)}</span>
          {item.changedSinceParked && <ChangedBadge />}
          <span className="ms-auto" />
          <When atMillis={item.parkedAtMillis} />
        </span>
        {detail && detail !== item.summary && <p className="text-xs text-destructive">{detail}</p>}
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4">
        <p className="text-sm">{item.summary}</p>
        <AnswerChips answers={item.answers} />
        <Parked.Plan />
        <Separator />
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {root && <AppIcon app={root.app} />}
          <span className="font-mono">{item.ref}</span>
          <span aria-hidden>·</span>
          <span>{item.workspace ?? "No Workspace"}</span>
        </span>
        <LineageTimeline item={item} />
      </div>
      <SheetFooter>
        <Parked.Commands />
      </SheetFooter>
    </Parked.Provider>
  );
}

function NotificationSheetBody({ notification }: { notification: NotificationRecord }) {
  return (
    <>
      <SheetHeader className="gap-1.5">
        <SheetTitle>{notification.title}</SheetTitle>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <ItemLink itemRef={notification.ref} />
          <span aria-hidden>·</span>
          <span>{notification.operation}</span>
          <span className="ms-auto" />
          <When atMillis={notification.atMillis} />
        </span>
      </SheetHeader>
      <div className="flex flex-col gap-4 px-4">
        <p className="text-sm">{notification.summary}</p>
        <AnswerChips answers={notification.answers} />
        <ArtifactLinks artifacts={notification.artifacts} />
      </div>
      <SheetFooter className="flex-row justify-end">
        <DismissButton notification={notification} />
      </SheetFooter>
    </>
  );
}

export function AttentionByWorkflow() {
  const { focus, setFocus } = useFocus();
  const parked = useVisibleParked();
  const notifications = useVisibleNotifications();
  const openItem = parked.find((item) => item.id === focus) ?? null;
  const openNotification = notifications.find((notification) => notification.id === focus) ?? null;
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-6 pb-6">
      {workflowList.map((workflow) => (
        <WorkflowCard
          key={workflow.id}
          workflow={workflow}
          parked={parked.filter((item) => item.workflow.id === workflow.id)}
          notifications={notifications.filter((notification) => notification.workflow.id === workflow.id)}
        />
      ))}
      <Sheet
        open={openItem !== null || openNotification !== null}
        onOpenChange={(open) => {
          if (!open) setFocus(null);
        }}
      >
        <SheetContent className="data-[side=right]:sm:max-w-lg">
          {openItem && <ParkedSheetBody key={openItem.id} item={openItem} />}
          {openNotification && <NotificationSheetBody notification={openNotification} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}
