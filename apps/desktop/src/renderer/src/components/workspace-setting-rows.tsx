import type { Connection } from "@cogwork/contracts";
import { Button } from "@cogwork/ui/components/button";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldTitle } from "@cogwork/ui/components/field";
import { Input } from "@cogwork/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@cogwork/ui/components/select";
import { Switch } from "@cogwork/ui/components/switch";
import { Textarea } from "@cogwork/ui/components/textarea";
import { Link } from "@tanstack/react-router";
import { createContext, type ReactNode, use } from "react";
import type { WorkspaceRecordDraft } from "../features/workspace-record";

export type PatchDraft = (next: Partial<WorkspaceRecordDraft>) => void;

export interface WorkspaceRecordValue {
  readonly state: { readonly draft: WorkspaceRecordDraft; readonly connections: readonly Connection[] };
  readonly actions: { readonly patch: PatchDraft };
  readonly meta: { readonly disabled: boolean };
}

const WorkspaceRecordContext = createContext<WorkspaceRecordValue | null>(null);

function useWorkspaceRecord() {
  const value = use(WorkspaceRecordContext);
  if (!value) throw new Error("Workspace record rows must render inside a WorkspaceRecord.Provider");
  return value;
}

function WorkspaceRecordProvider({
  value,
  children,
}: {
  readonly value: WorkspaceRecordValue;
  readonly children: ReactNode;
}) {
  return <WorkspaceRecordContext value={value}>{children}</WorkspaceRecordContext>;
}

const WorkspaceField = {
  Root: Field,
  Content: FieldContent,
  Description: FieldDescription,
  Group: FieldGroup,
  Title: FieldTitle,
};

function DraftInput({
  field,
  label,
  placeholder,
  type = "text",
}: {
  readonly field: keyof WorkspaceRecordDraft;
  readonly label: string;
  readonly placeholder?: string;
  readonly type?: "text" | "number";
}) {
  const {
    state: { draft },
    actions: { patch },
    meta: { disabled },
  } = useWorkspaceRecord();
  const value = draft[field];
  if (typeof value !== "string") return null;
  return (
    <Input
      aria-label={label}
      value={value}
      placeholder={placeholder}
      type={type}
      className="w-80"
      disabled={disabled}
      onChange={(event) => patch({ [field]: event.target.value })}
    />
  );
}

function DraftTextarea({
  field,
  label,
  placeholder,
}: {
  readonly field: keyof WorkspaceRecordDraft;
  readonly label: string;
  readonly placeholder?: string;
}) {
  const {
    state: { draft },
    actions: { patch },
    meta: { disabled },
  } = useWorkspaceRecord();
  const value = draft[field];
  if (typeof value !== "string") return null;
  return (
    <Textarea
      aria-label={label}
      value={value}
      placeholder={placeholder}
      className="w-80"
      disabled={disabled}
      onChange={(event) => patch({ [field]: event.target.value })}
    />
  );
}

export const connectionItems = (connections: readonly Connection[], system: "github" | "linear") =>
  connections
    .filter((connection) => connection.system === system)
    .map((connection) => ({ value: connection.id, label: connection.account }));

export const trackerSelectionPatch = (
  connections: readonly Connection[],
  issueTrackerType: "github" | "linear",
) => ({
  issueTrackerType,
  issueTrackerConnectionId: connectionItems(connections, issueTrackerType)[0]?.value ?? "unbound",
});

function ConnectionSelect({
  system,
  field,
  label,
}: {
  readonly system: "github" | "linear";
  readonly field: "issueTrackerConnectionId" | "sourceControlConnectionId";
  readonly label: string;
}) {
  const {
    state: { draft, connections },
    actions: { patch },
    meta: { disabled },
  } = useWorkspaceRecord();
  const items = connectionItems(connections, system);
  const placeholder = items.length === 0 ? "None established yet" : "Choose Connection";
  return (
    <WorkspaceField.Group className="w-auto gap-2">
      <Select
        items={items}
        value={draft[field]}
        disabled={disabled}
        onValueChange={(value) => {
          if (typeof value === "string") patch({ [field]: value });
        }}
      >
        <SelectTrigger aria-label={label} className="w-56">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {items.length === 0 ? (
        <Button nativeButton={false} variant="link" size="sm" render={<Link to="/connections" />}>
          Establish Connection
        </Button>
      ) : null}
    </WorkspaceField.Group>
  );
}

