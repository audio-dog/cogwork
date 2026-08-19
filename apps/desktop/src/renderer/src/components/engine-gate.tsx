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
import { type ReactNode, useState } from "react";
import { type BrokenReason, brokenReason, type Treatment, treatmentFor } from "../features/engine-gate";
import { useBoard } from "../features/use-board";
import { type EnginePhase, enginePhase, useEngineStatus } from "../features/use-engine-status";

const OFF_COPY = {
  title: "Engine is off",
  body: "Turn the engine on to resume work.",
  action: "Turn on engine",
} as const;

const BROKEN_MESSAGE: Record<BrokenReason, string> = {
  "engine-failed": "The engine stopped unexpectedly.",
  "daemon-unreachable": "Can't reach the daemon.",
};
const RESTART_ACTION = "Restart engine";

const CONNECTING_HINT_MS = 2000;

interface GateState {
  readonly treatment: Treatment;
  readonly phase: EnginePhase;
}

function useTreatment(): GateState {
  const { status } = useEngineStatus();
  const board = useBoard();
  const phase = enginePhase(status);
  return { treatment: treatmentFor(phase, board._tag), phase };
}

function TurnOnEngineButton({ size }: { size?: "sm" }) {
  const { setEnabled } = useEngineStatus();
  return (
    <Button size={size} onClick={() => setEnabled(true)}>
      <RiFlashlightLine data-icon="inline-start" />
      {OFF_COPY.action}
    </Button>
  );
}

function RestartEngineButton({ size }: { size?: "sm" }) {
  const { restart } = useEngineStatus();
  return (
    <Button size={size} onClick={restart}>
      <RiRestartLine data-icon="inline-start" />
      {RESTART_ACTION}
    </Button>
  );
}

function ConnectingFull({ skeleton }: { skeleton: ReactNode }) {
  const [persisted, setPersisted] = useState(false);
  useTimeoutEffect(() => setPersisted(true), CONNECTING_HINT_MS);
  return (
    <div className="relative size-full">
      {skeleton}
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
          <EmptyTitle>{OFF_COPY.title}</EmptyTitle>
          <EmptyDescription>{OFF_COPY.body}</EmptyDescription>
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

function CompactTreatment({ icon, title, action }: { icon: ReactNode; title: string; action: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
      {icon}
      <p className="text-xs text-balance text-muted-foreground">{title}</p>
      {action}
    </div>
  );
}

function OffCompact() {
  return (
    <CompactTreatment
      icon={<RiShutDownLine className="size-5 text-muted-foreground" />}
      title={OFF_COPY.title}
      action={<TurnOnEngineButton size="sm" />}
    />
  );
}

function BrokenCompact({ reason }: { reason: BrokenReason }) {
  return (
    <CompactTreatment
      icon={<RiErrorWarningLine className="size-5 text-destructive" />}
      title={BROKEN_MESSAGE[reason]}
      action={<RestartEngineButton size="sm" />}
    />
  );
}

export function EngineGate({ children, skeleton }: { children: ReactNode; skeleton: ReactNode }) {
  const { treatment, phase } = useTreatment();
  switch (treatment) {
    case "live":
      return <>{children}</>;
    case "off":
      return <OffFull />;
    case "connecting":
      return <ConnectingFull skeleton={skeleton} />;
    case "broken":
      return <BrokenFull reason={brokenReason(phase)} />;
  }
}

export function CompactEngineGate({ children, skeleton }: { children: ReactNode; skeleton: ReactNode }) {
  const { treatment, phase } = useTreatment();
  switch (treatment) {
    case "live":
      return <>{children}</>;
    case "off":
      return <OffCompact />;
    case "connecting":
      return <>{skeleton}</>;
    case "broken":
      return <BrokenCompact reason={brokenReason(phase)} />;
  }
}
