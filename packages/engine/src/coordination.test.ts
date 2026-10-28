import type { AttemptRecord, Claim, HandbackRecord } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { triageProposalBody } from "./comments";
import {
  attemptStatus,
  type CommentHost,
  type CoordinationComment,
  claimStatus,
  coordinationDetail,
  coordinationMarkers,
  coordinationStatus,
  defaultStatus,
  formatCoordinationBody,
  formatNoteBody,
  hasCogworkMarker,
  hasLedgerMarker,
  parseAttempts,
  parseClaim,
  parseFollowUp,
  parseHandback,
  postNote,
  selectLedger,
  selectTriageProposal,
  serializeAttempt,
  serializeClaim,
  serializeFollowUp,
  serializeHandback,
  upsertCoordination,
  type WireCodec,
} from "./coordination";
import type { FollowUpMarker } from "./follow-up";
import { wireCodec as githubCodec } from "./github/markers";
import { wireCodec as linearCodec } from "./linear/markers";

const codecs = [
  ["github", githubCodec],
  ["linear", linearCodec],
] as const satisfies ReadonlyArray<readonly [string, WireCodec]>;

const makeStore = () =>
  Effect.gen(function* () {
    const commentsRef = yield* Ref.make<ReadonlyArray<CoordinationComment<number>>>([]);
    const seq = yield* Ref.make(1);
    const host: CommentHost<number> = {
      comments: Ref.get(commentsRef),
      edit: (id, body) =>
        Ref.update(commentsRef, (comments) =>
          comments.map((comment) => (comment.id === id ? { ...comment, body } : comment)),
        ),
      create: (body) =>
        Ref.getAndUpdate(seq, (value) => value + 1).pipe(
          Effect.flatMap((id) =>
            Ref.update(commentsRef, (comments) => [
              ...comments,
              { id, body, isBot: true, createdAtMillis: id },
            ]),
          ),
        ),
    };
    const seed = (comment: CoordinationComment<number>) =>
      Ref.update(commentsRef, (comments) => [...comments, comment]);
    return { host, comments: Ref.get(commentsRef), seed };
  });

