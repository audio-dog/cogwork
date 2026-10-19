/**
 * The Triggers and Actions a person picks from while authoring a Workflow. Mock data: the engine
 * does not expose its Connections' events and output actions to the desktop yet.
 *
 * Triggers and Actions share one shape, because they are the same kind of choice: pick a connector,
 * pick the thing it offers, sometimes narrow that down once more. An Action also declares its
 * inputs and who fills each one, because only the text that needs judgement is the agent's to
 * write; the engine fills everything else.
 */

export type CatalogIcon =
  | "schedule"
  | "github"
  | "linear"
  | "slack"
  | "granola"
  | "webhook"
  | "cogwork"
  | "operation";

export interface CatalogOption {
  readonly id: string;
  readonly name: string;
}

/**
 * Where one Action input gets its value. Only `agent` becomes a field of the Operation's structured
 * output; the engine fills the others from fixed text, from the Run, or from the option picked in
 * the menu.
 */
export type InputSource =
  | { readonly kind: "agent"; readonly field: string; readonly hint: string }
  | { readonly kind: "fixed"; readonly text: string }
  | { readonly kind: "run"; readonly from: string }
  | { readonly kind: "menu" };

export interface ActionInput {
  readonly id: string;
  readonly label: string;
  readonly source: InputSource;
}

export interface CatalogItem {
  readonly id: string;
  readonly name: string;
  /** A third level in the menu. An item with options opens a submenu instead of being picked. */
  readonly options: readonly CatalogOption[];
  /** Empty for a Trigger. */
  readonly inputs: readonly ActionInput[];
}

export interface CatalogGroup {
  readonly id: string;
  readonly name: string;
  readonly icon: CatalogIcon;
  readonly connected: boolean;
  readonly items: readonly CatalogItem[];
  /** Items only this connector offers, listed under their own heading. */
  readonly exclusive: readonly CatalogItem[];
}

export interface Catalog {
  readonly groups: readonly CatalogGroup[];
}

/** One thing picked from a catalog: a Trigger, an Action, or a hand-off to another Operation. */
export interface CatalogChoice {
  readonly groupId: string;
  readonly groupName: string;
  readonly icon: CatalogIcon;
  readonly itemId: string;
  readonly itemName: string;
  readonly optionName: string | null;
}

const input = (id: string, label: string, source: InputSource): ActionInput => ({ id, label, source });
const agent = (field: string, hint: string): InputSource => ({ kind: "agent", field, hint });
const fixed = (text: string): InputSource => ({ kind: "fixed", text });
const fromRun = (from: string): InputSource => ({ kind: "run", from });
const fromMenu: InputSource = { kind: "menu" };

const item = (
  id: string,
  name: string,
  options: readonly string[] = [],
  inputs: readonly ActionInput[] = [],
): CatalogItem => ({
  id,
  name,
  options: options.map((option) => ({ id: option.toLowerCase().replace(/\s+/g, "-"), name: option })),
  inputs,
});

const theIssue = input("issue", "Issue", fromRun("The issue this Run started from"));
const issueTitle = input("title", "Title", agent("issue_title", "A short title for the new issue."));
const issueBody = input(
  "body",
  "Body",
  agent("issue_body", "The issue description in Markdown. Say who asked for the work and why."),
);
const commentBody = input(
  "body",
  "Comment",
  agent("comment", "The comment Cogwork posts. Write it for the person who reported the issue."),
);
const handOffBrief = input("brief", "Brief", fromRun("This Run's answers and everything the agent wrote"));

const trackerEvents: readonly CatalogItem[] = [
  item("issue-opened", "Issue opened"),
  item("issue-labelled", "Issue labelled", ["needs-triage", "ready-for-agent", "needs-info", "Any label"]),
  item("issue-commented", "Issue commented"),
  item("issue-closed", "Issue closed"),
];

