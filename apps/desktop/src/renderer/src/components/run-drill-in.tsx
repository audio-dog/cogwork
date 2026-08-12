import type { RunSummary } from "@clanker-forge/contracts";
import { Alert, AlertDescription, AlertTitle } from "@clanker-forge/ui/components/alert";
import { Badge } from "@clanker-forge/ui/components/badge";
import { Button } from "@clanker-forge/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@clanker-forge/ui/components/empty";
import { Separator } from "@clanker-forge/ui/components/separator";
import { Spinner } from "@clanker-forge/ui/components/spinner";
import { useAtom } from "@effect/atom-react";
import { RiStopCircleLine } from "@remixicon/react";
import * as Cause from "effect/Cause";
import { cancelRunAtom } from "../daemon/atoms";
import { elapsed } from "../features/format";
import { foldTranscript, type TranscriptEntry, useRunActivity } from "../features/run-activity";
import { RunStatusBadge } from "./badges";

function TextBlock({ entry }: { entry: Extract<TranscriptEntry, { kind: "text" }> }) {
  return <p className="text-sm whitespace-pre-wrap">{entry.text}</p>;
}

function ReasoningBlock({ entry }: { entry: Extract<TranscriptEntry, { kind: "reasoning" }> }) {
  return (
    <div className="flex flex-col gap-1 border-s-2 ps-3">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Reasoning</span>
      <p className="text-xs whitespace-pre-wrap text-muted-foreground">{entry.text}</p>
    </div>
  );
}

function ToolBlock({ entry }: { entry: Extract<TranscriptEntry, { kind: "tool" }> }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md bg-muted/50 p-2">
      <Badge variant="secondary">{entry.name}</Badge>
      {entry.args && <pre className="overflow-x-auto text-xs whitespace-pre-wrap">{entry.args}</pre>}
      {entry.result !== null && (
        <pre className="overflow-x-auto border-t pt-1.5 text-xs whitespace-pre-wrap text-muted-foreground">
          {entry.result}
        </pre>
      )}
    </div>
  );
}

function DiffBlock({ entry }: { entry: Extract<TranscriptEntry, { kind: "diff" }> }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-xs text-muted-foreground">{entry.path}</span>
      <pre className="overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-xs">{entry.diff}</pre>
    </div>
  );
}

function TranscriptRow({ entry }: { entry: TranscriptEntry }) {
  switch (entry.kind) {
    case "text":
      return <TextBlock entry={entry} />;
    case "reasoning":
      return <ReasoningBlock entry={entry} />;
    case "tool":
      return <ToolBlock entry={entry} />;
    case "diff":
      return <DiffBlock entry={entry} />;
    case "error":
      return (
        <Alert variant="destructive">
          <AlertTitle>Run error</AlertTitle>
          <AlertDescription>{entry.message}</AlertDescription>
        </Alert>
      );
  }
}

function CancelButton({ runId }: { runId: RunSummary["id"] }) {
  const [result, cancel] = useAtom(cancelRunAtom);
  const pending = result.waiting;

  return (
    <div className="flex flex-col gap-1">
      <Button disabled={pending} size="sm" variant="outline" onClick={() => cancel({ payload: { runId } })}>
        {pending ? <Spinner data-icon="inline-start" /> : <RiStopCircleLine data-icon="inline-start" />}
        Cancel &amp; park
      </Button>
      {result._tag === "Failure" && (
        <span className="text-xs text-destructive">{Cause.pretty(result.cause)}</span>
      )}
    </div>
  );
}

export function RunDrillIn({ run }: { run: RunSummary }) {
  const result = useRunActivity(run.id);
  const running = run.status === "running";
  const total = run.usage?.totalTokens;

  const transcript = () => {
    if (result._tag === "Failure") {
      return (
        <Alert variant="destructive">
          <AlertTitle>Activity stream disconnected</AlertTitle>
          <AlertDescription>{Cause.pretty(result.cause)}</AlertDescription>
        </Alert>
      );
    }

    const entries = result._tag === "Success" ? foldTranscript(result.value.items) : [];

    if (entries.length === 0) {
      return (
        <Empty>
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
      <div className="flex flex-col gap-3">
        {entries.map((entry) => (
          <TranscriptRow key={entry.key} entry={entry} />
        ))}
      </div>
    );
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <RunStatusBadge status={run.status} />
        <Badge variant="secondary">{run.stage}</Badge>
        <span>{run.harness}</span>
        {running && <span>running {elapsed(run.startedAtMillis)}</span>}
        {total !== undefined && <span>{total} tokens</span>}
      </div>
      {running && <CancelButton runId={run.id} />}
      <Separator />
      {transcript()}
    </section>
  );
}
