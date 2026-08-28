import {
  type ContributionSettingScope,
  type ContributionSettingUpdate,
  defaultContributionEnabled,
} from "@cogwork/contracts";
import { Badge } from "@cogwork/ui/components/badge";
import { Switch } from "@cogwork/ui/components/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { RiErrorWarningLine } from "@remixicon/react";
import { createContext, type ReactNode, use } from "react";
import {
  type Authority,
  authorityLabel,
  type Contribution as ContributionRecord,
  type Diagnostic,
  diagnosticLabels,
  type McpReadiness,
  type ScopeRef,
  scopeCopy,
  scopeKey,
} from "../features/configuration-model";
import {
  type DroppedRow,
  diagnosticsOf,
  enableScopeFor,
  resolveEnablement,
  settingsSpreadAcross,
  viewOf,
} from "../features/configuration-resolve";
import { useConfiguration } from "./configuration-provider";
import type { RowStatus } from "./customize-list";

interface ContributionState {
  readonly contribution: ContributionRecord;
  readonly on: boolean;
  readonly failed: boolean;
  readonly status: RowStatus;
  readonly diagnostics: readonly DroppedRow[];
  readonly spread: readonly string[];
  readonly writing: boolean;
}

interface ContributionActions {
  readonly setEnabled: (enabled: boolean) => void;
}

interface ContributionMeta {
  readonly target: ScopeRef | undefined;
}

interface ContributionContextValue {
  readonly state: ContributionState;
  readonly actions: ContributionActions;
  readonly meta: ContributionMeta;
}

const ContributionContext = createContext<ContributionContextValue | null>(null);

export function useContribution() {
  const value = use(ContributionContext);
  if (!value) throw new Error("Contribution parts must render inside Contribution.Provider");
  return value;
}

const contributionSettingScope = (target: ScopeRef | undefined) => {
  if (target?.kind === "settings-profile")
    return { _tag: "SettingsProfile" } satisfies ContributionSettingScope;
  if (target?.kind !== "private-overlay" || target.workspaceId === undefined) return null;
  return {
    _tag: "PrivateWorkspaceOverlay",
    workspace: target.workspaceId,
  } satisfies ContributionSettingScope;
};

const contributionSettingUpdate = (
  contribution: ContributionRecord,
  target: ScopeRef | undefined,
  enabled: boolean,
): ContributionSettingUpdate | null => {
  if (contribution.kind !== "mcp-server") return null;
  const scope = contributionSettingScope(target);
  if (scope === null) return null;
  return {
    _tag: "Set",
    row: {
      contribution: { id: contribution.id, kind: "mcp-server" },
      scope,
      enabled,
    },
  };
};

function ContributionProvider({
  contribution,
  children,
}: {
  contribution: ContributionRecord;
  children: ReactNode;
}) {
  const {
    actions: { setContributionSetting },
    meta: { contributionSettingWaiting },
  } = useConfiguration();
  const target = enableScopeFor(contribution);
  const resolved = resolveEnablement(contribution, viewOf(contribution));
  const on = resolved.effective ?? defaultContributionEnabled(authorityLabel(contribution.authority));
  const failed = contribution.load._tag === "failed";
  const notReady = contribution.readiness?._tag === "not-ready";

  const value: ContributionContextValue = {
    state: {
      contribution,
      on,
      failed,
      status: failed || (on && notReady) ? "error" : "ok",
      diagnostics: diagnosticsOf(contribution),
      spread: settingsSpreadAcross(contribution).map((kind) => scopeCopy[kind].name),
      writing: contributionSettingWaiting,
    },
    actions: {
      setEnabled: (enabled) => {
        const update = contributionSettingUpdate(contribution, target, enabled);
        if (update) setContributionSetting(update);
      },
    },
    meta: { target },
  };

  return <ContributionContext value={value}>{children}</ContributionContext>;
}

function AuthorityBadge({ authority }: { authority: Authority }) {
  const variant = authority._tag === "plugin" ? "secondary" : "outline";
  return <Badge variant={variant}>{authorityLabel(authority)}</Badge>;
}

function DiagnosticBadge({ diagnostic }: { diagnostic: Diagnostic }) {
  const variant = diagnostic._tag === "ambiguous" ? "destructive" : "outline";
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant={variant} />}>
        <RiErrorWarningLine data-icon="inline-start" />
        {diagnosticLabels[diagnostic._tag]}
      </TooltipTrigger>
      <TooltipContent className="max-w-80">{diagnostic.detail}</TooltipContent>
    </Tooltip>
  );
}

function ReadinessBadge({ readiness }: { readiness: McpReadiness }) {
  if (readiness._tag === "ready") return <Badge variant="outline">Ready</Badge>;
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="destructive" />}>Not ready</TooltipTrigger>
      <TooltipContent className="max-w-80">{readiness.reason}</TooltipContent>
    </Tooltip>
  );
}

function SpreadBadge({ places }: { places: readonly string[] }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="secondary" className="cursor-help" />}>
        <RiErrorWarningLine />
        set in {places.length} places
      </TooltipTrigger>
      <TooltipContent className="max-w-80">
        This one has a value written at {places.join(" and ")}. The more specific one wins whole; clearing it
        in one place falls back to the other.
      </TooltipContent>
    </Tooltip>
  );
}

function ContributionBadges() {
  const {
    state: { contribution, diagnostics, spread, failed, on },
  } = useContribution();

  return (
    <>
      <AuthorityBadge authority={contribution.authority} />
      {on && contribution.readiness ? <ReadinessBadge readiness={contribution.readiness} /> : null}
      {!on ? <Badge variant="secondary">Disabled</Badge> : null}
      {diagnostics.map((entry) => (
        <DiagnosticBadge
          key={`${entry.diagnostic._tag}:${scopeKey(entry.row.scope)}`}
          diagnostic={entry.diagnostic}
        />
      ))}
      {failed ? <Badge variant="destructive">Won't load</Badge> : null}
      {spread.length > 0 ? <SpreadBadge places={spread} /> : null}
    </>
  );
}

function ContributionSwitch({ label }: { label: string }) {
  const {
    state: { on, failed, writing },
    actions: { setEnabled },
    meta: { target },
  } = useContribution();

  return (
    <Switch
      aria-label={label}
      checked={on}
      disabled={failed || writing || target === undefined}
      onCheckedChange={setEnabled}
    />
  );
}

export const Contribution = {
  Provider: ContributionProvider,
  Badges: ContributionBadges,
  Switch: ContributionSwitch,
};
