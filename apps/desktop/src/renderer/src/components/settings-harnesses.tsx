import type { HarnessItem, HarnessName } from "@cogwork/contracts";
import { Alert, AlertDescription, AlertTitle } from "@cogwork/ui/components/alert";
import { Button } from "@cogwork/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@cogwork/ui/components/input-group";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@cogwork/ui/components/item";
import { ScrollArea } from "@cogwork/ui/components/scroll-area";
import { Skeleton } from "@cogwork/ui/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@cogwork/ui/components/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { cn } from "@cogwork/ui/lib/utils";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useTimeoutEffect } from "@react-hookz/web";
import { RiAlertLine, RiCheckLine, RiFileCopyLine, RiRefreshLine } from "@remixicon/react";
import { createContext, type ReactNode, use, useState } from "react";
import { harnessesAtom } from "../daemon/atoms";
import { relativeTime } from "../features/format";
import { harnessGlyph, harnessLabel } from "../features/harness-presentation";
import { harnessSummary, installedVersion, versionLabel } from "../features/harnesses-view";
import { settingEntry } from "../features/settings-catalog";
import { useNow } from "../features/use-now";
import { HarnessGlyphIcon } from "./harness-glyph";
import { useFocusFlash } from "./settings-parts";

/* ------------------------------------------------------------------------------ shared state */

interface HarnessesValue {
  readonly state: {
    readonly harnesses: readonly HarnessItem[];
    readonly selected: HarnessItem | undefined;
    readonly checkedAtMillis: number | null;
    readonly load: "loading" | "ready" | "failed";
  };
  readonly actions: {
    readonly select: (harness: HarnessName) => void;
    readonly check: () => void;
  };
  // A probe spawns every installed harness's CLI; stacking them up must stay impossible.
  readonly meta: { readonly checking: boolean };
}

const HarnessesContext = createContext<HarnessesValue | null>(null);

const useHarnesses = () => {
  const value = use(HarnessesContext);
  if (!value) throw new Error("Harness readers must render inside Harnesses.Provider");
  return value;
};

function HarnessesProvider({ children }: { readonly children: ReactNode }) {
  const queried = useAtomValue(harnessesAtom);
  const refresh = useAtomRefresh(harnessesAtom);
  const [chosen, setChosen] = useState<HarnessName | null>(null);

  const overview = queried._tag === "Success" ? queried.value : null;
  const harnesses = overview?.harnesses ?? [];
  const value: HarnessesValue = {
    state: {
      harnesses,
      selected: harnesses.find((item) => item.harness === chosen) ?? harnesses[0],
      checkedAtMillis: overview?.checkedAtMillis ?? null,
      load: overview ? "ready" : queried._tag === "Failure" ? "failed" : "loading",
    },
    actions: { select: setChosen, check: refresh },
    meta: { checking: queried.waiting },
  };
  return <HarnessesContext value={value}>{children}</HarnessesContext>;
}

/* ------------------------------------------------------------------------------ small pieces */

function AttentionDot({ attention }: { readonly attention: "none" | "warning" | "fatal" }) {
  if (attention === "none") return null;
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        attention === "fatal" ? "bg-destructive" : "bg-warning",
      )}
    />
  );
}

function VersionCode({ version }: { readonly version: string | null }) {
  const label = versionLabel(version);
  if (!label) return null;
  return <code className="min-w-0 truncate text-xs font-normal text-muted-foreground">{label}</code>;
}

/* ----------------------------------------------------------------------------------- the list */