export const triggerCatalog: Catalog = {
  groups: [
    {
      id: "schedule",
      name: "Schedule",
      icon: "schedule",
      connected: true,
      items: [
        item("hourly", "Every hour"),
        item("daily", "Every day", ["08:00", "12:00", "18:00"]),
        item("weekly", "Every week", ["Monday", "Wednesday", "Friday"]),
      ],
      exclusive: [],
    },
    {
      id: "github",
      name: "GitHub",
      icon: "github",
      connected: true,
      items: trackerEvents,
      exclusive: [
        item("pull-request", "Pull request", ["Opened", "Pushed", "Merged", "Closed"]),
        item("checks", "Checks completed", ["Passed", "Failed", "Any result"]),
        item("review", "Review submitted", ["Approved", "Changes requested", "Commented"]),
        item("review-comment", "Review comment added"),
        item("push", "Push to branch"),
      ],
    },
    {
      id: "linear",
      name: "Linear",
      icon: "linear",
      connected: false,
      items: trackerEvents,
      exclusive: [item("status", "Moved to status", ["Todo", "In progress", "In review", "Done"])],
    },
    {
      id: "slack",
      name: "Slack",
      icon: "slack",
      connected: true,
      items: [
        item("directed", "Message directed at me"),
        item("channel", "Message in a channel", ["#engineering", "#product"]),
        item("reaction", "Reaction added", ["👀", "✅"]),
      ],
      exclusive: [],
    },
    {
      id: "granola",
      name: "Granola",
      icon: "granola",
      connected: true,
      items: [item("transcript", "Transcript ingested"), item("meeting", "Meeting ended")],
      exclusive: [],
    },
    {
      id: "webhook",
      name: "Webhook",
      icon: "webhook",
      connected: true,
      items: [item("received", "Webhook received")],
      exclusive: [],
    },
  ],
};

export const actionCatalog: Catalog = {
  groups: [
    {
      id: "github",
      name: "GitHub",
      icon: "github",
      connected: true,
      items: [
        item(
          "create-issue",
          "Create an issue",
          [],
          [input("repository", "Repository", fromRun("The Workflow's workspace")), issueTitle, issueBody],
        ),
        item("comment", "Post a comment", [], [theIssue, commentBody]),
        item(
          "label",
          "Add a label",
          ["needs-triage", "ready-for-agent", "needs-info", "ready-for-human", "wontfix", "blocked"],
          [theIssue, input("label", "Label", fromMenu)],
        ),
        item("close", "Close the issue", [], [theIssue]),
      ],
      exclusive: [
        item(
          "open-pr",
          "Open a pull request",
          [],
          [
            input("branch", "Branch", fromRun("The branch this Run pushed")),
            input("title", "Title", agent("pr_title", "The pull request title.")),
            input("body", "Description", agent("pr_body", "What changed and why, written for the reviewer.")),
          ],
        ),
        item(
          "request-review",
          "Request a review",
          [],
          [
            input("pull-request", "Pull request", fromRun("The pull request this Run follows")),
            input("reviewers", "Reviewers", fixed("The repository's code owners")),
          ],
        ),
      ],
    },
    {
      id: "linear",
      name: "Linear",
      icon: "linear",
      connected: false,
      items: [
        item(
          "create-issue",
          "Create an issue",
          [],
          [input("team", "Team", fixed("The workspace's Linear team")), issueTitle, issueBody],
        ),
        item("comment", "Post a comment", [], [theIssue, commentBody]),
        item("close", "Close the issue", [], [theIssue]),
      ],
      exclusive: [
        item(
          "status",
          "Move to status",
          ["Todo", "In progress", "In review", "Done"],
          [theIssue, input("status", "Status", fromMenu)],
        ),
      ],
    },
    {
      id: "slack",
      name: "Slack",
      icon: "slack",
      connected: true,
      items: [
        item(
          "send",
          "Send a message",
          ["#engineering", "#product"],
          [
            input("channel", "Channel", fromMenu),
            input(
              "message",
              "Message",
              agent("slack_message", "The message to post, in two sentences or fewer."),
            ),
          ],
        ),
        item(
          "reply",
          "Reply in thread",
          [],
          [
            input("thread", "Thread", fromRun("The thread this Run started from")),
            input("message", "Reply", agent("slack_reply", "The reply to post in the thread.")),
          ],
        ),
      ],
      exclusive: [],
    },
    {
      id: "cogwork",
      name: "Cogwork",
      icon: "cogwork",
      connected: true,
      items: [
        item(
          "notify",
          "Notify me",
          [],
          [input("message", "Message", agent("notification", "One line that says what needs my attention."))],
        ),
        item(
          "approve",
          "Wait for my approval",
          [],
          [
            input(
              "question",
              "Question",
              agent("approval_request", "What you want me to approve, and what happens when I do."),
            ),
          ],
        ),
        item("stop", "Stop"),
      ],
      exclusive: [],
    },
  ],
};

