import type { RunSummary } from "@cogwork/contracts";
import { Alert, AlertDescription, AlertTitle } from "@cogwork/ui/components/alert";
import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@cogwork/ui/components/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cogwork/ui/components/empty";
import { Marker, MarkerContent, MarkerIcon } from "@cogwork/ui/components/marker";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@cogwork/ui/components/message-scroller";
import { Spinner } from "@cogwork/ui/components/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { useAtom } from "@effect/atom-react";
import {
  RiBrainLine,
  RiCheckLine,
  RiFileEditLine,
  RiSearchLine,
  RiStopCircleLine,
  RiTerminalBoxLine,
} from "@remixicon/react";
import * as Cause from "effect/Cause";
import { cancelRunAtom } from "../daemon/atoms";
import { elapsed } from "../features/format";
import { foldTranscript, statusLine, type TranscriptEntry, useRunActivity } from "../features/run-activity";
import { RunStatusBadge } from "./badges";
import { CodeBlock, Markdown } from "./markdown";

type FoldedEntry = Exclude<TranscriptEntry, { kind: "text" | "error" }>;

const isFoldedEntry = (entry: TranscriptEntry): entry is FoldedEntry =>
  entry.kind !== "text" && entry.kind !== "error";

function TranscriptStatus({ complete }: { complete: boolean }) {
  if (complete) return <RiCheckLine className="text-muted-foreground" />;
  return (
    <>
      <span aria-hidden className="size-2 rounded-full bg-primary animate-pulse" />
      <span className="sr-only">Running</span>
    </>
  );
}

function CodeDetail({ code, language }: { code: string; language: string }) {
  if (!code) return null;
  return <CodeBlock code={code} language={language} />;
}

const foldedDetail = (entry: FoldedEntry) => {
  if (entry.kind === "reasoning") return entry.text;
  if (entry.kind === "tool") return `${entry.args}\n${entry.result ?? ""}`;
  return entry.diff;
};

const foldedPreview = (entry: FoldedEntry) => {
  if (entry.kind === "reasoning") return entry.text;
  if (entry.kind === "tool") return entry.result ?? entry.args;
  return entry.path;
};

const foldedLabel = (entry: FoldedEntry) => {
  if (entry.kind === "reasoning") return "Thought";
  if (entry.kind === "tool" && entry.name === "read") return "Read file";
  if (entry.kind === "tool" && /rg|grep|search/i.test(entry.name)) return "Searched";
  if (entry.kind === "tool") return "Ran command";
  return "Edited";
};

const foldedIcon = (entry: FoldedEntry) => {
  if (entry.kind === "reasoning") return RiBrainLine;
  if (entry.kind === "tool") return RiTerminalBoxLine;
  return RiFileEditLine;
};

const foldedLanguage = (entry: FoldedEntry) => {
  if (entry.kind === "diff") return "diff";
  return "plaintext";
};

