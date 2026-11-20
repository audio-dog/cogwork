import type { GitHubPriorityField } from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { IssueTrackerError } from "../issue-tracker";
import type {
  GitHubIssueCreateInput,
  GitHubRepoRef,
  RawIssue,
  RawIssueComment,
  RawIssueEvent,
} from "./client";
import {
  continuedIssueFieldValueState,
  decodeIssueFieldValuePages,
  decodeIssueFieldValues,
  type IssueFieldValueState,
  issueFieldValuePagesQuery,
  issueFieldValuePageVariables,
  issueFieldValueState,
  issueFieldValuesByIssue,
  issueFieldValuesQuery,
} from "./client-graphql";
import {
  decodeIssue,
  decodeIssueFields,
  decodeSearchIssues,
  GitHubLabelsSchema,
  GitHubUsersSchema,
  IssueEventSchema,
  labelName,
  millisFromIso,
  parseIssueComments,
  parseIssues,
  toRawIssue,
} from "./client-responses";
import {
  acceptResponse,
  type GitHubTransport,
  isoMillis,
  repoPath,
  toUnavailable,
  unavailable,
  withPaginationDeadline,
  withTransientRetry,
} from "./client-transport";

const toAcceptedWriteError = (error: IssueTrackerError) =>
  new IssueTrackerError({
    reason: error.reason,
    message: error.message,
    writeMayHaveCommitted: true,
    ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
    ...(error.retryAfterMillis === undefined ? {} : { retryAfterMillis: error.retryAfterMillis }),
    ...(error.connectionId === undefined ? {} : { connectionId: error.connectionId }),
  });

const priorityFieldReadError = (repo: GitHubRepoRef, error: IssueTrackerError) =>
  new IssueTrackerError({
    reason: error.reason,
    message: `Could not load GitHub issue fields for ${repo.owner}. Grant read:org or Issue Fields read permission. ${error.message}`,
    ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
    ...(error.retryAfterMillis === undefined ? {} : { retryAfterMillis: error.retryAfterMillis }),
    ...(error.connectionId === undefined ? {} : { connectionId: error.connectionId }),
  });

const pageSize = 100;
const workContextCommentLimit = 10_000;
const workContextCommentByteLimit = 16 * 1024 * 1024;

const issueCommentBytes = (comment: RawIssueComment) =>
  Buffer.byteLength(comment.body) +
  Buffer.byteLength(comment.authorLogin ?? "") +
  Buffer.byteLength(comment.authorAssociation);

const orgPath = (repo: GitHubRepoRef, suffix: string) => `https://api.github.com/orgs/${repo.owner}${suffix}`;

