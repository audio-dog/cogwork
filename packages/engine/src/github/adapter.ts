import { WorkItemId } from "@clanker-forge/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { RegisteredWorkspace } from "../projector";
import { type TrackerItem, WorkSource, WorkSourceError, type WorkSourceService } from "../work-source";
import {
  GitHubClient,
  type GitHubClientService,
  type GitHubRepoRef,
  type RawComment,
  type RawIssue,
} from "./client";
import {
  attemptStatus,
  claimLabel,
  claimStatus,
  coordinationDetail,
  coordinationMarkers,
  coordinationStatus,
  defaultStatus,
  formatCoordinationBody,
  formatNoteBody,
  hasClaimLabel,
  hasClankerMarker,
  hasLedgerMarker,
  parseAttempts,
  parseClaim,
  parseFollowUp,
  roleLabel,
  rolesFromLabels,
  serializeAttempt,
  serializeClaim,
  serializeFollowUp,
} from "./markers";

interface GitHubTarget extends GitHubRepoRef {
  readonly botLogin: string | null;
}

interface CoordinationUpdate {
  readonly status?: string;
  readonly marker?: string;
  readonly detail?: string | null;
}

const botLedger = (comments: ReadonlyArray<RawComment>, botLogin: string | null) =>
  comments.find((comment) => comment.authorLogin === botLogin && hasLedgerMarker(comment.body));

const nextDetail = (update: CoordinationUpdate, previous: string) => {
  if (!Object.hasOwn(update, "detail")) return coordinationDetail(previous);
  return update.detail ?? null;
};

const targetFor = (workspace: RegisteredWorkspace) => {
  const source = workspace.config.workSource;
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

const coordinationLast = (comments: ReadonlyArray<RawComment>) => [
  ...comments.filter((comment) => !hasLedgerMarker(comment.body)),
  ...comments.filter((comment) => hasLedgerMarker(comment.body)),
];

const decodeItemId = Schema.decodeUnknownEffect(WorkItemId);
const itemId = (issueNumber: number) => decodeItemId(`#${issueNumber}`).pipe(Effect.orDie);

const issueNumberOf = Effect.fn("github.issueNumberOf")(function* (id: string) {
  const parsed = Number.parseInt(id.replace(/^#/, ""), 10);
  if (Number.isNaN(parsed)) {
    return yield* new WorkSourceError({ reason: "unavailable", message: `unrecognized work item id ${id}` });
  }
  return parsed;
});

const notGitHub = (workspace: RegisteredWorkspace) =>
  new WorkSourceError({
    reason: "unavailable",
    message: `workspace ${workspace.config.name} is not a github work source`,
  });

const make = (client: GitHubClientService): WorkSourceService => {
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

  const upsertCoordination = Effect.fn("github.upsertCoordination")(function* (
    target: GitHubTarget,
    number: number,
    update: CoordinationUpdate,
  ) {
    const comments = yield* client.listComments(target, number);
    const ledger = botLedger(comments, target.botLogin);
    const previous = ledger?.body ?? "";
    const markers = coordinationMarkers(previous);
    const body = formatCoordinationBody({
      status: update.status ?? coordinationStatus(previous) ?? defaultStatus,
      markers: update.marker === undefined ? markers : [...markers, update.marker],
      detail: nextDetail(update, previous),
    });
    if (ledger) {
      yield* client.editComment(target, ledger.id, body);
      return;
    }
    yield* client.createComment(target, number, body);
  });

  const buildItem = (target: GitHubTarget) =>
    Effect.fn("github.buildItem")(function* (issue: RawIssue) {
      const claimLabeled = hasClaimLabel(issue.labels);
      const comments = target.botLogin ? yield* client.listComments(target, issue.number) : [];
      const trusted = coordinationLast(
        comments.filter((comment) => comment.authorLogin === target.botLogin),
      ).map((comment) => comment.body);
      const id = yield* itemId(issue.number);
      return {
        id,
        title: issue.title,
        roles: rolesFromLabels(issue.labels),
        claimLabeled,
        claim: claimLabeled ? parseClaim(trusted) : null,
        attempts: parseAttempts(trusted),
        owned: trusted.some(hasClankerMarker),
        followUp: parseFollowUp(trusted),
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
    observe: (workspace) =>
      Effect.gen(function* () {
        const target = targetFor(workspace);
        if (!target) {
          return [] as ReadonlyArray<TrackerItem>;
        }
        return yield* observeTarget(target);
      }),
    claim: (workspace, id, claim) =>
      Effect.gen(function* () {
        const { target, number } = yield* resolveIssue(workspace, id);
        yield* client.addLabel(target, number, claimLabel);
        const status = claim.stage ? claimStatus(claim.stage) : `In progress — claimed by ${claim.by}.`;
        yield* upsertCoordination(target, number, { status, marker: serializeClaim(claim) });
      }),
    release: (workspace, id) =>
      Effect.gen(function* () {
        const { target, number } = yield* resolveIssue(workspace, id);
        yield* client.removeLabel(target, number, claimLabel);
      }),
    recordAttempt: (workspace, id, attempt, reason) =>
      Effect.gen(function* () {
        const { target, number } = yield* resolveIssue(workspace, id);
        yield* upsertCoordination(target, number, {
          status: attemptStatus(attempt, reason),
          marker: serializeAttempt(attempt),
        });
      }),
    recordFollowUp: (workspace, id, marker, detail) =>
      Effect.gen(function* () {
        const { target, number } = yield* resolveIssue(workspace, id);
        yield* upsertCoordination(target, number, { marker: serializeFollowUp(marker), detail });
      }),
    note: (workspace, id, detail) =>
      Effect.gen(function* () {
        const { target, number } = yield* resolveIssue(workspace, id);
        const comments = yield* client.listComments(target, number);
        const ledger = botLedger(comments, target.botLogin);
        if (ledger && coordinationDetail(ledger.body) !== null) {
          yield* upsertCoordination(target, number, { detail: null });
        }
        yield* client.createComment(target, number, formatNoteBody(detail));
      }),
    setRoles: (workspace, id, changes) =>
      Effect.gen(function* () {
        const { target, number } = yield* resolveIssue(workspace, id);
        yield* Effect.forEach(changes.remove, (role) => client.removeLabel(target, number, roleLabel(role)));
        yield* Effect.forEach(changes.add, (role) => client.addLabel(target, number, roleLabel(role)));
      }),
  };
};

export const layer = Layer.effect(
  WorkSource,
  Effect.gen(function* () {
    const client = yield* GitHubClient;
    return make(client);
  }),
);

export { make as makeAdapter };
