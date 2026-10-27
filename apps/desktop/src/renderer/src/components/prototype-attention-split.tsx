import { Alert, AlertDescription, AlertTitle } from "@cogwork/ui/components/alert";
import { Badge } from "@cogwork/ui/components/badge";
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "@cogwork/ui/components/item";
import { ScrollArea } from "@cogwork/ui/components/scroll-area";
import { Separator } from "@cogwork/ui/components/separator";
import { Tabs, TabsList, TabsTrigger } from "@cogwork/ui/components/tabs";
import type { ReactNode } from "react";
import {
  type NotificationRecord,
  type ParkedItem,
  type WorkflowRef,
  workflowList,
} from "../features/prototype-attention-data";
import {
  AnswerChips,
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
  WorkflowTag,
} from "./prototype-attention-parts";

/** PROTOTYPE — issue #794, variant C: a list beside the one item it shows in full. */

type SplitTab = "needs-you" | "notifications" | "skipped";

const isSplitTab = (value: unknown): value is SplitTab =>
  value === "needs-you" || value === "notifications" || value === "skipped";

const workflowFocus = (workflow: WorkflowRef) => `workflow:${workflow.id}`;

const tabFor = (focus: string | null): SplitTab => {
  if (focus?.startsWith("note:")) return "notifications";
  if (focus?.startsWith("workflow:")) return "skipped";
  return "needs-you";
};

function ListRow({
  selected,
  onSelect,
  media,
  title,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  media: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <Item
      size="xs"
      variant={selected ? "muted" : "default"}
      render={<button type="button" onClick={onSelect} />}
      className="text-start"
    >
      <ItemMedia>{media}</ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="w-full">
          <span className="truncate">{title}</span>
        </ItemTitle>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">{children}</span>
      </ItemContent>
    </Item>
  );
}

function ParkedDetail({ item }: { item: ParkedItem }) {
  const detail = reasonDetail(item.reason);
  return (
    <Parked.Provider item={item}>
      <div className="flex h-full min-h-0 flex-col">
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-5 p-6">
            <header className="flex flex-col gap-1.5">
              <h2 className="font-heading text-lg font-medium">{item.title}</h2>
              <span className="flex items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">{item.ref}</span>
                <WorkflowTag workflow={item.workflow} operation={item.operation} />
                {item.changedSinceParked && <ChangedBadge />}
                <span className="ms-auto" />
                <When atMillis={item.parkedAtMillis} />
              </span>
            </header>
            <Alert>
              <ReasonIcon reason={item.reason} />
              <AlertTitle>{reasonTitle(item)}</AlertTitle>
              {detail && <AlertDescription>{detail}</AlertDescription>}
            </Alert>
            <div className="grid grid-cols-[1fr_14rem] gap-6">
              <div className="flex min-w-0 flex-col gap-4">
                <p className="text-sm">{item.summary}</p>
                <AnswerChips answers={item.answers} />
                <Parked.Plan />
              </div>
              <aside className="flex flex-col gap-4">
                <LineageTimeline item={item} />
                <span className="text-xs text-muted-foreground">{item.workspace ?? "No Workspace"}</span>
              </aside>
            </div>
          </div>
        </ScrollArea>
        <Separator />
        <div className="p-4">
          <Parked.Commands />
        </div>
      </div>
    </Parked.Provider>
  );
}

function NotificationDetail({ notification }: { notification: NotificationRecord }) {
  return (
    <div className="flex flex-col gap-5 p-6">
      <header className="flex flex-col gap-1.5">
        <h2 className="font-heading text-lg font-medium">{notification.title}</h2>
        <span className="flex items-center gap-2">
          <ItemLink itemRef={notification.ref} />
          <WorkflowTag workflow={notification.workflow} operation={notification.operation} />
          <span className="ms-auto" />
          <When atMillis={notification.atMillis} />
        </span>
      </header>
      <p className="text-sm">{notification.summary}</p>
      <AnswerChips answers={notification.answers} />
      <ArtifactLinks artifacts={notification.artifacts} />
      <div className="flex justify-end">
        <DismissButton notification={notification} />
      </div>
    </div>
  );
}

