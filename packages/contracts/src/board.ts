import * as Stream from "effect/Stream";
import type { WorkspaceId } from "./base-schemas";
import type { SchedulerStats, WorkspaceFailureInfo, WorkspaceInfo } from "./daemon";
import { type ClassifiedItem, DaemonEvent, WorkspaceState } from "./daemon-event";
import type { RunSummary } from "./run";

export interface BoardItem {
  readonly workspace: WorkspaceId;
  readonly item: ClassifiedItem;
}

export interface Board {
  readonly items: ReadonlyMap<string, BoardItem>;
  readonly runs: ReadonlyMap<string, RunSummary>;
  readonly workspaces: ReadonlyMap<string, WorkspaceState>;
  readonly scheduler: SchedulerStats | null;
}

export const initialBoard: Board = {
  items: new Map(),
  runs: new Map(),
  workspaces: new Map(),
  scheduler: null,
};

export const settledRunLimit = 20;

const settled = (run: RunSummary) => run.status !== "running";

const retainRuns = (runs: ReadonlyMap<string, RunSummary>) => {
  const active = [...runs.entries()].filter(([, run]) => !settled(run));
  const recent = [...runs.entries()]
    .filter(([, run]) => settled(run))
    .sort(
      ([, left], [, right]) =>
        (right.endedAtMillis ?? right.startedAtMillis) - (left.endedAtMillis ?? left.startedAtMillis),
    )
    .slice(0, settledRunLimit);
  return new Map([...active, ...recent]);
};

export const itemKey = (workspace: WorkspaceId, id: string) => `${workspace}::${id}`;

export const workspaceKey = (state: WorkspaceState) =>
  WorkspaceState.match(state, {
    Registered: ({ name }) => name,
    Failed: ({ name, source }) => name ?? source,
  });

export const workspaceStateFromInfo = (info: WorkspaceInfo) => ({
  _tag: "Registered" as const,
  name: info.name,
  ...(info.displayName ? { displayName: info.displayName } : {}),
  checkoutPath: info.checkoutPath,
  issueTracker: info.issueTracker,
  harness: info.harness,
  poll: info.poll,
});

export const workspaceFailureState = (failure: WorkspaceFailureInfo) => ({
  _tag: "Failed" as const,
  ...(failure.name ? { name: failure.name } : {}),
  source: failure.source,
  message: failure.message,
});

const withoutItem = (items: ReadonlyMap<string, BoardItem>, key: string) =>
  new Map([...items].filter(([entryKey]) => entryKey !== key));

export const applyDaemonEvent = (board: Board, event: DaemonEvent): Board =>
  DaemonEvent.match(event, {
    SeedEnd: () => board,
    RunActivity: () => board,
    ItemChanged: ({ workspace, item }) => ({
      ...board,
      items: new Map(board.items).set(itemKey(workspace, item.id), { workspace, item }),
    }),
    ItemRemoved: ({ workspace, id }) => ({
      ...board,
      items: withoutItem(board.items, itemKey(workspace, id)),
    }),
    RunChanged: ({ run }) => ({
      ...board,
      runs: retainRuns(new Map(board.runs).set(run.id, run)),
    }),
    WorkspaceChanged: ({ workspace }) => ({
      ...board,
      workspaces: new Map(board.workspaces).set(workspaceKey(workspace), workspace),
    }),
    SchedulerChanged: ({ scheduler }) => ({ ...board, scheduler }),
  });

export const liveOnly = <E, R>(events: Stream.Stream<DaemonEvent, E, R>) =>
  events.pipe(Stream.dropUntil((event) => event._tag === "SeedEnd"));
