import type { RunSummary } from "@cogwork/contracts";
import { Alert, AlertDescription, AlertTitle } from "@cogwork/ui/components/alert";
import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@cogwork/ui/components/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@cogwork/ui/components/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cogwork/ui/components/empty";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@cogwork/ui/components/message-scroller";
import {
  ScrollAreaCorner,
  ScrollAreaRoot,
  ScrollAreaViewport,
  ScrollBar,
} from "@cogwork/ui/components/scroll-area";
import { Spinner } from "@cogwork/ui/components/spinner";
import { cn } from "@cogwork/ui/lib/utils";
import { useAtom } from "@effect/atom-react";
import {
  RiArrowDownSLine,
  RiCheckLine,
  RiErrorWarningLine,
  RiRobot2Line,
  RiStopCircleLine,
} from "@remixicon/react";
import { type ComponentProps, type ComponentType, createContext, type ReactNode, use } from "react";
import { cancelRunAtom } from "../daemon/atoms";
import { useOperationName } from "../features/activity-session";
import { daemonFailureMessage } from "../features/daemon-failure";
import { duration } from "../features/format";
import { type SubagentStatus, transcriptReplaying, useRunTranscript } from "../features/run-activity";
import {
  headingLine,
  type StepView,
  stepBody,
  type TranscriptRow,
  type TranscriptRowKind,
  type TranscriptRowOf,
  transcriptRows,
} from "../features/run-transcript";
import { useNow } from "../features/use-now";
import { Markdown } from "./markdown";

interface RunTranscriptState {
  readonly run: RunSummary;
  readonly rows: readonly TranscriptRow[];
  readonly line: string;
  readonly running: boolean;
  readonly streamError: string | null;
}

interface RunTranscriptActions {
  readonly cancel: () => void;
}

interface RunTranscriptMeta {
  readonly cancelPending: boolean;
  readonly cancelError: string | null;
}

interface RunTranscriptContextValue {
  readonly state: RunTranscriptState;
  readonly actions: RunTranscriptActions;
  readonly meta: RunTranscriptMeta;
}

const RunTranscriptContext = createContext<RunTranscriptContextValue | null>(null);

function useRunTranscriptContext() {
  const value = use(RunTranscriptContext);
  if (!value) throw new Error("Run transcript parts must render inside RunTranscript.Provider");
  return value;
}

function RunTranscriptProvider({ run, children }: { run: RunSummary; children: ReactNode }) {
  const result = useRunTranscript(run.id);
  const [cancelResult, cancelRun] = useAtom(cancelRunAtom);

  const running = run.status === "running";
  const entries = result._tag === "Success" ? result.value.entries : [];
  const rows = transcriptRows(entries, !running);

  return (
    <RunTranscriptContext
      value={{
        state: {
          run,
          rows,
          line: headingLine(rows, run.status, transcriptReplaying(result)),
          running,
          streamError: result._tag === "Failure" ? daemonFailureMessage(result.cause) : null,
        },
        actions: { cancel: () => cancelRun({ payload: { runId: run.id } }) },
        meta: {
          cancelPending: cancelResult.waiting,
          cancelError: cancelResult._tag === "Failure" ? daemonFailureMessage(cancelResult.cause) : null,
        },
      }}
    >
      {children}
    </RunTranscriptContext>
  );
}

function ElapsedTime() {
  const {
    state: { run },
  } = useRunTranscriptContext();
  const now = useNow();
  return <span className="tabular-nums">{duration(run.startedAtMillis, run.endedAtMillis ?? now)}</span>;
}

function Gutter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("flex size-6 shrink-0 items-center justify-center", className)}>{children}</span>
  );
}

function StepDetail({ view }: { view: StepView }) {
  const body = stepBody(view);
  return (
    <div className="mt-1 ms-8 border-s border-border/50 ps-3 pt-0.5">
      <pre className="max-h-64 cursor-text overflow-auto font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground select-text">
        {body}
      </pre>
      {view.note && <p className="pt-1 text-xs text-muted-foreground/70">{view.note}</p>}
    </div>
  );
}

