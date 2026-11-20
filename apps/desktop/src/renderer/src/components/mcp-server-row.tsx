import { Dialog, DialogTrigger } from "@cogwork/ui/components/dialog";
import { ItemContent, ItemDescription, ItemTitle } from "@cogwork/ui/components/item";

import { kindIcons } from "../features/configuration-icons";
import {
  type Contribution as ContributionRecord,
  LoadState,
  McpReadiness,
  scopeCopy,
} from "../features/configuration-model";
import { useConfiguration } from "./configuration-provider";
import { Contribution, useContribution } from "./contribution";
import { ListRow, ListRowActions, ListRowMedia, ListRowOpen } from "./customize-list";
import { McpConfigureDialog } from "./mcp-configure-dialog";

const Icon = kindIcons["mcp-server"];

function StatusLine() {
  const {
    state: { contribution, on },
  } = useContribution();
  const {
    meta: { workspaceById },
  } = useConfiguration();

  if (LoadState.$is("failed")(contribution.load)) return contribution.load.reason;
  const workspace = workspaceById(contribution.definedIn);
  const where = `${workspace ? `${workspace.name} · ` : ""}${scopeCopy[contribution.definedAt].name}`;
  if (!on) return `Off · ${where}`;
  if (McpReadiness.$is("not-ready")(contribution.readiness)) return contribution.readiness.reason;
  return `Connected · ${where}`;
}

function McpRowBody() {
  const {
    state: { contribution, on, failed, status },
  } = useContribution();

  return (
    <ListRow muted={!on && !failed}>
      <DialogTrigger render={<ListRowOpen label={`Configure ${contribution.localName}`} />} />
      <ListRowMedia status={status}>
        <Icon />
      </ListRowMedia>
      <ItemContent>
        <ItemTitle className="gap-1.5">
          {contribution.localName}
          <Contribution.Badges />
        </ItemTitle>
        <ItemDescription className={failed ? "text-destructive" : undefined}>
          <StatusLine />
        </ItemDescription>
      </ItemContent>
      <ListRowActions>
        <Contribution.Switch label={`Turn ${contribution.localName} on`} />
      </ListRowActions>
    </ListRow>
  );
}

/**
 * An MCP server launches a process, so it has an on / off. The row and its dialog share one
 * provider, and the Dialog owns whether it is open — no `open` prop travels between them.
 */
export function McpServerRow({ contribution }: { contribution: ContributionRecord }) {
  return (
    <Contribution.Provider contribution={contribution}>
      <Dialog>
        <McpRowBody />
        <McpConfigureDialog />
      </Dialog>
    </Contribution.Provider>
  );
}
