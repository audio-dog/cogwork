import { type ControlStore, maxSchedulerLimit } from "@cogwork/contracts";
import { Separator } from "@cogwork/ui/components/separator";
import { useBoard } from "../features/activity-session";
import { settingEntry } from "../features/settings-catalog";
import { minConcurrency, minDailyBudget, settingsOfflineFallbacks } from "../features/settings-defaults";
import { useDaemonLimit } from "../features/use-daemon-limit";
import { NumberStepper, SettingRow, SettingsSection, SubSectionCard } from "./settings-parts";

function EngineSettingsContent({ board }: { readonly board: ControlStore | null }) {
  const { controlStore, setLimit, result: write } = useDaemonLimit(board);
  const limits = controlStore?.daemonLimits;
  const disabled = limits === undefined || write.waiting;
  const expectedRevision = limits?.revision ?? 0;

  return (
    <SettingsSection title="Engine">
      <SubSectionCard label="Scheduler">
        <SettingRow entry={settingEntry("global-limit")}>
          <NumberStepper
            value={limits?.globalConcurrency ?? settingsOfflineFallbacks.globalConcurrency}
            min={minConcurrency}
            max={maxSchedulerLimit}
            label="Global concurrency"
            disabled={disabled}
            onChange={(value) => setLimit({ key: "global-concurrency", value, expectedRevision })}
          />
        </SettingRow>
        <Separator />
        <SettingRow entry={settingEntry("per-workspace-limit")}>
          <NumberStepper
            value={limits?.perWorkspaceConcurrency ?? settingsOfflineFallbacks.perWorkspaceConcurrency}
            min={minConcurrency}
            max={maxSchedulerLimit}
            label="Per-workspace concurrency"
            disabled={disabled}
            onChange={(value) => setLimit({ key: "per-workspace-concurrency", value, expectedRevision })}
          />
        </SettingRow>
      </SubSectionCard>
      <SubSectionCard label="Budget">
        <SettingRow entry={settingEntry("daily-budget")}>
          <NumberStepper
            value={limits?.dailyBudget ?? settingsOfflineFallbacks.dailyBudgetRuns}
            min={minDailyBudget}
            max={maxSchedulerLimit}
            label="Daily budget"
            disabled={disabled}
            onChange={(value) => setLimit({ key: "daily-budget", value, expectedRevision })}
          />
        </SettingRow>
      </SubSectionCard>
    </SettingsSection>
  );
}

export function EngineSettings() {
  const result = useBoard();
  const controlStore = result._tag === "Success" ? result.board.controlStore : null;
  return <EngineSettingsContent key={result._tag} board={controlStore} />;
}
