import { ClassifiedItem } from "@cogwork/contracts";
import { terminalLine } from "./terminal-text";

export const formatClassifiedItem = (item: ClassifiedItem) =>
  terminalLine(
    ClassifiedItem.match(item, {
      Eligible: ({ stage, id, title }) => `${stage} ${id} ${title}`,
      Claimed: ({ id, title, claim }) => `claimed ${id} ${title} (by ${claim.by})`,
      Blocked: ({ id, title, openBlockers }) =>
        `blocked ${id} ${title} (${openBlockers} open blocker${openBlockers === 1 ? "" : "s"})`,
      NeedsHuman: ({ reason, id, title }) => `needs-human ${reason} ${id} ${title}`,
    }),
  );
