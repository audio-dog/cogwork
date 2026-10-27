import { Tabs, TabsContent, TabsList, TabsTrigger } from "@cogwork/ui/components/tabs";
import { RiLayoutColumnLine, RiListUnordered } from "@remixicon/react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  CommandReadout,
  OsNotificationBanner,
  PrototypeControls,
} from "../../components/prototype-attention-chrome";
import { AttentionCompact } from "../../components/prototype-attention-compact";
import { type AttentionLayout, AttentionViewProvider } from "../../components/prototype-attention-parts";
import { AttentionQuiet } from "../../components/prototype-attention-quiet";
import { AttentionUpfront } from "../../components/prototype-attention-upfront";
import { PrototypeSwitcher, type PrototypeVariant } from "../../components/prototype-switcher";

/**
 * PROTOTYPE — issue #794. One attention surface with a board and a list; `?variant=` switches the
 * polish version, `?layout=` the arrangement, and `?focus=` names the card an OS notification opens.
 */

const variants: readonly PrototypeVariant[] = [
  { key: "P1", name: "Quiet" },
  { key: "P2", name: "Compact" },
  { key: "P3", name: "Plan up front" },
];

interface AttentionSearch {
  readonly variant: string;
  readonly layout: AttentionLayout;
  readonly focus?: string;
}

export const Route = createFileRoute("/_app/attention-prototype")({
  validateSearch: (search: Record<string, unknown>): AttentionSearch => ({
    variant: typeof search.variant === "string" ? search.variant : "P1",
    layout: search.layout === "list" ? "list" : "board",
    focus: typeof search.focus === "string" ? search.focus : undefined,
  }),
  component: AttentionPrototypeRoute,
});

function Variant({ variant }: { variant: string }) {
  if (variant === "P2") return <AttentionCompact />;
  if (variant === "P3") return <AttentionUpfront />;
  return <AttentionQuiet />;
}

const isLayout = (value: unknown): value is AttentionLayout => value === "board" || value === "list";

function AttentionPrototypeRoute() {
  const { variant, layout, focus } = Route.useSearch();
  const navigate = useNavigate();
  const go = (next: Partial<AttentionSearch>) =>
    navigate({ to: "/attention-prototype", search: { variant, layout, focus, ...next }, replace: true });
  const setFocus = (id: string | null) => go({ focus: id ?? undefined });

  return (
    <AttentionViewProvider focus={focus ?? null} setFocus={setFocus} layout={layout}>
      <Tabs
        value={layout}
        onValueChange={(next) => {
          if (isLayout(next)) go({ layout: next });
        }}
        className="gap-4 px-6 pt-5 pb-24"
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
        <TabsContent value="board">
          <Variant variant={variant} />
        </TabsContent>
        <TabsContent value="list">
          <Variant variant={variant} />
        </TabsContent>
      </Tabs>
      <OsNotificationBanner onOpen={setFocus} />
      <CommandReadout />
      <PrototypeSwitcher variants={variants} current={variant} onSelect={(key) => go({ variant: key })}>
        <PrototypeControls />
      </PrototypeSwitcher>
    </AttentionViewProvider>
  );
}