for (const [wire, codec] of codecs) {
  describe(`coordination (${wire} wire)`, () => {
    it("round-trips a claim, carrying its stage on both hosts", () => {
      const claim: Claim = { by: "cogwork", claimedAtMillis: 1_722_000_000_000, stage: "implement" };
      const body = formatCoordinationBody(codec, {
        status: claimStatus("implement"),
        markers: [serializeClaim(codec, claim)],
        detail: null,
      });
      assert.deepStrictEqual(parseClaim(codec, body), claim);
    });

    it("still decodes an older stage-less claim marker", () => {
      const claim: Claim = { by: "cogwork", claimedAtMillis: 1 };
      assert.deepStrictEqual(
        parseClaim(
          codec,
          formatCoordinationBody(codec, {
            status: defaultStatus,
            markers: [serializeClaim(codec, claim)],
            detail: null,
          }),
        ),
        claim,
      );
    });

    it("keeps only the most recent claim when several markers exist", () => {
      const older: Claim = { by: "old", claimedAtMillis: 1 };
      const newer: Claim = { by: "new", claimedAtMillis: 2 };
      const body = formatCoordinationBody(codec, {
        status: defaultStatus,
        markers: [serializeClaim(codec, older), serializeClaim(codec, newer)],
        detail: null,
      });
      assert.deepStrictEqual(parseClaim(codec, body), newer);
    });

    it("returns null for a body without a well-formed claim marker", () => {
      const body = formatCoordinationBody(codec, { status: defaultStatus, markers: [], detail: null });
      assert.isNull(parseClaim(codec, body));
    });

    it("round-trips attempt records and preserves their order", () => {
      const attempts: ReadonlyArray<AttemptRecord> = [
        { workflow: "coding", operation: "implement", outcome: "failed", atMillis: 1 },
        { workflow: "coding", operation: "follow-up", outcome: "succeeded", atMillis: 2 },
      ];
      const body = formatCoordinationBody(codec, {
        status: defaultStatus,
        markers: attempts.map((attempt) => serializeAttempt(codec, attempt)),
        detail: null,
      });
      assert.deepStrictEqual(parseAttempts(codec, body), attempts);
    });

    it("round-trips handback records and keeps the most recent one", () => {
      const older: HandbackRecord = { by: "local-owner", atMillis: 2 };
      const newer: HandbackRecord = { by: "local-owner", atMillis: 5 };
      const body = formatCoordinationBody(codec, {
        status: defaultStatus,
        markers: [serializeHandback(codec, older), serializeHandback(codec, newer)],
        detail: null,
      });
      assert.deepStrictEqual(parseHandback(codec, body), newer);
    });

    it("parses claim and attempts from a single consolidated body", () => {
      const claim: Claim = { by: "cogwork", claimedAtMillis: 3 };
      const attempts: ReadonlyArray<AttemptRecord> = [
        { workflow: "coding", operation: "implement", outcome: "failed", atMillis: 1 },
        { workflow: "coding", operation: "implement", outcome: "failed", atMillis: 2 },
      ];
      const body = formatCoordinationBody(codec, {
        status: claimStatus("implement"),
        markers: [
          ...attempts.map((attempt) => serializeAttempt(codec, attempt)),
          serializeClaim(codec, claim),
        ],
        detail: null,
      });
      assert.deepStrictEqual(parseClaim(codec, body), claim);
      assert.deepStrictEqual(parseAttempts(codec, body), attempts);
    });

    it("round-trips a follow-up marker and keeps the most recent one", () => {
      const older: FollowUpMarker = {
        checks: "failing",
        humanCommentAtMillis: 1,
        noProgress: 0,
        baseDivergence: "conflict",
        botTriggerAtMillis: 3,
      };
      const newer: FollowUpMarker = {
        checks: "passing",
        humanCommentAtMillis: 2,
        noProgress: 1,
        baseDivergence: "clean",
        botTriggerAtMillis: 4,
      };
      const body = formatCoordinationBody(codec, {
        status: defaultStatus,
        markers: [serializeFollowUp(codec, older), serializeFollowUp(codec, newer)],
        detail: null,
      });
      assert.deepStrictEqual(parseFollowUp(codec, body), newer);
    });

    it("returns null for a follow-up marker with an unknown check state", () => {
      const body = formatCoordinationBody(codec, {
        status: defaultStatus,
        markers: [codec.encode({ name: "follow-up", pairs: "checks=maybe human=1 noProgress=0" })],
        detail: null,
      });
      assert.isNull(parseFollowUp(codec, body));
    });

    it("reads a follow-up marker written before base divergence existed as base none", () => {
      const body = formatCoordinationBody(codec, {
        status: defaultStatus,
        markers: [codec.encode({ name: "follow-up", pairs: "checks=failing human=1 noProgress=0" })],
        detail: null,
      });
      assert.deepStrictEqual(parseFollowUp(codec, body), {
        checks: "failing",
        humanCommentAtMillis: 1,
        noProgress: 0,
        baseDivergence: "none",
        botTriggerAtMillis: 0,
      });
    });

    it("puts a failure reason on the attempt status line", () => {
      assert.strictEqual(
        attemptStatus(
          { workflow: "coding", operation: "implement", outcome: "failed", atMillis: 1 },
          "git worktree add: boom",
        ),
        "Last implement attempt failed: `git worktree add: boom`",
      );
    });

    it("keeps Markdown in a failure reason inside one code span", () => {
      assert.strictEqual(
        attemptStatus(
          { workflow: "coding", operation: "implement", outcome: "failed", atMillis: 1 },
          "conflicts: `tag`, @security, [review](https://example.com)",
        ),
        "Last implement attempt failed: ``conflicts: `tag`, @security, [review](https://example.com)``",
      );
    });

    it("recognizes any cogwork marker, including the ledger anchor and an agent note", () => {
      assert.isTrue(hasCogworkMarker(codec, codec.ledgerMarker));
      assert.isTrue(hasCogworkMarker(codec, serializeClaim(codec, { by: "x", claimedAtMillis: 1 })));
      assert.isTrue(hasCogworkMarker(codec, codec.encode({ name: "agent-note", pairs: "" })));
      assert.isFalse(hasCogworkMarker(codec, "please take another look, this still fails"));
    });

    it("formats a visible status above the markers and recovers status, markers, and detail", () => {
      const claim = serializeClaim(codec, { by: "bot", claimedAtMillis: 1 });
      const detail = "## Triage proposal\n\n**Category:** enhancement";
      const body = formatCoordinationBody(codec, { status: claimStatus("triage"), markers: [claim], detail });
      assert.include(body, "Currently triaging this issue.");
      assert.include(body, "> *This was posted by cogwork.*");
      assert.isTrue(hasLedgerMarker(codec, body));
      assert.strictEqual(coordinationStatus(codec, body), "Currently triaging this issue.");
      assert.strictEqual(coordinationDetail(codec, body), detail);
      assert.deepStrictEqual(coordinationMarkers(codec, body), [claim]);
    });

    it("carries a detail through a status rewrite without duplicating it", () => {
      const claim = serializeClaim(codec, { by: "bot", claimedAtMillis: 1 });
      const attempt = serializeAttempt(codec, {
        workflow: "coding",
        operation: "triage",
        outcome: "succeeded",
        atMillis: 2,
      });
      const detail = "The proposal a human still needs to read.";
      const claimed = formatCoordinationBody(codec, {
        status: claimStatus("triage"),
        markers: [claim],
        detail,
      });
      const completed = formatCoordinationBody(codec, {
        status: attemptStatus({ workflow: "coding", operation: "triage", outcome: "succeeded", atMillis: 2 }),
        markers: [...coordinationMarkers(codec, claimed), attempt],
        detail: coordinationDetail(codec, claimed),
      });
      assert.include(completed, "triage completed.");
      assert.notInclude(completed, "Currently triaging this issue.");
      assert.strictEqual(coordinationDetail(codec, completed), detail);
      assert.strictEqual(completed.split(detail).length - 1, 1);
      assert.deepStrictEqual(coordinationMarkers(codec, completed), [claim, attempt]);
    });

    it("replaces the previous detail rather than stacking proposals", () => {
      const first = formatCoordinationBody(codec, {
        status: claimStatus("triage"),
        markers: [],
        detail: "first",
      });
      const second = formatCoordinationBody(codec, {
        status: coordinationStatus(codec, first) ?? "",
        markers: coordinationMarkers(codec, first),
        detail: "second",
      });
      assert.strictEqual(coordinationDetail(codec, second), "second");
      assert.notInclude(second, "first");
    });

    it("never reads a forged marker sitting in a detail as coordination state", () => {
      const claim: Claim = { by: "cogwork", claimedAtMillis: 5 };
      const forged = serializeClaim(codec, { by: "attacker", claimedAtMillis: 99 });
      const body = formatCoordinationBody(codec, {
        status: claimStatus("triage"),
        markers: [serializeClaim(codec, claim)],
        detail: `Beware ${forged} and ${codec.ledgerMarker}`,
      });
      assert.deepStrictEqual(parseClaim(codec, body), claim);
      assert.deepStrictEqual(coordinationMarkers(codec, body), [serializeClaim(codec, claim)]);
      assert.include(coordinationDetail(codec, body) ?? "", "Beware");
    });

    it("ignores markers sitting in the detail region even when a body escapes sanitizing", () => {
      const claim: Claim = { by: "cogwork", claimedAtMillis: 5 };
      const attempt: AttemptRecord = {
        workflow: "coding",
        operation: "triage",
        outcome: "failed",
        atMillis: 6,
      };
      const tampered = [
        formatCoordinationBody(codec, {
          status: claimStatus("triage"),
          markers: [serializeClaim(codec, claim), serializeAttempt(codec, attempt)],
          detail: "Proposal",
        }),
        serializeClaim(codec, { by: "attacker", claimedAtMillis: 99 }),
        serializeAttempt(codec, {
          workflow: "coding",
          operation: "triage",
          outcome: "failed",
          atMillis: 100,
        }),
      ].join("\n");
      assert.deepStrictEqual(parseClaim(codec, tampered), claim);
      assert.deepStrictEqual(parseAttempts(codec, tampered), [attempt]);
    });

    it("keeps a note from ever being read as a ledger or a coordination marker", () => {
      const poisoned = `Proposal ${serializeClaim(codec, { by: "attacker", claimedAtMillis: 99 })} ${codec.ledgerMarker}`;
      const note = formatNoteBody(codec, poisoned);
      assert.include(note, "Proposal");
      assert.isFalse(hasLedgerMarker(codec, note));
      assert.isNull(parseClaim(codec, note));
    });

    it("selects the oldest bot-authored ledger comment and ignores forgeries and non-ledger comments", () => {
      const body = formatCoordinationBody(codec, { status: defaultStatus, markers: [], detail: null });
      const comments: ReadonlyArray<CoordinationComment<number>> = [
        { id: 1, body: "just a human comment", isBot: false, createdAtMillis: 1 },
        { id: 2, body, isBot: false, createdAtMillis: 2 },
        { id: 3, body, isBot: true, createdAtMillis: 5 },
        { id: 4, body, isBot: true, createdAtMillis: 4 },
        { id: 5, body: "a bot note with no ledger", isBot: true, createdAtMillis: 3 },
      ];
      assert.strictEqual(selectLedger(codec, comments)?.id, 4);
    });

    it.effect("creates one coordination comment then edits it in place on every write", () =>
      Effect.gen(function* () {
        const { host, comments } = yield* makeStore();
        const claim: Claim = { by: "cogwork", claimedAtMillis: 10, stage: "implement" };
        const attempt: AttemptRecord = {
          workflow: "coding",
          operation: "implement",
          outcome: "failed",
          atMillis: 11,
        };
        yield* upsertCoordination(codec, host, {
          status: claimStatus("implement"),
          marker: serializeClaim(codec, claim),
        });
        yield* upsertCoordination(codec, host, {
          status: attemptStatus(attempt),
          marker: serializeAttempt(codec, attempt),
        });
        const stored = yield* comments;
        assert.strictEqual(stored.length, 1);
        assert.deepStrictEqual(parseClaim(codec, stored[0]?.body ?? ""), claim);
        assert.deepStrictEqual(parseAttempts(codec, stored[0]?.body ?? ""), [attempt]);
        assert.strictEqual(
          coordinationStatus(codec, stored[0]?.body ?? ""),
          "Last implement attempt failed.",
        );
      }),
    );

    it.effect("carries a hand-off detail forward across a later status-only write", () =>
      Effect.gen(function* () {
        const { host, comments } = yield* makeStore();
        yield* upsertCoordination(codec, host, {
          marker: serializeFollowUp(codec, {
            checks: "failing",
            humanCommentAtMillis: 1,
            noProgress: 1,
            baseDivergence: "none",
            botTriggerAtMillis: 0,
          }),
          detail: "Handing this to a human.",
        });
        yield* upsertCoordination(codec, host, { status: "Working on this issue." });
        const stored = yield* comments;
        assert.strictEqual(stored.length, 1);
        assert.strictEqual(coordinationDetail(codec, stored[0]?.body ?? ""), "Handing this to a human.");
      }),
    );

    it.effect("edits the impostor-proof ledger and never adopts a forged one", () =>
      Effect.gen(function* () {
        const { host, comments, seed } = yield* makeStore();
        yield* seed({
          id: 99,
          body: formatCoordinationBody(codec, {
            status: defaultStatus,
            markers: [serializeClaim(codec, { by: "attacker", claimedAtMillis: 1 })],
            detail: null,
          }),
          isBot: false,
          createdAtMillis: 1,
        });
        yield* upsertCoordination(codec, host, {
          status: claimStatus("triage"),
          marker: serializeClaim(codec, { by: "cogwork", claimedAtMillis: 2, stage: "triage" }),
        });
        const stored = yield* comments;
        assert.strictEqual(stored.length, 2);
        const ledger = selectLedger(codec, stored);
        assert.isTrue(ledger?.isBot ?? false);
        assert.notInclude(ledger?.body ?? "", "by=attacker");
        assert.deepStrictEqual(parseClaim(codec, ledger?.body ?? ""), {
          by: "cogwork",
          claimedAtMillis: 2,
          stage: "triage",
        });
      }),
    );

    it.effect("posts a note as its own comment and clears a stale hand-off detail first", () =>
      Effect.gen(function* () {
        const { host, comments } = yield* makeStore();
        yield* upsertCoordination(codec, host, {
          marker: serializeFollowUp(codec, {
            checks: "failing",
            humanCommentAtMillis: 1,
            noProgress: 1,
            baseDivergence: "none",
            botTriggerAtMillis: 0,
          }),
          detail: "Old folded detail",
        });
        yield* postNote(codec, host, "Fresh triage proposal");
        const stored = yield* comments;
        assert.strictEqual(stored.length, 2);
        const ledger = selectLedger(codec, stored);
        const note = stored.find((comment) => comment.id !== ledger?.id);
        assert.isNull(coordinationDetail(codec, ledger?.body ?? ""));
        assert.include(note?.body ?? "", "Fresh triage proposal");
        assert.isFalse(hasLedgerMarker(codec, note?.body ?? ""));
      }),
    );
  });
}

