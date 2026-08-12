import type { Board } from "@clanker-forge/contracts";
import { Alert, AlertDescription, AlertTitle } from "@clanker-forge/ui/components/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@clanker-forge/ui/components/empty";
import * as Cause from "effect/Cause";
import type { ReactNode } from "react";
import { useBoard } from "../features/use-board";

export function BoardGate({ children }: { children: (board: Board) => ReactNode }) {
  const result = useBoard();

  if (result._tag === "Failure") {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertTitle>Could not reach the daemon</AlertTitle>
          <AlertDescription>{Cause.pretty(result.cause)}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (result._tag !== "Success") {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Connecting to the daemon…</EmptyTitle>
          <EmptyDescription>The view fills in as the event stream self-seeds.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return <>{children(result.board)}</>;
}
