import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@clanker-forge/ui/components/empty";
import { ScrollArea } from "@clanker-forge/ui/components/scroll-area";
import { inboxSections, recentlyDone } from "../features/feed";
import { relativeTime } from "../features/format";
import { useChromeStore } from "../store/chrome";
import { RunStatusBadge } from "./badges";
import { BoardGate } from "./board-gate";
import { InboxRow, SectionTitle, WorkspaceChip } from "./mission-control-ui";

export function Inbox() {
  const filter = useChromeStore((state) => state.workspaceFilter);
  return (
    <BoardGate>
      {(board) => {
        const sections = inboxSections(board, filter);
        const done = recentlyDone(board, filter);

        if (sections.length === 0 && done.length === 0) {
          return (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Inbox zero</EmptyTitle>
                <EmptyDescription>Nothing needs your attention right now.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          );
        }

        return (
          <ScrollArea className="h-full">
            <div className="mx-auto flex max-w-[820px] flex-col gap-6 px-5 py-5 pb-10">
              {sections.map((section) => (
                <section key={section.title} className="flex flex-col gap-3">
                  <SectionTitle title={section.title} count={section.rows.length} />
                  <div className="flex flex-col gap-2">
                    {section.rows.map((entry) => (
                      <InboxRow
                        key={`${entry.workspace}:${entry.item.id}`}
                        entry={entry}
                        accent={section.accent}
                      />
                    ))}
                  </div>
                </section>
              ))}
              {done.length > 0 && (
                <section className="flex flex-col gap-3">
                  <SectionTitle title="Recently done" count={done.length} />
                  <div className="flex flex-col gap-2">
                    {done.map(({ run, title }) => (
                      <div
                        key={run.id}
                        className="flex items-start gap-3 rounded-[11px] border bg-card p-3.5"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs text-muted-foreground">{run.workItem}</span>
                            <RunStatusBadge status={run.status} />
                            <span className="text-sm">{title ?? run.workItem}</span>
                          </div>
                        </div>
                        <div className="shrink-0 text-right text-xs text-muted-foreground">
                          <WorkspaceChip workspace={run.workspace} />
                          {run.endedAtMillis !== null && (
                            <div className="mt-1.5">{relativeTime(run.endedAtMillis)}</div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          </ScrollArea>
        );
      }}
    </BoardGate>
  );
}
