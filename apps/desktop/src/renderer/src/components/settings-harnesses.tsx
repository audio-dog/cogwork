import type { HarnessItem } from "@cogwork/contracts";
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
import { RiAlertLine, RiCheckLine, RiFileCopyLine, RiRefreshLine } from "@remixicon/react";
import { useState } from "react";
import { harnessesAtom } from "../daemon/atoms";
import { relativeTime } from "../features/format";
import { harnessGlyph, harnessLabel } from "../features/harness-presentation";
import { harnessSummary, installedVersion, versionLabel } from "../features/harnesses-view";
import { HarnessGlyphIcon } from "./harness-glyph";

/* ------------------------------------------------------------------------------ small pieces */

/** Only trouble gets a dot, so a ready list stays quiet. */
function StatusDot({ attention }: { readonly attention: "none" | "warning" | "fatal" }) {
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

const FIELD_GRID = "grid gap-x-4 gap-y-2.5 px-4 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-start";

/** One label/value pair, emitted as two cells of the enclosing `FIELD_GRID`. */
function Fact({
  label,
  value,
  detail,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
  readonly tone: "good" | "bad";
}) {
  return (
    <>
      <span className="text-xs font-medium text-foreground">{label}</span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <code
          className={cn(
            "text-xs [overflow-wrap:anywhere]",
            tone === "good" && "text-foreground",
            tone === "bad" && "text-destructive",
          )}
        >
          {value}
        </code>
        {detail ? <span className="text-xs text-muted-foreground">{detail}</span> : null}
      </div>
    </>
  );
}

function SignInCommand({ command }: { readonly command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="px-4">
      <InputGroup>
        <InputGroupInput readOnly value={command} aria-label="Sign-in command" className="font-mono" />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            aria-label="Copy command"
            onClick={() => {
              navigator.clipboard.writeText(command).catch(() => undefined);
              setCopied(true);
            }}
          >
            {copied ? <RiCheckLine /> : <RiFileCopyLine />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

/* ----------------------------------------------------------------------------------- the list */

function HarnessListRow({
  item,
  selected,
  onSelect,
}: {
  readonly item: HarnessItem;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const summary = harnessSummary(item.state);
  return (
    <Item
      size="sm"
      render={<button type="button" onClick={onSelect} aria-pressed={selected} />}
      // Fixed row height keeps the list even while a two-line status clamps instead of growing.
      className={cn(
        "min-h-19 cursor-pointer items-start text-left",
        selected && "bg-foreground/8",
        !selected && "hover:bg-foreground/4",
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
            <StatusDot attention={summary.attention} />
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

/* --------------------------------------------------------------------------------- the detail */

function ConfigurationTab({ item }: { readonly item: HarnessItem }) {
  const installed = installedVersion(item);
  const summary = harnessSummary(item.state);
  return (
    <div className="flex flex-col gap-4 py-4">
      <div className={FIELD_GRID}>
        <Fact
          label="Installed"
          tone={installed.requirement || installed.value === "not found" ? "bad" : "good"}
          value={installed.value}
          {...(installed.requirement ? { detail: `Needs ${installed.requirement}` } : {})}
        />
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

function HarnessDetail({ item }: { readonly item: HarnessItem }) {
  const summary = harnessSummary(item.state);
  return (
    <div className="flex min-w-0 flex-col lg:h-full lg:min-h-0">
      <div className="flex min-h-16 shrink-0 flex-col justify-center gap-1 border-b border-border px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-muted-foreground">
            <HarnessGlyphIcon glyph={harnessGlyph(item.harness)} />
          </span>
          <h2 className="truncate text-sm font-medium">{harnessLabel(item.harness)}</h2>
          <VersionCode version={item.version} />
        </div>
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] leading-[1.45] text-muted-foreground">
          <StatusDot attention={summary.attention} />
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
            <ConfigurationTab item={item} />
          </ScrollArea>
        </TabsContent>
        <TabsContent value="models" className="min-w-0 lg:min-h-0 lg:flex-1">
          <ScrollArea className="lg:h-full">
            <ModelsTab item={item} />
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ------------------------------------------------------------------------------------ the frame */

const FRAME =
  "overflow-hidden rounded-lg border border-border lg:grid lg:h-[calc(100dvh-11rem)] lg:max-h-[48rem] lg:min-h-[30rem] lg:grid-cols-[20rem_minmax(0,1fr)]";

/** Escapes the settings column, which is `max-w-2xl` — too narrow for a list beside a detail pane. */
const WIDE =
  "relative left-1/2 flex w-[min(64rem,calc(100vw-var(--sidebar-width)-4rem))] -translate-x-1/2 flex-col gap-4";

function LoadingFrame() {
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

export function HarnessesSettings() {
  const queried = useAtomValue(harnessesAtom);
  const refresh = useAtomRefresh(harnessesAtom);
  const [selected, setSelected] = useState<string | null>(null);

  const overview = queried._tag === "Success" ? queried.value : null;
  const harnesses = overview?.harnesses ?? [];
  const item = harnesses.find((candidate) => candidate.harness === selected) ?? harnesses[0];

  return (
    <div className={WIDE}>
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Providers</h1>
        <Tooltip>
          <TooltipTrigger render={<Button size="sm" variant="ghost" onClick={refresh} />}>
            <RiRefreshLine data-icon="inline-start" />
            {overview ? `Checked ${relativeTime(overview.checkedAtMillis)}` : "Check again"}
          </TooltipTrigger>
          <TooltipContent side="top">Check again</TooltipContent>
        </Tooltip>
      </div>

      {queried._tag === "Failure" ? (
        <Alert variant="destructive">
          <RiAlertLine />
          <AlertTitle>Cogwork could not read this machine's providers.</AlertTitle>
          <AlertDescription>The engine did not answer. Check again, or read the daemon log.</AlertDescription>
        </Alert>
      ) : null}

      {queried._tag === "Initial" ? <LoadingFrame /> : null}

      {overview && !item ? (
        <Empty className="rounded-lg border border-border py-16">
          <EmptyHeader>
            <EmptyTitle>No providers registered</EmptyTitle>
            <EmptyDescription>This engine build registers no coding agent to drive.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {item ? (
        <div className={FRAME}>
          <div className="border-b border-border lg:flex lg:min-h-0 lg:flex-col lg:border-e lg:border-b-0">
            <ScrollArea className="lg:min-h-0 lg:flex-1">
              <div className="divide-y divide-border">
                {harnesses.map((candidate) => (
                  <div key={candidate.harness} className="p-1">
                    <HarnessListRow
                      item={candidate}
                      selected={candidate.harness === item.harness}
                      onSelect={() => setSelected(candidate.harness)}
                    />
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
          <div className="min-w-0 lg:min-h-0">
            <HarnessDetail item={item} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
