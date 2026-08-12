import type { InterruptRecord, InterruptStore } from "@tanstack/ai-persistence";

// The provider runner's durable pause/resume seam, wired ahead of the
// interactive phase. It is process-scoped: pending interrupts outlive the run
// that raised them and are still there for the next run of the same session,
// which mirrors the run ledger's own in-memory durability. Swap this for a
// ledger-backed store when the ledger itself gains a persistent backend.
export const makeInterruptStore = (): InterruptStore => {
  const byId = new Map<string, InterruptRecord>();

  const sortedWhere = (predicate: (record: InterruptRecord) => boolean) =>
    [...byId.values()].filter(predicate).sort((a, b) => a.requestedAt - b.requestedAt);

  const terminate = (interruptId: string, status: "resolved" | "cancelled", response?: unknown) => {
    const existing = byId.get(interruptId);
    if (existing !== undefined) {
      // Promise-based store contract: no Effect Clock at this boundary.
      // @effect-diagnostics-next-line globalDate:off
      byId.set(interruptId, { ...existing, status, resolvedAt: Date.now(), response });
    }
    return Promise.resolve();
  };

  return {
    // Insert-if-absent: a duplicate create never clobbers a resolved interrupt
    // back to pending.
    create: (record) => {
      if (!byId.has(record.interruptId)) {
        byId.set(record.interruptId, { ...record, status: "pending" });
      }
      return Promise.resolve();
    },
    resolve: (interruptId, response) => terminate(interruptId, "resolved", response),
    cancel: (interruptId) => terminate(interruptId, "cancelled"),
    get: (interruptId) => Promise.resolve(byId.get(interruptId) ?? null),
    list: (threadId) => Promise.resolve(sortedWhere((record) => record.threadId === threadId)),
    listPending: (threadId) =>
      Promise.resolve(sortedWhere((record) => record.threadId === threadId && record.status === "pending")),
    listByRun: (runId) => Promise.resolve(sortedWhere((record) => record.runId === runId)),
    listPendingByRun: (runId) =>
      Promise.resolve(sortedWhere((record) => record.runId === runId && record.status === "pending")),
  };
};
