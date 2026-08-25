// PROTOTYPE — neutral atoms the Plugins / Customize variants share.
//
// Deliberately thin. Badges, icons and scope labels are the same question in every variant, so
// sharing them costs nothing; layout, navigation and the write affordance are the things the
// variants disagree about, and none of that lives here.

import { Badge } from "@cogwork/ui/components/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import {
  RiComputerLine,
  RiErrorWarningLine,
  RiFileTextLine,
  RiFolderLine,
  RiGitRepositoryLine,
  RiPulseLine,
  RiRobot2Line,
  RiServerLine,
  RiSparkling2Line,
  RiTerminalBoxLine,
} from "@remixicon/react";
import type { ComponentType } from "react";
import {
  type Authority,
  authorityLabel,
  type CatalogStatus,
  type ContributionKind,
  type Diagnostic,
  diagnosticLabels,
  type McpReadiness,
  type ScopeKind,
  type ScopeRef,
  scopeLabels,
  type Workspace,
} from "../features/configuration-model";

export const kindIcons: Record<ContributionKind, ComponentType> = {
  "mcp-server": RiServerLine,
  skill: RiSparkling2Line,
  subagent: RiRobot2Line,
  rules: RiFileTextLine,
  command: RiTerminalBoxLine,
  hook: RiPulseLine,
};

export const scopeIcons: Record<ScopeKind, ComponentType> = {
  "runtime-host": RiComputerLine,
  "workspace-input": RiGitRepositoryLine,
  "private-overlay": RiFolderLine,
};

/**
 * A Scope instance in words. The workspace Scopes name the workspace *and* its checkout path,
 * because two workspaces may share one git remote and would otherwise read identically.
 */
export function describeScope(scope: ScopeRef, workspaces: readonly Workspace[]): string {
  if (scope.workspaceId === undefined) return scopeLabels[scope.kind];
  const workspace = workspaces.find((candidate) => candidate.id === scope.workspaceId);
  if (!workspace) return `${scopeLabels[scope.kind]} — unknown workspace`;
  return `${scopeLabels[scope.kind]} · ${workspace.name}`;
}

export function AuthorityBadge({ authority }: { authority: Authority }) {
  const variant = authority._tag === "plugin" ? "secondary" : "outline";
  return <Badge variant={variant}>{authorityLabel(authority)}</Badge>;
}

export function DiagnosticBadge({ diagnostic }: { diagnostic: Diagnostic }) {
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

/**
 * Three postures are enforced exactly; anything finer is coarse. The recorded fidelity travels
 * with the row so no surface presents a coarse enforcement as exact.
 */
export function FidelityBadge({ fidelity }: { fidelity: "exact" | "coarse" }) {
  if (fidelity === "exact") return <Badge variant="outline">Enforced</Badge>;
  return <Badge variant="secondary">Coarse</Badge>;
}

export function ReadinessBadge({ readiness }: { readiness: McpReadiness }) {
  if (readiness._tag === "ready") return <Badge variant="outline">Ready</Badge>;
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="destructive" />}>Not ready</TooltipTrigger>
      <TooltipContent className="max-w-80">{readiness.reason}</TooltipContent>
    </Tooltip>
  );
}

export function CatalogStatusBadge({ status }: { status: CatalogStatus }) {
  if (status._tag === "active") return null;
  const variant = status._tag === "deleted" ? "destructive" : "secondary";
  const label = status._tag === "deleted" ? "Withdrawn" : "Deprecated";
  if (!status.message) return <Badge variant={variant}>{label}</Badge>;
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant={variant} />}>{label}</TooltipTrigger>
      <TooltipContent className="max-w-80">{status.message}</TooltipContent>
    </Tooltip>
  );
}

/** The identity an install record resolved to — a declared version, or a content revision. */
export function IdentityBadge({ identity }: { identity: string }) {
  return (
    <Badge variant="outline" className="font-mono">
      {identity}
    </Badge>
  );
}
