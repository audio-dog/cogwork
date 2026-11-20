import { ItemContent, ItemDescription, ItemTitle } from "@cogwork/ui/components/item";

import { kindIcons } from "../features/configuration-icons";
import { type Contribution as ContributionRecord, LoadState } from "../features/configuration-model";
import { useRightPanelStore } from "../store/right-panel";
import { Contribution, useContribution } from "./contribution";
import { ListRow, ListRowMedia, ListRowOpen } from "./customize-list";

const fileName = (path: string) => path.split("/").at(-1) ?? path;

function FileRowBody() {
  const {
    state: { contribution, status, failed },
  } = useContribution();
  const openFile = useRightPanelStore((state) => state.openFile);
  const Icon = kindIcons[contribution.kind];

  return (
    <ListRow>
      <ListRowOpen
        label={`Open ${contribution.localName}`}
        onClick={() => openFile(contribution.file, fileName(contribution.file))}
      />
      <ListRowMedia status={status}>
        <Icon />
      </ListRowMedia>
      <ItemContent>
        <ItemTitle className="gap-1.5">
          {contribution.localName}
          <Contribution.Badges />
        </ItemTitle>
        <ItemDescription className={failed ? "text-destructive" : undefined}>
          {failed && LoadState.$is("failed")(contribution.load)
            ? contribution.load.reason
            : contribution.summary}
        </ItemDescription>
      </ItemContent>
    </ListRow>
  );
}

/** A Skill, Rules, a Command or a Subagent: a file on the disk, with no on / off to set. */
export function ContributionFileRow({ contribution }: { contribution: ContributionRecord }) {
  return (
    <Contribution.Provider contribution={contribution}>
      <FileRowBody />
    </Contribution.Provider>
  );
}