function StepRow({ view }: { view: StepView }) {
  const expandable = stepBody(view).length > 0;
  return (
    <Collapsible>
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-0.5 py-1 text-left transition-colors",
          expandable ? "cursor-pointer hover:bg-accent/20" : "cursor-default",
        )}
        disabled={!expandable}
      >
        <Gutter className={view.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
          <view.icon className="block size-4 shrink-0 opacity-80" />
        </Gutter>
        <span className="flex w-full min-w-0 items-baseline gap-1.5">
          <span
            className={cn(
              "min-w-0 shrink truncate text-sm leading-6 font-medium",
              view.status === "failed" ? "text-destructive" : "text-foreground",
            )}
          >
            {view.label}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs leading-6 text-muted-foreground">
            {view.target}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-px text-muted-foreground">
          {view.status === "running" && (
            <Gutter>
              <Spinner className="size-3.5 opacity-70" />
            </Gutter>
          )}
          <Gutter>
            {expandable && (
              <RiArrowDownSLine className="size-4 opacity-70 transition-transform [[data-panel-open]_&]:rotate-180" />
            )}
          </Gutter>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <StepDetail view={view} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function EarlierSteps({ steps, noun }: { steps: readonly StepView[]; noun: string }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-1 text-left text-sm leading-6 transition-colors hover:bg-accent/20">
        <Gutter>
          <RiArrowDownSLine className="size-4 opacity-70 transition-transform [[data-panel-open]_&]:rotate-180" />
        </Gutter>
        <span className="font-medium">
          +{steps.length} previous {noun}
          {steps.length === 1 ? "" : "s"}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {steps.map((view) => (
          <StepRow key={view.key} view={view} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function WorkRow({ row }: { row: Extract<TranscriptRow, { kind: "work" }> }) {
  const latest = row.steps.at(-1);
  const earlier = row.steps.slice(0, -1);
  return (
    <section className="py-0.5">
      {earlier.length > 0 && <EarlierSteps steps={earlier} noun={row.foldNoun} />}
      {latest && <StepRow view={latest} />}
    </section>
  );
}

function NoteRow({ row }: { row: Extract<TranscriptRow, { kind: "note" }> }) {
  return (
    <div className="min-w-0 px-0.5 py-1.5">
      <Markdown className="text-sm">{row.text}</Markdown>
    </div>
  );
}

function ErrorRow({ row }: { row: Extract<TranscriptRow, { kind: "error" }> }) {
  return (
    <div className="py-1">
      <Alert variant="destructive">
        <AlertTitle>Run error</AlertTitle>
        <AlertDescription>{row.message}</AlertDescription>
      </Alert>
    </div>
  );
}

function WarningRow({ row }: { row: Extract<TranscriptRow, { kind: "warning" }> }) {
  return (
    <div className="py-1">
      <Alert>
        <RiErrorWarningLine />
        <AlertTitle>File changes may be incomplete</AlertTitle>
        <AlertDescription>{row.message}</AlertDescription>
      </Alert>
    </div>
  );
}

const subagentStatusBadges = {
  running: { Icon: Spinner, variant: "secondary" },
  finished: { Icon: RiCheckLine, variant: "secondary" },
  error: { Icon: RiErrorWarningLine, variant: "destructive" },
} satisfies Record<
  SubagentStatus,
  { Icon: ComponentType<{ className?: string }>; variant: ComponentProps<typeof Badge>["variant"] }
>;

function SubagentStatusBadge({ status }: { status: SubagentStatus }) {
  const { Icon, variant } = subagentStatusBadges[status];
  return (
    <Badge variant={variant}>
      <Icon data-icon="inline-start" />
      {status}
    </Badge>
  );
}

function SubagentRow({ row }: { row: TranscriptRowOf<"subagent"> }) {
  return (
    <div className="py-1">
      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <RiRobot2Line className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            {row.name}
          </CardTitle>
          <CardAction>
            <SubagentStatusBadge status={row.status} />
          </CardAction>
        </CardHeader>
        {(row.text || row.message) && (
          <CardContent>
            {row.text && <Markdown className="text-sm">{row.text}</Markdown>}
            {row.message && <p className="text-xs text-destructive">{row.message}</p>}
          </CardContent>
        )}
      </Card>
    </div>
  );
}

const rowViews: {
  readonly [Kind in TranscriptRowKind]: ComponentType<{ row: TranscriptRowOf<Kind> }>;
} = {
  work: WorkRow,
  note: NoteRow,
  warning: WarningRow,
  error: ErrorRow,
  subagent: SubagentRow,
};

function Row<Kind extends TranscriptRowKind>({ kind, row }: { kind: Kind; row: TranscriptRowOf<Kind> }) {
  const View: ComponentType<{ row: TranscriptRowOf<Kind> }> = rowViews[kind];
  return <View row={row} />;
}

function WorkingRow() {
  const {
    state: { line },
  } = useRunTranscriptContext();
  return (
    <div className="flex min-w-0 items-center gap-2 px-0.5 py-1.5 text-xs text-muted-foreground">
      <Gutter>
        <Spinner className="size-3.5 opacity-70" />
      </Gutter>
      <span className="shrink-0">
        Working for <ElapsedTime />
      </span>
      <span className="min-w-0 truncate text-muted-foreground/60">· {line}</span>
    </div>
  );
}

function EmptyStream() {
  const {
    state: { running },
  } = useRunTranscriptContext();
  return (
    <Empty className="m-4">
      <EmptyHeader>
        <EmptyTitle>{running ? "Waiting for the agent…" : "Nothing was streamed"}</EmptyTitle>
        <EmptyDescription>
          {running
            ? "Notes and commands appear here as they arrive."
            : "This run finished without streaming any activity."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function StreamError({ message }: { message: string }) {
  return (
    <Alert className="m-4" variant="destructive">
      <AlertTitle>Activity stream disconnected</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

/**
 * `MessageScroller` owns the scroll element, so `ScrollAreaViewport` takes it
 * through `render` — a second scroll container breaks both. `autoScroll`
 * defaults to false, and a `scrollAnchor` would pin new groups to the top.
 */
function TranscriptConversation() {
  const {
    state: { run, rows, running, streamError },
  } = useRunTranscriptContext();

  if (streamError) return <StreamError message={streamError} />;
  if (run.eventsPrunedAtMillis !== null)
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Empty className="m-4">
          <EmptyHeader>
            <EmptyTitle>Run history was pruned</EmptyTitle>
            <EmptyDescription>
              Cogwork removed this opaque session&apos;s events to keep local history bounded.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  if (rows.length === 0)
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <EmptyStream />
      </div>
    );

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        <ScrollAreaRoot className="min-h-0 flex-1">
          <ScrollAreaViewport render={<MessageScrollerViewport />}>
            <MessageScrollerContent className="gap-0 px-3 py-2">
              {rows.map((row) => (
                <MessageScrollerItem key={row.key} messageId={row.key}>
                  <Row kind={row.kind} row={row} />
                </MessageScrollerItem>
              ))}
              {running && (
                <MessageScrollerItem messageId="working">
                  <WorkingRow />
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </ScrollAreaViewport>
          <ScrollBar
            className="p-0.5 opacity-0 transition-opacity duration-200 data-hovering:opacity-100 data-scrolling:opacity-100 data-vertical:w-2.5"
            keepMounted
          />
          <ScrollAreaCorner />
        </ScrollAreaRoot>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

function RunStatusGlyph() {
  const {
    state: { run, running },
  } = useRunTranscriptContext();
  if (running)
    return (
      <>
        <span className="relative flex size-2 shrink-0 items-center justify-center" aria-hidden>
          <span className="absolute size-2 animate-ping rounded-full bg-primary opacity-60" />
          <span className="relative size-2 rounded-full bg-primary" />
        </span>
        <span className="sr-only">Running</span>
      </>
    );
  if (run.status === "succeeded")
    return (
      <>
        <RiCheckLine className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="sr-only">Succeeded</span>
      </>
    );
  return (
    <>
      <RiErrorWarningLine className="size-3.5 shrink-0 text-destructive" aria-hidden />
      <span className="sr-only">{run.status}</span>
    </>
  );
}

function CancelButton() {
  const {
    state: { running },
    actions: { cancel },
    meta: { cancelPending },
  } = useRunTranscriptContext();
  if (!running) return null;
  return (
    <Button className="ms-auto" disabled={cancelPending} size="sm" variant="outline" onClick={cancel}>
      {cancelPending ? <Spinner data-icon="inline-start" /> : <RiStopCircleLine data-icon="inline-start" />}
      Cancel &amp; park
    </Button>
  );
}

function RunNow() {
  const {
    state: { run, line },
    meta: { cancelError },
  } = useRunTranscriptContext();
  const operationName = useOperationName();
  return (
    <div className="shrink-0 border-b p-3">
      <div className="rounded-lg border bg-card px-3 py-2.5">
        <div className="flex items-start gap-2">
          <span className="mt-1">
            <RunStatusGlyph />
          </span>
          <p className="min-w-0 flex-1 text-sm leading-snug font-medium">{line}</p>
        </div>
        <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
          <ElapsedTime />
          <span aria-hidden>·</span>
          <span>{operationName(run)}</span>
          <CancelButton />
        </div>
        {cancelError && <p className="mt-1.5 text-xs text-destructive">{cancelError}</p>}
      </div>
    </div>
  );
}

export const RunTranscript = {
  Provider: RunTranscriptProvider,
  Now: RunNow,
  Conversation: TranscriptConversation,
};
