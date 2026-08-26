import { ItemContent, ItemDescription, ItemTitle } from "@cogwork/ui/components/item";
import type { Contribution } from "../features/configuration-model";
import { useRightPanelStore } from "../store/right-panel";
import { kindIcons } from "./configuration-atoms";
import { ContributionBadges, contributionStatus } from "./contribution-badges";
import { ListRowButton, ListRowMedia } from "./customize-list";

const fileName = (path: string) => path.split("/").at(-1) ?? path;

export function ContributionFileRow({ contribution }: { contribution: Contribution }) {
  const openFile = useRightPanelStore((state) => state.openFile);
  const Icon = kindIcons[contribution.kind];

  return (
    <ListRowButton onOpen={() => openFile(contribution.id, contribution.file, fileName(contribution.file))}>
      <ListRowMedia status={contributionStatus(contribution)}>
        <Icon />
      </ListRowMedia>
      <ItemContent>
        <ItemTitle className="gap-1.5">
          {contribution.localName}
          <ContributionBadges contribution={contribution} />
        </ItemTitle>
        <ItemDescription className={contribution.load._tag === "failed" ? "text-destructive" : undefined}>
          {contribution.load._tag === "failed" ? contribution.load.reason : contribution.summary}
        </ItemDescription>
      </ItemContent>
    </ListRowButton>
  );
}
