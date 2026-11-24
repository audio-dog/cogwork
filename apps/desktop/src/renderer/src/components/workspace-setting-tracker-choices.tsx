import type {
  Connection,
  ConnectionBindingId,
  GitHubPriorityField,
  IssueTrackerPerson,
  LinearTeam,
  WorkspaceId,
} from "@cogwork/contracts";
import { Alert, AlertDescription, AlertTitle } from "@cogwork/ui/components/alert";
import { Button } from "@cogwork/ui/components/button";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "@cogwork/ui/components/combobox";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldTitle } from "@cogwork/ui/components/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@cogwork/ui/components/select";
import { Skeleton } from "@cogwork/ui/components/skeleton";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type * as Cause from "effect/Cause";
import type { ReactNode } from "react";

import { githubPriorityFieldsAtom, issueTrackerPeopleAtom, linearTeamsAtom } from "../daemon/atoms";
import { daemonFailureMessage } from "../features/daemon-failure";
import type { WorkspaceRecordDraft } from "../features/workspace-record";
import { useWorkspaceRecord } from "./workspace-record-context";

const trackerConnection = (draft: WorkspaceRecordDraft, connections: readonly Connection[]) =>
  connections.find(({ id }) => id === draft.issueTrackerConnectionId)?.id ?? "unbound";

function TrackerLoadFailure({
  cause,
  onRetry,
  children,
}: {
  readonly cause: Cause.Cause<unknown>;
  readonly onRetry: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Alert variant="destructive" className="max-w-80">
      <AlertTitle>{children}</AlertTitle>
      <AlertDescription>{daemonFailureMessage(cause)}</AlertDescription>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </Alert>
  );
}

export const priorityFieldItems = (fields: readonly GitHubPriorityField[], selected: string) => {
  const selectedIsAvailable = fields.some((field) => field.id.toString() === selected);
  const unavailable =
    selected === "" || selectedIsAvailable
      ? []
      : [{ value: selected, label: `Unavailable field #${selected}` }];
  return [
    { value: "none", label: "Do not order by priority" },
    ...unavailable,
    ...fields.map((field) => ({ value: field.id.toString(), label: field.name })),
  ];
};

function PriorityFieldSelect({ fields }: { readonly fields: readonly GitHubPriorityField[] }) {
  const {
    state: { draft },
    actions: { patch },
    meta: { disabled },
  } = useWorkspaceRecord();
  const items = priorityFieldItems(fields, draft.priorityFieldId);
  return (
    <Select
      items={items}
      value={draft.priorityFieldId || "none"}
      disabled={disabled}
      onValueChange={(value) => patch({ priorityFieldId: !value || value === "none" ? "" : value })}
    >
      <SelectTrigger aria-label="Priority issue field" className="w-80">
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
  );
}

function LivePriorityFieldSelect({
  workspace,
  connection,
}: {
  readonly workspace: WorkspaceId;
  readonly connection: ConnectionBindingId;
}) {
  const atom = githubPriorityFieldsAtom(workspace, connection);
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  if (result._tag === "Success") return <PriorityFieldSelect fields={result.value} />;
  if (result._tag !== "Failure") return <Skeleton className="h-9 w-80" />;
  return (
    <FieldGroup className="w-auto gap-2">
      <PriorityFieldSelect fields={[]} />
      <TrackerLoadFailure cause={result.cause} onRetry={refresh}>
        Could not load priority fields
      </TrackerLoadFailure>
    </FieldGroup>
  );
}

export function PriorityFieldRow() {
  const {
    state: { draft, connections },
    meta: { disabled, workspace },
  } = useWorkspaceRecord();
  if (draft.issueTrackerType !== "github") return null;
  const connection = trackerConnection(draft, connections);
  return (
    <Field orientation="responsive" data-disabled={disabled}>
      <FieldContent>
        <FieldTitle>Priority</FieldTitle>
        <FieldDescription>
          Optional organization issue field used to order work within a Workflow.
        </FieldDescription>
      </FieldContent>
      {workspace ? (
        <LivePriorityFieldSelect workspace={workspace} connection={connection} />
      ) : (
        <FieldGroup className="w-auto gap-2">
          <PriorityFieldSelect fields={[]} />
          <FieldDescription>Register this workspace to load fields.</FieldDescription>
        </FieldGroup>
      )}
    </Field>
  );
}

function LinearTeamsSelect({ items }: { readonly items: readonly ChipChoice[] }) {
  return (
    <DraftChipsSelect
      field="teams"
      items={items}
      label="Linear teams"
      placeholder="Choose teams"
      empty="No teams found."
    />
  );
}

function LiveLinearTeamsSelect({
  workspace,
  connection,
}: {
  readonly workspace: WorkspaceId;
  readonly connection: ConnectionBindingId;
}) {
  const {
    state: { draft },
  } = useWorkspaceRecord();
  const atom = linearTeamsAtom(workspace, connection);
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  if (result._tag === "Success") return <LinearTeamsSelect items={teamItems(result.value, draft.teams)} />;
  if (result._tag !== "Failure") return <Skeleton className="h-9 w-80" />;
  return (
    <FieldGroup className="w-auto gap-2">
      <LinearTeamsSelect items={unloadedItems(draft.teams)} />
      <TrackerLoadFailure cause={result.cause} onRetry={refresh}>
        Could not load teams
      </TrackerLoadFailure>
    </FieldGroup>
  );
}

