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
import { Switch } from "@cogwork/ui/components/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@cogwork/ui/components/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { cn } from "@cogwork/ui/lib/utils";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useTimeoutEffect } from "@react-hookz/web";
import { RiAlertLine, RiCheckLine, RiFileCopyLine, RiRefreshLine } from "@remixicon/react";
import { createFileRoute } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { createContext, type ReactNode, use, useState } from "react";
import { ProviderGlyphIcon } from "../../components/provider-glyph";
import { useFocusFlash } from "../../components/settings-parts";
import { checkHarnessesAtom, setHarnessEnabledAtom } from "../../daemon/atoms";
import { BoardResult, useBoard } from "../../features/activity-session";
import { relativeTime } from "../../features/format";
import {
  applyHarnessEnablement,
  type HarnessEnablementOverlay,
  type HarnessSummary,
  harnessEnablementView,
  harnessSummary,
  installedVersion,
  versionLabel,
} from "../../features/harnesses-view";
import { providerGlyph, providerLabel } from "../../features/provider-presentation";
import { settingEntry } from "../../features/settings-catalog";
import { useNow } from "../../features/use-now";

/* ------------------------------------------------------------------------------ shared state */

interface ProvidersValue {
  readonly state: {
    readonly providers: readonly HarnessItem[];
    readonly selected: HarnessItem | undefined;
    readonly checkedAtMillis: number | null;
    readonly load: "loading" | "ready" | "failed";
    readonly mutationFailure: string | null;
  };
  readonly actions: {
    readonly select: (harness: HarnessName) => void;
    readonly check: () => void;
    readonly setEnabled: (harness: HarnessName, enabled: boolean) => void;
  };
  readonly meta: { readonly checking: boolean; readonly changing: boolean };
}

const ProvidersContext = createContext<ProvidersValue | null>(null);

const useProviders = () => {
  const value = use(ProvidersContext);
  if (!value) throw new Error("Provider readers must render inside <Providers>");
  return value;
};

const loadState = (overview: unknown, failed: boolean): ProvidersValue["state"]["load"] => {
  if (overview) return "ready";
  if (failed) return "failed";
  return "loading";
};

const checkLabel = (checking: boolean, checkedAtMillis: number | null, now: number) => {
  if (checking) return "Checking…";
  if (checkedAtMillis) return `Checked ${relativeTime(checkedAtMillis, now)}`;
  return "Check again";
};

function Providers({ children }: { readonly children: ReactNode }) {
  const boardResult = useBoard();
  const [chosen, setChosen] = useState<HarnessName | null>(null);
  const [enablementOverlay, setEnablementOverlay] = useState<HarnessEnablementOverlay | null>(null);
  const checkHarnesses = useAtomSet(checkHarnessesAtom, { mode: "promiseExit" });
  const checkResult = useAtomValue(checkHarnessesAtom);
  const setEnabled = useAtomSet(setHarnessEnabledAtom, { mode: "promiseExit" });
  const enablement = useAtomValue(setHarnessEnabledAtom);

  const board = BoardResult.$is("Success")(boardResult) ? boardResult.board : null;
  const overview = board?.harnesses ?? null;
  const boardControlStore = board?.controlStore ?? null;
  const { controlStore, settled } = harnessEnablementView(boardControlStore, enablementOverlay);
  if (settled) setEnablementOverlay(null);
  const providers = applyHarnessEnablement(overview?.harnesses ?? [], controlStore);
  const mutationCause = [checkResult, enablement].find((result) => result._tag === "Failure")?.cause;
  const value: ProvidersValue = {
    state: {
      providers,
      selected: providers.find((item) => item.harness === chosen) ?? providers[0],
      checkedAtMillis: overview?.checkedAtMillis ?? null,
      load: loadState(overview, BoardResult.$is("Failure")(boardResult)),
      mutationFailure: mutationCause ? Cause.pretty(mutationCause) : null,
    },
    actions: {
      select: setChosen,
      check: () => checkHarnesses({ payload: undefined }),
      setEnabled: (harness, enabled) =>
        setEnabled({ payload: { harness, enabled } }).then((exit) => {
          if (!Exit.isSuccess(exit)) return;
          setEnablementOverlay({ base: boardControlStore, updated: exit.value });
        }),
    },
    meta: { checking: checkResult.waiting, changing: enablement.waiting },
  };
  return <ProvidersContext value={value}>{children}</ProvidersContext>;
}

