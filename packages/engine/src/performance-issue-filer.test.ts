import { WorkItemId, type WorkItemId as WorkItemIdType } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { wireCodec } from "./github/markers";
import {
  make,
  type PerformanceIssue,
  PerformanceIssueFiler,
  type PerformanceIssueFilerHost,
  PerformanceIssueFingerprint,
} from "./performance-issue-filer";

const decodeWorkItemId = Schema.decodeSync(WorkItemId);
const decodeFingerprint = Schema.decodeSync(PerformanceIssueFingerprint);
const fingerprint = decodeFingerprint("daemon.event-loop-delay-p99.above");
const marker = wireCodec.encode({ name: "selfperf", pairs: `fingerprint=${fingerprint}` });
const pendingFingerprint = decodeFingerprint("renderer.heap-headroom.below");
const pendingMarker = wireCodec.encode({
  name: "selfperf",
  pairs: `fingerprint=${pendingFingerprint}`,
});

interface Recorded {
  readonly created: ReadonlyArray<{
    readonly title: string;
    readonly body: string;
    readonly labels: ReadonlyArray<string>;
  }>;
  readonly comments: ReadonlyArray<{ readonly id: WorkItemIdType; readonly body: string }>;
  readonly labelRepairs: ReadonlyArray<WorkItemIdType>;
}

const input = {
  fingerprint,
  title: "Daemon event-loop delay p99 exceeded 100 ms",
  body: "Signal: daemon event-loop delay p99 above threshold",
  recurrenceBody: "Fired again.\n\nObserved: 140 ms",
};

class PerformanceIssueCalls extends Context.Service<PerformanceIssueCalls, Ref.Ref<Recorded>>()(
  "@cogwork/engine/performance-issue-filer.test/PerformanceIssueCalls",
) {
  static readonly layer = Layer.effect(
    PerformanceIssueCalls,
    Ref.make<Recorded>({ created: [], comments: [], labelRepairs: [] }),
  );
}

const filerLayer = (
  issues: ReadonlyArray<PerformanceIssue>,
  pendingFingerprints: ReadonlySet<PerformanceIssueFingerprint> = new Set(),
) =>
  Layer.effect(
    PerformanceIssueFiler,
    Effect.gen(function* () {
      const recorded = yield* PerformanceIssueCalls;
      const host: PerformanceIssueFilerHost = {
        codec: wireCodec,
        target: Effect.succeed({
          list: Effect.succeed(issues),
          pendingFingerprints: Effect.succeed(pendingFingerprints),
          create: (created) =>
            Ref.update(recorded, (current) => ({ ...current, created: [...current.created, created] })),
          comment: (id, body) =>
            Ref.update(recorded, (current) => ({
              ...current,
              comments: [...current.comments, { id, body }],
            })),
          ensureLabels: (currentIssue) =>
            Ref.update(recorded, (current) => ({
              ...current,
              labelRepairs: [...current.labelRepairs, currentIssue.id],
            })),
          confirmPending: (currentIssue) =>
            Ref.update(recorded, (current) => ({
              ...current,
              labelRepairs: [...current.labelRepairs, currentIssue.id],
            })).pipe(Effect.map(() => true)),
        }),
      };
      return yield* make(host, 3);
    }),
  ).pipe(Layer.provideMerge(PerformanceIssueCalls.layer));

const issue = (overrides: Partial<PerformanceIssue> = {}) =>
  ({
    id: decodeWorkItemId("#10"),
    url: "https://github.com/colonylabs/cogwork/issues/10",
    state: "open",
    body: marker,
    createdAtMillis: Date.UTC(2026, 8, 9, 12),
    labels: ["needs-triage", "origin:selfperf"],
    hasMergedFix: false,
    ...overrides,
  }) satisfies PerformanceIssue;

const today = Date.UTC(2026, 8, 9, 15);
const filedToday = issue({ id: decodeWorkItemId("#1"), body: "", createdAtMillis: today - 1 });
const cappedIssues = [
  filedToday,
  issue({ id: decodeWorkItemId("#2"), body: "", createdAtMillis: today - 2 }),
  issue({ id: decodeWorkItemId("#3"), body: "", createdAtMillis: today - 3 }),
];
const closedOccurrence = issue({
  state: "closed",
  createdAtMillis: Date.UTC(2026, 8, 8, 12),
  hasMergedFix: true,
});
const visiblePending = issue({ id: decodeWorkItemId("#2"), body: pendingMarker });

