import type { ReadModelItem, ReadyToMergeItem } from "@cogwork/contracts";
import { terminalLine } from "./terminal-text";

export const readyToMergeText = (item: ReadyToMergeItem) =>
  `${item.id} ${item.title} (PR #${item.pr.number})`;

export const formatReadModelItem = (item: ReadModelItem) =>
  terminalLine(`ready-to-merge ${readyToMergeText(item)}`);
