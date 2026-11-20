import { branchBelongsToTicketSlug, ticketSlug } from "./worktree";

interface LinkKeyPull {
  readonly headRef: string;
  readonly closingIssueNumbers: ReadonlyArray<number>;
}

const numericIssue = /^#(\d+)$/;

export const pullClosesWorkItem = (id: string, pull: LinkKeyPull) => {
  const match = numericIssue.exec(id);
  return match ? pull.closingIssueNumbers.includes(Number(match[1])) : false;
};

export const pullMatchesLinkKey = (id: string, pull: LinkKeyPull) =>
  pullClosesWorkItem(id, pull) || branchBelongsToTicketSlug(pull.headRef, ticketSlug(id));
