import {
  type Connection,
  type ConnectionSystem,
  maxSchedulerLimit,
  type WorkspaceId,
  type WorkspaceState,
} from "@cogwork/contracts";
import { Alert, AlertDescription, AlertTitle } from "@cogwork/ui/components/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@cogwork/ui/components/alert-dialog";
import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@cogwork/ui/components/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@cogwork/ui/components/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@cogwork/ui/components/field";
import { Input } from "@cogwork/ui/components/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@cogwork/ui/components/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@cogwork/ui/components/item";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@cogwork/ui/components/select";
import { Separator } from "@cogwork/ui/components/separator";
import { Spinner } from "@cogwork/ui/components/spinner";
import {
  RiAddLine,
  RiAlertLine,
  RiFolderTransferLine,
  RiGitRepositoryLine,
  RiSubtractLine,
} from "@remixicon/react";
import { type FormEvent, type ReactNode, useState } from "react";
import { minConcurrency, minDailyBudget, settingsOfflineFallbacks } from "../features/settings-defaults";
import { parseCount, sanitizeCountDraft } from "../features/settings-values";
import {
  absoluteCheckoutPathFrom,
  type WorkspaceTracker,
  workspaceOutcomeError,
  workspaceRegistrationFrom,
  workspaceSubmissionIsLocked,
  workspaceSubmissionStatus,
} from "../features/workspace-registration";
import { LiveWorkspacesProvider, useWorkspaces, WorkspacesProvider } from "./workspaces-provider";

export type { WorkspacesValue } from "./workspaces-provider";

const textFrom = (data: FormData, name: string) => {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
};

const registrationDraftFrom = (form: HTMLFormElement, tracker: WorkspaceTracker) => {
  const data = new FormData(form);
  return {
    name: textFrom(data, "name"),
    checkoutPath: textFrom(data, "checkoutPath"),
    gitRemote: textFrom(data, "gitRemote"),
    tracker,
    issueTrackerConnectionId: textFrom(data, "issueTrackerConnectionId"),
    repository: textFrom(data, "repository"),
    linearTeams: textFrom(data, "linearTeams"),
    linearOrganization: textFrom(data, "linearOrganization"),
    sourceControlRepository: textFrom(data, "sourceControlRepository"),
    sourceControlConnectionId: textFrom(data, "sourceControlConnectionId"),
  };
};

const workspaceTrackerFrom = (value: string | null) => {
  if (value === "github" || value === "linear") return value;
  return null;
};

const deregisterWorkspaceWarning =
  "Deregistering removes the registration, its private settings, and private authoring tree. Run history stays.";

const connectionsFor = (connections: readonly Connection[], system: ConnectionSystem) =>
  connections.filter((connection) => connection.system === system && connection.status === "established");

