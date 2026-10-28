import { AttemptRecord, Claim, codingOperation, type HandbackRecord, LineageId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  type CommentHost,
  type CoordinationComment,
  coordinationDetail,
  coordinationMarkers,
  coordinationStatus,
  defaultStatus,
  formatCoordinationBody,
  formatNoteBody,
  parseAttempts,
  parseClaim,
  parseHandback,
  selectLedger,
  serializeAttempt,
  serializeClaim,
  serializeHandback,
  upsertCoordination,
  type WireCodec,
} from "./coordination";
import { wireCodec as githubCodec } from "./github/markers";
import { wireCodec as linearCodec } from "./linear/markers";

const codecs = [
  ["github", githubCodec],
  ["linear", linearCodec],
] as const satisfies ReadonlyArray<readonly [string, WireCodec]>;
const root = LineageId.make("issue:1");
const lineage = { root, parent: null, hop: 0 };
const claim: Claim = {
  by: "cogwork",
  claimedAtMillis: 1,
  operation: codingOperation("implement"),
  lineage,
};
const attempt: AttemptRecord = {
  operation: codingOperation("implement"),
  outcome: "failed",
  atMillis: 2,
  lineage,
};
const handback: HandbackRecord = { by: "person", atMillis: 3, note: "try again" };

const makeStore = () =>
  Effect.gen(function* () {
    const comments = yield* Ref.make<ReadonlyArray<CoordinationComment<number>>>([]);
    const host: CommentHost<number> = {
      comments: Ref.get(comments),
      edit: (id, body) =>
        Ref.update(comments, (current) =>
          current.map((comment) => (comment.id === id ? { ...comment, body } : comment)),
        ),
      create: (body) =>
        Ref.update(comments, (current) => [
          ...current,
          { id: current.length + 1, body, isBot: true, createdAtMillis: current.length + 1 },
        ]),
    };
    return { comments, host };
  });

it("requires full lineage on Claim and Attempt records", () => {
  assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(Claim)({ by: "cogwork", claimedAtMillis: 1 })));
  assert.isTrue(
    Result.isFailure(
      Schema.decodeUnknownResult(AttemptRecord)({
        operation: codingOperation("implement"),
        outcome: "failed",
        atMillis: 1,
      }),
    ),
  );
});

for (const [wire, codec] of codecs) {
  describe(`coordination (${wire} wire)`, () => {
    it("round-trips required records", () => {
      const body = formatCoordinationBody(codec, {
        status: defaultStatus,
        markers: [
          serializeClaim(codec, claim),
          serializeAttempt(codec, attempt),
          serializeHandback(codec, handback),
        ],
        detail: null,
      });

      assert.deepStrictEqual(parseClaim(codec, body), claim);
      assert.deepStrictEqual(parseAttempts(codec, body), [attempt]);
      assert.deepStrictEqual(parseHandback(codec, body), handback);
    });

    it("drops malformed persisted records", () => {
      const body = formatCoordinationBody(codec, {
        status: defaultStatus,
        markers: [
          codec.encode({ name: "claim", pairs: "by=cogwork at=1 workflow=coding operation=implement" }),
          codec.encode({
            name: "attempt",
            pairs: "workflow=coding operation=implement outcome=failed at=1",
          }),
        ],
        detail: null,
      });

      assert.isNull(parseClaim(codec, body));
      assert.deepStrictEqual(parseAttempts(codec, body), []);
    });

    it.effect("creates one ledger and appends records in place", () =>
      Effect.gen(function* () {
        const store = yield* makeStore();
        yield* upsertCoordination(codec, store.host, {
          status: "Claimed",
          marker: serializeClaim(codec, claim),
        });
        yield* upsertCoordination(codec, store.host, {
          status: "Failed",
          marker: serializeAttempt(codec, attempt),
          detail: "needs attention",
        });

        const comments = yield* Ref.get(store.comments);
        assert.lengthOf(comments, 1);
        assert.strictEqual(coordinationStatus(codec, comments[0]?.body ?? ""), "Failed");
        assert.strictEqual(coordinationDetail(codec, comments[0]?.body ?? ""), "needs attention");
        assert.deepStrictEqual(coordinationMarkers(codec, comments[0]?.body ?? ""), [
          serializeClaim(codec, claim),
          serializeAttempt(codec, attempt),
        ]);
      }),
    );

    it("selects the oldest bot ledger", () => {
      const body = formatCoordinationBody(codec, { status: defaultStatus, markers: [], detail: null });
      assert.strictEqual(
        selectLedger(codec, [
          { id: 2, body, isBot: true, createdAtMillis: 2 },
          { id: 1, body, isBot: true, createdAtMillis: 1 },
        ])?.id,
        1,
      );
    });

    it("strips coordination markers from notes", () => {
      const forged = serializeClaim(codec, claim);
      assert.notInclude(formatNoteBody(codec, `before\n${forged}\nafter`), "by=cogwork");
    });
  });
}
