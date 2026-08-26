// One contribution, as a row in a place group.
//
// Because the levels are places a file lives rather than a precedence ladder, there is no write
// target to choose: a thing is turned on where it is. That leaves one switch.
//
// Two exceptions get a word, and only when they apply. A repository may ship an executable
// contribution but may never enable one, so a repo-shipped Hook says where its switch writes. And
// one identity carrying a setting in more than one place is the single case ADR 0013's direction
// decides, which is rare enough to be a badge rather than the shape of the row.

import { Badge } from "@cogwork/ui/components/badge";
import { Switch } from "@cogwork/ui/components/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { RiErrorWarningLine } from "@remixicon/react";
import { draftCellAt, withDraft } from "../features/configuration-draft";
import { type Contribution, scopeCopy, scopeLabels } from "../features/configuration-model";
import {
  enableScopeFor,
  offeredElsewhere,
  resolveEnablement,
  settingsSpreadAcross,
} from "../features/configuration-resolve";
import { useConfigurationDraftStore } from "../store/configuration-draft";
import { AuthorityBadge, DiagnosticBadge, kindIcons, ReadinessBadge } from "./configuration-atoms";
import { ListRow } from "./customize-list";

export function CustomizeRow({ contribution }: { contribution: Contribution }) {
  const cells = useConfigurationDraftStore((state) => state.cells);
  const setCell = useConfigurationDraftStore((state) => state.setCell);

  // The workspace comes from the contribution: it lives in one place, and that place names it.
  const view = { workspaceId: contribution.definedIn };
  const edited = withDraft(contribution, cells);
  const resolved = resolveEnablement(edited, view);
  const target = enableScopeFor(contribution);
  const spread = settingsSpreadAcross(edited, view);
  const failed = contribution.load._tag === "failed";
  const Icon = kindIcons[contribution.kind];
  const on = target ? draftCellAt(contribution, target, cells) === "on" : resolved.effective === true;

  const detail = failed
    ? contribution.load._tag === "failed" && (
        <span className="text-destructive">{contribution.load.reason}</span>
      )
    : offeredElsewhere(contribution) && target
      ? `${contribution.summary} — the repo cannot turn this on, so the switch writes to ${scopeCopy[target.kind].name}.`
      : contribution.summary;

  return (
    <ListRow
      icon={<Icon />}
      status={failed ? "error" : "ok"}
      title={contribution.localName}
      badge={
        <>
          <AuthorityBadge authority={contribution.authority} />
          {contribution.readiness ? <ReadinessBadge readiness={contribution.readiness} /> : null}
          {resolved.dropped.map((entry) => (
            <DiagnosticBadge key={entry.diagnostic._tag} diagnostic={entry.diagnostic} />
          ))}
          {failed ? <Badge variant="destructive">Failed to load</Badge> : null}
          {spread.length > 0 ? (
            <Tooltip>
              <TooltipTrigger render={<Badge variant="secondary" className="cursor-help" />}>
                <RiErrorWarningLine />
                set in {spread.length} places
              </TooltipTrigger>
              <TooltipContent className="max-w-80">
                This one has a value written at {spread.map((kind) => scopeLabels[kind]).join(" and ")}. The
                more specific one wins whole; clearing it in one place falls back to the other.
              </TooltipContent>
            </Tooltip>
          ) : null}
        </>
      }
      detail={detail}
      trailing={
        <Switch
          checked={on}
          disabled={failed || target === undefined}
          onCheckedChange={(checked) => {
            if (target) setCell(contribution.id, target, checked ? "on" : "off");
          }}
        />
      }
    />
  );
}
