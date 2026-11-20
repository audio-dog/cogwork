import type { ReactNode } from "react";
import { createContext, use, useState } from "react";

import {
  type ActivityCategory,
  type ActivityRow,
  activityCategory,
  activityNow,
  type NowState,
  useActivitySession,
} from "../features/activity-session";
import { useRightPanelStore } from "../store/right-panel";
import { type FunnelFilterContextValue, funnelSelectionMatches, useFunnelSelection } from "./funnel-filter";

const categoryOptions: ReadonlyArray<{ key: ActivityCategory; label: string }> = [
  { key: "run", label: "Runs" },
  { key: "item", label: "Items" },
  { key: "scheduler", label: "Scheduler" },
  { key: "workspace", label: "Workspaces" },
  { key: "system", label: "System" },
];

interface ActivityViewState {
  readonly now: NowState;
  readonly rows: readonly ActivityRow[];
  readonly query: string;
  readonly verbose: boolean;
  readonly frozen: boolean;
}

interface ActivityViewActions {
  readonly setQuery: (query: string) => void;
  readonly toggleVerbose: () => void;
  readonly toggleFrozen: () => void;
  readonly openRow: (row: ActivityRow) => void;
  readonly openRun: (run: NowState["runs"][number]) => void;
}

interface ActivityViewMeta {
  readonly filter: FunnelFilterContextValue;
}

interface ActivityViewContextValue {
  readonly state: ActivityViewState;
  readonly actions: ActivityViewActions;
  readonly meta: ActivityViewMeta;
}

const ActivityViewContext = createContext<ActivityViewContextValue | null>(null);

export function useActivityView() {
  const value = use(ActivityViewContext);
  if (value === null) throw new Error("useActivityView must render inside ActivityViewProvider.");
  return value;
}

export function ActivityViewProvider({ children }: { children: ReactNode }) {
  const session = useActivitySession();
  const feed = { now: activityNow(session), log: session.log };
  const openItem = useRightPanelStore((state) => state.openItem);
  const [query, setQuery] = useState("");
  const [verbose, setVerbose] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [snapshot, setSnapshot] = useState<readonly ActivityRow[]>([]);
  const selection = useFunnelSelection();
  const source = frozen ? snapshot : feed.log;
  const visible = source.filter((row) => verbose || !row.lowSignal);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const searched = visible.filter((row) => {
    const content = `${row.summary} ${row.label} ${row.entity?.id ?? ""}`.toLocaleLowerCase();
    return content.includes(normalizedQuery);
  });
  const rows = searched
    .filter((row) => funnelSelectionMatches(selection.selected, activityCategory(row.kind)))
    .toReversed();
  const options = categoryOptions.map((option) => ({
    ...option,
    count: visible.filter((row) => activityCategory(row.kind) === option.key).length,
  }));
  const toggleFrozen = () => {
    if (frozen) {
      setFrozen(false);
      return;
    }
    setSnapshot(feed.log);
    setFrozen(true);
  };
  const openRow = (row: ActivityRow) => {
    const entity = row.entity;
    if (!entity) return;
    openItem(
      entity.workspace,
      entity.type === "run" ? entity.workItem : entity.id,
      entity.type === "run" ? entity.id : undefined,
    );
  };
  const openRun = (run: NowState["runs"][number]) => {
    openItem(run.workspace, run.workItem, run.runId);
  };
  const filter: FunnelFilterContextValue = {
    state: { options, selected: selection.selected },
    actions: selection,
    meta: { ariaLabel: "Filter event types", resetLabel: "All event types" },
  };

  return (
    <ActivityViewContext
      value={{
        state: { now: feed.now, rows, query, verbose, frozen },
        actions: {
          setQuery,
          toggleVerbose: () => setVerbose((current) => !current),
          toggleFrozen,
          openRow,
          openRun,
        },
        meta: { filter },
      }}
    >
      {children}
    </ActivityViewContext>
  );
}
