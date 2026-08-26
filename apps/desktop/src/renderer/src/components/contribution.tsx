import { Badge } from "@cogwork/ui/components/badge";
import { Switch } from "@cogwork/ui/components/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { RiErrorWarningLine } from "@remixicon/react";
import { createContext, type ReactNode, use } from "react";
import { draftCellAt, withDraft } from "../features/configuration-draft";
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
import { useConfigurationDraftStore } from "../store/configuration-draft";
import type { RowStatus } from "./customize-list";

interface ContributionState {
  readonly contribution: ContributionRecord;
  readonly on: boolean;
  readonly failed: boolean;
  readonly status: RowStatus;
  readonly diagnostics: readonly DroppedRow[];
  readonly spread: readonly string[];
}

interface ContributionActions {
  readonly setEnabled: (enabled: boolean) => void;
}

interface ContributionMeta {
  /** The Scope a switch writes to, or undefined when this kind has no on / off at all. */
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

/**
 * Resolves one Contribution once, for the row, its badges and its dialog together. Each of those
 * used to repeat the same five lines, so a mistake in them was a mistake in three places.
 */
function ContributionProvider({
  contribution,
  children,
}: {
  contribution: ContributionRecord;
  children: ReactNode;
}) {
  const cells = useConfigurationDraftStore((state) => state.cells);
  const setCell = useConfigurationDraftStore((state) => state.setCell);

  const edited = withDraft(contribution, cells);
  const target = enableScopeFor(contribution);
  const resolved = resolveEnablement(edited, viewOf(contribution));
  const on = target ? draftCellAt(contribution, target, cells) === "on" : resolved.effective === true;
  const failed = contribution.load._tag === "failed";
  const notReady = contribution.readiness?._tag === "not-ready";

  const value: ContributionContextValue = {
    state: {
      contribution,
      on,
      failed,
      status: failed || notReady ? "error" : "ok",
      // A diagnostic is a fact about this Contribution, not about the view, so it is never hidden.
      diagnostics: diagnosticsOf(edited),
      spread: settingsSpreadAcross(edited).map((kind) => scopeCopy[kind].name),
    },
    actions: {
      setEnabled: (enabled) => {
        if (target) setCell(contribution.id, target, enabled ? "on" : "off");
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
    state: { contribution, diagnostics, spread, failed },
  } = useContribution();

  return (
    <>
      <AuthorityBadge authority={contribution.authority} />
      {contribution.readiness ? <ReadinessBadge readiness={contribution.readiness} /> : null}
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
    state: { on, failed },
    actions: { setEnabled },
    meta: { target },
  } = useContribution();

  return (
    <Switch
      aria-label={label}
      checked={on}
      disabled={failed || target === undefined}
      onCheckedChange={setEnabled}
    />
  );
}

export const Contribution = {
  Provider: ContributionProvider,
  Badges: ContributionBadges,
  Switch: ContributionSwitch,
};