export function LinearTeamsRow() {
  const {
    state: { draft, connections },
    meta: { disabled, workspace },
  } = useWorkspaceRecord();
  return (
    <Field orientation="responsive" data-disabled={disabled}>
      <FieldContent>
        <FieldTitle>Teams</FieldTitle>
        <FieldDescription>Linear teams whose work items this workspace reads.</FieldDescription>
      </FieldContent>
      {workspace ? (
        <LiveLinearTeamsSelect workspace={workspace} connection={trackerConnection(draft, connections)} />
      ) : (
        <FieldGroup className="w-auto gap-2">
          <LinearTeamsSelect items={unloadedItems(draft.teams)} />
          <FieldDescription>Register this workspace to load teams.</FieldDescription>
        </FieldGroup>
      )}
    </Field>
  );
}

interface ChipChoice {
  readonly value: string;
  readonly label: string;
}

const withUnknownChoices = (choices: readonly ChipChoice[], selected: readonly string[]) => {
  const listed = new Set(choices.map(({ value }) => value));
  const unknown = selected
    .filter((value) => !listed.has(value))
    .map((value) => ({ value, label: `Unknown: ${value}` }));
  return [...unknown, ...choices];
};

export const assigneeItems = (people: readonly IssueTrackerPerson[], selected: readonly string[]) =>
  withUnknownChoices(
    people.map(({ identity, label }) => ({ value: identity, label })),
    selected,
  );

export const teamItems = (teams: readonly LinearTeam[], selected: readonly string[]) =>
  withUnknownChoices(
    teams.map(({ key, name }) => ({ value: key, label: `${name} (${key})` })),
    selected,
  );

export const unloadedItems = (selected: readonly string[]) =>
  selected.map((value) => ({ value, label: value }));

function DraftChipsSelect({
  field,
  items,
  label,
  placeholder,
  empty,
}: {
  readonly field: "assigneeAllowlist" | "teams";
  readonly items: readonly ChipChoice[];
  readonly label: string;
  readonly placeholder: string;
  readonly empty: string;
}) {
  const {
    state: { draft },
    actions: { patch },
    meta: { disabled },
  } = useWorkspaceRecord();
  const anchor = useComboboxAnchor();
  const labels = new Map(items.map((item) => [item.value, item.label]));
  const labelOf = (value: string) => labels.get(value) ?? value;
  return (
    <Combobox
      multiple
      items={items.map(({ value }) => value)}
      value={[...draft[field]]}
      disabled={disabled}
      itemToStringLabel={labelOf}
      onValueChange={(values) => patch({ [field]: values })}
    >
      <ComboboxChips ref={anchor} className="w-80">
        <ComboboxValue>
          {(values: readonly string[]) => (
            <>
              {values.map((value) => (
                <ComboboxChip key={value}>{labelOf(value)}</ComboboxChip>
              ))}
              <ComboboxChipsInput aria-label={label} placeholder={placeholder} />
            </>
          )}
        </ComboboxValue>
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>{empty}</ComboboxEmpty>
        <ComboboxList>
          {(value: string) => (
            <ComboboxItem key={value} value={value}>
              {labelOf(value)}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function AssigneeAllowlistSelect({ items }: { readonly items: readonly ChipChoice[] }) {
  return (
    <DraftChipsSelect
      field="assigneeAllowlist"
      items={items}
      label="Assignee allowlist"
      placeholder="Choose people"
      empty="No people found."
    />
  );
}

function LiveAssigneeAllowlistSelect({
  workspace,
  connection,
}: {
  readonly workspace: WorkspaceId;
  readonly connection: ConnectionBindingId;
}) {
  const {
    state: { draft },
  } = useWorkspaceRecord();
  const atom = issueTrackerPeopleAtom(workspace, connection);
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  if (result._tag === "Success") {
    return <AssigneeAllowlistSelect items={assigneeItems(result.value, draft.assigneeAllowlist)} />;
  }
  if (result._tag !== "Failure") return <Skeleton className="h-9 w-80" />;
  return (
    <FieldGroup className="w-auto gap-2">
      <AssigneeAllowlistSelect items={unloadedItems(draft.assigneeAllowlist)} />
      <TrackerLoadFailure cause={result.cause} onRetry={refresh}>
        Could not load people
      </TrackerLoadFailure>
    </FieldGroup>
  );
}

export function AssigneeAllowlistRow() {
  const {
    state: { draft, connections },
    meta: { disabled, workspace },
  } = useWorkspaceRecord();
  return (
    <Field orientation="responsive" data-disabled={disabled}>
      <FieldContent>
        <FieldTitle>Assignee allowlist</FieldTitle>
        <FieldDescription>People whose assigned work Cogwork may take.</FieldDescription>
      </FieldContent>
      {workspace ? (
        <LiveAssigneeAllowlistSelect
          workspace={workspace}
          connection={trackerConnection(draft, connections)}
        />
      ) : (
        <FieldGroup className="w-auto gap-2">
          <AssigneeAllowlistSelect items={unloadedItems(draft.assigneeAllowlist)} />
          <FieldDescription>Register this workspace to load people.</FieldDescription>
        </FieldGroup>
      )}
    </Field>
  );
}