function HarnessRow({ item }: { readonly item: HarnessItem }) {
  const {
    state: { selected },
    actions: { select },
  } = useHarnesses();
  const summary = harnessSummary(item.state);
  const active = item.harness === selected?.harness;
  return (
    <Item
      size="sm"
      render={<button type="button" onClick={() => select(item.harness)} aria-pressed={active} />}
      className={cn(
        "min-h-19 cursor-pointer items-start text-left",
        active && "bg-foreground/8",
        !active && "hover:bg-foreground/4",
      )}
    >
      <ItemMedia variant="icon">
        {/* ItemMedia sizes a bare svg to `size-4`; its `:not([class*='size-'])` selector yields to this. */}
        <HarnessGlyphIcon glyph={harnessGlyph(item.harness)} className="size-5" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="flex min-w-0 items-center gap-2">
          <span className="truncate">{harnessLabel(item.harness)}</span>
          <VersionCode version={item.version} />
        </ItemTitle>
        <ItemDescription className="flex items-start gap-1.5">
          <span className="flex h-[1.45em] shrink-0 items-center">
            <AttentionDot attention={summary.attention} />
          </span>
          <span className="line-clamp-2 [overflow-wrap:anywhere]">
            {summary.headline}
            {summary.detail ? ` · ${summary.detail}` : null}
          </span>
        </ItemDescription>
      </ItemContent>
    </Item>
  );
}

