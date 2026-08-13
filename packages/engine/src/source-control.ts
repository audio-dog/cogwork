import type { WorkItemId } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ObservedPr } from "./follow-up";
import type { IssueTrackerError } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";

// Everything the provider can learn about a pull request by reading it. The follow-up marker is the
// tracker's coordination state, not the PR's, so it is attached during composition rather than here.
export type PrSignals = Omit<ObservedPr, "followUp">;

// The title is here, not just the id, because the exact-branch tie-break needs the full
// `branchName(item)` and not only its `ticketSlug` prefix.
export interface OwnedItem {
  readonly id: WorkItemId;
  readonly title: string;
}

export interface SourceControlProviderService {
  // Given the items the tracker considers daemon-owned, resolve each one's pull request and report
  // its state. Returns signals only for the owned items whose PR passes the trusted-author gate.
  readonly observe: (
    workspace: RegisteredWorkspace,
    owned: ReadonlyArray<OwnedItem>,
  ) => Effect.Effect<ReadonlyMap<WorkItemId, PrSignals>, IssueTrackerError>;
}

export class SourceControlProvider extends Context.Service<
  SourceControlProvider,
  SourceControlProviderService
>()("@cogwork/engine/source-control/SourceControlProvider") {}

const noProvider: SourceControlProviderService = {
  observe: () => Effect.succeed(new Map()),
};

// The binding for a workspace with no source control provider — a Linear tracker with no
// `sourceControl` block. It reports no pull request for any item.
export const emptyLayer = Layer.succeed(SourceControlProvider, noProvider);
