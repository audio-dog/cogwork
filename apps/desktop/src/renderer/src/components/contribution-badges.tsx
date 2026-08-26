import { Badge } from "@cogwork/ui/components/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { RiErrorWarningLine } from "@remixicon/react";
import { withDraft } from "../features/configuration-draft";
import {
  type Authority,
  authorityLabel,
  type Contribution,
  type Diagnostic,
  diagnosticLabels,
  type McpReadiness,
  scopeCopy,
  scopeKey,
} from "../features/configuration-model";
import { resolveEnablement, settingsSpreadAcross } from "../features/configuration-resolve";
import { useConfigurationDraftStore } from "../store/configuration-draft";

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

export function ContributionBadges({ contribution }: { contribution: Contribution }) {
  const cells = useConfigurationDraftStore((state) => state.cells);
  const view = { workspaceId: contribution.definedIn };
  const edited = withDraft(contribution, cells);
  const dropped = resolveEnablement(edited, view).dropped;
  const spread = settingsSpreadAcross(edited).map((kind) => scopeCopy[kind].name);

  return (
    <>
      <AuthorityBadge authority={contribution.authority} />
      {contribution.readiness ? <ReadinessBadge readiness={contribution.readiness} /> : null}
      {dropped.map((entry) => (
        <DiagnosticBadge
          key={`${entry.diagnostic._tag}:${scopeKey(entry.row.scope)}`}
          diagnostic={entry.diagnostic}
        />
      ))}
      {contribution.load._tag === "failed" ? <Badge variant="destructive">Won't load</Badge> : null}
      {spread.length > 0 ? <SpreadBadge places={spread} /> : null}
    </>
  );
}

export function contributionStatus(contribution: Contribution) {
  if (contribution.load._tag === "failed") return "error" as const;
  if (contribution.readiness?._tag === "not-ready") return "error" as const;
  return "ok" as const;
}