function FoldedRow({ entry, status }: { entry: FoldedEntry; status: RunSummary["status"] }) {
  const detail = foldedDetail(entry);
  const preview = foldedPreview(entry);
  const label = foldedLabel(entry);
  const complete = entry.kind !== "tool" || entry.complete || status !== "running";
  const Icon = foldedIcon(entry);
  const language = foldedLanguage(entry);

  return (
    <Collapsible>
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">{label}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{preview || "Working…"}</span>
        <TranscriptStatus complete={complete} />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-2 pb-2">
        <CodeDetail code={detail} language={language} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function TextRow({ entry }: { entry: Extract<TranscriptEntry, { kind: "text" }> }) {
  return <Markdown className="text-sm">{entry.text}</Markdown>;
}

function ErrorRow({ entry }: { entry: Extract<TranscriptEntry, { kind: "error" }> }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Run error</AlertTitle>
      <AlertDescription>{entry.message}</AlertDescription>
    </Alert>
  );
}

const transcriptGroups = (entries: readonly TranscriptEntry[]) =>
  entries.reduce<TranscriptEntry[][]>((groups, entry) => {
    const group = groups.at(-1);
    if (isFoldedEntry(entry) && group?.every(isFoldedEntry)) group.push(entry);
    else groups.push([entry]);
    return groups;
  }, []);

const previousActivityLabel = (entries: readonly FoldedEntry[]) =>
  entries.every((entry) => entry.kind === "tool") ? "previous tool calls" : "previous activities";

function TranscriptRows({
  entries,
  status,
}: {
  entries: readonly TranscriptEntry[];
  status: RunSummary["status"];
}) {
  const groups = transcriptGroups(entries);

  return groups.map((group, index) => {
    const [first] = group;
    if (!first) return null;
    if (!isFoldedEntry(first))
      return (
        <MessageScrollerItem key={first.key} scrollAnchor={index === groups.length - 1}>
          {first.kind === "text" ? <TextRow entry={first} /> : <ErrorRow entry={first} />}
        </MessageScrollerItem>
      );
    const folded = group.filter(isFoldedEntry);
    const latest = folded.at(-1);
    const previous = folded.slice(0, -1);
    return (
      <MessageScrollerItem key={first.key} scrollAnchor={index === groups.length - 1}>
        <div className="flex flex-col gap-1">
          {previous.length > 0 && (
            <Collapsible>
              <CollapsibleTrigger className="cursor-pointer px-2 text-xs text-muted-foreground hover:text-foreground">
                +{previous.length} {previousActivityLabel(previous)}
              </CollapsibleTrigger>
              <CollapsibleContent className="flex flex-col gap-1">
                {previous.map((entry) => (
                  <FoldedRow key={entry.key} entry={entry} status={status} />
                ))}
              </CollapsibleContent>
            </Collapsible>
          )}
          {latest && <FoldedRow entry={latest} status={status} />}
        </div>
      </MessageScrollerItem>
    );
  });
}

function CancelButton({ runId }: { runId: RunSummary["id"] }) {
  const [result, cancel] = useAtom(cancelRunAtom);
  const pending = result.waiting;
  return (
    <div className="flex flex-col gap-1">
      <Button disabled={pending} size="sm" variant="outline" onClick={() => cancel({ payload: { runId } })}>
        {pending ? <Spinner data-icon="inline-start" /> : <RiStopCircleLine data-icon="inline-start" />}Cancel
        &amp; park
      </Button>
      {result._tag === "Failure" && (
        <span className="text-xs text-destructive">{Cause.pretty(result.cause)}</span>
      )}
    </div>
  );
}

function TokenCount({ usage }: { usage: NonNullable<RunSummary["usage"]> }) {
  if (usage.totalTokens === undefined) return null;
  if (usage.estimated !== true) return <span>{usage.totalTokens} tokens</span>;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="cursor-help underline decoration-dotted underline-offset-2" />}
      >
        ~{usage.totalTokens} tokens
      </TooltipTrigger>
      <TooltipContent>
        Best-guess estimate. Cursor's ACP mode doesn't report token usage, so this is derived from the prompt
        and streamed text length.
      </TooltipContent>
    </Tooltip>
  );
}

function NowBanner({ run, line }: { run: RunSummary; line: string }) {
  const running = run.status === "running";
  return (
    <section className="flex flex-col gap-2 border-b bg-background p-4">
      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <RunStatusBadge status={run.status} />
        <Badge variant="secondary">{run.stage}</Badge>
        <span>{run.harness}</span>
        <span>{running ? elapsed(run.startedAtMillis) : "Finished"}</span>
        {run.usage && <TokenCount usage={run.usage} />}
        {running && <CancelButton runId={run.id} />}
      </div>
      <Marker className="mx-auto w-full max-w-3xl">
        <MarkerIcon>{running ? <RiSearchLine /> : <RiCheckLine />}</MarkerIcon>
        <MarkerContent>{line}</MarkerContent>
      </Marker>
    </section>
  );
}

function TranscriptBody({
  entries,
  result,
  status,
}: {
  entries: readonly TranscriptEntry[];
  result: ReturnType<typeof useRunActivity>;
  status: RunSummary["status"];
}) {
  const running = status === "running";
  if (result._tag === "Failure") {
    return (
      <Alert className="m-4" variant="destructive">
        <AlertTitle>Activity stream disconnected</AlertTitle>
        <AlertDescription>{Cause.pretty(result.cause)}</AlertDescription>
      </Alert>
    );
  }
  if (entries.length === 0) {
    return (
      <Empty className="m-4">
        <EmptyHeader>
          <EmptyTitle>{running ? "Waiting for the agent…" : "No activity recorded"}</EmptyTitle>
          <EmptyDescription>
            {running
              ? "Text, reasoning, tool calls, and diffs appear here as they stream."
              : "This run produced no streamed activity."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <MessageScrollerProvider>
      <div className="min-h-0 flex-1">
        <MessageScroller>
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-4 p-4">
              <TranscriptRows entries={entries} status={status} />
              {running && (
                <MessageScrollerItem>
                  <Marker>
                    <MarkerIcon>
                      <Spinner />
                    </MarkerIcon>
                    <MarkerContent>Working…</MarkerContent>
                  </Marker>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </div>
    </MessageScrollerProvider>
  );
}

export function RunDrillIn({ run }: { run: RunSummary }) {
  const result = useRunActivity(run.id);
  const activities = result._tag === "Success" ? result.value.items : [];
  const entries = foldTranscript(activities);
  const line = statusLine(activities, run.status);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <NowBanner run={run} line={line} />
      <TranscriptBody entries={entries} result={result} status={run.status} />
    </div>
  );
}