function CheckoutRows() {
  return (
    <WorkspaceField.Root orientation="responsive">
      <WorkspaceField.Content>
        <WorkspaceField.Title>Checkout path</WorkspaceField.Title>
        <WorkspaceField.Description>
          Change it to re-bind. Every setting and Run survives the move.
        </WorkspaceField.Description>
      </WorkspaceField.Content>
      <DraftInput field="checkoutPath" label="Checkout path" placeholder="/Users/you/sites/cogwork" />
    </WorkspaceField.Root>
  );
}

function IdentityRows() {
  return (
    <WorkspaceField.Group>
      <WorkspaceField.Root orientation="responsive">
        <WorkspaceField.Content>
          <WorkspaceField.Title>Name</WorkspaceField.Title>
          <WorkspaceField.Description>The name shown across Cogwork.</WorkspaceField.Description>
        </WorkspaceField.Content>
        <DraftInput field="displayName" label="Workspace name" />
      </WorkspaceField.Root>
      <WorkspaceField.Root orientation="responsive">
        <WorkspaceField.Content>
          <WorkspaceField.Title>Git remote</WorkspaceField.Title>
          <WorkspaceField.Description>
            Clone hint used when Cogwork creates another checkout.
          </WorkspaceField.Description>
        </WorkspaceField.Content>
        <DraftInput field="gitRemote" label="Git remote" placeholder="git@github.com:org/repo.git" />
      </WorkspaceField.Root>
    </WorkspaceField.Group>
  );
}

