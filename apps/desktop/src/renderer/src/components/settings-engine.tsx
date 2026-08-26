import { maxSchedulerLimit } from "@cogwork/contracts";
import { Separator } from "@cogwork/ui/components/separator";
import { useBoard } from "../features/activity-session";
import { settingEntry } from "../features/settings-catalog";
import { minConcurrency, minDailyBudget, settingsOfflineFallbacks } from "../features/settings-defaults";
import { useSchedulerConfig } from "../features/use-scheduler-config";
import { NumberStepper, SettingRow, SettingsSection, SubSectionCard } from "./settings-parts";

export function EngineSettings() {
  const result = useBoard();
  const scheduler = result._tag === "Success" ? result.board.scheduler : null;
  const { setConfig, result: write } = useSchedulerConfig();
  // Without a connected scheduler there is nothing real to seed from or write to, so the controls
  // show the offline fallbacks read-only until the daemon is up.
  const disabled = scheduler === null || write.waiting;

  return (
    <SettingsSection title="Engine">
      <SubSectionCard label="Scheduler">
        <SettingRow entry={settingEntry("global-limit")}>
          <NumberStepper
            value={scheduler?.globalLimit ?? settingsOfflineFallbacks.globalConcurrency}
            min={minConcurrency}
            max={maxSchedulerLimit}
            label="Global concurrency"
            disabled={disabled}
            onChange={(globalLimit) => setConfig({ globalLimit })}
          />
        </SettingRow>
        <Separator />
        <SettingRow entry={settingEntry("per-workspace-limit")}>
          <NumberStepper
            value={scheduler?.perWorkspaceLimit ?? settingsOfflineFallbacks.perWorkspaceConcurrency}
            min={minConcurrency}
            max={maxSchedulerLimit}
            label="Per-workspace concurrency"
            disabled={disabled}
            onChange={(perWorkspaceLimit) => setConfig({ perWorkspaceLimit })}
          />
        </SettingRow>
      </SubSectionCard>
      <SubSectionCard label="Budget">
        <SettingRow entry={settingEntry("daily-budget")}>
          <NumberStepper
            value={scheduler?.dailyBudgetLimit ?? settingsOfflineFallbacks.dailyBudgetRuns}
            min={minDailyBudget}
            max={maxSchedulerLimit}
            label="Daily budget"
            disabled={disabled}
            onChange={(dailyBudget) => setConfig({ dailyBudget })}
          />
        </SettingRow>
      </SubSectionCard>
    </SettingsSection>
  );
}
