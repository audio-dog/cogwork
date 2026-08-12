import type { PrBaseDivergence, PrChecks, PrReviewStatus, RunStatus } from "@clanker-forge/contracts";
import { Badge } from "@clanker-forge/ui/components/badge";
import type { ComponentProps } from "react";

type BadgeVariant = ComponentProps<typeof Badge>["variant"];

const runStatus: Record<RunStatus, { label: string; variant: BadgeVariant }> = {
  running: { label: "Running", variant: "default" },
  succeeded: { label: "Succeeded", variant: "secondary" },
  failed: { label: "Failed", variant: "destructive" },
  exhausted: { label: "Exhausted", variant: "outline" },
  interrupted: { label: "Interrupted", variant: "outline" },
  crashed: { label: "Crashed", variant: "destructive" },
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const { label, variant } = runStatus[status];
  return <Badge variant={variant}>{label}</Badge>;
}

const prChecks: Record<PrChecks, { label: string; variant: BadgeVariant }> = {
  passing: { label: "Checks passing", variant: "secondary" },
  failing: { label: "Checks failing", variant: "destructive" },
  pending: { label: "Checks pending", variant: "outline" },
};

export function PrChecksBadge({ checks }: { checks: PrChecks }) {
  const { label, variant } = prChecks[checks];
  return <Badge variant={variant}>{label}</Badge>;
}

const prReview: Record<PrReviewStatus, { label: string; variant: BadgeVariant }> = {
  pending: { label: "Review pending", variant: "outline" },
  "changes-requested": { label: "Changes requested", variant: "destructive" },
  ready: { label: "Ready to merge", variant: "secondary" },
};

export function PrReviewBadge({ review }: { review: PrReviewStatus }) {
  const { label, variant } = prReview[review];
  return <Badge variant={variant}>{label}</Badge>;
}

const prDivergence: Record<PrBaseDivergence, { label: string; variant: BadgeVariant } | null> = {
  conflict: { label: "Conflicts", variant: "destructive" },
  clean: { label: "Behind base", variant: "outline" },
  none: null,
};

export function PrDivergenceBadge({ divergence }: { divergence: PrBaseDivergence }) {
  const badge = prDivergence[divergence];
  if (!badge) return null;
  return <Badge variant={badge.variant}>{badge.label}</Badge>;
}
