import { type DaemonLimitKey, maxSchedulerLimit } from "@cogwork/contracts";
import { Alert, AlertDescription, AlertTitle } from "@cogwork/ui/components/alert";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@cogwork/ui/components/input-group";
import { RiAddLine, RiSubtractLine } from "@remixicon/react";
import { createFileRoute } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { useState } from "react";
import { SettingRow, SettingsSection, SubSectionCard } from "../../components/settings-parts";
import { BoardResult, useBoard } from "../../features/activity-session";
import { settingEntry } from "../../features/settings-catalog";
import { minConcurrency, minDailyBudget, settingsOfflineFallbacks } from "../../features/settings-defaults";
import { parseCount, sanitizeCountDraft } from "../../features/settings-values";
import { useDaemonLimit } from "../../features/use-daemon-limit";

function LimitStepper({
  value,
  min,
  label,
  disabled,
  onChange,
}: {
  readonly value: number;
  readonly min: number;
  readonly label: string;
  readonly disabled: boolean;
  readonly onChange: (value: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const commit = (next: number) => {
    setEditing(false);
    const clamped = Math.min(maxSchedulerLimit, Math.max(min, next));
    if (clamped !== value) onChange(clamped);
  };
  return (
    <InputGroup className="w-28">
      <InputGroupInput
        aria-label={label}
        inputMode="numeric"
        disabled={disabled}
        value={editing ? draft : String(value)}
        onFocus={() => {
          setDraft(String(value));
          setEditing(true);
        }}
        onBlur={() => commit(parseCount(draft, min))}
        onChange={(event) => setDraft(sanitizeCountDraft(event.target.value))}
      />
      <InputGroupAddon>
        <InputGroupButton
          size="icon-xs"
          disabled={disabled}
          aria-label={`Decrease ${label}`}
          onClick={() => commit(value - 1)}
        >
          <RiSubtractLine data-icon="inline-start" />
        </InputGroupButton>
      </InputGroupAddon>
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-xs"
          disabled={disabled}
          aria-label={`Increase ${label}`}
          onClick={() => commit(value + 1)}
        >
          <RiAddLine data-icon="inline-start" />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}

function SchedulingSettings() {
  const board = useBoard();
  const published = BoardResult.$is("Success")(board) ? board.board.controlStore : null;
  const { controlStore, result, setLimit } = useDaemonLimit(published);
  const limits = controlStore?.daemonLimits ?? null;
  // A second click would interrupt the first write and resubmit its pre-write revision.
  const disabled = limits === null || result.waiting;
  const failure = result._tag === "Failure" && result.cause ? Cause.pretty(result.cause) : null;
  const expectedRevision = limits?.revision ?? 0;

  const limitRows: ReadonlyArray<{
    readonly key: DaemonLimitKey;
    readonly value: number;
    readonly min: number;
    readonly label: string;
  }> = [
    {
      key: "global-concurrency",
      value: limits?.globalConcurrency ?? settingsOfflineFallbacks.globalConcurrency,
      min: minConcurrency,
      label: "Runs at once",
    },
    {
      key: "per-workspace-concurrency",
      value: limits?.perWorkspaceConcurrency ?? settingsOfflineFallbacks.perWorkspaceConcurrency,
      min: minConcurrency,
      label: "Runs at once per workspace",
    },
    {
      key: "daily-budget",
      value: limits?.dailyBudget ?? settingsOfflineFallbacks.dailyBudgetRuns,
      min: minDailyBudget,
      label: "Runs per day",
    },
  ];

  return (
    <SettingsSection title="Scheduling">
      <SubSectionCard label="Limits">
        {limitRows.map((row) => (
          <SettingRow key={row.key} entry={settingEntry(row.key)}>
            <LimitStepper
              value={row.value}
              min={row.min}
              label={row.label}
              disabled={disabled}
              onChange={(value) => setLimit({ key: row.key, value, expectedRevision })}
            />
          </SettingRow>
        ))}
        {failure ? (
          <Alert variant="destructive">
            <AlertTitle>Could not save that limit</AlertTitle>
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        ) : null}
      </SubSectionCard>
    </SettingsSection>
  );
}

export const Route = createFileRoute("/settings/scheduling")({
  component: SchedulingSettings,
});
