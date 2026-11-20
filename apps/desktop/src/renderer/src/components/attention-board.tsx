import { Alert, AlertAction, AlertDescription } from "@cogwork/ui/components/alert";
import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@cogwork/ui/components/tabs";
import { cn } from "@cogwork/ui/lib/utils";
import { RiLayoutColumnLine, RiListUnordered } from "@remixicon/react";
import type { ReactNode } from "react";

import { byUrgency, skippedByWorkflow } from "../features/workflow-parks";
import { AttentionProvider, isAttentionLayout, useAttention } from "./attention-board-context";
import { NotificationCard } from "./attention-board-notification";
import { ParkedCard } from "./attention-board-parked";
import { SkippedCard } from "./attention-board-skipped";

function Lane({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const {
    state: { layout },
  } = useAttention();
  return (
    <section className="flex flex-col gap-1 rounded-2xl bg-muted/60 p-1">
      <h2
        className={cn(
          "flex h-8 items-center gap-2 px-2.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase",
          layout === "board" && "justify-center",
        )}
      >
        {title}
        <Badge variant="secondary" className="tabular-nums">
          {count}
        </Badge>
      </h2>
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  );
}

function AttentionLanes() {
  const {
    state: { parked, notifications, skipped, layout },
  } = useAttention();
  const skippedGroups = skippedByWorkflow(skipped);
  return (
    <div
      className={cn(
        layout === "board" && "grid grid-cols-3 items-start gap-2",
        layout === "list" && "mx-auto flex w-full max-w-3xl flex-col gap-3",
      )}
    >
      <Lane title="Needs you" count={parked.length}>
        {byUrgency(parked).map((item) => (
          <ParkedCard key={item.id} item={item} />
        ))}
      </Lane>
      <Lane title="Notified" count={notifications.length}>
        {notifications.map((notification) => (
          <NotificationCard key={notification.id} notification={notification} />
        ))}
      </Lane>
      <Lane title="Skipped" count={skippedGroups.length}>
        {skippedGroups.map((group) => (
          <SkippedCard key={group.workflow.id} workflow={group.workflow} records={group.records} />
        ))}
      </Lane>
    </div>
  );
}

function AttentionFrame({ children }: { children: ReactNode }) {
  const {
    state: { layout, failure, notificationFailure },
    actions: { setLayout, openNotificationSettings },
  } = useAttention();
  return (
    <Tabs
      value={layout}
      onValueChange={(next) => {
        if (isAttentionLayout(next)) setLayout(next);
      }}
      className="gap-4 px-6 pt-5 pb-6"
    >
      <header className="flex items-center justify-between">
        <h1 className="text-base font-medium">Attention</h1>
        <TabsList>
          <TabsTrigger value="board">
            <RiLayoutColumnLine />
            Board
          </TabsTrigger>
          <TabsTrigger value="list">
            <RiListUnordered />
            List
          </TabsTrigger>
        </TabsList>
      </header>
      {failure && (
        <Alert variant="destructive">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
      {notificationFailure && (
        <Alert variant="destructive">
          <AlertDescription>
            {notificationFailure}. Parks still appear here. Allow Cogwork notifications in System Settings.
          </AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={openNotificationSettings}>
              System Settings
            </Button>
          </AlertAction>
        </Alert>
      )}
      <TabsContent value="board">{children}</TabsContent>
      <TabsContent value="list">{children}</TabsContent>
    </Tabs>
  );
}

export const Attention = {
  Provider: AttentionProvider,
  Frame: AttentionFrame,
  Lanes: AttentionLanes,
};
