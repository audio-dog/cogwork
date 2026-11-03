import {
  type Connection,
  type ControlStore,
  type HarnessReadiness,
  type WorkspaceId,
  WorkspaceState,
} from "@cogwork/contracts";
import { Alert, AlertDescription, AlertTitle } from "@cogwork/ui/components/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@cogwork/ui/components/alert-dialog";
import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@cogwork/ui/components/item";
import { Spinner } from "@cogwork/ui/components/spinner";
import { cn } from "@cogwork/ui/lib/utils";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { RiAlertLine, RiDeleteBinLine, RiGitRepositoryLine } from "@remixicon/react";
import { useState } from "react";
import { harnessCatalogsAtom, harnessReadinessAtom, setOperationSettingAtom } from "../daemon/atoms";
import { BoardResult, useBoard } from "../features/activity-session";
import { workspaceConnectionChoices } from "../features/connections-view";
import { daemonFailureMessage } from "../features/daemon-failure";
import {
  type AvailableHarnessCatalog,
  harnessCatalogLoad,
  operationSettingBatch,
} from "../features/operation-settings";
import {
  changedFieldCount,
  draftAfterSubmission,
  emptyDraft,
  seededDraft,
  type WorkspaceHealth,
  type WorkspaceRecordDraft,
  workspaceHealth,
  workspaceIdentity,
  workspaceKey,
  workspaceLabel,
  workspaceRecordDraftError,
  workspaceRecordWritable,
  workspaceUpdateFromDraft,
} from "../features/workspace-record";
import { absoluteCheckoutPathFrom } from "../features/workspace-registration";
import { OperationSettings } from "./operation-settings";
import { SettingsSection, SubSectionCard } from "./settings-parts";
import { type PatchDraft, WorkspaceRecord } from "./workspace-setting-rows";
import { useWorkspaces } from "./workspaces-provider";

interface WorkspaceSettings {
  readonly status: "loading" | "offline" | "ready" | "unknown";
  readonly workspace: WorkspaceState | null;
  readonly label: string;
  readonly draft: WorkspaceRecordDraft;
  readonly changes: number;
  readonly controlStore: ControlStore | null;
  readonly connections: readonly Connection[];
  readonly workspaceId: WorkspaceId | null;
  readonly writable: boolean;
  readonly recordWritable: boolean;
  readonly health: WorkspaceHealth | null;
  readonly inFlight: number | null;
  readonly limit: number | null;
  readonly saving: boolean;
  readonly saveError: string | null;
  readonly patch: PatchDraft;
  readonly save: () => void;
  readonly discard: () => void;
}

interface WorkspaceDraftEdits {
  readonly workspace: string;
  readonly draft: WorkspaceRecordDraft;
}

const draftError = (pathRefused: boolean, recordRefused: boolean, draft: WorkspaceRecordDraft) => {
  if (pathRefused) return "Use an absolute path.";
  if (recordRefused) return workspaceRecordDraftError(draft);
  return null;
};

/**
 * One workspace's draft: edits over the saved value over the seeded record. Nothing is
 * seeded by an effect — the draft is derived at render, so a live daemon change reaches
 * every field nobody has touched.
 */
