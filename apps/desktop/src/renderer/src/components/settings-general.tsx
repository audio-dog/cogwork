import { Button } from "@cogwork/ui/components/button";
import { Switch } from "@cogwork/ui/components/switch";
import { useState } from "react";
import type { ProcessProfileCapture } from "../../../shared/ipc";
import { settingEntry } from "../features/settings-catalog";
import { useWindowPreferences } from "../features/use-window-preferences";
import { SettingRow, SettingsSection, SubSectionCard } from "./settings-parts";

const processCaptures = [
  { label: "Daemon heap", request: { _tag: "DaemonHeapSnapshot" } },
  { label: "Daemon CPU", request: { _tag: "DaemonCpuProfile" } },
  { label: "Main heap", request: { _tag: "MainHeapSnapshot" } },
  { label: "Main CPU", request: { _tag: "MainCpuProfile" } },
] as const satisfies ReadonlyArray<{
  readonly label: string;
  readonly request: ProcessProfileCapture;
}>;

function ProcessCaptureControls() {
  const { preferences } = useWindowPreferences();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const settleCapture = (next: string) => {
    setPending(false);
    setMessage(next);
  };
  const capture = (request: ProcessProfileCapture) => () => {
    setPending(true);
    setMessage(null);
    return window.cogwork
      .captureProcessProfile(request)
      .then(settleCapture, (error) => settleCapture(error instanceof Error ? error.message : String(error)));
  };
  const disabled = preferences?.profiling !== true || pending;

  return (
    <div className="flex max-w-xl flex-wrap items-center justify-end gap-2">
      {message && <span>{message}</span>}
      {processCaptures.map(({ label, request }) => (
        <Button key={label} variant="outline" size="sm" disabled={disabled} onClick={capture(request)}>
          {label}
        </Button>
      ))}
    </div>
  );
}

export function GeneralSettings() {
  const { preferences, setCloseToHide, setProfiling } = useWindowPreferences();
  const [preferenceMessage, setPreferenceMessage] = useState<string | null>(null);
  const changeCloseToHide = (closeToHide: boolean) => {
    setCloseToHide(closeToHide).catch(() => undefined);
  };
  const changeProfiling = (profiling: boolean) => {
    setPreferenceMessage(null);
    setProfiling(profiling).catch((error) =>
      setPreferenceMessage(error instanceof Error ? error.message : String(error)),
    );
  };
  return (
    <SettingsSection title="General">
      <SubSectionCard label="Window">
        <SettingRow entry={settingEntry("close-to-hide")}>
          <Switch
            aria-label="Close to hide"
            checked={preferences?.closeToHide ?? true}
            disabled={preferences === null}
            onCheckedChange={changeCloseToHide}
          />
        </SettingRow>
      </SubSectionCard>
      <SubSectionCard label="Diagnostics">
        <SettingRow entry={settingEntry("profiling")}>
          <div className="flex max-w-sm items-center justify-end gap-2">
            {preferenceMessage && <span>{preferenceMessage}</span>}
            <Switch
              aria-label="Profiling"
              checked={preferences?.profiling ?? false}
              disabled={preferences === null}
              onCheckedChange={changeProfiling}
            />
          </div>
        </SettingRow>
        <SettingRow entry={settingEntry("process-captures")}>
          <ProcessCaptureControls />
        </SettingRow>
      </SubSectionCard>
    </SettingsSection>
  );
}
