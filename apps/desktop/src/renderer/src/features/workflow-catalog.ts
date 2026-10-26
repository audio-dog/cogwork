export type CatalogIcon =
  | "schedule"
  | "github"
  | "linear"
  | "slack"
  | "granola"
  | "webhook"
  | "cogwork"
  | "operation";

/** Text the agent writes for an Action, returned as `field` in the Operation's structured output. */
export interface AgentInput {
  readonly id: string;
  readonly label: string;
  readonly field: string;
  readonly hint: string;
}

export interface CatalogItem {
  readonly id: string;
  readonly name: string;
  readonly options: readonly string[];
  readonly agentInputs: readonly AgentInput[];
}

export interface CatalogGroup {
  readonly id: string;
  readonly name: string;
  readonly icon: CatalogIcon;
  readonly items: readonly CatalogItem[];
  readonly connectorOnly: readonly CatalogItem[];
}

export type Catalog = readonly CatalogGroup[];

export interface CatalogChoice {
  readonly groupId: string;
  readonly groupName: string;
  readonly icon: CatalogIcon;
  readonly itemId: string;
  readonly itemName: string;
  readonly optionName: string | null;
  readonly agentInputs: readonly AgentInput[];
}

const agentInput = (id: string, label: string, field: string, hint: string) => ({ id, label, field, hint });

const item = (
  id: string,
  name: string,
  options: readonly string[] = [],
  agentInputs: readonly AgentInput[] = [],
) => ({ id, name, options, agentInputs });

const issueTitle = agentInput("title", "Title", "issue_title", "A short title for the new issue.");
const issueBody = agentInput(
  "body",
  "Body",
  "issue_body",
  "The issue description in Markdown. Say who asked for the work and why.",
);
const commentBody = agentInput(
  "body",
  "Comment",
  "comment",
  "The comment Cogwork posts. Write it for the person who reported the issue.",
);

const trackerEvents = [
  item("issue-opened", "Issue opened"),
  item("issue-labelled", "Issue labelled", ["needs-triage", "ready-for-agent", "needs-info", "Any label"]),
  item("issue-commented", "Issue commented"),
  item("issue-closed", "Issue closed"),
];

