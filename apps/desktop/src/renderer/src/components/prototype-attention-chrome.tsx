import { Button } from "@cogwork/ui/components/button";
import { Card } from "@cogwork/ui/components/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@cogwork/ui/components/dropdown-menu";
import { Separator } from "@cogwork/ui/components/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { RiCloseLine, RiNotification3Line, RiRefreshLine } from "@remixicon/react";
import { notifications, parkedItems, raisesOsNotification } from "../features/prototype-attention-data";
import { usePrototypeAttention } from "../features/prototype-attention-store";
import { NotificationIcon, ReasonIcon, reasonLabel } from "./prototype-attention-parts";

/**
 * PROTOTYPE — issue #794. Controls around the variants, not part of the design: a stand-in for the
 * macOS banner that main would post, and a readout of the command RPC each response sends.
 */

const bannerContent = (id: string) => {
  const item = parkedItems.find((candidate) => candidate.id === id);
  if (item) return { title: reasonLabel(item), body: item.title, icon: <ReasonIcon reason={item.reason} /> };
  const notification = notifications.find((candidate) => candidate.id === id);
  if (notification)
    return { title: notification.title, body: notification.summary, icon: <NotificationIcon /> };
  return null;
};

export function OsNotificationBanner({ onOpen }: { onOpen: (id: string) => void }) {
  const banner = usePrototypeAttention((state) => state.banner);
  const clearBanner = usePrototypeAttention((state) => state.clearBanner);
  const content = banner ? bannerContent(banner) : null;
  if (!banner || !content) return null;
  return (
    <Card size="sm" className="fixed top-12 right-4 z-50 w-80 shadow-lg">
      <div className="flex items-start gap-3 px-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-3 text-start"
          onClick={() => {
            clearBanner();
            onOpen(banner);
          }}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
            {content.icon}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="text-xs text-muted-foreground">cogwork</span>
            <span className="truncate text-sm font-medium">{content.title}</span>
            <span className="line-clamp-2 text-sm text-muted-foreground">{content.body}</span>
          </span>
        </button>
        <Button aria-label="Close notification" size="icon-xs" variant="ghost" onClick={clearBanner}>
          <RiCloseLine />
        </Button>
      </div>
    </Card>
  );
}

export function OsNotificationMenu() {
  const showBanner = usePrototypeAttention((state) => state.showBanner);
  const parks = parkedItems.filter((item) => raisesOsNotification(item.reason));
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={<Button aria-label="Send an OS notification" size="icon-sm" variant="ghost" />}
            />
          }
        >
          <RiNotification3Line />
        </TooltipTrigger>
        <TooltipContent>Send an OS notification</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" align="center" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Parks</DropdownMenuLabel>
          {parks.map((item) => (
            <DropdownMenuItem key={item.id} onClick={() => showBanner(item.id)}>
              <ReasonIcon reason={item.reason} />
              <span className="truncate">{item.title}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuGroup>
          <DropdownMenuLabel>Notify me</DropdownMenuLabel>
          {notifications.map((notification) => (
            <DropdownMenuItem key={notification.id} onClick={() => showBanner(notification.id)}>
              <NotificationIcon />
              <span className="truncate">{notification.title}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PrototypeControls() {
  const reset = usePrototypeAttention((state) => state.reset);
  return (
    <>
      <Separator orientation="vertical" className="h-5" />
      <OsNotificationMenu />
      <Tooltip>
        <TooltipTrigger render={<Button aria-label="Reset" size="icon-sm" variant="ghost" onClick={reset} />}>
          <RiRefreshLine />
        </TooltipTrigger>
        <TooltipContent>Reset</TooltipContent>
      </Tooltip>
    </>
  );
}

export function CommandReadout() {
  const lastCommand = usePrototypeAttention((state) => state.lastCommand);
  if (!lastCommand) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-18 z-50 flex justify-center">
      <span className="rounded-full border bg-popover px-3 py-1 font-mono text-xs shadow-sm">
        {lastCommand}
      </span>
    </div>
  );
}