function HarnessList() {
  const {
    state: { harnesses },
  } = useHarnesses();
  return (
    <div className="border-b border-border lg:flex lg:min-h-0 lg:flex-col lg:border-e lg:border-b-0">
      <ScrollArea className="lg:min-h-0 lg:flex-1">
        <div className="divide-y divide-border">
          {harnesses.map((item) => (
            <div key={item.harness} className="p-1">
              <HarnessRow item={item} />
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

/* --------------------------------------------------------------------------------- the detail */

const FIELD_GRID = "grid gap-x-4 gap-y-2.5 px-4 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-start";

function SignInCommand({ command }: { readonly command: string }) {
  const [copied, setCopied] = useState(false);
  const [clearCopied] = useTimeoutEffect(() => setCopied(false), copied ? 2000 : undefined);
  return (
    <div className="px-4">
      <InputGroup>
        <InputGroupInput readOnly value={command} aria-label="Sign-in command" className="font-mono" />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            aria-label="Copy command"
            onClick={() => {
              navigator.clipboard
                .writeText(command)
                .then(
                  () => setCopied(true),
                  () => setCopied(false),
                )
                .finally(clearCopied);
            }}
          >
            {copied ? <RiCheckLine /> : <RiFileCopyLine />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

function ConfigurationTab({ item }: { readonly item: HarnessItem }) {
  const installed = installedVersion(item);
  const summary = harnessSummary(item.state);
  return (
    <div className="flex flex-col gap-4 py-4">
      <div className={FIELD_GRID}>
        <span className="text-xs font-medium text-foreground">Installed</span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <code
            className={cn(
              "text-xs [overflow-wrap:anywhere]",
              installed.faulty ? "text-destructive" : "text-foreground",
            )}
          >
            {installed.value}
          </code>
          {installed.requirement ? (
            <span className="text-xs text-muted-foreground">Needs {installed.requirement}</span>
          ) : null}
        </div>
      </div>
      {summary.signIn ? <SignInCommand command={summary.signIn} /> : null}
    </div>
  );
}

function ModelsTab({ item }: { readonly item: HarnessItem }) {
  if (item.models.length === 0) {
    return (
      <Empty className="py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HarnessGlyphIcon glyph={harnessGlyph(item.harness)} />
          </EmptyMedia>
          <EmptyTitle>No models</EmptyTitle>
          <EmptyDescription>{harnessLabel(item.harness)} offered no model list.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-2 py-4">
      <p className="px-4 text-sm">{item.models.length} models available.</p>
      <div className="flex flex-col px-1">
        {item.models.map((model) => (
          <Item key={model} size="xs">
            <ItemContent>
              <ItemTitle className="font-mono text-xs font-normal">{model}</ItemTitle>
            </ItemContent>
          </Item>
        ))}
      </div>
    </div>
  );
}

function HarnessDetail() {
  const {
    state: { selected },
  } = useHarnesses();
  if (!selected) return null;
  const summary = harnessSummary(selected.state);
  return (
    <div className="min-w-0 lg:min-h-0">
      <div className="flex min-w-0 flex-col lg:h-full lg:min-h-0">
        <div className="flex min-h-16 shrink-0 flex-col justify-center gap-1 border-b border-border px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-muted-foreground">
              <HarnessGlyphIcon glyph={harnessGlyph(selected.harness)} />
            </span>
            <h2 className="truncate text-sm font-medium">{harnessLabel(selected.harness)}</h2>
            <VersionCode version={selected.version} />
          </div>
          <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
            <AttentionDot attention={summary.attention} />
            <span>{summary.headline}</span>
            {summary.detail ? <span>· {summary.detail}</span> : null}
          </p>
        </div>

        <Tabs defaultValue="configuration" className="min-w-0 gap-0 lg:min-h-0 lg:flex-1">
          <div className="shrink-0 border-b border-border px-4 py-2">
            <TabsList>
              <TabsTrigger value="configuration">Configuration</TabsTrigger>
              <TabsTrigger value="models">Models</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="configuration" className="min-w-0 lg:min-h-0 lg:flex-1">
            <ScrollArea className="lg:h-full">
              <ConfigurationTab item={selected} />
            </ScrollArea>
          </TabsContent>
          <TabsContent value="models" className="min-w-0 lg:min-h-0 lg:flex-1">
            <ScrollArea className="lg:h-full">
              <ModelsTab item={selected} />
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------ the page */

const FRAME =
  "overflow-hidden rounded-lg border border-border lg:grid lg:h-[calc(100dvh-11rem)] lg:max-h-[48rem] lg:min-h-[30rem] lg:grid-cols-[20rem_minmax(0,1fr)]";

function HarnessesHeader() {
  const {
    state: { checkedAtMillis },
    actions: { check },
    meta: { checking },
  } = useHarnesses();
  const now = useNow();
  return (
    <div className="flex items-center justify-between gap-4">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">Providers</h1>
      <Tooltip>
        <TooltipTrigger render={<Button size="sm" variant="ghost" disabled={checking} onClick={check} />}>
          <RiRefreshLine data-icon="inline-start" />
          {checking
            ? "Checking…"
            : checkedAtMillis
              ? `Checked ${relativeTime(checkedAtMillis, now)}`
              : "Check again"}
        </TooltipTrigger>
        <TooltipContent side="top">Check again</TooltipContent>
      </Tooltip>
    </div>
  );
}

function HarnessesLoading() {
  return (
    <div className={FRAME}>
      <div className="flex flex-col gap-1 border-b border-border p-1 lg:border-e lg:border-b-0">
        {[0, 1, 2, 3].map((row) => (
          <Skeleton key={row} className="h-19 w-full rounded-md" />
        ))}
      </div>
      <div className="min-w-0" />
    </div>
  );
}

function HarnessesFailure() {
  return (
    <Alert variant="destructive">
      <RiAlertLine />
      <AlertTitle>Cogwork could not read this machine's harnesses.</AlertTitle>
      <AlertDescription>The engine did not answer. Check again, or read the daemon log.</AlertDescription>
    </Alert>
  );
}

function HarnessesNone() {
  return (
    <Empty className="rounded-lg border border-border py-16">
      <EmptyHeader>
        <EmptyTitle>No harnesses registered</EmptyTitle>
        <EmptyDescription>This engine build registers no coding agent to drive.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function HarnessesFrame() {
  return (
    <div className={FRAME}>
      <HarnessList />
      <HarnessDetail />
    </div>
  );
}

function HarnessesBody() {
  const {
    state: { load, selected },
  } = useHarnesses();
  if (load === "failed") return <HarnessesFailure />;
  if (load === "loading") return <HarnessesLoading />;
  if (!selected) return <HarnessesNone />;
  return <HarnessesFrame />;
}

export function HarnessesSettings() {
  const { ref, flashing, flashKey } = useFocusFlash(settingEntry("harness-state").id);
  return (
    <HarnessesProvider>
      {/* The settings shell centres its column at `max-w-2xl`; this breaks out of it. */}
      <div
        key={flashKey}
        ref={ref}
        className={cn(
          "relative left-1/2 flex w-[min(64rem,calc(100vw-var(--sidebar-width)-4rem))] -translate-x-1/2 scroll-mt-8 flex-col gap-4 rounded-lg",
          flashing && "settings-focus-flash",
        )}
      >
        <HarnessesHeader />
        <HarnessesBody />
      </div>
    </HarnessesProvider>
  );
}
