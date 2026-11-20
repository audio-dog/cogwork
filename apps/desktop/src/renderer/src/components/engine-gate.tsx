import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@cogwork/ui/components/empty";
import { useTimeoutEffect } from "@react-hookz/web";
import { RiErrorWarningLine, RiFlashlightLine, RiRestartLine, RiShutDownLine } from "@remixicon/react";
import { createContext, type ReactNode, use, useState } from "react";

import { useBoard } from "../features/activity-session";
import { type BrokenReason, brokenReason, type Treatment, treatmentFor } from "../features/engine-gate";
import { type EnginePhase, enginePhase, useEngineStatus } from "../features/use-engine-status";

const OFF_TITLE = "Engine is off";
const OFF_BODY = "Turn the engine on to resume work.";
const TURN_ON_ACTION = "Turn on engine";
const RESTART_ACTION = "Restart engine";

const BROKEN_MESSAGE: Record<BrokenReason, string> = {
  "engine-failed": "The engine stopped unexpectedly.",
  "daemon-unreachable": "Can't reach the daemon.",
};

const CONNECTING_HINT_MS = 2000;

interface EngineGateActions {
  readonly setEnabled: (enabled: boolean) => void;
  readonly restart: () => void;
}

interface EngineGateContextValue {
  readonly treatment: Treatment;
  readonly phase: EnginePhase;
  readonly isRestarting: boolean;
  readonly actions: EngineGateActions;
}

const EngineGateContext = createContext<EngineGateContextValue | null>(null);

function useEngineGate() {
  const value = use(EngineGateContext);
  if (!value) throw new Error("Engine gate parts must render inside EngineGate.Provider");
  return value;
}

function EngineGateProvider({ children }: { children: ReactNode }) {
  const { status, isRestarting, setEnabled, restart } = useEngineStatus();
  const board = useBoard();
  const phase = enginePhase(status);
  const treatment = treatmentFor(phase, board);
  return (
    <EngineGateContext value={{ treatment, phase, isRestarting, actions: { setEnabled, restart } }}>
      {children}
    </EngineGateContext>
  );
}

function TurnOnEngineButton({ size }: { size?: "sm" }) {
  const {
    isRestarting,
    actions: { setEnabled },
  } = useEngineGate();
  return (
    <Button size={size} disabled={isRestarting} onClick={() => setEnabled(true)}>
      <RiFlashlightLine data-icon="inline-start" />
      {TURN_ON_ACTION}
    </Button>
  );
}

function RestartEngineButton({ size }: { size?: "sm" }) {
  const {
    isRestarting,
    actions: { restart },
  } = useEngineGate();
  return (
    <Button size={size} disabled={isRestarting} onClick={restart}>
      <RiRestartLine data-icon="inline-start" />
      {RESTART_ACTION}
    </Button>
  );
}

function ConnectingFull({ children }: { children: ReactNode }) {
  const [persisted, setPersisted] = useState(false);
  useTimeoutEffect(() => setPersisted(true), CONNECTING_HINT_MS);
  return (
    <div className="relative size-full">
      {children}
      {persisted && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <Badge variant="secondary">Connecting…</Badge>
        </div>
      )}
    </div>
  );
}

function OffFull() {
  return (
    <div className="flex h-full flex-col p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <RiShutDownLine />
          </EmptyMedia>
          <EmptyTitle>{OFF_TITLE}</EmptyTitle>
          <EmptyDescription>{OFF_BODY}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <TurnOnEngineButton />
        </EmptyContent>
      </Empty>
    </div>
  );
}

function BrokenFull({ reason }: { reason: BrokenReason }) {
  return (
    <div className="flex h-full flex-col p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <RiErrorWarningLine />
          </EmptyMedia>
          <EmptyTitle>{BROKEN_MESSAGE[reason]}</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <RestartEngineButton />
        </EmptyContent>
      </Empty>
    </div>
  );
}

function OffCompact() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
      <RiShutDownLine className="size-5 text-muted-foreground" />
      <p className="text-xs text-balance text-muted-foreground">{OFF_TITLE}</p>
      <TurnOnEngineButton size="sm" />
    </div>
  );
}

function BrokenCompact({ reason }: { reason: BrokenReason }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
      <RiErrorWarningLine className="size-5 text-destructive" />
      <p className="text-xs text-balance text-muted-foreground">{BROKEN_MESSAGE[reason]}</p>
      <RestartEngineButton size="sm" />
    </div>
  );
}

function EngineGateLive({ children }: { children: ReactNode }) {
  const { treatment } = useEngineGate();
  if (treatment !== "live") return null;
  return children;
}

function EngineGateConnecting({ children }: { children: ReactNode }) {
  const { treatment } = useEngineGate();
  if (treatment !== "connecting") return null;
  return <ConnectingFull>{children}</ConnectingFull>;
}

function EngineGateOff() {
  const { treatment } = useEngineGate();
  if (treatment !== "off") return null;
  return <OffFull />;
}

function EngineGateBroken() {
  const { treatment, phase } = useEngineGate();
  if (treatment !== "broken") return null;
  return <BrokenFull reason={brokenReason(phase)} />;
}

function CompactEngineGateLive({ children }: { children: ReactNode }) {
  const { treatment } = useEngineGate();
  if (treatment !== "live") return null;
  return children;
}

function CompactEngineGateConnecting({ children }: { children: ReactNode }) {
  const { treatment } = useEngineGate();
  if (treatment !== "connecting") return null;
  return children;
}

function CompactEngineGateOff() {
  const { treatment } = useEngineGate();
  if (treatment !== "off") return null;
  return <OffCompact />;
}

function CompactEngineGateBroken() {
  const { treatment, phase } = useEngineGate();
  if (treatment !== "broken") return null;
  return <BrokenCompact reason={brokenReason(phase)} />;
}

export const EngineGate = {
  Provider: EngineGateProvider,
  Live: EngineGateLive,
  Connecting: EngineGateConnecting,
  Off: EngineGateOff,
  Broken: EngineGateBroken,
};

export const CompactEngineGate = {
  Provider: EngineGateProvider,
  Live: CompactEngineGateLive,
  Connecting: CompactEngineGateConnecting,
  Off: CompactEngineGateOff,
  Broken: CompactEngineGateBroken,
};
