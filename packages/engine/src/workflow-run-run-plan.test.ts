import {
  keyOf,
  NeedIdentity,
  WorkflowActionArtifact,
  WorkflowActionPlan,
  WorkflowDocument,
  WorkspaceConfig,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { HarnessRunner } from "./harness";
import type { RegisteredWorkspace } from "./projector";
import { emptyRegistry } from "./projector";
import { RunLedger } from "./run-ledger";
import { RunRecorder } from "./run-recorder";
import { emptyService as emptySourceControl } from "./source-control";
import { WorkflowArtifactStore } from "./workflow-artifact-store";
import { make as makeNotifications } from "./workflow-notification";
import { admission, granolaAdmission } from "./workflow-run-admissions-fixtures";
import {
  decodeRun,
  decodeWorkItem,
  decodeWorkspace,
  document,
  harnessName,
  issueSearchService,
  notifyEntry,
  postReviewCatalogEntry,
  reviewDocument,
  reviewOutput,
  reviewWorkspace,
  waitForApprovalCatalogEntry,
  workflow,
  workflowService,
  workflowServiceFor,
  workflowServiceWith,
} from "./workflow-run-documents-fixtures";
import { requirements, resultEvent, testProgram } from "./workflow-run-fixtures";

describe("WorkflowRun", () => {
  it.effect("freezes the complete Granola note in Work context", () =>
    Effect.gen(function* () {
      const { runner } = yield* testProgram([
        {
          summary: "Captured",
          stuck: false,
          answers: { done: "yes" },
          inputs: { notification: "Captured" },
        },
      ]);
      yield* runner.execute(granolaAdmission);
      const [run] = yield* (yield* RunLedger).listRuns(10);
      assert.isDefined(run);
      if (!run) return;
      const plan = yield* (yield* RunLedger).getRunPlan(run.id);

      assert.strictEqual(
        plan?.workContext.prose.body,
        [
          "# Weekly product sync",
          "",
          "## Attendees",
          "Taylor <taylor@example.com>",
          "Ari <ari@example.com>",
          "",
          "## Calendar event",
          "Weekly product sync · 2026-10-29 09:00 MDT",
          "",
          "## Summary",
          "Decided to ship the smaller change.",
          "",
          "## Transcript",
          "Taylor: Ship the smaller change.\nAri: Agreed.",
        ].join("\n"),
      );
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("includes artifacts already created by the lineage in Work context", () =>
    Effect.gen(function* () {
      const artifact = WorkflowActionArtifact.make({
        kind: "IssueCreated",
        workspace: decodeWorkspace("cogwork"),
        issue: decodeWorkItem("#99"),
        url: "https://example.test/issues/99",
        origin: {
          item: keyOf(granolaAdmission.event.key),
          workflow,
          attempt: decodeRun("prior-run"),
          writeKey: "prior-write",
          lineage: granolaAdmission.lineage,
        },
      });
      yield* (yield* WorkflowArtifactStore).record(artifact);
      const { runner } = yield* testProgram([
        {
          summary: "Captured",
          stuck: false,
          answers: { done: "yes" },
          inputs: { notification: "Captured" },
        },
      ]);

      yield* runner.execute(granolaAdmission);
      const [run] = yield* (yield* RunLedger).listRuns(10);
      assert.isDefined(run);
      if (!run) return;
      const plan = yield* (yield* RunLedger).getRunPlan(run.id);

      assert.include(plan?.workContext.prose.body ?? "", "## Artifacts this lineage created");
      assert.include(plan?.workContext.prose.body ?? "", "https://example.test/issues/99");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("writes frozen Notify me text and keeps the Run workspace-free", () =>
    Effect.gen(function* () {
      const { runner } = yield* testProgram([
        {
          summary: "All clear",
          stuck: false,
          answers: { done: "yes" },
          inputs: { notification: "Deploy ready" },
        },
      ]);
      yield* runner.execute(admission);
      const ledger = yield* RunLedger;
      const [run] = yield* ledger.listRuns(10);
      assert.isDefined(run);
      if (!run) return;
      const plan = yield* ledger.getRunPlan(run.id);
      const activities = yield* (yield* RunRecorder).replay(run).pipe(Stream.runCollect);
      const actionPlan = activities.find(
        ({ event }) => event.type === "CUSTOM" && event.name === "workflow.action-plan",
      );
      const frozenPlan = yield* Schema.decodeUnknownEffect(Schema.Struct({ object: WorkflowActionPlan }))(
        actionPlan?.event.value,
      ).pipe(Effect.map(({ object }) => object));
      yield* Effect.forEach(
        Array.from({ length: 101 }, (_, index) => index),
        (index) =>
          ledger.insertRun({
            ...run,
            id: decodeRun(`noise-${index}`),
            startedAtMillis: run.startedAtMillis + index + 1,
          }),
        { discard: true },
      );
      const restartedNotifications = yield* makeNotifications;

      assert.strictEqual(run.status, "succeeded");
      assert.isNull(plan?.sandbox.workspace);
      assert.isEmpty(plan?.tools ?? []);
      assert.isDefined(actionPlan);
      assert.strictEqual(frozenPlan.steps[0]?.entry, notifyEntry);
      assert.deepStrictEqual(frozenPlan.steps[0]?.inputs, { notification: "Deploy ready" });
      assert.strictEqual(plan?.workContext.prose.body, admission.event.workContext?.body);
      assert.deepStrictEqual(
        plan?.workContext.prose.comments.map((comment) => ({ ...comment })),
        admission.event.workContext?.comments,
      );
      assert.strictEqual(
        plan?.instructions.find(({ source }) => source === "workflow-operation")?.content,
        "implement-agent:Summarize the day.",
      );
      assert.deepStrictEqual(
        (yield* restartedNotifications.list).map(({ summary, answers }) => ({ summary, answers })),
        [{ summary: "Deploy ready", answers: { done: "yes" } }],
      );
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("adds issue search only when a Transition writes an issue", () =>
    Effect.gen(function* () {
      const { runner } = yield* testProgram(
        [
          {
            summary: "Create it",
            stuck: false,
            answers: { done: "yes" },
            inputs: { issue_title: "Title", issue_body: "Body" },
            workspace: "none",
          },
        ],
        {},
        issueSearchService(yield* workflowService.catalog),
      );

      yield* runner.execute(admission);
      const [run] = yield* (yield* RunLedger).listRuns(1);
      assert.isDefined(run);
      if (!run) return;
      const plan = yield* (yield* RunLedger).getRunPlan(run.id);

      assert.deepStrictEqual(plan?.tools, ["issue-search"]);
      assert.deepStrictEqual(
        { ...plan?.provenance.projection.find(({ member }) => member === "Tools") },
        { member: "Tools", disposition: "projected" },
      );
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("lists no engine tool for a Harness that does not project Tools", () =>
    Effect.gen(function* () {
      const { runner } = yield* testProgram(
        [
          {
            summary: "Create it",
            stuck: false,
            answers: { done: "yes" },
            inputs: { issue_title: "Title", issue_body: "Body" },
            workspace: "none",
          },
        ],
        { projectedMembers: [] },
        issueSearchService(yield* workflowService.catalog),
      );

      yield* runner.execute(admission);
      const [run] = yield* (yield* RunLedger).listRuns(1);
      assert.isDefined(run);
      if (!run) return;
      const plan = yield* (yield* RunLedger).getRunPlan(run.id);

      assert.deepStrictEqual(plan?.tools, []);
      assert.deepStrictEqual(
        { ...plan?.provenance.projection.find(({ member }) => member === "Tools") },
        {
          member: "Tools",
          disposition: "not-projected",
          reason: "selected harness does not project Tools",
        },
      );
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  const releaseNeed = Schema.decodeSync(NeedIdentity)("local:user/skill/release");
  const skillProgram = Effect.fn("WorkflowRunTest.skillProgram")(function* (
    projectedMembers: HarnessRunner["projectedMembers"],
  ) {
    const skillWorkspace: RegisteredWorkspace = {
      source: "test",
      repository: "owner/repo",
      contributions: [
        {
          id: "local:repo/skill/release",
          authority: "local:repo",
          kind: "skill",
          localName: "release",
          file: "/repo/.agents/skills/release/SKILL.md",
        },
        {
          id: releaseNeed,
          authority: "local:user",
          kind: "skill",
          localName: "release",
          file: "/home/.agents/skills/release/SKILL.md",
        },
        {
          id: "local:repo/rules/style",
          authority: "local:repo",
          kind: "rules",
          localName: "style",
          file: "/repo/.agents/rules/style.md",
        },
      ],
      config: yield* Schema.decodeEffect(WorkspaceConfig)({
        id: "repo",
        displayName: "repo",
        checkoutPath: "/repo",
        issueTracker: { type: "github" },
      }),
    };
    const requiredDocument = WorkflowDocument.make({
      ...document,
      operations: document.operations.map((candidate) => ({ ...candidate, requires: [releaseNeed] })),
    });
    const { runner, coordination } = yield* testProgram(
      [{ summary: "Done", stuck: false, answers: { done: "yes" }, inputs: { notification: "Done" } }],
      {
        projectedMembers,
        registry: { ...emptyRegistry, workspaces: [skillWorkspace] },
        pluginContributions: [
          {
            id: "plugin:linear/skill/triage-notes",
            authority: "plugin:linear",
            kind: "skill",
            localName: "triage-notes",
            summary: "Triage notes",
            file: "/plugins/linear/skills/triage-notes/SKILL.md",
            load: { _tag: "Loaded" },
          },
        ],
      },
      {
        ...workflowServiceWith(requiredDocument),
        catalog: workflowService.catalog.pipe(
          Effect.map((result) => ({ ...result, machine: { ...result.machine, readyNeeds: [releaseNeed] } })),
        ),
      },
    );
    yield* runner.execute({
      ...admission,
      event: { ...admission.event, workspace: decodeWorkspace("repo") },
    });
    const [run] = yield* (yield* RunLedger).listRuns(1);
    const plan = run ? yield* (yield* RunLedger).getRunPlan(run.id) : null;
    return { plan, parks: yield* Ref.get(coordination.parks) };
  });

  it.effect(
    "admits a required Skill over a same-named Skill, and Plugin Skills, into the Run Plan of a Harness that projects Skills",
    () =>
      Effect.gen(function* () {
        const { plan } = yield* skillProgram(["Tools", "Skills"]);

        assert.deepStrictEqual(
          plan?.skills.map(({ identity, name, source }) => ({ identity, name, source })),
          [
            { identity: releaseNeed, name: "release", source: "/home/.agents/skills/release/SKILL.md" },
            {
              identity: "plugin:linear/skill/triage-notes",
              name: "triage-notes",
              source: "/plugins/linear/skills/triage-notes/SKILL.md",
            },
          ],
        );
        assert.deepStrictEqual(
          { ...plan?.provenance.projection.find(({ member }) => member === "Skills") },
          { member: "Skills", disposition: "projected" },
        );
      }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("rejects the Run Plan when the Harness cannot supply a required Skill", () =>
    Effect.gen(function* () {
      const { plan, parks } = yield* skillProgram(["Tools"]);

      assert.isNull(plan);
      assert.deepStrictEqual(parks.at(-1)?.reason, {
        _tag: "PlanRejected",
        reason: `${harnessName} does not project Skills, so it cannot supply the required Skill ${releaseNeed}`,
        entry: admission.event.entry,
      });
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("adds the pull request tool and rejects a head change after its read", () =>
    Effect.gen(function* () {
      const pullReads = yield* Ref.make(0);
      const sourceControl = {
        ...emptySourceControl,
        readPullRequest: () =>
          Ref.getAndUpdate(pullReads, (count) => count + 1).pipe(
            Effect.map((count) => ({
              number: 826,
              url: "https://github.com/owner/repo/pull/826",
              headBranch: "826-review-actions",
              baseBranch: "main",
              headSha: count === 0 ? "abc123" : "new-head",
              title: "Review actions",
              description: "Adds review actions.",
              diff: "",
              changedFiles: [],
              comments: [],
            })),
          ),
      };
      const { runner, coordination } = yield* testProgram(
        [reviewOutput],
        {
          registry: { ...emptyRegistry, workspaces: [reviewWorkspace] },
          sourceControl,
          run: (request) => {
            const execute = request.engineTools?.find(({ name }) => name === "pull-request")?.execute;
            if (!execute) return Stream.die("pull request tool is unavailable");
            return Stream.fromEffect(
              Effect.promise(() =>
                Promise.resolve(execute({ workspace: "repo", pull_request: "#826" })),
              ).pipe(Effect.map(() => resultEvent(reviewOutput))),
            );
          },
        },
        workflowServiceFor(reviewDocument, [postReviewCatalogEntry, waitForApprovalCatalogEntry]),
      );

      yield* runner.execute(admission);
      const [run] = yield* (yield* RunLedger).listRuns(1);
      assert.isDefined(run);
      if (!run) return;
      const plan = yield* (yield* RunLedger).getRunPlan(run.id);

      assert.deepStrictEqual(plan?.tools, ["pull-request"]);
      assert.strictEqual(run.status, "failed");
      assert.include((yield* Ref.get(coordination.attempts))[0]?.reason ?? "", "received a new commit");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("records the event's title and link on the Run and gives the link to the agent", () =>
    Effect.gen(function* () {
      const { runner } = yield* testProgram([
        {
          summary: "All clear",
          stuck: false,
          answers: { done: "yes" },
          inputs: { notification: "Deploy ready" },
        },
      ]);
      const subject = { title: "Fix login", url: "https://github.com/acme/web/issues/7" };
      yield* runner.execute({ ...admission, event: { ...admission.event, subject } });
      const ledger = yield* RunLedger;
      const [run] = yield* ledger.listRuns(10);
      const plan = run ? yield* ledger.getRunPlan(run.id) : null;

      assert.deepStrictEqual(run?.subject, subject);
      assert.strictEqual(plan?.workContext.reference.url, subject.url);
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );
});
