import { type AttemptRecord, type Claim, WorkItemId } from "@clanker-forge/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { CoordinationComment, CoordinationHost } from "../coordination";
import * as Coordination from "../coordination";
import {
  type FollowUpMarker,
  IssueTracker,
  IssueTrackerError,
  type IssueTrackerService,
  type RoleChanges,
  type TrackerItem,
} from "../issue-tracker";
import type { RegisteredWorkspace } from "../projector";
import {
  GitHubClient,
  type GitHubClientService,
  type GitHubRepoRef,
  type RawComment,
  type RawIssue,
} from "./client";
import { claimLabel, hasClaimLabel, roleLabel, rolesFromLabels, wireCodec } from "./markers";

interface GitHubTarget extends GitHubRepoRef {
  readonly botLogin: string | null;
}

const toCoordinationComment =
  (botLogin: string | null) =>
  (comment: RawComment): CoordinationComment<number> => ({
    id: comment.id,
    body: comment.body,
    isBot: comment.authorLogin === botLogin,
    createdAtMillis: comment.createdAtMillis,
  });

const targetFor = (workspace: RegisteredWorkspace) => {
  const source = workspace.config.issueTracker;
  if (source.type !== "github" || !source.repo) return null;
  const [owner, name] = source.repo.split("/");
  if (!owner || !name) return null;
  return {
    owner,
    name,
    tokenEnv: source.tokenEnv ?? "GITHUB_TOKEN",
    botLogin: source.botLogin ?? null,
  } satisfies GitHubTarget;
};

const decodeItemId = Schema.decodeUnknownEffect(WorkItemId);
const itemId = (issueNumber: number) => decodeItemId(`#${issueNumber}`).pipe(Effect.orDie);

const issueNumberOf = Effect.fn("github.issueNumberOf")(function* (id: string) {
  const parsed = Number.parseInt(id.replace(/^#/, ""), 10);
  if (Number.isNaN(parsed)) {
    return yield* new IssueTrackerError({
      reason: "unavailable",
      message: `unrecognized work item id ${id}`,
    });
  }
  return parsed;
});

const notGitHub = (workspace: RegisteredWorkspace) =>
  new IssueTrackerError({
    reason: "unavailable",
    message: `workspace ${workspace.config.name} is not a github work source`,
  });

const make = (client: GitHubClientService): IssueTrackerService => {
  const resolveIssue = Effect.fn("github.resolveIssue")(function* (
    workspace: RegisteredWorkspace,
    id: string,
  ) {
    const target = targetFor(workspace);
    if (!target) {
      return yield* notGitHub(workspace);
    }
    const number = yield* issueNumberOf(id);
    return { target, number };
  });

  const coordinationHost = (target: GitHubTarget, number: number): CoordinationHost<number> => ({
    comments: client
      .listComments(target, number)
      .pipe(Effect.map((comments) => comments.map(toCoordinationComment(target.botLogin)))),
    edit: (id, body) => client.editComment(target, id, body),
    create: (body) => client.createComment(target, number, body),
  });

  const buildItem = (target: GitHubTarget) =>
    Effect.fn("github.buildItem")(function* (issue: RawIssue) {
      const claimLabeled = hasClaimLabel(issue.labels);
      const comments = target.botLogin ? yield* client.listComments(target, issue.number) : [];
      const ledger = Coordination.selectLedger(
        wireCodec,
        comments.map(toCoordinationComment(target.botLogin)),
      );
      const body = ledger?.body ?? "";
      const id = yield* itemId(issue.number);
      return {
        id,
        title: issue.title,
        roles: rolesFromLabels(issue.labels),
        claimLabeled,
        claim: claimLabeled ? Coordination.parseClaim(wireCodec, body) : null,
        attempts: Coordination.parseAttempts(wireCodec, body),
        owned: ledger !== undefined,
        followUp: Coordination.parseFollowUp(wireCodec, body),
        openBlockers: issue.openBlockers,
      } satisfies TrackerItem;
    });

  const observeTarget = Effect.fn("github.observeTarget")(function* (target: GitHubTarget) {
    const issues = yield* client.listIssues(target);
    return yield* Effect.forEach(
      issues.filter((issue) => !issue.isPullRequest),
      buildItem(target),
      {
        concurrency: 10,
      },
    );
  });

  return {
    rateLimitScope: () => null,
    observe: Effect.fn("github.observe")(function* (workspace: RegisteredWorkspace) {
      const target = targetFor(workspace);
      if (!target) {
        return [];
      }
      return yield* observeTarget(target);
    }),
    claim: Effect.fn("github.claim")(function* (
      workspace: RegisteredWorkspace,
      id: WorkItemId,
      claim: Claim,
    ) {
      const { target, number } = yield* resolveIssue(workspace, id);
      yield* client.addLabel(target, number, claimLabel);
      yield* Coordination.upsertCoordination(wireCodec, coordinationHost(target, number), {
        status: Coordination.claimStatusFor(claim),
        marker: Coordination.serializeClaim(wireCodec, claim),
      });
    }),
    release: Effect.fn("github.release")(function* (workspace: RegisteredWorkspace, id: WorkItemId) {
      const { target, number } = yield* resolveIssue(workspace, id);
      yield* client.removeLabel(target, number, claimLabel);
    }),
    recordAttempt: Effect.fn("github.recordAttempt")(function* (
      workspace: RegisteredWorkspace,
      id: WorkItemId,
      attempt: AttemptRecord,
      reason?: string,
    ) {
      const { target, number } = yield* resolveIssue(workspace, id);
      yield* Coordination.upsertCoordination(wireCodec, coordinationHost(target, number), {
        status: Coordination.attemptStatus(attempt, reason),
        marker: Coordination.serializeAttempt(wireCodec, attempt),
      });
    }),
    recordFollowUp: Effect.fn("github.recordFollowUp")(function* (
      workspace: RegisteredWorkspace,
      id: WorkItemId,
      marker: FollowUpMarker,
      detail?: string,
    ) {
      const { target, number } = yield* resolveIssue(workspace, id);
      yield* Coordination.upsertCoordination(wireCodec, coordinationHost(target, number), {
        marker: Coordination.serializeFollowUp(wireCodec, marker),
        detail,
      });
    }),
    note: Effect.fn("github.note")(function* (
      workspace: RegisteredWorkspace,
      id: WorkItemId,
      detail: string,
    ) {
      const { target, number } = yield* resolveIssue(workspace, id);
      yield* Coordination.postNote(wireCodec, coordinationHost(target, number), detail);
    }),
    setRoles: Effect.fn("github.setRoles")(function* (
      workspace: RegisteredWorkspace,
      id: WorkItemId,
      changes: RoleChanges,
    ) {
      const { target, number } = yield* resolveIssue(workspace, id);
      yield* Effect.forEach(changes.remove, (role) => client.removeLabel(target, number, roleLabel(role)));
      yield* Effect.forEach(changes.add, (role) => client.addLabel(target, number, roleLabel(role)));
    }),
  };
};

export const layer = Layer.effect(
  IssueTracker,
  Effect.gen(function* () {
    const client = yield* GitHubClient;
    return make(client);
  }),
);

export { make as makeAdapter };
