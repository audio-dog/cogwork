import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { wireCodec } from "./github/markers";
import { make, type PerformanceIssue, type PerformanceIssueFilerHost } from "./performance-issue-filer";

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

const hostWith = (issues: ReadonlyArray<PerformanceIssue>) =>
  Effect.gen(function* () {
    const recorded = yield* Ref.make<Recorded>({ created: [], comments: [] });
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
    return { filer: yield* make(host, 3), recorded };
  });

const issue = (overrides: Partial<PerformanceIssue> = {}) =>
  ({
    id: "#10",
    url: "https://github.com/colonylabs/cogwork/issues/10",
    state: "open",
    body: marker,
    createdAtMillis: Date.UTC(2026, 8, 9, 12),
    ...overrides,
  }) satisfies PerformanceIssue;

describe("performance issue filer", () => {
  it.effect("comments on an open fingerprint match instead of filing", () =>
    Effect.gen(function* () {
      const { filer, recorded } = yield* hostWith([issue()]);

      const result = yield* filer.submit(input, Date.UTC(2026, 8, 9, 15));

      assert.strictEqual(result, "commented");
      assert.deepStrictEqual(yield* Ref.get(recorded), {
        created: [],
        comments: [{ id: "#10", body: input.recurrenceBody }],
      });
    }),
  );

  it.effect("enforces the UTC-day filing cap", () =>
    Effect.gen(function* () {
      const today = Date.UTC(2026, 8, 9, 15);
      const { filer, recorded } = yield* hostWith([
        issue({ id: "#1", body: "", createdAtMillis: today - 1 }),
        issue({ id: "#2", body: "", createdAtMillis: today - 2 }),
        issue({ id: "#3", body: "", createdAtMillis: today - 3 }),
      ]);

      const result = yield* filer.submit(input, today);

      assert.strictEqual(result, "capped");
      assert.deepStrictEqual(yield* Ref.get(recorded), { created: [], comments: [] });
    }),
  );

  it.effect("files a cross-linked regression instead of reopening a closed issue", () =>
    Effect.gen(function* () {
      const closed = issue({ state: "closed", createdAtMillis: Date.UTC(2026, 8, 8, 12) });
      const { filer, recorded } = yield* hostWith([closed]);

      const result = yield* filer.submit(input, Date.UTC(2026, 8, 9, 15));
      const calls = yield* Ref.get(recorded);

      assert.strictEqual(result, "filed");
      assert.strictEqual(calls.comments.length, 0);
      assert.strictEqual(calls.created.length, 1);
      assert.strictEqual(calls.created[0]?.title, `Regression: ${input.title}`);
      assert.include(calls.created[0]?.body ?? "", `Previous occurrence: ${closed.url}`);
    }),
  );

  it.effect("files one labeled evidence issue when no fingerprint matches", () =>
    Effect.gen(function* () {
      const { filer, recorded } = yield* hostWith([]);

      const result = yield* filer.submit(input, Date.UTC(2026, 8, 9, 15));
      const [created] = (yield* Ref.get(recorded)).created;

      assert.strictEqual(result, "filed");
      assert.deepStrictEqual(created?.labels, ["needs-triage", "origin:selfperf"]);
      assert.include(created?.body ?? "", marker);
    }),
  );
});
