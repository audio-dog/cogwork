import { Card } from "@cogwork/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@cogwork/ui/components/item";
import { Switch } from "@cogwork/ui/components/switch";
import { cn } from "@cogwork/ui/lib/utils";
import { RiToolsLine } from "@remixicon/react";
import { createContext, type ReactNode, use, useRef } from "react";
import {
  findSection,
  type SettingEntry,
  type SettingsSectionId,
  settingsIndex,
} from "../features/settings-catalog";
import { useDesktopPreferences } from "../store/preferences";

const FocusedSettingContext = createContext<{ focus?: string; jump?: number }>({});

function useFocusScroll(id: string) {
  const { focus, jump } = use(FocusedSettingContext);
  const scrolledFor = useRef<string | undefined>(undefined);
  const active = focus === id;
  const scrollToken = active ? `${id}:${jump ?? 0}` : undefined;

  if (!active) {
    scrolledFor.current = undefined;
  }

  return (node: HTMLElement | null) => {
    if (!node || !scrollToken || scrolledFor.current === scrollToken) return;
    scrolledFor.current = scrollToken;
    node.scrollIntoView({ block: "center" });
  };
}

function settingEntry(id: string) {
  const found = settingsIndex.find((entry) => entry.id === id);
  if (!found) throw new Error(`Unknown setting: ${id}`);
  return found;
}

function CloseToHideControl() {
  const closeToHide = useDesktopPreferences((state) => state.closeToHide);
  const setCloseToHide = useDesktopPreferences((state) => state.setCloseToHide);
  return <Switch aria-label="Close to hide" checked={closeToHide} onCheckedChange={setCloseToHide} />;
}

function SettingRow({ entry, children }: { entry: SettingEntry; children: ReactNode }) {
  const { focus, jump } = use(FocusedSettingContext);
  const scrollRef = useFocusScroll(entry.id);
  const flashing = focus === entry.id;
  return (
    <Item
      key={flashing ? `${entry.id}:${jump ?? 0}` : entry.id}
      ref={scrollRef}
      className={cn("scroll-mt-8 rounded-lg", flashing && "settings-focus-flash")}
    >
      <ItemContent>
        <ItemTitle>{entry.title}</ItemTitle>
        <ItemDescription>{entry.description}</ItemDescription>
      </ItemContent>
      <ItemActions>{children}</ItemActions>
    </Item>
  );
}

function SubSectionCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-muted-foreground">{label}</h2>
      <Card size="sm" className="gap-0 py-0">
        {children}
      </Card>
    </section>
  );
}

function GeneralPage() {
  return (
    <SubSectionCard label="Window">
      <SettingRow entry={settingEntry("close-to-hide")}>
        <CloseToHideControl />
      </SettingRow>
    </SubSectionCard>
  );
}

function ComingSoonPage() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <RiToolsLine />
        </EmptyMedia>
        <EmptyTitle>Coming soon</EmptyTitle>
        <EmptyDescription>This section is on its way in a follow-up.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function SectionBody({ sectionId }: { sectionId: SettingsSectionId }) {
  switch (sectionId) {
    case "general":
      return <GeneralPage />;
    case "appearance":
    case "engine":
      return <ComingSoonPage />;
  }
}

export function SettingsSectionView({
  sectionId,
  focus,
  jump,
}: {
  sectionId: SettingsSectionId;
  focus?: string;
  jump?: number;
}) {
  const section = findSection(sectionId);
  return (
    <FocusedSettingContext value={{ focus, jump }}>
      <div className="flex flex-col gap-8">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">{section?.label}</h1>
        <SectionBody sectionId={sectionId} />
      </div>
    </FocusedSettingContext>
  );
}