function IssueTrackerRows() {
  const {
    state: { draft, connections },
    actions: { patch },
    meta: { disabled },
  } = useWorkspaceRecord();
  const trackerItems = [
    { value: "github", label: "GitHub Issues" },
    { value: "linear", label: "Linear" },
  ];
  return (
    <WorkspaceField.Group>
      <WorkspaceField.Root orientation="responsive">
        <WorkspaceField.Content>
          <WorkspaceField.Title>Tracker</WorkspaceField.Title>
          <WorkspaceField.Description>
            The system that owns this workspace's work items.
          </WorkspaceField.Description>
        </WorkspaceField.Content>
        <Select
          items={trackerItems}
          value={draft.issueTrackerType}
          disabled={disabled}
          onValueChange={(value) => {
            if (value === "github" || value === "linear") patch(trackerSelectionPatch(connections, value));
          }}
        >
          <SelectTrigger aria-label="Issue tracker" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {trackerItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </WorkspaceField.Root>
      <WorkspaceField.Root orientation="responsive">
        <WorkspaceField.Content>
          <WorkspaceField.Title>Connection</WorkspaceField.Title>
          <WorkspaceField.Description>
            Credentials stay in Connections; this record keeps only the reference.
          </WorkspaceField.Description>
        </WorkspaceField.Content>
        <ConnectionSelect
          system={draft.issueTrackerType}
          field="issueTrackerConnectionId"
          label="Issue tracker Connection"
        />
      </WorkspaceField.Root>
      <WorkspaceField.Root orientation="responsive">
        <WorkspaceField.Content>
          <WorkspaceField.Title>Repository</WorkspaceField.Title>
          <WorkspaceField.Description>
            Tracker-native repository target, when the tracker needs one.
          </WorkspaceField.Description>
        </WorkspaceField.Content>
        <DraftInput field="issueTrackerRepo" label="Issue tracker repository" placeholder="org/repo" />
      </WorkspaceField.Root>
      {draft.issueTrackerType === "linear" ? (
        <WorkspaceField.Group>
          <WorkspaceField.Root orientation="responsive">
            <WorkspaceField.Content>
              <WorkspaceField.Title>Teams</WorkspaceField.Title>
              <WorkspaceField.Description>Comma-separated Linear team keys.</WorkspaceField.Description>
            </WorkspaceField.Content>
            <DraftInput field="teams" label="Linear teams" placeholder="ENG, APP" />
          </WorkspaceField.Root>
          <WorkspaceField.Root orientation="responsive">
            <WorkspaceField.Content>
              <WorkspaceField.Title>Organization</WorkspaceField.Title>
              <WorkspaceField.Description>Optional Linear organization key.</WorkspaceField.Description>
            </WorkspaceField.Content>
            <DraftInput field="organization" label="Linear organization" />
          </WorkspaceField.Root>
          <WorkspaceField.Root orientation="responsive">
            <WorkspaceField.Content>
              <WorkspaceField.Title>Read comment history</WorkspaceField.Title>
              <WorkspaceField.Description>
                Let reconciliation use earlier Linear comments.
              </WorkspaceField.Description>
            </WorkspaceField.Content>
            <Switch
              aria-label="Read comment history"
              checked={draft.linearHistory}
              disabled={disabled}
              onCheckedChange={(linearHistory) => patch({ linearHistory })}
            />
          </WorkspaceField.Root>
        </WorkspaceField.Group>
      ) : null}
      <WorkspaceField.Root orientation="responsive">
        <WorkspaceField.Content>
          <WorkspaceField.Title>Actor login</WorkspaceField.Title>
          <WorkspaceField.Description>GitHub identity Cogwork acts as.</WorkspaceField.Description>
        </WorkspaceField.Content>
        <DraftInput field="trackerActorLogin" label="Tracker actor login" />
      </WorkspaceField.Root>
      <WorkspaceField.Root orientation="responsive">
        <WorkspaceField.Content>
          <WorkspaceField.Title>Actor user id</WorkspaceField.Title>
          <WorkspaceField.Description>Linear identity Cogwork acts as.</WorkspaceField.Description>
        </WorkspaceField.Content>
        <DraftInput field="trackerActorUserId" label="Tracker actor user id" />
      </WorkspaceField.Root>
      <WorkspaceField.Root orientation="responsive">
        <WorkspaceField.Content>
          <WorkspaceField.Title>Priority project</WorkspaceField.Title>
          <WorkspaceField.Description>Optional GitHub project number and field.</WorkspaceField.Description>
        </WorkspaceField.Content>
        <WorkspaceField.Group className="w-auto">
          <DraftInput field="priorityProject" label="Priority project number" type="number" />
          <DraftInput field="priorityField" label="Priority field" />
        </WorkspaceField.Group>
      </WorkspaceField.Root>
    </WorkspaceField.Group>
  );
}

function TriageRows() {
  return (
    <WorkspaceField.Group>
      <WorkspaceField.Root orientation="responsive">
        <WorkspaceField.Content>
          <WorkspaceField.Title>Assignee allowlist</WorkspaceField.Title>
          <WorkspaceField.Description>
            Comma-separated identities whose work Cogwork may take.
          </WorkspaceField.Description>
        </WorkspaceField.Content>
        <DraftInput field="assigneeAllowlist" label="Assignee allowlist" />
      </WorkspaceField.Root>
      <WorkspaceField.Root orientation="responsive">
        <WorkspaceField.Content>
          <WorkspaceField.Title>Bot allowlist</WorkspaceField.Title>
          <WorkspaceField.Description>
            Comma-separated bot logins whose comments may wake follow-up.
          </WorkspaceField.Description>
        </WorkspaceField.Content>
        <DraftInput field="trackerBotAllowlist" label="Tracker bot allowlist" />
      </WorkspaceField.Root>
      <WorkspaceField.Root orientation="responsive">
        <WorkspaceField.Content>
          <WorkspaceField.Title>Role labels</WorkspaceField.Title>
          <WorkspaceField.Description>
            The five labels that move work through triage.
          </WorkspaceField.Description>
        </WorkspaceField.Content>
        <WorkspaceField.Group className="w-auto">
          <DraftInput field="needsTriageLabel" label="Needs triage label" placeholder="needs-triage" />
          <DraftInput
            field="readyForAgentLabel"
            label="Ready for agent label"
            placeholder="ready-for-agent"
          />
          <DraftInput field="needsInfoLabel" label="Needs info label" placeholder="needs-info" />
          <DraftInput
            field="readyForHumanLabel"
            label="Ready for human label"
            placeholder="ready-for-human"
          />
          <DraftInput field="wontfixLabel" label="Won't fix label" placeholder="wontfix" />
        </WorkspaceField.Group>
      </WorkspaceField.Root>
    </WorkspaceField.Group>
  );
}

function SourceControlRows() {
  const {
    state: { draft },
    actions: { patch },
    meta: { disabled },
  } = useWorkspaceRecord();
  const items = [
    { value: "none", label: "Not bound" },
    { value: "github", label: "GitHub" },
  ];
  return (
    <WorkspaceField.Group>
      <WorkspaceField.Root orientation="responsive">
        <WorkspaceField.Content>
          <WorkspaceField.Title>Provider</WorkspaceField.Title>
          <WorkspaceField.Description>
            The read-only provider that reports pull request state.
          </WorkspaceField.Description>
        </WorkspaceField.Content>
        <Select
          items={items}
          value={draft.sourceControlType}
          disabled={disabled}
          onValueChange={(value) => {
            if (value === "none" || value === "github") patch({ sourceControlType: value });
          }}
        >
          <SelectTrigger aria-label="Source control provider" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </WorkspaceField.Root>
      {draft.sourceControlType === "github" ? (
        <WorkspaceField.Group>
          <WorkspaceField.Root orientation="responsive">
            <WorkspaceField.Content>
              <WorkspaceField.Title>Connection</WorkspaceField.Title>
              <WorkspaceField.Description>
                GitHub credentials used to read pull requests.
              </WorkspaceField.Description>
            </WorkspaceField.Content>
            <ConnectionSelect
              system="github"
              field="sourceControlConnectionId"
              label="Source control Connection"
            />
          </WorkspaceField.Root>
          <WorkspaceField.Root orientation="responsive">
            <WorkspaceField.Content>
              <WorkspaceField.Title>Repository</WorkspaceField.Title>
              <WorkspaceField.Description>
                Repository whose pull requests belong to this workspace.
              </WorkspaceField.Description>
            </WorkspaceField.Content>
            <DraftInput field="sourceControlRepo" label="Source control repository" placeholder="org/repo" />
          </WorkspaceField.Root>
          <WorkspaceField.Root orientation="responsive">
            <WorkspaceField.Content>
              <WorkspaceField.Title>Actor login</WorkspaceField.Title>
              <WorkspaceField.Description>
                Login used to identify Cogwork's own pull request comments.
              </WorkspaceField.Description>
            </WorkspaceField.Content>
            <DraftInput field="sourceControlActorLogin" label="Source control actor login" />
          </WorkspaceField.Root>
          <WorkspaceField.Root orientation="responsive">
            <WorkspaceField.Content>
              <WorkspaceField.Title>Bot allowlist</WorkspaceField.Title>
              <WorkspaceField.Description>
                Comma-separated bots allowed to wake follow-up.
              </WorkspaceField.Description>
            </WorkspaceField.Content>
            <DraftInput field="sourceControlBotAllowlist" label="Source control bot allowlist" />
          </WorkspaceField.Root>
        </WorkspaceField.Group>
      ) : null}
    </WorkspaceField.Group>
  );
}

function WorktreeRows() {
  return (
    <WorkspaceField.Group>
      <WorkspaceField.Root orientation="responsive">
        <WorkspaceField.Content>
          <WorkspaceField.Title>Root</WorkspaceField.Title>
          <WorkspaceField.Description>
            Directory where managed worktrees are created.
          </WorkspaceField.Description>
        </WorkspaceField.Content>
        <DraftInput field="worktreeRoot" label="Worktree root" />
      </WorkspaceField.Root>
      <WorkspaceField.Root orientation="responsive">
        <WorkspaceField.Content>
          <WorkspaceField.Title>Remote</WorkspaceField.Title>
          <WorkspaceField.Description>Git remote used for managed branches.</WorkspaceField.Description>
        </WorkspaceField.Content>
        <DraftInput field="worktreeRemote" label="Worktree remote" placeholder="origin" />
      </WorkspaceField.Root>
      <WorkspaceField.Root orientation="responsive">
        <WorkspaceField.Content>
          <WorkspaceField.Title>Base branch</WorkspaceField.Title>
          <WorkspaceField.Description>Branch new work starts from.</WorkspaceField.Description>
        </WorkspaceField.Content>
        <DraftInput field="worktreeBaseBranch" label="Worktree base branch" placeholder="main" />
      </WorkspaceField.Root>
      <WorkspaceField.Root orientation="responsive">
        <WorkspaceField.Content>
          <WorkspaceField.Title>Linked paths</WorkspaceField.Title>
          <WorkspaceField.Description>
            One path per line, linked into each worktree.
          </WorkspaceField.Description>
        </WorkspaceField.Content>
        <DraftTextarea field="worktreeLinkPaths" label="Worktree linked paths" />
      </WorkspaceField.Root>
      <WorkspaceField.Root orientation="responsive">
        <WorkspaceField.Content>
          <WorkspaceField.Title>Setup commands</WorkspaceField.Title>
          <WorkspaceField.Description>One command per line, run in order.</WorkspaceField.Description>
        </WorkspaceField.Content>
        <DraftTextarea field="worktreeSetup" label="Worktree setup commands" />
      </WorkspaceField.Root>
      <WorkspaceField.Root orientation="responsive">
        <WorkspaceField.Content>
          <WorkspaceField.Title>Delete after</WorkspaceField.Title>
          <WorkspaceField.Description>
            Idle milliseconds before a managed worktree is reaped.
          </WorkspaceField.Description>
        </WorkspaceField.Content>
        <DraftInput
          field="worktreeReapAfterMillis"
          label="Delete worktree after milliseconds"
          type="number"
        />
      </WorkspaceField.Root>
    </WorkspaceField.Group>
  );
}

function RunRows() {
  return (
    <WorkspaceField.Group>
      <WorkspaceField.Root orientation="responsive">
        <WorkspaceField.Content>
          <WorkspaceField.Title>Concurrency</WorkspaceField.Title>
          <WorkspaceField.Description>
            Maximum Runs this workspace may have in flight.
          </WorkspaceField.Description>
        </WorkspaceField.Content>
        <DraftInput field="concurrency" label="Workspace concurrency" type="number" />
      </WorkspaceField.Root>
      <WorkspaceField.Root orientation="responsive">
        <WorkspaceField.Content>
          <WorkspaceField.Title>MCP skills</WorkspaceField.Title>
          <WorkspaceField.Description>
            Schema-decoded JSON array of MCP capabilities supplied to Runs.
          </WorkspaceField.Description>
        </WorkspaceField.Content>
        <DraftTextarea field="mcpSkills" label="MCP skills" placeholder="[]" />
      </WorkspaceField.Root>
    </WorkspaceField.Group>
  );
}

export const WorkspaceRecord = {
  Provider: WorkspaceRecordProvider,
  CheckoutRows,
  IdentityRows,
  IssueTrackerRows,
  TriageRows,
  SourceControlRows,
  WorktreeRows,
  RunRows,
};
