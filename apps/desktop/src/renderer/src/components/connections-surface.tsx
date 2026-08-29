import type {
  ConnectionEstablishment,
  ConnectionId,
  ConnectionItem,
  ConnectionOverview,
  ConnectionSystem,
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
  CardFooter,
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
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@cogwork/ui/components/select";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { RiAlertLine, RiCheckLine, RiDeleteBinLine, RiPlugLine } from "@remixicon/react";
import * as Cause from "effect/Cause";
import * as Redacted from "effect/Redacted";
import { createContext, type FormEvent, type ReactNode, use, useState } from "react";
import {
  connectionsAtom,
  establishConnectionAtom,
  reconnectConnectionAtom,
  removeConnectionAtom,
} from "../daemon/atoms";
import { useBoard } from "../features/activity-session";
import { connectionAction, connectionPluginLabel, connectionStatus } from "../features/connections-view";

interface ConnectionsValue {
  readonly state: { readonly overview: ConnectionOverview | null };
  readonly actions: {
    readonly establish: (establishment: ConnectionEstablishment) => void;
    readonly reconnect: (establishment: ConnectionEstablishment) => void;
    readonly remove: (connectionId: ConnectionId) => void;
  };
  readonly meta: { readonly failure: string | null; readonly danglingWorkspaces: readonly string[] };
}

const ConnectionsContext = createContext<ConnectionsValue | null>(null);

const useConnections = () => {
  const value = use(ConnectionsContext);
  if (!value) throw new Error("Connections readers must render inside Connections.Provider");
  return value;
};

const failureOf = (
  ...results: ReadonlyArray<{ readonly _tag: string; readonly cause?: Cause.Cause<unknown> }>
) => {
  const failure = results.find((result) => result._tag === "Failure");
  return failure?.cause ? Cause.pretty(failure.cause) : null;
};

function ConnectionsProvider({ children }: { readonly children: ReactNode }) {
  const boardResult = useBoard();
  const queried = useAtomValue(connectionsAtom);
  const [establishResult, establish] = useAtom(establishConnectionAtom);
  const [reconnectResult, reconnect] = useAtom(reconnectConnectionAtom);
  const [removeResult, remove] = useAtom(removeConnectionAtom);
  const board = boardResult._tag === "Success" ? boardResult.board : null;
  const overview = board?.connections ?? (queried._tag === "Success" ? queried.value : null);
  const value: ConnectionsValue = {
    state: { overview },
    actions: {
      establish: (establishment) => establish({ payload: { establishment } }),
      reconnect: (establishment) => reconnect({ payload: { establishment } }),
      remove: (connectionId) => remove({ payload: { connectionId } }),
    },
    meta: {
      failure: failureOf(establishResult, reconnectResult, removeResult, queried),
      danglingWorkspaces: board?.connectionNotices ?? [],
    },
  };
  return <ConnectionsContext value={value}>{children}</ConnectionsContext>;
}

type CredentialMethod = "api-key" | "env" | "browser";

interface ConnectionFormValue {
  readonly state: {
    readonly open: boolean;
    readonly method: CredentialMethod;
    readonly error: string | null;
  };
  readonly actions: {
    readonly setOpen: (open: boolean) => void;
    readonly setMethod: (value: string | null) => void;
    readonly submit: (event: FormEvent<HTMLFormElement>) => void;
  };
  readonly meta: { readonly system: ConnectionSystem };
}

const ConnectionFormContext = createContext<ConnectionFormValue | null>(null);

const useConnectionForm = () => {
  const value = use(ConnectionFormContext);
  if (!value) throw new Error("Connection form readers must render inside ConnectionForm.Provider");
  return value;
};

const textFrom = (data: FormData, name: string) => {
  const value = data.get(name);
  return typeof value === "string" ? value.trim() : "";
};

const methodFrom = (value: string | null, system: ConnectionSystem): CredentialMethod | null => {
  if (value === "api-key" || value === "env") return value;
  if (value === "browser" && system === "linear") return value;
  return null;
};

const sourceFrom = (method: CredentialMethod, data: FormData) => {
  if (method === "browser") return { _tag: "Stored" } satisfies ConnectionEstablishment["source"];
  if (method === "env") {
    const name = textFrom(data, "environment");
    return name ? ({ _tag: "Env", name } satisfies ConnectionEstablishment["source"]) : null;
  }
  const key = textFrom(data, "apiKey");
  return key
    ? ({ _tag: "ApiKey", key: Redacted.make(key) } satisfies ConnectionEstablishment["source"])
    : null;
};

function ConnectionFormProvider({
  system,
  mutate,
  children,
}: {
  readonly system: ConnectionSystem;
  readonly mutate: (establishment: ConnectionEstablishment) => void;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [method, setMethodState] = useState<CredentialMethod>("api-key");
  const [error, setError] = useState<string | null>(null);
  const setMethod = (value: string | null) => {
    const next = methodFrom(value, system);
    if (next) setMethodState(next);
  };
  const setOpenState = (next: boolean) => {
    setOpen(next);
    if (next) setError(null);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const account = textFrom(data, "account");
    const source = sourceFrom(method, data);
    if (!account || !source) {
      setError("Complete the account and credential fields.");
      return;
    }
    mutate({ system, account, source });
    setOpen(false);
  };
  const value: ConnectionFormValue = {
    state: { open, method, error },
    actions: { setOpen: setOpenState, setMethod, submit },
    meta: { system },
  };
  return <ConnectionFormContext value={value}>{children}</ConnectionFormContext>;
}

const defaultEnvironment = (system: ConnectionSystem) =>
  system === "github" ? "GITHUB_TOKEN" : "LINEAR_API_KEY";

function CredentialFields() {
  const {
    state: { method, error },
    actions: { setMethod },
    meta: { system },
  } = useConnectionForm();
  const invalid = error !== null;
  return (
    <FieldGroup>
      <Field data-invalid={invalid}>
        <FieldLabel htmlFor={`${system}-credential-method`}>Sign-in method</FieldLabel>
        <Select value={method} onValueChange={setMethod}>
          <SelectTrigger id={`${system}-credential-method`} className="w-full" aria-invalid={invalid}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="api-key">API key</SelectItem>
              <SelectItem value="env">Environment variable</SelectItem>
              {system === "linear" ? <SelectItem value="browser">Saved login</SelectItem> : null}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      {method === "api-key" ? (
        <Field data-invalid={invalid}>
          <FieldLabel htmlFor={`${system}-api-key`}>API key</FieldLabel>
          <Input
            id={`${system}-api-key`}
            name="apiKey"
            type="password"
            autoComplete="off"
            required
            aria-invalid={invalid}
          />
          <FieldDescription>Stored in Cogwork's credential store, never the Control store.</FieldDescription>
        </Field>
      ) : null}
      {method === "env" ? (
        <Field data-invalid={invalid}>
          <FieldLabel htmlFor={`${system}-environment`}>Environment variable</FieldLabel>
          <Input
            id={`${system}-environment`}
            name="environment"
            defaultValue={defaultEnvironment(system)}
            required
            aria-invalid={invalid}
          />
          <FieldDescription>Cogwork reads the current value without copying it.</FieldDescription>
        </Field>
      ) : null}
      {method === "browser" ? (
        <Field>
          <FieldDescription>
            Uses credentials saved by <code>cogwork login linear</code>.
          </FieldDescription>
        </Field>
      ) : null}
      {error ? (
        <Field data-invalid>
          <FieldError>{error}</FieldError>
        </Field>
      ) : null}
    </FieldGroup>
  );
}

function EstablishConnectionDialogBody({ system }: { readonly system: ConnectionSystem }) {
  const {
    state: { open, error },
    actions: { setOpen, submit },
  } = useConnectionForm();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>Establish</DialogTrigger>
      <DialogContent>
        <form className="contents" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Establish {system} Connection</DialogTitle>
            <DialogDescription>Choose how Cogwork can authenticate to this system.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={error !== null}>
              <FieldLabel htmlFor={`${system}-account`}>Account</FieldLabel>
              <Input
                id={`${system}-account`}
                name="account"
                placeholder="acme"
                required
                aria-invalid={error !== null}
              />
            </Field>
            <CredentialFields />
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button type="submit">Establish</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EstablishConnectionDialog({ system }: { readonly system: ConnectionSystem }) {
  const {
    actions: { establish },
  } = useConnections();
  return (
    <ConnectionFormProvider system={system} mutate={establish}>
      <EstablishConnectionDialogBody system={system} />
    </ConnectionFormProvider>
  );
}

function ReconnectConnectionDialogBody({ item }: { readonly item: ConnectionItem }) {
  const {
    state: { open },
    actions: { setOpen, submit },
  } = useConnectionForm();
  const account = item.connection?.account ?? "";
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>Re-connect</DialogTrigger>
      <DialogContent>
        <form className="contents" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Re-connect {item.system}</DialogTitle>
            <DialogDescription>Replace the credential for {account}.</DialogDescription>
          </DialogHeader>
          <input type="hidden" name="account" value={account} />
          <CredentialFields />
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button type="submit">Re-connect</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReconnectConnectionDialog({ item }: { readonly item: ConnectionItem }) {
  const {
    actions: { reconnect },
  } = useConnections();
  return (
    <ConnectionFormProvider system={item.system} mutate={reconnect}>
      <ReconnectConnectionDialogBody item={item} />
    </ConnectionFormProvider>
  );
}

function RemoveConnectionDialog({ item }: { readonly item: ConnectionItem }) {
  const {
    actions: { remove },
  } = useConnections();
  const connection = item.connection;
  if (!connection) return null;
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button size="sm" variant="ghost" />}>
        <RiDeleteBinLine data-icon="inline-start" />
        Remove
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {item.system} Connection?</AlertDialogTitle>
          <AlertDialogDescription>
            Cogwork removes the credential and any Plugin that requires this Connection. Workspaces stay
            registered and can dangle until you bind another Connection.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => remove(connection.id)}>
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ConnectionCard({ item }: { readonly item: ConnectionItem }) {
  const status = connectionStatus(item);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{item.system === "github" ? "GitHub" : "Linear"}</CardTitle>
        <CardDescription>{item.connection?.account ?? "No account"}</CardDescription>
        <CardAction>
          <Badge variant={item.readiness._tag === "Ready" ? "secondary" : "outline"}>
            {item.readiness._tag === "Ready" ? <RiCheckLine data-icon="inline-start" /> : null}
            {status}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          {item.readiness._tag === "NotReady" ? item.readiness.reason : "Credential ready."}
        </p>
        <Badge variant="ghost">{connectionPluginLabel(item)}</Badge>
      </CardContent>
      <CardFooter className="justify-between gap-2">
        <RemoveConnectionDialog item={item} />
        <ConnectionMutationDialog item={item} />
      </CardFooter>
    </Card>
  );
}

function ConnectionMutationDialog({ item }: { readonly item: ConnectionItem }) {
  const action = connectionAction(item);
  if (action === "none") return null;
  if (action === "establish") return <EstablishConnectionDialog system={item.system} />;
  return <ReconnectConnectionDialog item={item} />;
}

function ConnectionsContent() {
  const {
    state: { overview },
    meta: { failure, danglingWorkspaces },
  } = useConnections();
  if (!overview) {
    return (
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <RiPlugLine />
          </EmptyMedia>
          <EmptyTitle>Loading Connections</EmptyTitle>
          <EmptyDescription>Waiting for the daemon.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Connections</h1>
        <p className="text-sm text-muted-foreground">
          Accounts Cogwork can use for issue trackers and Plugins.
        </p>
      </header>
      {failure ? (
        <Alert variant="destructive">
          <RiAlertLine />
          <AlertTitle>Connection change failed</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">{failure}</AlertDescription>
        </Alert>
      ) : null}
      {danglingWorkspaces.length > 0 ? (
        <Alert>
          <RiAlertLine />
          <AlertTitle>Workspaces need a Connection</AlertTitle>
          <AlertDescription>{danglingWorkspaces.join(", ")}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        {overview.connections.map((item) => (
          <ConnectionCard key={item.system} item={item} />
        ))}
      </div>
    </div>
  );
}

export function ConnectionsSurface() {
  return (
    <ConnectionsProvider>
      <ConnectionsContent />
    </ConnectionsProvider>
  );
}

export const Connections = { Provider: ConnectionsProvider, Content: ConnectionsContent };