/* ------------------------------------------------------------------------------ small pieces */

function AttentionDot({ attention }: { readonly attention: HarnessSummary["attention"] }) {
  if (attention === "none") return null;
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        attention === "muted" && "bg-muted-foreground",
        attention === "warning" && "bg-warning",
        attention === "fatal" && "bg-destructive",
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

function ProviderRow({ item }: { readonly item: HarnessItem }) {
  const {
    state: { selected },
    actions: { select, setEnabled },
    meta: { changing },
  } = useProviders();
  const summary = harnessSummary(item);
  const active = item.harness === selected?.harness;
  return (
    <Item
      size="sm"
      className={cn(
        "min-h-19 items-start text-left",
        active && "bg-foreground/8",
        !active && "hover:bg-foreground/4",
        !item.enabled && "opacity-60",
      )}
    >
      <button
        type="button"
        onClick={() => select(item.harness)}
        aria-pressed={active}
        className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 text-left"
      >
        <ItemMedia variant="icon">
          <ProviderGlyphIcon glyph={providerGlyph(item.harness)} className="size-5" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle className="flex min-w-0 items-center gap-2">
            <span className="truncate">{providerLabel(item.harness)}</span>
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
      </button>
      <Switch
        size="sm"
        checked={item.enabled}
        disabled={changing}
        aria-label={`${item.enabled ? "Disable" : "Enable"} ${providerLabel(item.harness)}`}
        onCheckedChange={(enabled) => setEnabled(item.harness, enabled)}
      />
    </Item>
  );
}

function ProviderList() {
  const {
    state: { providers },
  } = useProviders();
  return (
    <div className="border-b border-border lg:flex lg:min-h-0 lg:flex-col lg:border-e lg:border-b-0">
      <ScrollArea className="lg:min-h-0 lg:flex-1">
        <div className="divide-y divide-border">
          {providers.map((item) => (
            <div key={item.harness} className="p-1">
              <ProviderRow item={item} />
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

/* --------------------------------------------------------------------------------- the detail */

function SignInCommand({ command }: { readonly command: string }) {
  const [copied, setCopied] = useState(false);
  useTimeoutEffect(() => setCopied(false), copied ? 2000 : undefined);
  return (
    <div className="px-4">
      <InputGroup>
        <InputGroupInput readOnly value={command} aria-label="Sign-in command" className="font-mono" />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            aria-label="Copy command"
            onClick={() => {
              navigator.clipboard.writeText(command).then(
                () => setCopied(true),
                () => setCopied(false),
              );
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
  const summary = harnessSummary(item);
  return (
    <div className="flex flex-col gap-4 py-4">
      <div className="grid gap-x-4 gap-y-2.5 px-4 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-start">
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
      {summary.signIn ? <SignInCommand key={summary.signIn} command={summary.signIn} /> : null}
      {item.diagnostics.length > 0 ? (
        <Alert className="mx-4 w-auto">
          <RiAlertLine />
          <AlertTitle>Provider diagnostics</AlertTitle>
          <AlertDescription>
            <ul className="flex list-disc flex-col gap-1 ps-4">
              {item.diagnostics.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function ModelsTab({ item }: { readonly item: HarnessItem }) {
  if (item.models.length === 0) {
    return (
      <Empty className="py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ProviderGlyphIcon glyph={providerGlyph(item.harness)} />
          </EmptyMedia>
          <EmptyTitle>No models</EmptyTitle>
          <EmptyDescription>{providerLabel(item.harness)} offered no model list.</EmptyDescription>
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

function ProviderDetail() {
  const {
    state: { selected },
  } = useProviders();
  if (!selected) return null;
  const summary = harnessSummary(selected);
  return (
    <div className="min-w-0 lg:min-h-0">
      <div className="flex min-w-0 flex-col lg:h-full lg:min-h-0">
        <div className="flex min-h-16 shrink-0 flex-col justify-center gap-1 border-b border-border px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-muted-foreground">
              <ProviderGlyphIcon glyph={providerGlyph(selected.harness)} />
            </span>
            <h2 className="truncate text-sm font-medium">{providerLabel(selected.harness)}</h2>
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

function ProvidersHeader() {
  const {
    state: { checkedAtMillis },
    actions: { check },
    meta: { checking },
  } = useProviders();
  const now = useNow();
  const label = checkLabel(checking, checkedAtMillis, now);
  return (
    <div className="flex items-center justify-between gap-4">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">Providers</h1>
      <Tooltip>
        <TooltipTrigger render={<Button size="sm" variant="ghost" disabled={checking} onClick={check} />}>
          <RiRefreshLine data-icon="inline-start" />
          {label}
        </TooltipTrigger>
        <TooltipContent side="top">Check again</TooltipContent>
      </Tooltip>
    </div>
  );
}

function ProvidersLoading() {
  return (
    <div className="overflow-hidden rounded-lg border border-border lg:grid lg:h-[calc(100dvh-11rem)] lg:max-h-[48rem] lg:min-h-[30rem] lg:grid-cols-[20rem_minmax(0,1fr)]">
      <div className="flex flex-col gap-1 border-b border-border p-1 lg:border-e lg:border-b-0">
        {[0, 1, 2, 3].map((row) => (
          <Skeleton key={row} className="h-19 w-full rounded-md" />
        ))}
      </div>
      <div className="min-w-0" />
    </div>
  );
}

function ProvidersFailure() {
  return (
    <Alert variant="destructive">
      <RiAlertLine />
      <AlertTitle>Cogwork could not read this machine's providers.</AlertTitle>
      <AlertDescription>The engine did not answer. Check again, or read the daemon log.</AlertDescription>
    </Alert>
  );
}

function ProvidersNone() {
  return (
    <Empty className="rounded-lg border border-border py-16">
      <EmptyHeader>
        <EmptyTitle>No providers registered</EmptyTitle>
        <EmptyDescription>This engine build registers no coding agent to drive.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function ProvidersFrame() {
  return (
    <div className="overflow-hidden rounded-lg border border-border lg:grid lg:h-[calc(100dvh-11rem)] lg:max-h-[48rem] lg:min-h-[30rem] lg:grid-cols-[20rem_minmax(0,1fr)]">
      <ProviderList />
      <ProviderDetail />
    </div>
  );
}

function ProvidersBody() {
  const {
    state: { load, mutationFailure, selected },
  } = useProviders();
  if (load === "failed") return <ProvidersFailure />;
  if (load === "loading") return <ProvidersLoading />;
  if (!selected) return <ProvidersNone />;
  return (
    <div className="flex flex-col gap-4">
      {mutationFailure ? (
        <Alert variant="destructive">
          <RiAlertLine />
          <AlertTitle>Cogwork could not change this provider.</AlertTitle>
          <AlertDescription>{mutationFailure}</AlertDescription>
        </Alert>
      ) : null}
      <ProvidersFrame />
    </div>
  );
}

function ProvidersSettings() {
  const { ref, flashing, flashKey } = useFocusFlash(settingEntry("harness-state").id);
  return (
    <Providers>
      {/* The settings shell centres its column at `max-w-2xl`; this breaks out of it. */}
      <div
        key={flashKey}
        ref={ref}
        className={cn(
          "relative left-1/2 flex w-[min(64rem,calc(100vw-var(--sidebar-width)-4rem))] -translate-x-1/2 scroll-mt-8 flex-col gap-4 rounded-lg",
          flashing && "settings-focus-flash",
        )}
      >
        <ProvidersHeader />
        <ProvidersBody />
      </div>
    </Providers>
  );
}

export const Route = createFileRoute("/settings/providers")({
  component: ProvidersSettings,
});
