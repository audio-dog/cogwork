import type { PrBaseDivergence, PrChecks, PrReviewStatus, RunStatus } from "@cogwork/contracts";
import { Badge } from "@cogwork/ui/components/badge";
import type { ComponentProps } from "react";
import { runStatusLabel } from "../features/run-status";

type BadgeVariant = ComponentProps<typeof Badge>["variant"];

const runStatus: Record<RunStatus, BadgeVariant> = {
  running: "default",
  succeeded: "secondary",
  declined: "outline",
  failed: "destructive",
  exhausted: "outline",
  interrupted: "outline",
  crashed: "destructive",
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return <Badge variant={runStatus[status]}>{runStatusLabel[status]}</Badge>;
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