function useWorkspaceSettings(workspaceId: string): WorkspaceSettings {
  const {
    state: { status, workspaces, controlStore, connectionOverview },
    actions: { rebind, update },
    meta: { rebindPending, rebindError, rebindTarget, updatePending, updateError, updateTarget },
  } = useWorkspaces();
  const board = useBoard();
  const picture = BoardResult.$is("Success")(board) ? board.board : null;
  const scheduler = picture?.scheduler ?? null;
  const dangling = picture?.connectionNotices ?? [];

  const [edits, setEdits] = useState<WorkspaceDraftEdits | null>(null);
  const [pathRefused, setPathRefused] = useState(false);
  const [recordRefused, setRecordRefused] = useState(false);
  const [submitted, setSubmitted] = useState({ update: false, rebind: false });

  const workspace = workspaces.find((candidate) => workspaceKey(candidate) === workspaceId) ?? null;
  const baseline = workspace ? seededDraft(workspace) : null;
  const load = scheduler?.perWorkspace.find((entry) => entry.name === workspaceId) ?? null;
  // A Failed workspace input may hold no minted id, and then no act can target it.
  const identity = workspace ? workspaceIdentity(workspace) : null;
  const recordWritable = workspace ? workspaceRecordWritable(workspace) : false;
  const editWorkspace = workspace ? `${workspaceKey(workspace)}:${workspace._tag}` : null;
  const activeEdits = edits?.workspace === editWorkspace ? edits.draft : null;
  const setDraft = (draft: WorkspaceRecordDraft | null) =>
    setEdits(draft && editWorkspace ? { workspace: editWorkspace, draft } : null);

  // The daemon has caught up, so the draft is no longer an edit.
  if (activeEdits && baseline && changedFieldCount(activeEdits, baseline) === 0) {
    setDraft(null);
    setSubmitted({ update: false, rebind: false });
  }
  const draft = activeEdits ?? baseline;
  const connections = workspaceConnectionChoices(connectionOverview, [
    draft?.issueTrackerConnectionId ?? "unbound",
    draft?.sourceControlConnectionId ?? "unbound",
  ]);
  const submittedUpdateError = submitted.update && updateTarget === identity ? updateError : null;
  const submittedRebindError = submitted.rebind && rebindTarget === identity ? rebindError : null;

  return {
    status: status === "ready" && !workspace ? "unknown" : status,
    workspace,
    label: workspace ? workspaceLabel(workspace) : workspaceId,
    draft: draft ?? emptyDraft,
    changes: draft && baseline ? changedFieldCount(draft, baseline) : 0,
    controlStore,
    connections,
    workspaceId: identity,
    writable: identity !== null,
    recordWritable,
    health: workspace
      ? workspaceHealth(
          workspace,
          dangling.some((entry) => entry === workspaceId),
        )
      : null,
    inFlight: load?.inFlight ?? null,
    limit: load?.limit ?? null,
    patch: (next) => {
      setPathRefused(false);
      setRecordRefused(false);
      setSubmitted({ update: false, rebind: false });
      setDraft({ ...(activeEdits ?? baseline ?? emptyDraft), ...next });
    },
    saving: (rebindPending && rebindTarget === identity) || (updatePending && updateTarget === identity),
    // The provider keeps a failure until the next act, so only this page's own submit shows it.
    saveError:
      draftError(pathRefused, recordRefused, draft ?? emptyDraft) ??
      submittedUpdateError ??
      submittedRebindError,
    save: () => {
      if (!activeEdits || !baseline || !identity) {
        setDraft(null);
        return;
      }
      const pathChanged = activeEdits.checkoutPath !== baseline.checkoutPath;
      const recordChanged =
        recordWritable &&
        changedFieldCount({ ...activeEdits, checkoutPath: baseline.checkoutPath }, baseline) > 0;
      const checkoutPath = pathChanged
        ? absoluteCheckoutPathFrom(activeEdits.checkoutPath)
        : baseline.checkoutPath;
      const workspaceUpdate = recordChanged ? workspaceUpdateFromDraft(activeEdits) : null;
      setPathRefused(checkoutPath === null);
      setRecordRefused(recordChanged && workspaceUpdate === null);
      if (!checkoutPath || (recordChanged && !workspaceUpdate)) return;
      setDraft(draftAfterSubmission(activeEdits, checkoutPath, workspaceUpdate));
      setSubmitted({ update: recordChanged, rebind: pathChanged });
      if (recordChanged && workspaceUpdate) update(identity, workspaceUpdate);
      if (pathChanged) rebind(identity, checkoutPath);
    },
    discard: () => {
      setDraft(null);
      setPathRefused(false);
      setRecordRefused(false);
      setSubmitted({ update: false, rebind: false });
    },
  };
}

function LiveOperationSettings({
  controlStore,
  workspace,
  disabled,
}: {
  readonly controlStore: ControlStore | null;
  readonly workspace: WorkspaceId;
  readonly disabled: boolean;
}) {
  const boardResult = useBoard();
  const catalogResult = useAtomValue(harnessCatalogsAtom);
  const readinessResult = useAtomValue(harnessReadinessAtom);
  const catalogs = catalogResult._tag === "Success" ? catalogResult.value : null;
  const board = BoardResult.$is("Success")(boardResult) ? boardResult.board : null;
  const queriedReadiness = readinessResult._tag === "Success" ? readinessResult.value : null;
  const readiness = board?.harnesses ?? queriedReadiness;
  const load = harnessCatalogLoad(catalogs, catalogResult._tag === "Failure");

  if (load.status === "loading") {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        Loading Harness catalogs…
      </div>
    );
  }

  if (load.status === "failed") {
    return (
      <Alert variant="destructive">
        <RiAlertLine />
        <AlertTitle>Could not load Harness catalogs</AlertTitle>
        <AlertDescription>Workspace operation settings are unchanged.</AlertDescription>
      </Alert>
    );
  }

  return (
    <LoadedOperationSettings
      controlStore={controlStore}
      workspace={workspace}
      catalogs={load.catalogs}
      readiness={readiness}
      disabled={disabled}
    />
  );
}

