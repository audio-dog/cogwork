import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { wireCodec } from "./github/markers";
import {
  make,
  type PerformanceIssue,
  PerformanceIssueFiler,
  type PerformanceIssueFilerHost,
} from "./performance-issue-filer";

const fingerprint = "daemon.event-loop-delay-p99.above";
const marker = wireCodec.encode({ name: "selfperf", pairs: `fingerprint=${fingerprint}` });

interface Recorded {
  readonly created: ReadonlyArray<{
    readonly title: string;
    readonly body: string;
    readonly labels: ReadonlyArray<string>;
  }>;
  readonly comments: ReadonlyArray<{ readonly id: string; readonly body: string }>;
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
    Ref.make<Recorded>({ created: [], comments: [] }),
  );
}

const filerLayer = (issues: ReadonlyArray<PerformanceIssue>) =>
  Layer.effect(
    PerformanceIssueFiler,
    Effect.gen(function* () {
      const recorded = yield* PerformanceIssueCalls;
      const host: PerformanceIssueFilerHost = {
        codec: wireCodec,
        target: Effect.succeed({
          list: Effect.succeed(issues),
          create: (created) =>
            Ref.update(recorded, (current) => ({ ...current, created: [...current.created, created] })),
          comment: (id, body) =>
            Ref.update(recorded, (current) => ({
              ...current,
              comments: [...current.comments, { id, body }],
            })),
        }),
      };
      return yield* make(host, 3);
    }),
  ).pipe(Layer.provideMerge(PerformanceIssueCalls.layer));

const issue = (overrides: Partial<PerformanceIssue> = {}) =>
  ({
    id: "#10",
    url: "https://github.com/colonylabs/cogwork/issues/10",
    state: "open",
    body: marker,
    createdAtMillis: Date.UTC(2026, 8, 9, 12),
    ...overrides,
  }) satisfies PerformanceIssue;

const today = Date.UTC(2026, 8, 9, 15);
const cappedIssues = [
  issue({ id: "#1", body: "", createdAtMillis: today - 1 }),
  issue({ id: "#2", body: "", createdAtMillis: today - 2 }),
  issue({ id: "#3", body: "", createdAtMillis: today - 3 }),
];
const closedOccurrence = issue({ state: "closed", createdAtMillis: Date.UTC(2026, 8, 8, 12) });

describe("performance issue filer", () => {
  it.effect("comments on an open fingerprint match instead of filing", () =>
    Effect.gen(function* () {
      const filer = yield* PerformanceIssueFiler;
      const recorded = yield* PerformanceIssueCalls;

      const result = yield* filer.submit(input, Date.UTC(2026, 8, 9, 15));

      assert.strictEqual(result, "commented");
      assert.deepStrictEqual(yield* Ref.get(recorded), {
        created: [],
        comments: [{ id: "#10", body: input.recurrenceBody }],
      });
    }).pipe(Effect.provide(filerLayer([issue()]))),
  );

  it.effect("enforces the UTC-day filing cap", () =>
    Effect.gen(function* () {
      const filer = yield* PerformanceIssueFiler;
      const recorded = yield* PerformanceIssueCalls;

      const result = yield* filer.submit(input, today);

      assert.strictEqual(result, "capped");
      assert.deepStrictEqual(yield* Ref.get(recorded), { created: [], comments: [] });
    }).pipe(Effect.provide(filerLayer(cappedIssues))),
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
