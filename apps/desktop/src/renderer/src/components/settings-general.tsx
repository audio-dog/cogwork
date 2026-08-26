import { Switch } from "@cogwork/ui/components/switch";
import { settingEntry } from "../features/settings-catalog";
import { useWindowPreferences } from "../features/use-window-preferences";
import { SettingRow, SettingsSection, SubSectionCard } from "./settings-parts";

function CloseToHideControl() {
  const { preferences, setCloseToHide } = useWindowPreferences();
  return (
    <Switch
      aria-label="Close to hide"
      checked={preferences?.closeToHide ?? true}
      disabled={preferences === null}
      onCheckedChange={setCloseToHide}
    />
  );
}

export function GeneralSettings() {
  return (
    <SettingsSection title="General">
      <SubSectionCard label="Window">
        <SettingRow entry={settingEntry("close-to-hide")}>
          <CloseToHideControl />
        </SettingRow>
      </SubSectionCard>
    </SettingsSection>
  );
}