function LoadedOperationSettings({
  controlStore,
  workspace,
  catalogs,
  readiness,
  disabled,
}: {
  readonly controlStore: ControlStore | null;
  readonly workspace: WorkspaceId;
  readonly catalogs: ReadonlyArray<AvailableHarnessCatalog>;
  readonly readiness: HarnessReadiness | null;
  readonly disabled: boolean;
}) {
  const [writeResult, write] = useAtom(setOperationSettingAtom(workspace));

  return (
    <OperationSettings.Provider
      value={{
        state: { catalogs, controlStore, readiness, workspace },
        actions: {
          write: (updates) => write({ payload: { updates: operationSettingBatch(workspace, updates) } }),
        },
        meta: { disabled },
      }}
    >
      <OperationSettings.Rows />
      {writeResult._tag === "Failure" && writeResult.cause ? (
        <Alert variant="destructive">
          <RiAlertLine />
          <AlertTitle>Could not save that setting</AlertTitle>
          <AlertDescription>{daemonFailureMessage(writeResult.cause)}</AlertDescription>
        </Alert>
      ) : null}
    </OperationSettings.Provider>
  );
}

function HealthDot({ tone }: { readonly tone: WorkspaceHealth["tone"] }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        tone === "ok" && "bg-emerald-500 shadow-[0_0_8px] shadow-emerald-500/60",
        tone === "failed" && "bg-destructive",
      )}
    />
  );
}

function PageHeader({ settings }: { readonly settings: WorkspaceSettings }) {
  return (
    <div className="flex flex-col gap-1">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <span>Workspaces</span>
        <span aria-hidden>/</span>
        <span className="text-foreground">{settings.label}</span>
      </nav>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {settings.health ? (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <HealthDot tone={settings.health.tone} />
            {settings.health.label}
          </span>
        ) : null}
        {settings.inFlight !== null && settings.limit !== null ? (
          <Badge variant={settings.inFlight > 0 ? "secondary" : "outline"} className="tabular-nums">
            {settings.inFlight} of {settings.limit} Runs in flight
          </Badge>
        ) : null}
        {settings.workspace && WorkspaceState.guards.Registered(settings.workspace) ? (
          <Badge variant="outline" className="font-mono">
            {settings.workspace.name}
          </Badge>
        ) : null}
      </div>
    </div>
  );
}

function HealthAlert({ health }: { readonly health: WorkspaceHealth | null }) {
  if (!health || health.tone === "ok") return null;
  return (
    <Alert variant="destructive">
      <RiAlertLine />
      <AlertTitle>{health.label}</AlertTitle>
      <AlertDescription>{health.detail}</AlertDescription>
    </Alert>
  );
}

function SaveBar({ settings }: { readonly settings: WorkspaceSettings }) {
  if (settings.changes === 0) return null;
  return (
    <div className="sticky bottom-4 z-10 flex items-center gap-3 rounded-lg border border-border bg-background/95 px-4 py-3 shadow-lg backdrop-blur">
      <span className={cn("text-xs", settings.saveError ? "text-destructive" : "text-muted-foreground")}>
        {settings.saveError ??
          (settings.changes === 1 ? "1 unsaved change" : `${settings.changes} unsaved changes`)}
      </span>
      <div className="ml-auto flex gap-2">
        <Button variant="ghost" size="sm" disabled={settings.saving} onClick={settings.discard}>
          Discard changes
        </Button>
        <Button size="sm" disabled={settings.saving} onClick={settings.save}>
          {settings.saving ? <Spinner data-icon="inline-start" /> : null}
          Save changes
        </Button>
      </div>
    </div>
  );
}

