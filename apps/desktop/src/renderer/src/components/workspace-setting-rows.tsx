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
    .map((connection) => ({
      value: connection.id,
      label: connection.account,
      disabled: connection.status !== "established",
    }));

const establishedConnectionId = (connections: readonly Connection[], system: "github" | "linear") =>
  connectionItems(connections, system).find((item) => !item.disabled)?.value ?? "unbound";

export const trackerSelectionPatch = (
  connections: readonly Connection[],
  issueTrackerType: "github" | "linear",
) => ({
  issueTrackerType,
  issueTrackerConnectionId: establishedConnectionId(connections, issueTrackerType),
});

export const sourceControlSelectionPatch = (
  connections: readonly Connection[],
  sourceControlType: "none" | "github",
) => {
  if (sourceControlType === "none") {
    return { sourceControlType, sourceControlConnectionId: "unbound" };
  }
  return {
    sourceControlType,
    sourceControlConnectionId: establishedConnectionId(connections, sourceControlType),
  };
};

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
  const hasEstablishedConnection = items.some((item) => !item.disabled);
  const placeholder = hasEstablishedConnection ? "Choose Connection" : "None established yet";
  return (
    <FieldGroup className="w-auto gap-2">
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
              <SelectItem key={item.value} value={item.value} disabled={item.disabled}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {hasEstablishedConnection ? null : (
        <Button nativeButton={false} variant="link" size="sm" render={<Link to="/connections" />}>
          Establish Connection
        </Button>
      )}
    </FieldGroup>
  );
}

function CheckoutRows() {
  return (
    <Field orientation="responsive">
      <FieldContent>
        <FieldTitle>Checkout path</FieldTitle>
        <FieldDescription>Change it to re-bind. Every setting and Run survives the move.</FieldDescription>
      </FieldContent>
      <DraftInput field="checkoutPath" label="Checkout path" placeholder="/Users/you/sites/cogwork" />
    </Field>
  );
}

function IdentityRows() {
  return (
    <FieldGroup>
      <Field orientation="responsive">
        <FieldContent>
          <FieldTitle>Name</FieldTitle>
          <FieldDescription>The name shown across Cogwork.</FieldDescription>
        </FieldContent>
        <DraftInput field="displayName" label="Workspace name" />
      </Field>
      <Field orientation="responsive">
        <FieldContent>
          <FieldTitle>Git remote</FieldTitle>
          <FieldDescription>Clone hint used when Cogwork creates another checkout.</FieldDescription>
        </FieldContent>
        <DraftInput field="gitRemote" label="Git remote" placeholder="git@github.com:org/repo.git" />
      </Field>
    </FieldGroup>
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
    <FieldGroup>
      <Field orientation="responsive">
        <FieldContent>
          <FieldTitle>Tracker</FieldTitle>
          <FieldDescription>The system that owns this workspace's work items.</FieldDescription>
        </FieldContent>
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
      </Field>
      <Field orientation="responsive">
        <FieldContent>
          <FieldTitle>Connection</FieldTitle>
          <FieldDescription>
            Credentials stay in Connections; this record keeps only the reference.
          </FieldDescription>
        </FieldContent>
        <ConnectionSelect
          system={draft.issueTrackerType}
          field="issueTrackerConnectionId"
          label="Issue tracker Connection"
        />
      </Field>
      {draft.issueTrackerType === "linear" ? (
        <FieldGroup>
          <Field orientation="responsive">
            <FieldContent>
              <FieldTitle>Teams</FieldTitle>
              <FieldDescription>Comma-separated Linear team keys.</FieldDescription>
            </FieldContent>
            <DraftInput field="teams" label="Linear teams" placeholder="ENG, APP" />
          </Field>
          <Field orientation="responsive">
            <FieldContent>
              <FieldTitle>Organization</FieldTitle>
              <FieldDescription>Optional Linear organization key.</FieldDescription>
            </FieldContent>
            <DraftInput field="organization" label="Linear organization" />
          </Field>
        </FieldGroup>
      ) : null}
      <Field orientation="responsive">
        <FieldContent>
          <FieldTitle>Actor login</FieldTitle>
          <FieldDescription>GitHub identity Cogwork acts as.</FieldDescription>
        </FieldContent>
        <DraftInput field="trackerActorLogin" label="Tracker actor login" />
      </Field>
      <Field orientation="responsive">
        <FieldContent>
          <FieldTitle>Actor user id</FieldTitle>
          <FieldDescription>Linear identity Cogwork acts as.</FieldDescription>
        </FieldContent>
        <DraftInput field="trackerActorUserId" label="Tracker actor user id" />
      </Field>
      <Field orientation="responsive">
        <FieldContent>
          <FieldTitle>Priority project</FieldTitle>
          <FieldDescription>Optional GitHub project number and field.</FieldDescription>
        </FieldContent>
        <FieldGroup className="w-auto">
          <DraftInput field="priorityProject" label="Priority project number" type="number" />
          <DraftInput field="priorityField" label="Priority field" />
        </FieldGroup>
      </Field>
    </FieldGroup>
  );
}

function TriageRows() {
  return (
    <FieldGroup>
      <Field orientation="responsive">
        <FieldContent>
          <FieldTitle>Assignee allowlist</FieldTitle>
          <FieldDescription>Comma-separated identities whose work Cogwork may take.</FieldDescription>
        </FieldContent>
        <DraftInput field="assigneeAllowlist" label="Assignee allowlist" />
      </Field>
      <Field orientation="responsive">
        <FieldContent>
          <FieldTitle>Bot allowlist</FieldTitle>
          <FieldDescription>Comma-separated bot logins whose comments may wake follow-up.</FieldDescription>
        </FieldContent>
        <DraftInput field="trackerBotAllowlist" label="Tracker bot allowlist" />
      </Field>
      <Field orientation="responsive">
        <FieldContent>
          <FieldTitle>Role labels</FieldTitle>
          <FieldDescription>The five labels that move work through triage.</FieldDescription>
        </FieldContent>
        <FieldGroup className="w-auto">
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
        </FieldGroup>
      </Field>
    </FieldGroup>
  );
}