export const choiceOf = (
  group: CatalogGroup,
  entry: CatalogItem,
  optionName: string | null,
): CatalogChoice => ({
  groupId: group.id,
  groupName: group.name,
  icon: group.icon,
  itemId: entry.id,
  itemName: entry.name,
  optionName,
});

export const choiceKey = (choice: CatalogChoice) =>
  `${choice.groupId}/${choice.itemId}/${choice.optionName ?? ""}`;

/** Every leaf in the catalog, so one query can match a connector, an event, or an option. */
export const leavesOf = (catalog: Catalog) =>
  catalog.groups.flatMap((group) =>
    [...group.items, ...group.exclusive].flatMap((entry) =>
      entry.options.length === 0
        ? [choiceOf(group, entry, null)]
        : entry.options.map((option) => choiceOf(group, entry, option.name)),
    ),
  );

const operationsGroupId = "operations";
const operationsGroupName = "Run an Operation";

export const isHandOff = (choice: CatalogChoice) => choice.groupId === operationsGroupId;

interface OperationRef {
  readonly id: string;
  readonly name: string;
}

/** The Workflow's other Operations, offered as one more group so a hand-off is picked like an Action. */
export const withOperations = (catalog: Catalog, operations: readonly OperationRef[]): Catalog => ({
  groups: [
    {
      id: operationsGroupId,
      name: operationsGroupName,
      icon: "operation",
      connected: true,
      items: operations.map((operation) => item(operation.id, operation.name, [], [handOffBrief])),
      exclusive: [],
    },
    ...catalog.groups,
  ],
});

export const handOffTo = (operation: OperationRef): CatalogChoice => ({
  groupId: operationsGroupId,
  groupName: operationsGroupName,
  icon: "operation",
  itemId: operation.id,
  itemName: operation.name,
  optionName: null,
});

const entryOf = (catalog: Catalog, groupId: string, itemId: string) => {
  const group = catalog.groups.find((candidate) => candidate.id === groupId);
  const entry = [...(group?.items ?? []), ...(group?.exclusive ?? [])].find(
    (candidate) => candidate.id === itemId,
  );
  return group && entry ? { group, entry } : null;
};

export const inputsFor = (choice: CatalogChoice): readonly ActionInput[] => {
  if (isHandOff(choice)) return [handOffBrief];
  return entryOf(actionCatalog, choice.groupId, choice.itemId)?.entry.inputs ?? [];
};

/** Finds a catalog entry by connector and id, so mock data reads as the menu path a person clicks. */
const pickFrom = (catalog: Catalog, groupId: string, itemId: string, optionName: string | null) => {
  const found = entryOf(catalog, groupId, itemId);
  if (!found) throw new Error(`No catalog entry ${groupId}/${itemId}`);
  return choiceOf(found.group, found.entry, optionName);
};

export const pickAction = (groupId: string, itemId: string, optionName: string | null = null) =>
  pickFrom(actionCatalog, groupId, itemId, optionName);

export const pickTrigger = (groupId: string, itemId: string, optionName: string | null = null) =>
  pickFrom(triggerCatalog, groupId, itemId, optionName);