function DeregisterRow({ label, workspace }: { readonly label: string; readonly workspace: WorkspaceId }) {
  const {
    actions: { deregister },
    meta: { deregisterPending, deregisterError, deregisterTarget },
  } = useWorkspaces();
  const targeted = deregisterTarget === workspace;
  return (
    <Item className="rounded-lg">
      <ItemContent>
        <ItemTitle>Deregister this workspace</ItemTitle>
        <ItemDescription>
          Cogwork stops operating over this repository. Its Run history stays.
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <AlertDialog>
          <AlertDialogTrigger render={<Button size="sm" variant="outline" disabled={deregisterPending} />}>
            <RiDeleteBinLine data-icon="inline-start" />
            Deregister
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Deregister {label}?</AlertDialogTitle>
              <AlertDialogDescription>
                You lose its private settings and its Authoring tree. A Run already in flight can finish, but
                this workspace takes no new work. Its Run history stays.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {targeted && deregisterError ? (
              <Alert variant="destructive">
                <RiAlertLine />
                <AlertTitle>Deregistering failed</AlertTitle>
                <AlertDescription>{deregisterError}</AlertDescription>
              </Alert>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel>Keep it</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={deregisterPending}
                onClick={() => deregister(workspace)}
              >
                {targeted && deregisterPending ? <Spinner data-icon="inline-start" /> : null}
                Deregister
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </ItemActions>
    </Item>
  );
}

function StatusState({ status }: { readonly status: "loading" | "offline" | "unknown" }) {
  if (status === "loading") {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Spinner />
          </EmptyMedia>
          <EmptyTitle>Loading this workspace</EmptyTitle>
          <EmptyDescription>Waiting for the daemon.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (status === "offline") {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <RiAlertLine />
          </EmptyMedia>
          <EmptyTitle>Cannot reach the daemon</EmptyTitle>
          <EmptyDescription>Reconnect to read and change these settings.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <RiGitRepositoryLine />
        </EmptyMedia>
        <EmptyTitle>This workspace is not registered</EmptyTitle>
        <EmptyDescription>It may have been deregistered. Choose another from the sidebar.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function WorkspaceSettingsPage({ workspaceId }: { readonly workspaceId: string }) {
  const settings = useWorkspaceSettings(workspaceId);

  if (settings.status !== "ready") {
    return (
      <main className="mx-auto w-full max-w-3xl px-8 pt-6">
        <StatusState status={settings.status} />
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-8 pt-6 pb-12">
      <PageHeader settings={settings} />
      <HealthAlert health={settings.health} />
      <SettingsSection title={settings.label}>
        {settings.writable ? null : (
          <Alert>
            <RiAlertLine />
            <AlertTitle>Nothing here can be changed</AlertTitle>
            <AlertDescription>
              Cogwork never read this workspace input, so it has no identity for a setting to belong to. Fix
              what the message above reports, then register it.
            </AlertDescription>
          </Alert>
        )}
        <WorkspaceRecord.Provider
          value={{
            state: { draft: settings.draft, connections: settings.connections },
            actions: { patch: settings.patch },
            meta: { disabled: settings.saving || !settings.writable, workspace: settings.workspaceId },
          }}
        >
          <SubSectionCard label="Checkout">
            <WorkspaceRecord.CheckoutRows />
          </SubSectionCard>
        </WorkspaceRecord.Provider>
        <WorkspaceRecord.Provider
          value={{
            state: { draft: settings.draft, connections: settings.connections },
            actions: { patch: settings.patch },
            meta: {
              disabled: settings.saving || !settings.recordWritable,
              workspace: settings.workspaceId,
            },
          }}
        >
          <SubSectionCard label="Workspace">
            <WorkspaceRecord.IdentityRows />
          </SubSectionCard>
          <SubSectionCard label="Issue tracker">
            <WorkspaceRecord.IssueTrackerRows />
          </SubSectionCard>
          <SubSectionCard label="Triage and ownership">
            <WorkspaceRecord.TriageRows />
          </SubSectionCard>
          <SubSectionCard label="Source control">
            <WorkspaceRecord.SourceControlRows />
          </SubSectionCard>
          <SubSectionCard label="Worktrees">
            <WorkspaceRecord.WorktreeRows />
          </SubSectionCard>
          <SubSectionCard label="Runs">
            <WorkspaceRecord.RunRows />
          </SubSectionCard>
        </WorkspaceRecord.Provider>
        {settings.workspaceId ? (
          <>
            {/* Operations sits second: which model runs the work matters more than the rest. */}
            <SubSectionCard label="Operations">
              <LiveOperationSettings
                controlStore={settings.controlStore}
                workspace={settings.workspaceId}
                disabled={settings.saving}
              />
            </SubSectionCard>
            <SubSectionCard label="Registration">
              <DeregisterRow label={settings.label} workspace={settings.workspaceId} />
            </SubSectionCard>
          </>
        ) : null}
      </SettingsSection>
      <SaveBar settings={settings} />
    </main>
  );
}