export const makeIssueClient = (transport: GitHubTransport) => {
  const {
    fetchJson,
    fetchUncachedJsonResponse,
    graphql,
    linkedPageNumber,
    send,
    sendAcceptedJsonOnce,
    sendAcceptedOnce,
    sendJson,
  } = transport;

  const issueCommentPagePath = Effect.fn("github.issueCommentPagePath")(function* (
    repo: GitHubRepoRef,
    issueNumber: number,
    header: string | undefined,
  ) {
    const expectedPath = `/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/comments`;
    const canonicalPath = new RegExp(`^/repositories/[1-9]\\d*/issues/${issueNumber}/comments$`);
    const page = yield* linkedPageNumber(header, expectedPath, canonicalPath, "issue comment");
    return page === null ? null : repoPath(repo, `/issues/${issueNumber}/comments?per_page=100&page=${page}`);
  });

  interface IssueCommentPages {
    readonly pages: ReadonlyArray<ReadonlyArray<RawIssueComment>>;
    readonly visited: ReadonlySet<string>;
    readonly commentCount: number;
    readonly commentBytes: number;
  }

  const collectIssueCommentPages: (
    repo: GitHubRepoRef,
    issueNumber: number,
    path: string,
    enforceAdmissionLimit: boolean,
    state?: IssueCommentPages,
  ) => Effect.Effect<ReadonlyArray<RawIssueComment>, IssueTrackerError> = Effect.fn(
    "github.collectIssueCommentPages",
  )(function* (
    repo,
    issueNumber,
    path,
    enforceAdmissionLimit,
    state = { pages: [], visited: new Set(), commentCount: 0, commentBytes: 0 },
  ) {
    if (state.visited.has(path)) {
      return yield* unavailable("GitHub issue comment pagination returned a repeated next link");
    }
    const response = yield* fetchUncachedJsonResponse(repo, path);
    const nextPath = yield* issueCommentPagePath(repo, issueNumber, response.nextLink ?? undefined);
    const comments = yield* parseIssueComments(response.body);
    const commentCount = state.commentCount + comments.length;
    const commentBytes =
      state.commentBytes + comments.reduce((total, comment) => total + issueCommentBytes(comment), 0);
    const withinAdmissionLimit =
      commentCount <= workContextCommentLimit && commentBytes <= workContextCommentByteLimit;
    if (enforceAdmissionLimit && !withinAdmissionLimit) {
      return yield* new IssueTrackerError({
        reason: "unavailable",
        retryable: false,
        message: `GitHub issue thread exceeds admission limits (${workContextCommentLimit} comments or ${workContextCommentByteLimit} bytes)`,
      });
    }
    const nextState = {
      pages: [...state.pages, comments],
      visited: new Set(state.visited).add(path),
      commentCount,
      commentBytes,
    };
    if (nextPath === null) return nextState.pages.flat();
    return yield* collectIssueCommentPages(repo, issueNumber, nextPath, enforceAdmissionLimit, nextState);
  });

  const addLabel = Effect.fn("github.addLabel")((repo: GitHubRepoRef, issueNumber: number, label: string) =>
    sendJson(repo, HttpClientRequest.post(repoPath(repo, `/issues/${issueNumber}/labels`)), {
      labels: [label],
    }),
  );

  const createIssue = Effect.fn("github.createIssue")(function* (
    repo: GitHubRepoRef,
    input: GitHubIssueCreateInput,
  ) {
    const acceptedBody = yield* sendAcceptedJsonOnce(
      repo,
      HttpClientRequest.post(repoPath(repo, "/issues")),
      {
        title: input.title,
        body: input.body,
        labels: input.labels,
      },
    );
    if (Option.isNone(acceptedBody)) {
      return yield* unavailable("GitHub accepted issue creation but its response was unavailable", true);
    }
    return yield* Effect.gen(function* () {
      const created = yield* Effect.mapError(decodeIssue(acceptedBody.value), toUnavailable);
      const applied = new Set(created.labels.map(labelName));
      yield* Effect.forEach(
        input.labels.filter((label) => !applied.has(label)),
        (label) => addLabel(repo, created.number, label),
      );
      return toRawIssue(repo, created);
    }).pipe(Effect.mapError(toAcceptedWriteError));
  });

  const createComment = Effect.fn("github.createComment")(function* (
    repo: GitHubRepoRef,
    issueNumber: number,
    body: string,
  ) {
    yield* sendAcceptedOnce(repo, HttpClientRequest.post(repoPath(repo, `/issues/${issueNumber}/comments`)), {
      body,
    });
  });

  const listUserLogins = (repo: GitHubRepoRef, pathFor: (page: number) => string) => {
    const collect: (page?: number) => Effect.Effect<ReadonlyArray<string>, IssueTrackerError> = Effect.fn(
      "github.collectUserPages",
    )(function* (page = 1) {
      const json = yield* fetchJson(repo, repoPath(repo, pathFor(page)));
      const users = yield* Effect.mapError(
        Schema.decodeUnknownEffect(GitHubUsersSchema)(json),
        toUnavailable,
      );
      const current = users.map(({ login }) => login);
      if (current.length < 100) return current;
      return [...current, ...(yield* collect(page + 1))];
    });
    return withPaginationDeadline(collect());
  };

  const listCollaborators = Effect.fn("github.listCollaborators")(function* (repo: GitHubRepoRef) {
    return yield* listUserLogins(repo, (page) => `/collaborators?affiliation=all&per_page=100&page=${page}`);
  });

  const listAssignees = Effect.fn("github.listAssignees")(function* (repo: GitHubRepoRef) {
    return yield* listUserLogins(repo, (page) => `/assignees?per_page=100&page=${page}`);
  });

  const listLabels = Effect.fn("github.listLabels")(function* (repo: GitHubRepoRef) {
    const collect: (page?: number) => Effect.Effect<ReadonlyArray<string>, IssueTrackerError> = Effect.fn(
      "github.collectLabelPages",
    )(function* (page = 1) {
      const json = yield* fetchJson(repo, repoPath(repo, `/labels?per_page=100&page=${page}`));
      const labels = yield* Effect.mapError(
        Schema.decodeUnknownEffect(GitHubLabelsSchema)(json),
        toUnavailable,
      );
      const current = labels.map(({ name }) => name);
      if (current.length < 100) return current;
      return [...current, ...(yield* collect(page + 1))];
    });
    return yield* withPaginationDeadline(collect());
  });

  const createPerformanceComment = Effect.fn("github.createPerformanceComment")(function* (
    repo: GitHubRepoRef,
    issueNumber: number,
    body: string,
  ) {
    yield* createComment(repo, issueNumber, body).pipe(
      Effect.catchIf(
        (error) => error.writeMayHaveCommitted !== false,
        () => Effect.void,
      ),
    );
  });

  interface IssueQuery {
    readonly state: "open" | "all";
    readonly label?: string;
    readonly since?: number;
  }

  const issuePagePath = (query: IssueQuery, page: number) => {
    const parameters = new URLSearchParams({
      state: query.state,
      per_page: String(pageSize),
      page: String(page),
    });
    if (query.label) parameters.set("labels", query.label);
    if (query.since !== undefined) {
      parameters.set("sort", "updated");
      parameters.set("direction", "asc");
      parameters.set("since", isoMillis(query.since));
    }
    return `/issues?${parameters}`;
  };

  const collectIssueFieldValuePages: (
    repo: GitHubRepoRef,
    states: ReadonlyArray<IssueFieldValueState>,
  ) => Effect.Effect<ReadonlyArray<IssueFieldValueState>, IssueTrackerError> = Effect.fn(
    "github.collectIssueFieldValuePages",
  )(function* (repo, states) {
    const pending = states.filter((state) => state.cursor !== null);
    if (pending.length === 0) return states;
    const data = yield* graphql(
      repo,
      issueFieldValuePagesQuery(pending.length),
      issueFieldValuePageVariables(pending),
    );
    const payload = yield* Effect.mapError(decodeIssueFieldValuePages(data), toUnavailable);
    const continued = pending.map((state, index) =>
      continuedIssueFieldValueState(state, payload[`issue${index}`]),
    );
    const continuedById = new Map(continued.map((state) => [state.nodeId, state] as const));
    return yield* collectIssueFieldValuePages(
      repo,
      states.map((state) => continuedById.get(state.nodeId) ?? state),
    );
  });

  const collectIssueFieldValues = Effect.fn("github.collectIssueFieldValues")(function* (
    repo: GitHubRepoRef,
    issueNodeIds: ReadonlyArray<string>,
  ) {
    const data = yield* graphql(repo, issueFieldValuesQuery, { ids: issueNodeIds });
    const payload = yield* Effect.mapError(decodeIssueFieldValues(data), toUnavailable);
    const states = payload.nodes.flatMap((issue) => (issue ? [issueFieldValueState(issue, new Map())] : []));
    const completed = yield* collectIssueFieldValuePages(repo, states);
    return issueFieldValuesByIssue(completed);
  });

  const collectIssuePages: (
    repo: GitHubRepoRef,
    query: IssueQuery,
    page?: number,
  ) => Effect.Effect<ReadonlyArray<RawIssue>, IssueTrackerError> = Effect.fn("github.collectIssuePages")(
    function* (repo, query, page = 1) {
      const json = yield* fetchJson(repo, repoPath(repo, issuePagePath(query, page)));
      const current = yield* parseIssues(repo, json);
      if (current.length < pageSize) return current;
      const remaining = yield* collectIssuePages(repo, query, page + 1);
      return [...current, ...remaining];
    },
  );

  return {
    listIssues: Effect.fn("github.listIssues")(function* (
      repo: GitHubRepoRef,
      query: IssueQuery = { state: "open" },
    ) {
      return yield* withPaginationDeadline(collectIssuePages(repo, query));
    }),
    readIssue: (repo: GitHubRepoRef, issueNumber: number) =>
      fetchJson(repo, repoPath(repo, `/issues/${issueNumber}`)).pipe(
        Effect.flatMap((json) => Effect.mapError(decodeIssue(json), toUnavailable)),
        Effect.map((issue) => toRawIssue(repo, issue)),
      ),
    findIssueWithMarker: Effect.fn("github.findIssueWithMarker")(function* (
      repo: GitHubRepoRef,
      marker: string,
    ) {
      const query = new URLSearchParams({
        q: `repo:${repo.owner}/${repo.name} is:issue in:body "${marker}"`,
        per_page: "100",
      });
      const { body: json } = yield* fetchUncachedJsonResponse(
        repo,
        `https://api.github.com/search/issues?${query}`,
      );
      const payload = yield* Effect.mapError(decodeSearchIssues(json), toUnavailable);
      const issue = payload.items.find(({ body }) => body?.includes(marker));
      return issue ? toRawIssue(repo, issue) : null;
    }),
    listIssueFieldValues: Effect.fn("github.listIssueFieldValues")(function* (
      repo: GitHubRepoRef,
      issueNodeIds: ReadonlyArray<string>,
    ) {
      if (issueNodeIds.length === 0) return new Map();
      return yield* withPaginationDeadline(collectIssueFieldValues(repo, issueNodeIds));
    }),
    listPriorityFields: Effect.fn("github.listPriorityFields")(function* (repo: GitHubRepoRef) {
      const json = yield* fetchJson(repo, orgPath(repo, "/issue-fields")).pipe(
        Effect.mapError((error) => priorityFieldReadError(repo, error)),
      );
      const fields = yield* Effect.mapError(decodeIssueFields(json), toUnavailable);
      return fields
        .filter((field) => field.data_type === "single_select")
        .map(({ id, name }) => ({ id, name }) satisfies GitHubPriorityField);
    }),
    listComments: Effect.fn("github.listComments")(function* (repo: GitHubRepoRef, issueNumber: number) {
      const json = yield* fetchJson(repo, repoPath(repo, `/issues/${issueNumber}/comments?per_page=100`));
      return yield* parseIssueComments(json);
    }),
    listIssueEvents: Effect.fn("github.listIssueEvents")(function* (
      repo: GitHubRepoRef,
      issueNumber: number,
    ) {
      const collect: (page?: number) => Effect.Effect<ReadonlyArray<RawIssueEvent>, IssueTrackerError> =
        Effect.fn("github.collectIssueEventPages")(function* (page = 1) {
          const json = yield* fetchJson(
            repo,
            repoPath(repo, `/issues/${issueNumber}/events?per_page=100&page=${page}`),
          );
          const decoded = yield* Effect.mapError(
            Schema.decodeUnknownEffect(Schema.Array(IssueEventSchema))(json),
            toUnavailable,
          );
          const current = decoded.map((event) => ({
            id: event.id,
            event: event.event,
            labelName: event.label?.name ?? null,
            createdAtMillis: millisFromIso(event.created_at),
          }));
          if (current.length < 100) return current;
          return [...current, ...(yield* collect(page + 1))];
        });
      return yield* withPaginationDeadline(collect());
    }),
    listAllComments: Effect.fn("github.listAllComments")(function* (
      repo: GitHubRepoRef,
      issueNumber: number,
    ) {
      return yield* withPaginationDeadline(
        collectIssueCommentPages(
          repo,
          issueNumber,
          repoPath(repo, `/issues/${issueNumber}/comments?per_page=100`),
          true,
        ),
      );
    }),
    listTriggerComments: Effect.fn("github.listTriggerComments")(function* (
      repo: GitHubRepoRef,
      issueNumber: number,
    ) {
      return yield* withPaginationDeadline(
        collectIssueCommentPages(
          repo,
          issueNumber,
          repoPath(repo, `/issues/${issueNumber}/comments?per_page=100`),
          false,
        ),
      );
    }),
    createIssue,
    addLabel,
    removeLabel: (repo: GitHubRepoRef, issueNumber: number, label: string) =>
      withTransientRetry(
        send(
          repo,
          HttpClientRequest.delete(
            repoPath(repo, `/issues/${issueNumber}/labels/${encodeURIComponent(label)}`),
          ),
          acceptResponse,
        ),
      ),
    closeIssue: (repo: GitHubRepoRef, issueNumber: number) =>
      sendAcceptedOnce(repo, HttpClientRequest.patch(repoPath(repo, `/issues/${issueNumber}`)), {
        state: "closed",
      }),
    createComment,
    listCollaborators,
    listAssignees,
    listLabels,
    createPerformanceComment,
    editComment: (repo: GitHubRepoRef, commentId: number, body: string) =>
      sendJson(repo, HttpClientRequest.patch(repoPath(repo, `/issues/comments/${commentId}`)), { body }),
  };
};
