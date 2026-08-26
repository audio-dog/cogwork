import { ItemActions, ItemContent, ItemDescription, ItemTitle } from "@cogwork/ui/components/item";
import { Switch } from "@cogwork/ui/components/switch";
import { useState } from "react";
import { draftCellAt, withDraft } from "../features/configuration-draft";
import { type Contribution, scopeCopy } from "../features/configuration-model";
import { workspaceById } from "../features/configuration-placeholder";
import { enableScopeFor, resolveEnablement } from "../features/configuration-resolve";
import { useConfigurationDraftStore } from "../store/configuration-draft";
import { kindIcons } from "./configuration-atoms";
import { ContributionBadges, contributionStatus } from "./contribution-badges";
import { ListRowButton, ListRowMedia } from "./customize-list";
import { McpConfigureDialog } from "./mcp-configure-dialog";

const Icon = kindIcons["mcp-server"];

function statusLine(contribution: Contribution, on: boolean) {
  if (contribution.load._tag === "failed") return contribution.load.reason;
  if (contribution.readiness?._tag === "not-ready") return contribution.readiness.reason;
  const workspace = workspaceById(contribution.definedIn);
  const where = `${workspace ? `${workspace.name} · ` : ""}${scopeCopy[contribution.definedAt].name}`;
  return `${on ? "Connected" : "Off"} · ${where}`;
}

export function McpServerRow({ contribution }: { contribution: Contribution }) {
  const cells = useConfigurationDraftStore((state) => state.cells);
  const setCell = useConfigurationDraftStore((state) => state.setCell);
  const [configuring, setConfiguring] = useState(false);

  const view = { workspaceId: contribution.definedIn };
  const resolved = resolveEnablement(withDraft(contribution, cells), view);
  const target = enableScopeFor(contribution);
  const failed = contribution.load._tag === "failed";
  const on = target ? draftCellAt(contribution, target, cells) === "on" : resolved.effective === true;

  return (
    <>
      <ListRowButton onOpen={() => setConfiguring(true)}>
        <ListRowMedia status={contributionStatus(contribution)}>
          <Icon />
        </ListRowMedia>
        <ItemContent>
          <ItemTitle className="gap-1.5">
            {contribution.localName}
            <ContributionBadges contribution={contribution} />
          </ItemTitle>
          <ItemDescription className={failed ? "text-destructive" : undefined}>
            {statusLine(contribution, on)}
          </ItemDescription>
        </ItemContent>
        <ItemActions
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Switch
            checked={on}
            disabled={failed || target === undefined}
            onCheckedChange={(checked) => {
              if (target) setCell(contribution.id, target, checked ? "on" : "off");
            }}
          />
        </ItemActions>
      </ListRowButton>
      <McpConfigureDialog contribution={contribution} open={configuring} onOpenChange={setConfiguring} />
    </>
  );
}