describe("performance issue filer", () => {
  it.effect("comments on an open fingerprint match instead of filing", () =>
    Effect.gen(function* () {
      const filer = yield* PerformanceIssueFiler;
      const recorded = yield* PerformanceIssueCalls;

      const result = yield* filer.submit(input, Date.UTC(2026, 8, 9, 15));

      assert.strictEqual(result, "commented");
      assert.deepStrictEqual(yield* Ref.get(recorded), {
        created: [],
        comments: [{ id: decodeWorkItemId("#10"), body: input.recurrenceBody }],
        labelRepairs: [decodeWorkItemId("#10")],
      });
    }).pipe(Effect.provide(filerLayer([issue()]))),
  );

  it.effect("confirms a pending open issue without posting a recurrence comment", () =>
    Effect.gen(function* () {
      const filer = yield* PerformanceIssueFiler;
      const recorded = yield* PerformanceIssueCalls;

      const result = yield* filer.submit(input, today);

      assert.strictEqual(result, "filed");
      assert.deepStrictEqual(yield* Ref.get(recorded), {
        created: [],
        comments: [],
        labelRepairs: [decodeWorkItemId("#10")],
      });
    }).pipe(Effect.provide(filerLayer([issue()], new Set([fingerprint])))),
  );

  it.effect("enforces the UTC-day filing cap", () =>
    Effect.gen(function* () {
      const filer = yield* PerformanceIssueFiler;
      const recorded = yield* PerformanceIssueCalls;

      const result = yield* filer.submit(input, today);

      assert.strictEqual(result, "capped");
      assert.deepStrictEqual(yield* Ref.get(recorded), { created: [], comments: [], labelRepairs: [] });
    }).pipe(Effect.provide(filerLayer(cappedIssues))),
  );

  it.effect("counts accepted issues that are waiting for confirmation", () =>
    Effect.gen(function* () {
      const filer = yield* PerformanceIssueFiler;
      const recorded = yield* PerformanceIssueCalls;

      const result = yield* filer.submit(input, today);

      assert.strictEqual(result, "capped");
      assert.deepStrictEqual(yield* Ref.get(recorded), {
        created: [],
        comments: [],
        labelRepairs: [],
      });
    }).pipe(
      Effect.provide(
        filerLayer(cappedIssues.slice(0, 2), new Set([decodeFingerprint("renderer.heap-headroom.below")])),
      ),
    ),
  );

  it.effect("does not count a visible pending issue twice", () =>
    Effect.gen(function* () {
      const filer = yield* PerformanceIssueFiler;
      const recorded = yield* PerformanceIssueCalls;

      const result = yield* filer.submit(input, today);

      assert.strictEqual(result, "filed");
      assert.strictEqual((yield* Ref.get(recorded)).created.length, 1);
    }).pipe(Effect.provide(filerLayer([filedToday, visiblePending], new Set([pendingFingerprint])))),
  );

  it.effect("comments on a closed occurrence until its fix merges", () =>
    Effect.gen(function* () {
      const filer = yield* PerformanceIssueFiler;
      const recorded = yield* PerformanceIssueCalls;

      const result = yield* filer.submit(input, today);

      assert.strictEqual(result, "commented");
      assert.deepStrictEqual(yield* Ref.get(recorded), {
        created: [],
        comments: [{ id: closedOccurrence.id, body: input.recurrenceBody }],
        labelRepairs: [closedOccurrence.id],
      });
    }).pipe(Effect.provide(filerLayer([{ ...closedOccurrence, hasMergedFix: false }]))),
  );

  it.effect("files a cross-linked regression instead of reopening a closed issue", () =>
    Effect.gen(function* () {
      const filer = yield* PerformanceIssueFiler;
      const recorded = yield* PerformanceIssueCalls;

      const result = yield* filer.submit(input, Date.UTC(2026, 8, 9, 15));
      const calls = yield* Ref.get(recorded);

      assert.strictEqual(result, "filed");
      assert.strictEqual(calls.comments.length, 0);
      assert.strictEqual(calls.created.length, 1);
      assert.strictEqual(calls.created[0]?.title, `Regression: ${input.title}`);
      assert.include(calls.created[0]?.body ?? "", `Previous occurrence: ${closedOccurrence.url}`);
    }).pipe(Effect.provide(filerLayer([closedOccurrence]))),
  );

  it.effect("files one labeled evidence issue when no fingerprint matches", () =>
    Effect.gen(function* () {
      const filer = yield* PerformanceIssueFiler;
      const recorded = yield* PerformanceIssueCalls;

      const result = yield* filer.submit(input, Date.UTC(2026, 8, 9, 15));
      const [created] = (yield* Ref.get(recorded)).created;

      assert.strictEqual(result, "filed");
      assert.deepStrictEqual(created?.labels, ["needs-triage", "origin:selfperf"]);
      assert.include(created?.body ?? "", marker);
    }).pipe(Effect.provide(filerLayer([]))),
  );
});
