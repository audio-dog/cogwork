import type {
  Board,
  Connection,
  ControlStore,
  DaemonLimitUpdate,
  WorkspaceId,
  WorkspaceRegistration,
  WorkspaceState,
} from "@cogwork/contracts";
import { useAtom } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { createContext, type ReactNode, use, useState } from "react";
import { deregisterWorkspaceAtom, rebindWorkspaceAtom, registerWorkspaceAtom } from "../daemon/atoms";
import { BoardResult, useBoard } from "../features/activity-session";
import { readyConnections } from "../features/connections-view";
import { useDaemonLimit } from "../features/use-daemon-limit";

type WorkspacesStatus = "loading" | "offline" | "ready";
type WorkspaceBoardState = { readonly status: WorkspacesStatus; readonly picture: Board | null };

interface WorkspacesStateValue {
  readonly status: WorkspacesStatus;
  readonly workspaces: readonly WorkspaceState[];
  readonly controlStore: ControlStore | null;
  readonly connections: readonly Connection[];
}

interface WorkspacesActions {
  readonly register: (registration: WorkspaceRegistration) => void;
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
  result._tag === "Failure" && result.cause ? Cause.pretty(result.cause) : null;

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
  const [deregisterResult, runDeregister] = useAtom(deregisterWorkspaceAtom);
  const [rebindTarget, setRebindTarget] = useState<WorkspaceId | null>(null);
  const [deregisterTarget, setDeregisterTarget] = useState<WorkspaceId | null>(null);
  const { status, picture } = BoardResult.$match(board, {
    Initial: (): WorkspaceBoardState => ({ status: "loading", picture: null }),
    Failure: (): WorkspaceBoardState => ({ status: "offline", picture: null }),
    Success: ({ board }): WorkspaceBoardState => ({ status: "ready", picture: board }),
  });
  const limits = useDaemonLimit(picture?.controlStore ?? null);
  const workspaces = picture ? [...picture.workspaces.values()] : [];
  const connections = readyConnections(picture?.connections);

  const actions: WorkspacesActions = {
    register: (registration) => runRegister({ payload: { registration } }),
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
          connections,
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
