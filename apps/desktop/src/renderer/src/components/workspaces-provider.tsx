import type {
  ConnectionOverview,
  ControlStore,
  DaemonLimitUpdate,
  WorkspaceId,
  WorkspaceRegistration,
  WorkspaceState,
  WorkspaceUpdate,
} from "@cogwork/contracts";
import { useAtom } from "@effect/atom-react";
import type * as Cause from "effect/Cause";
import { createContext, type ReactNode, use, useState } from "react";
import {
  deregisterWorkspaceAtom,
  rebindWorkspaceAtom,
  registerWorkspaceAtom,
  updateWorkspaceAtom,
} from "../daemon/atoms";
import { BoardResult, useBoard } from "../features/activity-session";
import { daemonFailureMessage } from "../features/daemon-failure";
import { useDaemonLimit } from "../features/use-daemon-limit";

type WorkspacesStatus = "loading" | "offline" | "ready";

interface WorkspacesStateValue {
  readonly status: WorkspacesStatus;
  readonly workspaces: readonly WorkspaceState[];
  readonly controlStore: ControlStore | null;
  readonly connectionOverview: ConnectionOverview | null;
}

interface WorkspacesActions {
  readonly register: (registration: WorkspaceRegistration) => void;
  readonly update: (workspace: WorkspaceId, update: WorkspaceUpdate) => void;
  readonly rebind: (workspace: WorkspaceId, checkoutPath: string) => void;
  readonly deregister: (workspace: WorkspaceId) => void;
  readonly setLimit: (update: DaemonLimitUpdate) => void;
}

interface WorkspacesMeta {
  readonly registerPending: boolean;
  readonly registerError: string | null;
  readonly registerOutcome: WorkspaceState | null;
  readonly rebindPending: boolean;
  readonly rebindError: string | null;
  readonly rebindOutcome: WorkspaceState | null;
  readonly rebindTarget: WorkspaceId | null;
  readonly updatePending: boolean;
  readonly updateError: string | null;
  readonly updateTarget: WorkspaceId | null;
  readonly deregisterPending: boolean;
  readonly deregisterError: string | null;
  readonly deregisterTarget: WorkspaceId | null;
  readonly limitPending: boolean;
  readonly limitError: string | null;
}

export interface WorkspacesValue {
  readonly state: WorkspacesStateValue;
  readonly actions: WorkspacesActions;
  readonly meta: WorkspacesMeta;
}

const WorkspacesContext = createContext<WorkspacesValue | null>(null);

const resultError = (result: { readonly _tag: string; readonly cause?: Cause.Cause<unknown> }) =>
  result._tag === "Failure" && result.cause ? daemonFailureMessage(result.cause) : null;

const resultValue = <T,>(result: { readonly _tag: string; readonly value?: T }) =>
  result._tag === "Success" ? (result.value ?? null) : null;

export function useWorkspaces() {
  const value = use(WorkspacesContext);
  if (!value) throw new Error("Workspaces readers must render inside a Workspaces provider");
  return value;
}

export function WorkspacesProvider({ value, children }: { value: WorkspacesValue; children: ReactNode }) {
  return <WorkspacesContext value={value}>{children}</WorkspacesContext>;
}

export function LiveWorkspacesProvider({ children }: { children: ReactNode }) {
  const board = useBoard();
  const [registerResult, runRegister] = useAtom(registerWorkspaceAtom);
  const [rebindResult, runRebind] = useAtom(rebindWorkspaceAtom);
  const [updateResult, runUpdate] = useAtom(updateWorkspaceAtom);
  const [deregisterResult, runDeregister] = useAtom(deregisterWorkspaceAtom);
  const [rebindTarget, setRebindTarget] = useState<WorkspaceId | null>(null);
  const [updateTarget, setUpdateTarget] = useState<WorkspaceId | null>(null);
  const [deregisterTarget, setDeregisterTarget] = useState<WorkspaceId | null>(null);
  const status = BoardResult.$match(board, {
    Initial: (): WorkspacesStatus => "loading",
    Failure: (): WorkspacesStatus => "offline",
    Success: (): WorkspacesStatus => "ready",
  });
  const picture = BoardResult.$is("Success")(board) ? board.board : null;
  const limits = useDaemonLimit(picture?.controlStore ?? null);
  const workspaces = picture ? [...picture.workspaces.values()] : [];

  const actions: WorkspacesActions = {
    register: (registration) => runRegister({ payload: { registration } }),
    update: (workspace, update) => {
      setUpdateTarget(workspace);
      runUpdate({ payload: { workspace, update } });
    },
    rebind: (workspace, checkoutPath) => {
      setRebindTarget(workspace);
      runRebind({ payload: { workspace, checkoutPath } });
    },
    deregister: (workspace) => {
      setDeregisterTarget(workspace);
      runDeregister({ payload: { workspace } });
    },
    setLimit: limits.setLimit,
  };

  return (
    <WorkspacesProvider
      value={{
        state: {
          status,
          workspaces,
          controlStore: limits.controlStore,
          connectionOverview: picture?.connections ?? null,
        },
        actions,
        meta: {
          registerPending: registerResult.waiting,
          registerError: resultError(registerResult),
          registerOutcome: resultValue(registerResult),
          rebindPending: rebindResult.waiting,
          rebindError: resultError(rebindResult),
          rebindOutcome: resultValue(rebindResult),
          rebindTarget,
          updatePending: updateResult.waiting,
          updateError: resultError(updateResult),
          updateTarget,
          deregisterPending: deregisterResult.waiting,
          deregisterError: resultError(deregisterResult),
          deregisterTarget,
          limitPending: limits.result.waiting,
          limitError: resultError(limits.result),
        },
      }}
    >
      {children}
    </WorkspacesProvider>
  );
}