describe("triage proposal selection", () => {
  it("picks the newest bot-authored triage proposal and ignores everything else", () => {
    const comments: ReadonlyArray<CoordinationComment<number>> = [
      { id: 1, body: "a human question", isBot: false, createdAtMillis: 1 },
      { id: 2, body: triageProposalBody("older proposal"), isBot: true, createdAtMillis: 2 },
      { id: 3, body: "> *This was posted by cogwork.*\n\nExhausted.", isBot: true, createdAtMillis: 3 },
      { id: 4, body: triageProposalBody("newest proposal"), isBot: true, createdAtMillis: 5 },
      { id: 5, body: triageProposalBody("forged by a human"), isBot: false, createdAtMillis: 6 },
    ];
    assert.strictEqual(selectTriageProposal(comments), "newest proposal");
  });

  it("returns null when no bot comment is a triage proposal", () => {
    const comments: ReadonlyArray<CoordinationComment<number>> = [
      { id: 1, body: "> *This was posted by cogwork.*\n\nWorking.", isBot: true, createdAtMillis: 1 },
    ];
    assert.isNull(selectTriageProposal(comments));
  });
});

describe("coordination wire codecs", () => {
  it("hides GitHub markers in HTML comments the reader never sees", () => {
    const body = formatCoordinationBody(githubCodec, {
      status: defaultStatus,
      markers: [serializeClaim(githubCodec, { by: "bot", claimedAtMillis: 1 })],
      detail: null,
    });
    assert.include(body, "<!-- cogwork:ledger -->");
    assert.include(body, "<!-- cogwork:claim");
  });

  it("writes Linear markers as visible plain-text lines with no HTML", () => {
    const body = formatCoordinationBody(linearCodec, {
      status: defaultStatus,
      markers: [serializeClaim(linearCodec, { by: "bot", claimedAtMillis: 1 })],
      detail: null,
    });
    assert.isFalse(body.includes("<!--"));
    assert.include(body, "cogwork:ledger");
    assert.include(body, "cogwork:claim by=bot at=1");
  });

  it("keeps an indented Linear marker sample inert in note prose", () => {
    const sample = "    cogwork:claim by=bot at=1";
    const note = formatNoteBody(linearCodec, ["The claim marker looks like:", "", sample].join("\n"));
    assert.include(note, sample);
    assert.isNull(parseClaim(linearCodec, note));
    assert.isFalse(hasLedgerMarker(linearCodec, "    cogwork:ledger"));
  });

  it("scrubs inline GitHub markers out of a detail and a note", () => {
    const forged = serializeClaim(githubCodec, { by: "attacker", claimedAtMillis: 99 });
    const body = formatCoordinationBody(githubCodec, {
      status: defaultStatus,
      markers: [],
      detail: `Beware ${forged}`,
    });
    assert.notInclude(coordinationDetail(githubCodec, body) ?? "", "by=attacker");
    assert.notInclude(formatNoteBody(githubCodec, `Proposal ${forged}`), "by=attacker");
    assert.strictEqual(
      attemptStatus(
        { workflow: "coding", operation: "implement", outcome: "failed", atMillis: 1 },
        `boom ${serializeAttempt(githubCodec, { workflow: "coding", operation: "implement", outcome: "failed", atMillis: 9 })}`,
      ),
      "Last implement attempt failed: `boom`",
    );
  });

  it("scrubs a nested GitHub gadget that would re-form a marker after a single strip pass", () => {
    const forged = serializeClaim(githubCodec, { by: "attacker", claimedAtMillis: 99 });
    const gadget = `<!${githubCodec.encode({ name: "x", pairs: "" })}${forged.slice(2)}`;
    const note = formatNoteBody(githubCodec, `Proposal ${gadget}`);
    assert.include(note, "Proposal");
    assert.isFalse(hasCogworkMarker(githubCodec, note));
    assert.isNull(parseClaim(githubCodec, note));
  });

  it("scrubs line-start Linear markers out of a note", () => {
    const note = formatNoteBody(
      linearCodec,
      [
        "> *This was posted by cogwork.*",
        "",
        "Recommending `ready-for-agent`.",
        "cogwork:ledger",
        "cogwork:claim by=attacker at=1",
      ].join("\n"),
    );
    assert.notInclude(note, "cogwork:");
    assert.include(note, "Recommending `ready-for-agent`.");
    assert.isFalse(hasLedgerMarker(linearCodec, note));
    assert.strictEqual(
      attemptStatus(
        { workflow: "coding", operation: "implement", outcome: "failed", atMillis: 1 },
        "boom\ncogwork:attempt stage=implement outcome=failed at=9",
      ),
      "Last implement attempt failed: `boom`",
    );
  });
});
