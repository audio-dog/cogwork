// PROTOTYPE — one contribution, as a row.
//
// Shared by the rail and the split-dropdown variants on purpose: those two differ only in the
// filter control, which is the thing under test. Variant B's table row is genuinely different and
// lives with it.
//
// The row is deliberately plain. Because the levels are places a file lives rather than a
// precedence ladder, there is no write target to choose: a thing is turned on where it is. That
// removes the mode every earlier variant needed, and leaves one switch.

import { Badge } from "@cogwork/ui/components/badge";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@cogwork/ui/components/item";
import { Switch } from "@cogwork/ui/components/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { RiErrorWarningLine } from "@remixicon/react";
import { draftCellAt, withDraft } from "../features/configuration-draft";
import {
  type Contribution,
  scopeLabels,
  scopeOriginLabels,
  scopeShortLabels,
} from "../features/configuration-model";
import {
  enableScopeFor,
  offeredElsewhere,
  resolveEnablement,
  settingsSpreadAcross,
} from "../features/configuration-resolve";
import { useConfigurationDraftStore } from "../store/configuration-draft";
import {
  AuthorityBadge,
  DiagnosticBadge,
  kindIcons,
  ReadinessBadge,
  scopeIcons,
} from "./configuration-atoms";
import { useWorkspaceId } from "./customize-atoms";

/** Where a contribution's file sits. Shown on every row, because it is the axis being filtered. */
export function DefinedAtBadge({ contribution }: { contribution: Contribution }) {
  const Icon = scopeIcons[contribution.definedAt];
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="outline" className="cursor-help" />}>
        <Icon />
        {scopeShortLabels[contribution.definedAt]}
      </TooltipTrigger>
      <TooltipContent className="max-w-80">
        <span className="font-medium">{scopeLabels[contribution.definedAt]}</span> — this file lives{" "}
        {scopeOriginLabels[contribution.definedAt]}.
        <br />
        <span className="font-mono text-xs">{contribution.file}</span>
      </TooltipContent>
    </Tooltip>
  );
}

export function CustomizeRow({ contribution }: { contribution: Contribution }) {
  const cells = useConfigurationDraftStore((state) => state.cells);
  const setCell = useConfigurationDraftStore((state) => state.setCell);
  const workspaceId = useWorkspaceId();

  const edited = withDraft(contribution, cells);
  const resolved = resolveEnablement(edited, { workspaceId });
  const target = enableScopeFor(contribution, workspaceId);
  const spread = settingsSpreadAcross(edited, { workspaceId });
  const failed = contribution.load._tag === "failed";
  const Icon = kindIcons[contribution.kind];
  const on = target ? draftCellAt(contribution, target, cells) === "on" : resolved.effective === true;

  return (
    <Item variant="outline" className="items-start">
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{contribution.localName}</span>
          <DefinedAtBadge contribution={contribution} />
          <AuthorityBadge authority={contribution.authority} />
          {contribution.readiness ? <ReadinessBadge readiness={contribution.readiness} /> : null}
          {resolved.dropped.map((entry) => (
            <DiagnosticBadge key={entry.diagnostic._tag} diagnostic={entry.diagnostic} />
          ))}
          {failed ? <Badge variant="destructive">Failed to load</Badge> : null}
          {/* The exception ADR 0013's direction exists for. Rare, so it is a badge, not the page. */}
          {spread.length > 0 ? (
            <Tooltip>
              <TooltipTrigger render={<Badge variant="secondary" className="cursor-help" />}>
                <RiErrorWarningLine />
                set in {spread.length} places
              </TooltipTrigger>
              <TooltipContent className="max-w-80">
                This one has a value written at {spread.map((kind) => scopeLabels[kind]).join(" and ")}. The
                more specific one wins whole. Clearing it in one place falls back to the other.
              </TooltipContent>
            </Tooltip>
          ) : null}
        </ItemTitle>
        <ItemDescription>{contribution.summary}</ItemDescription>
        {failed && contribution.load._tag === "failed" ? (
          <p className="mt-1 text-xs text-destructive">{contribution.load.reason}</p>
        ) : offeredElsewhere(contribution) && target ? (
          // A repository may ship an executable contribution but may never enable one.
          <p className="mt-1 text-xs text-muted-foreground">
            The repository offers this. It cannot be turned on there, so the switch writes to{" "}
            {scopeLabels[target.kind]}.
          </p>
        ) : null}
      </ItemContent>
      <ItemActions>
        <Switch
          checked={on}
          disabled={failed || target === undefined}
          onCheckedChange={(checked) => {
            if (target) setCell(contribution.id, target, checked ? "on" : "off");
          }}
        />
      </ItemActions>
    </Item>
  );
}