function SkippedDetail({ workflow }: { workflow: WorkflowRef }) {
  const records = skippedFor(workflow);
  const steps = records.filter((record) => record.kind === "step");
  const events = records.filter((record) => record.kind === "event");
  return (
    <div className="flex flex-col gap-5 p-6">
      <h2 className="font-heading text-lg font-medium">{workflow.name}</h2>
      {steps.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-muted-foreground">Steps</h3>
          <div className="divide-y">
            {steps.map((record) => (
              <SkippedRow key={record.id} record={record} />
            ))}
          </div>
        </section>
      )}
      {events.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-muted-foreground">Events</h3>
          <div className="divide-y">
            {events.map((record) => (
              <SkippedRow key={record.id} record={record} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function NeedsYouPane({ parked }: { parked: readonly ParkedItem[] }) {
  const { focus, setFocus } = useFocus();
  const selected = parked.find((item) => item.id === focus) ?? parked[0];
  return (
    <>
      <SplitList>
        {parked.map((item) => (
          <ListRow
            key={item.id}
            selected={item.id === selected?.id}
            onSelect={() => setFocus(item.id)}
            media={<ReasonIcon reason={item.reason} />}
            title={item.title}
          >
            <span className="truncate">{reasonTitle(item)}</span>
            <span className="ms-auto" />
            <When atMillis={item.parkedAtMillis} />
          </ListRow>
        ))}
      </SplitList>
      <SplitDetail>{selected && <ParkedDetail key={selected.id} item={selected} />}</SplitDetail>
    </>
  );
}

function NotificationsPane({ notifications }: { notifications: readonly NotificationRecord[] }) {
  const { focus, setFocus } = useFocus();
  const selected = notifications.find((notification) => notification.id === focus) ?? notifications[0];
  return (
    <>
      <SplitList>
        {notifications.map((notification) => (
          <ListRow
            key={notification.id}
            selected={notification.id === selected?.id}
            onSelect={() => setFocus(notification.id)}
            media={<NotificationIcon />}
            title={notification.title}
          >
            <span className="truncate">{notification.workflow.name}</span>
            <span className="ms-auto" />
            <When atMillis={notification.atMillis} />
          </ListRow>
        ))}
      </SplitList>
      <SplitDetail>{selected && <NotificationDetail notification={selected} />}</SplitDetail>
    </>
  );
}

function SkippedPane() {
  const { focus, setFocus } = useFocus();
  const withSkips = workflowList.filter((workflow) => skippedFor(workflow).length > 0);
  const selected = withSkips.find((workflow) => workflowFocus(workflow) === focus) ?? withSkips[0];
  return (
    <>
      <SplitList>
        {withSkips.map((workflow) => (
          <ListRow
            key={workflow.id}
            selected={workflow.id === selected?.id}
            onSelect={() => setFocus(workflowFocus(workflow))}
            media={<Badge variant="secondary">{skippedFor(workflow).length}</Badge>}
            title={workflow.name}
          >
            <span className="font-mono">r{workflow.revision}</span>
          </ListRow>
        ))}
      </SplitList>
      <SplitDetail>{selected && <SkippedDetail workflow={selected} />}</SplitDetail>
    </>
  );
}

function SplitList({ children }: { children: ReactNode }) {
  return (
    <ScrollArea className="col-start-1 row-start-2 min-h-0">
      <ItemGroup className="gap-0.5 p-2">{children}</ItemGroup>
    </ScrollArea>
  );
}

function SplitDetail({ children }: { children: ReactNode }) {
  return (
    <div className="col-start-2 row-span-2 row-start-1 min-h-0 overflow-y-auto border-s">{children}</div>
  );
}

export function AttentionSplit() {
  const { focus, setFocus } = useFocus();
  const parked = useVisibleParked();
  const notifications = useVisibleNotifications();
  const tab = tabFor(focus);
  const firstOf: Record<SplitTab, string | null> = {
    "needs-you": parked[0]?.id ?? null,
    notifications: notifications[0]?.id ?? null,
    skipped: workflowList[0] ? workflowFocus(workflowList[0]) : null,
  };
  return (
    <div className="grid h-full min-h-0 grid-cols-[22rem_1fr] grid-rows-[auto_1fr] border-t">
      <div className="col-start-1 row-start-1 p-2 pb-0">
        <Tabs
          value={tab}
          onValueChange={(next) => {
            if (isSplitTab(next)) setFocus(firstOf[next]);
          }}
        >
          <TabsList className="w-full">
            <TabsTrigger value="needs-you">
              Needs you <Badge variant="secondary">{parked.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="notifications">
              Notified <Badge variant="secondary">{notifications.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="skipped">Skipped</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {tab === "needs-you" && <NeedsYouPane parked={parked} />}
      {tab === "notifications" && <NotificationsPane notifications={notifications} />}
      {tab === "skipped" && <SkippedPane />}
    </div>
  );
}