export const triggerCatalog: Catalog = [
  {
    id: "schedule",
    name: "Schedule",
    icon: "schedule",
    items: [
      item("hourly", "Every hour"),
      item("daily", "Every day", ["08:00", "12:00", "18:00"]),
      item("weekly", "Every week", ["Monday", "Wednesday", "Friday"]),
    ],
    connectorOnly: [],
  },
  {
    id: "github",
    name: "GitHub",
    icon: "github",
    items: trackerEvents,
    connectorOnly: [
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
    items: trackerEvents,
    connectorOnly: [item("status", "Moved to status", ["Todo", "In progress", "In review", "Done"])],
  },
  {
    id: "slack",
    name: "Slack",
    icon: "slack",
    items: [
      item("directed", "Message directed at me"),
      item("channel", "Message in a channel", ["#engineering", "#product"]),
      item("reaction", "Reaction added", ["👀", "✅"]),
    ],
    connectorOnly: [],
  },
  {
    id: "granola",
    name: "Granola",
    icon: "granola",
    items: [item("transcript", "Transcript ingested"), item("meeting", "Meeting ended")],
    connectorOnly: [],
  },
  {
    id: "webhook",
    name: "Webhook",
    icon: "webhook",
    items: [item("received", "Webhook received")],
    connectorOnly: [],
  },
];

export const actionCatalog: Catalog = [
  {
    id: "github",
    name: "GitHub",
    icon: "github",
    items: [
      item("create-issue", "Create an issue", [], [issueTitle, issueBody]),
      item("comment", "Post a comment", [], [commentBody]),
      item("label", "Add a label", [
        "needs-triage",
        "ready-for-agent",
        "needs-info",
        "ready-for-human",
        "wontfix",
        "blocked",
      ]),
      item("close", "Close the issue"),
    ],
    connectorOnly: [
      item(
        "open-pr",
        "Open a pull request",
        [],
        [
          agentInput("title", "Title", "pr_title", "The pull request title."),
          agentInput("body", "Description", "pr_body", "What changed and why, written for the reviewer."),
        ],
      ),
      item("request-review", "Request a review"),
    ],
  },
  {
    id: "linear",
    name: "Linear",
    icon: "linear",
    items: [
      item("create-issue", "Create an issue", [], [issueTitle, issueBody]),
      item("comment", "Post a comment", [], [commentBody]),
      item("close", "Close the issue"),
    ],
    connectorOnly: [item("status", "Move to status", ["Todo", "In progress", "In review", "Done"])],
  },
  {
    id: "slack",
    name: "Slack",
    icon: "slack",
    items: [
      item(
        "send",
        "Send a message",
        ["#engineering", "#product"],
        [
          agentInput(
            "message",
            "Message",
            "slack_message",
            "The message to post, in two sentences or fewer.",
          ),
        ],
      ),
      item(
        "reply",
        "Reply in thread",
        [],
        [agentInput("message", "Reply", "slack_reply", "The reply to post in the thread.")],
      ),
    ],
    connectorOnly: [],
  },
  {
    id: "cogwork",
    name: "Cogwork",
    icon: "cogwork",
    items: [
      item(
        "notify",
        "Notify me",
        [],
        [agentInput("message", "Message", "notification", "One line that says what needs my attention.")],
      ),
      item(
        "approve",
        "Wait for my approval",
        [],
        [
          agentInput(
            "question",
            "Question",
            "approval_request",
            "What you want me to approve, and what happens when I do.",
          ),
        ],
      ),
      item("stop", "Stop"),
    ],
    connectorOnly: [],
  },
];

export const choiceOf = (group: CatalogGroup, entry: CatalogItem, optionName: string | null) => ({
  groupId: group.id,
  groupName: group.name,
  icon: group.icon,
  itemId: entry.id,
  itemName: entry.name,
  optionName,
  agentInputs: entry.agentInputs,
});

export const choiceKey = (choice: CatalogChoice) =>
  `${choice.groupId}/${choice.itemId}/${choice.optionName ?? ""}`;

export const sameChoice = (a: CatalogChoice, b: CatalogChoice) => choiceKey(a) === choiceKey(b);

const entriesOf = (group: CatalogGroup) => [...group.items, ...group.connectorOnly];

export const allChoicesIn = (catalog: Catalog) =>
  catalog.flatMap((group) =>
    entriesOf(group).flatMap((entry) =>
      entry.options.length === 0
        ? [choiceOf(group, entry, null)]
        : entry.options.map((option) => choiceOf(group, entry, option)),
    ),
  );

interface OperationRef {
  readonly id: string;
  readonly name: string;
}

const operationsGroupId = "operations";

const operationsGroup = (operations: readonly OperationRef[]): CatalogGroup => ({
  id: operationsGroupId,
  name: "Run an Operation",
  icon: "operation",
  items: operations.map((operation) => item(operation.id, operation.name)),
  connectorOnly: [],
});

export const isHandOff = (choice: CatalogChoice) => choice.groupId === operationsGroupId;

export const withOperations = (catalog: Catalog, operations: readonly OperationRef[]) =>
  operations.length === 0 ? catalog : [operationsGroup(operations), ...catalog];

export const handOffTo = (operation: OperationRef) =>
  choiceOf(operationsGroup([]), item(operation.id, operation.name), null);

const pickFrom = (catalog: Catalog, groupId: string, itemId: string, optionName: string | null) => {
  const group = catalog.find((candidate) => candidate.id === groupId);
  const entry = group && entriesOf(group).find((candidate) => candidate.id === itemId);
  if (!group || !entry) throw new Error(`No catalog entry ${groupId}/${itemId}`);
  return choiceOf(group, entry, optionName);
};

export const pickAction = (groupId: string, itemId: string, optionName: string | null = null) =>
  pickFrom(actionCatalog, groupId, itemId, optionName);

export const pickTrigger = (groupId: string, itemId: string, optionName: string | null = null) =>
  pickFrom(triggerCatalog, groupId, itemId, optionName);
