import type { InterruptRecord } from "@tanstack/ai-persistence";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

type NewInterrupt = Omit<InterruptRecord, "status" | "resolvedAt">;
type InterruptStatus = Extract<InterruptRecord["status"], "resolved" | "cancelled">;
type InterruptRecords = ReadonlyMap<string, InterruptRecord>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isLegacyPending = (record: InterruptRecord) => {
  const metadata = isObject(record.payload.metadata) ? record.payload.metadata : null;
  if (!metadata) return false;
  const hasLegacyKind = metadata.kind === "approval" || metadata.kind === "client_tool";
  return (
    record.status === "pending" &&
    hasLegacyKind &&
    typeof record.payload.toolCallId === "string" &&
    !("tanstack:interruptBinding" in metadata)
  );
};

const sortedWhere = (records: InterruptRecords, predicate: (record: InterruptRecord) => boolean) =>
  [...records.values()].filter(predicate).sort((a, b) => a.requestedAt - b.requestedAt);

const insert = (records: InterruptRecords, record: NewInterrupt) => {
  if (records.has(record.interruptId)) return records;
  return new Map(records).set(record.interruptId, { ...record, status: "pending" });
};

const terminate = (
  records: InterruptRecords,
  interruptId: string,
  status: InterruptStatus,
  resolvedAt: number,
  response?: unknown,
) => {
  const existing = records.get(interruptId);
  if (existing === undefined) return records;
  return new Map(records).set(interruptId, { ...existing, status, resolvedAt, response });
};

const retireLegacyPending = (
  records: InterruptRecords,
  predicate: (record: InterruptRecord) => boolean,
  resolvedAt: number,
): readonly [Array<InterruptRecord>, InterruptRecords] => {
  const legacy = sortedWhere(records, (record) => predicate(record) && isLegacyPending(record));
  const migrated = legacy.reduce<InterruptRecords>(
    (current, record) => terminate(current, record.interruptId, "cancelled", resolvedAt),
    records,
  );
  return [sortedWhere(migrated, (record) => predicate(record) && record.status === "pending"), migrated];
};

export const make = Effect.gen(function* () {
  const records = yield* Ref.make<InterruptRecords>(new Map());

  const finish = (interruptId: string, status: InterruptStatus, response?: unknown) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((resolvedAt) =>
        Ref.update(records, (current) => terminate(current, interruptId, status, resolvedAt, response)),
      ),
    );

  const listWhere = (predicate: (record: InterruptRecord) => boolean) =>
    Effect.map(Ref.get(records), (current) => sortedWhere(current, predicate));

  const listPendingWhere = (predicate: (record: InterruptRecord) => boolean) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((resolvedAt) =>
        Ref.modify(records, (current) => retireLegacyPending(current, predicate, resolvedAt)),
      ),
    );

  return {
    create: Effect.fn("InterruptStore.create")((record: NewInterrupt) =>
      Ref.update(records, (current) => insert(current, record)),
    ),
    resolve: Effect.fn("InterruptStore.resolve")((interruptId: string, response?: unknown) =>
      finish(interruptId, "resolved", response),
    ),
    cancel: Effect.fn("InterruptStore.cancel")((interruptId: string) => finish(interruptId, "cancelled")),
    get: Effect.fn("InterruptStore.get")((interruptId: string) =>
      Effect.map(Ref.get(records), (current) => current.get(interruptId) ?? null),
    ),
    list: Effect.fn("InterruptStore.list")((threadId: string) =>
      listWhere((record) => record.threadId === threadId),
    ),
    listPending: Effect.fn("InterruptStore.listPending")((threadId: string) =>
      listPendingWhere((record) => record.threadId === threadId),
    ),
    listByRun: Effect.fn("InterruptStore.listByRun")((runId: string) =>
      listWhere((record) => record.runId === runId),
    ),
    listPendingByRun: Effect.fn("InterruptStore.listPendingByRun")((runId: string) =>
      listPendingWhere((record) => record.runId === runId),
    ),
  };
});

export type InterruptStoreService = Effect.Success<typeof make>;

export class InterruptStore extends Context.Service<InterruptStore, InterruptStoreService>()(
  "@cogwork/engine/interrupt-store/InterruptStore",
) {}

export const layer = Layer.effect(InterruptStore, make);
