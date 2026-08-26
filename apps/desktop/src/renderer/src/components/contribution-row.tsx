// One contribution, as a row.
//
// Shared by the Customize list and a Plugin's own page so a row behaves the same wherever it is.
// Clicking it opens the thing that configures it: an MCP server has a dialog, because it has status
// a person cannot edit and a source they can. Everything else is a file, and files open in the right
// panel — the seam the Files feature will grow into.

import { Badge } from "@cogwork/ui/components/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { RiErrorWarningLine } from "@remixicon/react";
import { type ReactNode, useState } from "react";
import { withDraft } from "../features/configuration-draft";
import { type Contribution, scopeLabels } from "../features/configuration-model";
import { resolveEnablement, settingsSpreadAcross } from "../features/configuration-resolve";
import { useConfigurationDraftStore } from "../store/configuration-draft";
import { useRightPanelStore } from "../store/right-panel";
import { AuthorityBadge, DiagnosticBadge, kindIcons, ReadinessBadge } from "./configuration-atoms";
import { ListRow } from "./customize-list";
import { McpConfigureDialog } from "./mcp-configure-dialog";

/** The tab's name, which is the file's name — not its path. */
function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

export function ContributionRow({
  contribution,
  trailing,
  detail,
}: {
  contribution: Contribution;
  trailing?: ReactNode;
  /** Overrides the row's own line, where a caller has something better to say. */
  detail?: ReactNode;
}) {
  const cells = useConfigurationDraftStore((state) => state.cells);
  const openFile = useRightPanelStore((state) => state.openFile);
  const [configuring, setConfiguring] = useState(false);

  // The workspace comes from the contribution: it lives in one place, and that place names it.
  const view = { workspaceId: contribution.definedIn };
  const edited = withDraft(contribution, cells);
  const resolved = resolveEnablement(edited, view);
  const spread = settingsSpreadAcross(edited, view);
  const failed = contribution.load._tag === "failed";
  const Icon = kindIcons[contribution.kind];
  const mcp = contribution.kind === "mcp-server";

  const line = failed
    ? contribution.load._tag === "failed" && (
        <span className="text-destructive">{contribution.load.reason}</span>
      )
    : (detail ?? contribution.summary);

  return (
    <>
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
            {failed ? <Badge variant="destructive">Won't load</Badge> : null}
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
        detail={line}
        trailing={trailing}
        onOpen={() => (mcp ? setConfiguring(true) : openFile(contribution.file, fileName(contribution.file)))}
      />
      {mcp ? (
        <McpConfigureDialog contribution={contribution} open={configuring} onOpenChange={setConfiguring} />
      ) : null}
    </>
  );
}