function GitHubTrackerConnectionField({ connections }: { readonly connections: readonly Connection[] }) {
  const invalid = connections.length === 0;
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor="workspace-github-connection">GitHub Connection</FieldLabel>
      <Select name="issueTrackerConnectionId" defaultValue={connections[0]?.id} required>
        <SelectTrigger id="workspace-github-connection" className="w-full" aria-invalid={invalid}>
          <SelectValue placeholder="Choose a Connection" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {connections.map((connection) => (
              <SelectItem key={connection.id} value={connection.id}>
                {connection.account}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {connections.length === 0 ? (
        <FieldDescription>Establish this Connection before registering the workspace.</FieldDescription>
      ) : null}
    </Field>
  );
}

function GitHubRegistrationFields({ connections }: { readonly connections: readonly Connection[] }) {
  return (
    <>
      <GitHubTrackerConnectionField connections={connections} />
      <Field>
        <FieldLabel htmlFor="workspace-repository">GitHub repository</FieldLabel>
        <Input id="workspace-repository" name="repository" placeholder="owner/repository" required />
        <FieldDescription>The issue repository this workspace watches.</FieldDescription>
      </Field>
    </>
  );
}

function LinearTrackerConnectionField({ connections }: { readonly connections: readonly Connection[] }) {
  const invalid = connections.length === 0;
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor="workspace-linear-connection">Linear Connection</FieldLabel>
      <Select name="issueTrackerConnectionId" defaultValue={connections[0]?.id} required>
        <SelectTrigger id="workspace-linear-connection" className="w-full" aria-invalid={invalid}>
          <SelectValue placeholder="Choose a Connection" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {connections.map((connection) => (
              <SelectItem key={connection.id} value={connection.id}>
                {connection.account}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {invalid ? (
        <FieldDescription>Establish this Connection before registering the workspace.</FieldDescription>
      ) : null}
    </Field>
  );
}

function GitHubSourceControlConnectionField({
  connections,
}: {
  readonly connections: readonly Connection[];
}) {
  const invalid = connections.length === 0;
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor="workspace-source-control-connection">GitHub source-control Connection</FieldLabel>
      <Select name="sourceControlConnectionId" defaultValue={connections[0]?.id} required>
        <SelectTrigger id="workspace-source-control-connection" className="w-full" aria-invalid={invalid}>
          <SelectValue placeholder="Choose a Connection" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {connections.map((connection) => (
              <SelectItem key={connection.id} value={connection.id}>
                {connection.account}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {invalid ? (
        <FieldDescription>Establish this Connection before adding source control.</FieldDescription>
      ) : null}
    </Field>
  );
}

function OptionalSourceControlFields({ connections }: { readonly connections: readonly Connection[] }) {
  const [repository, setRepository] = useState("");
  return (
    <>
      <Field>
        <FieldLabel htmlFor="workspace-source-control">GitHub source control</FieldLabel>
        <Input
          id="workspace-source-control"
          name="sourceControlRepository"
          placeholder="owner/repository"
          value={repository}
          onChange={(event) => setRepository(event.target.value)}
        />
        <FieldDescription>Optional repository used to read pull request state.</FieldDescription>
      </Field>
      {repository.trim() ? <GitHubSourceControlConnectionField connections={connections} /> : null}
    </>
  );
}

function LinearRegistrationFields({
  githubConnections,
  linearConnections,
}: {
  readonly githubConnections: readonly Connection[];
  readonly linearConnections: readonly Connection[];
}) {
  return (
    <>
      <LinearTrackerConnectionField connections={linearConnections} />
      <Field>
        <FieldLabel htmlFor="workspace-linear-teams">Linear teams</FieldLabel>
        <Input id="workspace-linear-teams" name="linearTeams" placeholder="ENG, Platform" required />
        <FieldDescription>Comma-separated team keys to watch.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="workspace-linear-organization">Linear organization</FieldLabel>
        <Input id="workspace-linear-organization" name="linearOrganization" placeholder="acme" />
      </Field>
      <OptionalSourceControlFields connections={githubConnections} />
    </>
  );
}

function RegistrationOutcome({ outcome }: { readonly outcome: WorkspaceState }) {
  if (outcome._tag !== "Failed") {
    return (
      <Alert>
        <RiGitRepositoryLine />
        <AlertTitle>Workspace registered</AlertTitle>
        <AlertDescription>{outcome.displayName ?? outcome.name} is now registered.</AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="destructive">
      <RiAlertLine />
      <AlertTitle>Workspace input failed</AlertTitle>
      <AlertDescription>{outcome.message}</AlertDescription>
    </Alert>
  );
}

function WorkspaceActions({
  workspace,
  label,
  className,
}: {
  readonly workspace: WorkspaceId;
  readonly label: string;
  readonly className?: string;
}) {
  return (
    <ItemActions className={className}>
      <RebindWorkspaceDialog workspace={workspace} label={label} />
      <DeregisterWorkspaceDialog workspace={workspace} label={label} />
    </ItemActions>
  );
}

function RegisterWorkspaceDialog() {
  const {
    state: { connections },
    actions: { register },
    meta: { registerPending, registerError, registerOutcome },
  } = useWorkspaces();
  const [tracker, setTracker] = useState<WorkspaceTracker>("github");
  const [invalid, setInvalid] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const githubConnections = connectionsFor(connections, "github");
  const linearConnections = connectionsFor(connections, "linear");
  const status = workspaceSubmissionStatus({
    submitted,
    pending: registerPending,
    error: registerError,
    outcomeError: null,
    outcome: registerOutcome,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status === "submitting" || status === "complete") return;
    const registration = workspaceRegistrationFrom(registrationDraftFrom(event.currentTarget, tracker));
    if (!registration) {
      setInvalid(true);
      return;
    }

    setInvalid(false);
    setSubmitted(true);
    register(registration);
  };
  const setTrackerValue = (value: string | null) => {
    const nextTracker = workspaceTrackerFrom(value);
    if (!nextTracker) return;
    setTracker(nextTracker);
  };
  const changeOpen = (open: boolean) => {
    if (!open) return;
    setSubmitted(false);
    setInvalid(false);
  };
  const activeError = status === "failed" ? registerError : null;
  const activeOutcome = status === "complete" ? registerOutcome : null;
  const disabled = workspaceSubmissionIsLocked(status);

  return (
    <Dialog onOpenChange={changeOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <RiAddLine data-icon="inline-start" />
        Register workspace
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form className="contents" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Register a workspace</DialogTitle>
            <DialogDescription>
              Registration admits this repository's Workspace input and Authoring tree to Cogwork.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="max-h-[65vh] overflow-y-auto px-1 py-1">
            <Field data-invalid={invalid}>
              <FieldLabel htmlFor="workspace-name">Name</FieldLabel>
              <Input id="workspace-name" name="name" placeholder="Cogwork" required aria-invalid={invalid} />
            </Field>
            <Field data-invalid={invalid}>
              <FieldLabel htmlFor="workspace-checkout-path">Checkout path</FieldLabel>
              <Input
                id="workspace-checkout-path"
                name="checkoutPath"
                placeholder="/Users/you/sites/cogwork"
                required
                aria-invalid={invalid}
              />
              <FieldDescription>Use the absolute path to the repository checkout.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="workspace-git-remote">Git remote</FieldLabel>
              <Input id="workspace-git-remote" name="gitRemote" placeholder="git@github.com:owner/repo.git" />
              <FieldDescription>Optional re-binding hint. It is not the workspace identity.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="workspace-tracker">Issue tracker</FieldLabel>
              <Select value={tracker} onValueChange={setTrackerValue}>
                <SelectTrigger id="workspace-tracker" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="github">GitHub Issues</SelectItem>
                    <SelectItem value="linear">Linear</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            {tracker === "github" ? (
              <GitHubRegistrationFields connections={githubConnections} />
            ) : (
              <LinearRegistrationFields
                githubConnections={githubConnections}
                linearConnections={linearConnections}
              />
            )}
            {invalid ? <FieldError>Complete the required fields and use an absolute path.</FieldError> : null}
            {activeError ? <FieldError>{activeError}</FieldError> : null}
            {activeOutcome ? <RegistrationOutcome outcome={activeOutcome} /> : null}
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
            <Button type="submit" disabled={disabled}>
              {status === "submitting" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RiAddLine data-icon="inline-start" />
              )}
              Register
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const workspaceIdentity = (workspace: WorkspaceState) => {
  if (workspace._tag === "Registered") return workspace.name;
  return workspace.name ?? null;
};

const workspaceLabel = (workspace: WorkspaceState) => {
  if (workspace._tag === "Registered") return workspace.displayName ?? workspace.name;
  return workspace.displayName ?? workspace.name ?? workspace.source;
};

function RegistryEmpty({
  icon: Icon,
  title,
  description,
}: {
  readonly icon: typeof RiAlertLine;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function RebindWorkspaceDialog({
  workspace,
  label,
}: {
  readonly workspace: WorkspaceId;
  readonly label: string;
}) {
  const {
    actions: { rebind },
    meta: { rebindPending, rebindError, rebindOutcome, rebindTarget },
  } = useWorkspaces();
  const [invalid, setInvalid] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const targeted = rebindTarget === workspace;
  const activeOutcome = targeted ? rebindOutcome : null;
  const outcomeError = workspaceOutcomeError(activeOutcome);
  const status = workspaceSubmissionStatus({
    submitted,
    pending: rebindPending,
    error: targeted ? rebindError : null,
    outcomeError,
    outcome: activeOutcome,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (rebindPending || workspaceSubmissionIsLocked(status)) return;
    const checkoutPath = absoluteCheckoutPathFrom(
      textFrom(new FormData(event.currentTarget), "checkoutPath"),
    );
    if (!checkoutPath) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setSubmitted(true);
    rebind(workspace, checkoutPath);
  };
  const changeOpen = (open: boolean) => {
    if (!open) return;
    setSubmitted(false);
    setInvalid(false);
  };
  const activeError = status === "failed" ? (rebindError ?? outcomeError) : null;
  const rebound = status === "complete";
  const disabled = rebindPending || workspaceSubmissionIsLocked(status);

  return (
    <Dialog onOpenChange={changeOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" disabled={rebindPending} />}>
        Re-bind path
      </DialogTrigger>
      <DialogContent>
        <form className="contents" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Re-bind {label}</DialogTitle>
            <DialogDescription>
              Change the checkout path without changing the WorkspaceId or private settings.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={invalid}>
              <FieldLabel htmlFor={`rebind-${workspace}`}>New checkout path</FieldLabel>
              <Input
                id={`rebind-${workspace}`}
                name="checkoutPath"
                placeholder="/Users/you/sites/repository"
                required
                aria-invalid={invalid}
              />
              <FieldDescription>Use an absolute path.</FieldDescription>
              {invalid ? <FieldError>Enter an absolute checkout path.</FieldError> : null}
            </Field>
            {activeError ? <FieldError>{activeError}</FieldError> : null}
            {rebound ? (
              <Alert>
                <RiFolderTransferLine />
                <AlertTitle>Path re-bound</AlertTitle>
                <AlertDescription>{label} now uses the new checkout path.</AlertDescription>
              </Alert>
            ) : null}
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
            <Button type="submit" disabled={disabled}>
              {targeted && rebindPending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RiFolderTransferLine data-icon="inline-start" />
              )}
              Re-bind
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeregisterWorkspaceDialog({
  workspace,
  label,
}: {
  readonly workspace: WorkspaceId;
  readonly label: string;
}) {
  const {
    actions: { deregister },
    meta: { deregisterPending, deregisterError, deregisterTarget },
  } = useWorkspaces();
  const targeted = deregisterTarget === workspace;
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button size="sm" variant="ghost" disabled={deregisterPending} />}>
        Deregister
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Deregister {label}?</AlertDialogTitle>
          <AlertDialogDescription>
            {deregisterWorkspaceWarning} A Run already in flight can finish, but this workspace takes no new
            work.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {targeted && deregisterError ? (
          <Alert variant="destructive">
            <AlertTitle>Deregistration failed</AlertTitle>
            <AlertDescription>{deregisterError}</AlertDescription>
          </Alert>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deregisterPending}
            onClick={() => deregister(workspace)}
          >
            {targeted && deregisterPending ? <Spinner data-icon="inline-start" /> : null}
            Deregister
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function WorkspaceRow({ workspace }: { readonly workspace: WorkspaceState }) {
  const identity = workspaceIdentity(workspace);
  const label = workspaceLabel(workspace);
  if (workspace._tag === "Failed") {
    return (
      <Item variant="outline" className="items-start">
        <ItemMedia variant="icon">
          <RiAlertLine />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>
            {label}
            <Badge variant="destructive">Input failed</Badge>
          </ItemTitle>
          <ItemDescription>{workspace.message}</ItemDescription>
          <span className="font-mono text-xs text-muted-foreground">{workspace.source}</span>
        </ItemContent>
        {identity ? <WorkspaceActions workspace={identity} label={label} /> : null}
      </Item>
    );
  }

  return (
    <Item variant="outline" className="items-start">
      <ItemMedia variant="icon">
        <RiGitRepositoryLine />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {label}
          <Badge variant="outline">{workspace.name}</Badge>
          <Badge variant="secondary">{workspace.issueTracker}</Badge>
        </ItemTitle>
        <ItemDescription>{workspace.checkoutPath}</ItemDescription>
      </ItemContent>
      <WorkspaceActions workspace={workspace.name} label={label} className="flex-col items-end" />
    </Item>
  );
}

function RegistryStatus() {
  const {
    state: { status, workspaces },
  } = useWorkspaces();
  if (status === "loading") {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Spinner />
          </EmptyMedia>
          <EmptyTitle>Loading workspaces</EmptyTitle>
          <EmptyDescription>Waiting for the daemon's published picture.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (status === "offline") {
    return (
      <RegistryEmpty
        icon={RiAlertLine}
        title="Workspaces unavailable"
        description="Reconnect to the daemon to manage workspaces."
      />
    );
  }
  if (workspaces.length === 0) {
    return (
      <RegistryEmpty
        icon={RiGitRepositoryLine}
        title="No workspaces registered"
        description="Register a repository to let Cogwork discover and run its work."
      />
    );
  }
  return (
    <ItemGroup className="gap-2">
      {workspaces
        .toSorted((left, right) => workspaceLabel(left).localeCompare(workspaceLabel(right)))
        .map((workspace) => (
          <WorkspaceRow
            key={workspaceIdentity(workspace) ?? workspaceLabel(workspace)}
            workspace={workspace}
          />
        ))}
    </ItemGroup>
  );
}

function NumberStepper({
  value,
  min,
  max,
  label,
  disabled,
  onChange,
}: {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly label: string;
  readonly disabled: boolean;
  readonly onChange: (value: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const commit = (next: number) => {
    setEditing(false);
    const clamped = Math.min(max, Math.max(min, next));
    if (clamped !== value) onChange(clamped);
  };
  const step = (delta: number) => commit(value + delta);
  return (
    <InputGroup className="w-28">
      <InputGroupInput
        aria-label={label}
        inputMode="numeric"
        disabled={disabled}
        value={editing ? draft : String(value)}
        onFocus={() => {
          setDraft(String(value));
          setEditing(true);
        }}
        onBlur={() => commit(parseCount(draft, min))}
        onChange={(event) => setDraft(sanitizeCountDraft(event.target.value))}
      />
      <InputGroupAddon>
        <InputGroupButton
          size="icon-xs"
          disabled={disabled}
          aria-label={`Decrease ${label}`}
          onClick={() => step(-1)}
        >
          <RiSubtractLine data-icon="inline-start" />
        </InputGroupButton>
      </InputGroupAddon>
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-xs"
          disabled={disabled}
          aria-label={`Increase ${label}`}
          onClick={() => step(1)}
        >
          <RiAddLine data-icon="inline-start" />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}

function WorkspacesRoot({ children }: { readonly children: ReactNode }) {
  return <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-8 pt-6 pb-12">{children}</main>;
}

function WorkspacesHeader() {
  return (
    <header className="flex flex-col gap-1">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">Workspaces</h1>
      <p className="text-sm text-muted-foreground">
        Repositories this machine operates over, and the durable limits it operates under.
      </p>
    </header>
  );
}

function WorkspacesRegistry() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Registered workspaces</CardTitle>
        <CardDescription>
          Register admits a repository. Re-binding changes its path without changing its identity.{" "}
          {deregisterWorkspaceWarning}
        </CardDescription>
        <CardAction>
          <RegisterWorkspaceDialog />
        </CardAction>
      </CardHeader>
      <CardContent>
        <RegistryStatus />
      </CardContent>
    </Card>
  );
}

function WorkspacesLimits() {
  const {
    state: { controlStore },
    actions: { setLimit },
    meta: { limitPending, limitError },
  } = useWorkspaces();
  const limits = controlStore?.daemonLimits;
  const disabled = !limits || limitPending;
  const expectedRevision = limits?.revision ?? 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Runtime limits</CardTitle>
        <CardDescription>These values are durable and apply to the daemon on this machine.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-0">
        <Item>
          <ItemContent>
            <ItemTitle>Global concurrency</ItemTitle>
            <ItemDescription>Runs kept in flight across all workspaces.</ItemDescription>
          </ItemContent>
          <ItemActions>
            <NumberStepper
              value={limits?.globalConcurrency ?? settingsOfflineFallbacks.globalConcurrency}
              min={minConcurrency}
              max={maxSchedulerLimit}
              label="Global concurrency"
              disabled={disabled}
              onChange={(value) => setLimit({ key: "global-concurrency", value, expectedRevision })}
            />
          </ItemActions>
        </Item>
        <Separator />
        <Item>
          <ItemContent>
            <ItemTitle>Per-workspace concurrency</ItemTitle>
            <ItemDescription>Runs kept in flight inside one workspace.</ItemDescription>
          </ItemContent>
          <ItemActions>
            <NumberStepper
              value={limits?.perWorkspaceConcurrency ?? settingsOfflineFallbacks.perWorkspaceConcurrency}
              min={minConcurrency}
              max={maxSchedulerLimit}
              label="Per-workspace concurrency"
              disabled={disabled}
              onChange={(value) => setLimit({ key: "per-workspace-concurrency", value, expectedRevision })}
            />
          </ItemActions>
        </Item>
        <Separator />
        <Item>
          <ItemContent>
            <ItemTitle>Daily budget</ItemTitle>
            <ItemDescription>Runs started per day before the scheduler pauses new work.</ItemDescription>
          </ItemContent>
          <ItemActions>
            <NumberStepper
              value={limits?.dailyBudget ?? settingsOfflineFallbacks.dailyBudgetRuns}
              min={minDailyBudget}
              max={maxSchedulerLimit}
              label="Daily budget"
              disabled={disabled}
              onChange={(value) => setLimit({ key: "daily-budget", value, expectedRevision })}
            />
          </ItemActions>
        </Item>
        {limitError ? (
          <Alert variant="destructive" className="mt-3">
            <AlertTitle>Limit update failed</AlertTitle>
            <AlertDescription>{limitError}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

export const Workspaces = {
  Provider: WorkspacesProvider,
  LiveProvider: LiveWorkspacesProvider,
  Root: WorkspacesRoot,
  Header: WorkspacesHeader,
  Registry: WorkspacesRegistry,
  Limits: WorkspacesLimits,
};
