// A contribution in the Customize list: the shared row, plus the one switch.
//
// Because the levels are places a file lives rather than a precedence ladder, there is no write
// target to choose — a thing is turned on where it is. The exception gets a word, and only where it
// applies: a repository may ship an executable contribution but may never enable one, so its switch
// says where it writes instead.

import { Switch } from "@cogwork/ui/components/switch";
import { draftCellAt, withDraft } from "../features/configuration-draft";
import { type Contribution, scopeCopy } from "../features/configuration-model";
import { enableScopeFor, offeredElsewhere, resolveEnablement } from "../features/configuration-resolve";
import { useConfigurationDraftStore } from "../store/configuration-draft";
import { ContributionRow } from "./contribution-row";

export function CustomizeRow({ contribution }: { contribution: Contribution }) {
  const cells = useConfigurationDraftStore((state) => state.cells);
  const setCell = useConfigurationDraftStore((state) => state.setCell);

  const view = { workspaceId: contribution.definedIn };
  const resolved = resolveEnablement(withDraft(contribution, cells), view);
  const target = enableScopeFor(contribution);
  const failed = contribution.load._tag === "failed";
  const on = target ? draftCellAt(contribution, target, cells) === "on" : resolved.effective === true;

  const detail =
    offeredElsewhere(contribution) && target
      ? `${contribution.summary} — the repo can't turn this on, so the switch writes to ${scopeCopy[target.kind].name}.`
      : undefined;

  return (
    <ContributionRow
      contribution={contribution}
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