function SourceControlRows() {
  const {
    state: { draft, connections },
    actions: { patch },
    meta: { disabled },
  } = useWorkspaceRecord();
  const items = [
    { value: "none", label: "Not bound" },
    { value: "github", label: "GitHub" },
  ];
  return (
    <FieldGroup>
      <Field orientation="responsive">
        <FieldContent>
          <FieldTitle>Provider</FieldTitle>
          <FieldDescription>The read-only provider that reports pull request state.</FieldDescription>
        </FieldContent>
        <Select
          items={items}
          value={draft.sourceControlType}
          disabled={disabled}
          onValueChange={(value) => {
            if (value === "none" || value === "github") {
              patch(sourceControlSelectionPatch(connections, value));
            }
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
      </Field>
      <Field orientation="responsive">
        <FieldContent>
          <FieldTitle>Linear history</FieldTitle>
          <FieldDescription>Rebase follow-up branches when the base diverges.</FieldDescription>
        </FieldContent>
        <Switch
          aria-label="Require linear history"
          checked={draft.linearHistory}
          disabled={disabled}
          onCheckedChange={(linearHistory) => patch({ linearHistory })}
        />
      </Field>
      {draft.sourceControlType === "github" ? (
        <FieldGroup>
          <Field orientation="responsive">
            <FieldContent>
              <FieldTitle>Connection</FieldTitle>
              <FieldDescription>GitHub credentials used to read pull requests.</FieldDescription>
            </FieldContent>
            <ConnectionSelect
              system="github"
              field="sourceControlConnectionId"
              label="Source control Connection"
            />
          </Field>
          <Field orientation="responsive">
            <FieldContent>
              <FieldTitle>Actor login</FieldTitle>
              <FieldDescription>Login used to identify Cogwork's own pull request comments.</FieldDescription>
            </FieldContent>
            <DraftInput field="sourceControlActorLogin" label="Source control actor login" />
          </Field>
          <Field orientation="responsive">
            <FieldContent>
              <FieldTitle>Bot allowlist</FieldTitle>
              <FieldDescription>Comma-separated bots allowed to wake follow-up.</FieldDescription>
            </FieldContent>
            <DraftInput field="sourceControlBotAllowlist" label="Source control bot allowlist" />
          </Field>
        </FieldGroup>
      ) : null}
    </FieldGroup>
  );
}

function WorktreeRows() {
  return (
    <FieldGroup>
      <Field orientation="responsive">
        <FieldContent>
          <FieldTitle>Root</FieldTitle>
          <FieldDescription>Directory where managed worktrees are created.</FieldDescription>
        </FieldContent>
        <DraftInput field="worktreeRoot" label="Worktree root" />
      </Field>
      <Field orientation="responsive">
        <FieldContent>
          <FieldTitle>Remote</FieldTitle>
          <FieldDescription>Git remote used for managed branches.</FieldDescription>
        </FieldContent>
        <DraftInput field="worktreeRemote" label="Worktree remote" placeholder="origin" />
      </Field>
      <Field orientation="responsive">
        <FieldContent>
          <FieldTitle>Base branch</FieldTitle>
          <FieldDescription>Branch new work starts from.</FieldDescription>
        </FieldContent>
        <DraftInput field="worktreeBaseBranch" label="Worktree base branch" placeholder="main" />
      </Field>
      <Field orientation="responsive">
        <FieldContent>
          <FieldTitle>Linked paths</FieldTitle>
          <FieldDescription>One path per line, linked into each worktree.</FieldDescription>
        </FieldContent>
        <DraftTextarea field="worktreeLinkPaths" label="Worktree linked paths" />
      </Field>
      <Field orientation="responsive">
        <FieldContent>
          <FieldTitle>Setup commands</FieldTitle>
          <FieldDescription>One command per line, run in order.</FieldDescription>
        </FieldContent>
        <DraftTextarea field="worktreeSetup" label="Worktree setup commands" />
      </Field>
      <Field orientation="responsive">
        <FieldContent>
          <FieldTitle>Delete after</FieldTitle>
          <FieldDescription>Idle milliseconds before a managed worktree is reaped.</FieldDescription>
        </FieldContent>
        <DraftInput
          field="worktreeReapAfterMillis"
          label="Delete worktree after milliseconds"
          type="number"
        />
      </Field>
    </FieldGroup>
  );
}

function RunRows() {
  return (
    <FieldGroup>
      <Field orientation="responsive">
        <FieldContent>
          <FieldTitle>Concurrency</FieldTitle>
          <FieldDescription>Maximum Runs this workspace may have in flight.</FieldDescription>
        </FieldContent>
        <DraftInput field="concurrency" label="Workspace concurrency" type="number" />
      </Field>
      <Field orientation="responsive">
        <FieldContent>
          <FieldTitle>MCP skills</FieldTitle>
          <FieldDescription>Schema-decoded JSON array of MCP capabilities supplied to Runs.</FieldDescription>
        </FieldContent>
        <DraftTextarea field="mcpSkills" label="MCP skills" placeholder="[]" />
      </Field>
    </FieldGroup>
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
