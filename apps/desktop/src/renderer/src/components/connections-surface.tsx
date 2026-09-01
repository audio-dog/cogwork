import type {
  ConnectionEstablishment,
  ConnectionId,
  ConnectionItem,
  ConnectionOverview,
  ConnectionSystem,
  PluginItem,
  PluginOverview,
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
import { GithubIcon, LinearIcon } from "@cogwork/ui/components/brand-icons";
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
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@cogwork/ui/components/item";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { RiAlertLine, RiCheckLine, RiDeleteBinLine, RiPlugLine } from "@remixicon/react";
import { Link, linkOptions } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { createContext, type ReactNode, use } from "react";
import {
  connectionsAtom,
  establishConnectionAtom,
  pluginsAtom,
  reconnectConnectionAtom,
  removeConnectionAtom,
} from "../daemon/atoms";
import { useBoard } from "../features/activity-session";
import {
  connectionAction,
  connectionStatus,
  connectionSystemLabel,
  pluginRequiring,
} from "../features/connections-view";
import { type PluginLoadState, pluginSurfaceOf } from "../features/plugin-configuration";
import { ConnectionEstablishmentDialog } from "./connection-establishment-form";

interface ConnectionsValue {
  readonly state: {
    readonly overview: ConnectionOverview | null;
    readonly plugins: PluginOverview;
    readonly pluginsLoad: PluginLoadState;
  };
  readonly actions: {
    // Answer null on success, or the daemon's message when it refused — the establish dialog shows
    // that inline and stays open, so a rejected credential can be corrected without re-typing.
    readonly establish: (establishment: ConnectionEstablishment) => Promise<string | null>;
    readonly reconnect: (establishment: ConnectionEstablishment) => Promise<string | null>;
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

// `Cause.pretty` renders the whole trace, which in a Vite renderer is a wall of bundler URLs. Every
// error the daemon returns here carries a written message; that is the only part a person can act on.
const messageOf = (cause: Cause.Cause<unknown>) => {
  const error: unknown = Cause.squash(cause);
  if (typeof error === "object" && error !== null && "message" in error) {
    const { message } = error as { readonly message: unknown };
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "The daemon rejected the change. Check the daemon log for details.";
};

const failureOf = (
  ...results: ReadonlyArray<{ readonly _tag: string; readonly cause?: Cause.Cause<unknown> }>
) => {
  const failure = results.find((result) => result._tag === "Failure");
  return failure?.cause ? messageOf(failure.cause) : null;
};

// Establishment is the one mutation whose failure belongs to a form rather than to the page: the
// person is looking at the field that caused it, so it never reaches the surface-level Alert.
const rejectionOf = async (pending: Promise<Exit.Exit<unknown, unknown>>) => {
  const exit = await pending;
  return Exit.isSuccess(exit) ? null : messageOf(exit.cause);
};

function ConnectionsProvider({ children }: { readonly children: ReactNode }) {
  const boardResult = useBoard();
  const queried = useAtomValue(connectionsAtom);
  const queriedPlugins = useAtomValue(pluginsAtom);
  const establish = useAtomSet(establishConnectionAtom, { mode: "promiseExit" });
  const reconnect = useAtomSet(reconnectConnectionAtom, { mode: "promiseExit" });
  const [removeResult, remove] = useAtom(removeConnectionAtom);
  const board = boardResult._tag === "Success" ? boardResult.board : null;
  const overview = board?.connections ?? (queried._tag === "Success" ? queried.value : null);
  // The Board carries Connections and Plugins on separate events, and the Connection overview has a
  // query fallback the Plugin overview did not. Without the same fallback a card reached that way
  // shows live Connection state under a Plugin line that never resolves.
  const pluginSurface = pluginSurfaceOf(board, queriedPlugins);
  const value: ConnectionsValue = {
    state: { overview, plugins: pluginSurface.overview, pluginsLoad: pluginSurface.loadState },
    actions: {
      establish: (establishment) => rejectionOf(establish({ payload: { establishment } })),
      reconnect: (establishment) => rejectionOf(reconnect({ payload: { establishment } })),
      remove: (connectionId) => remove({ payload: { connectionId } }),
    },
    meta: {
      failure: failureOf(removeResult, queried),
      danglingWorkspaces: board?.connectionNotices ?? [],
    },
  };
  return <ConnectionsContext value={value}>{children}</ConnectionsContext>;
}

function EstablishConnectionDialog({ system }: { readonly system: ConnectionSystem }) {
  const {
    actions: { establish },
  } = useConnections();
  return (
    <ConnectionEstablishmentDialog
      system={system}
      triggerLabel="Connect"
      title={`Connect ${connectionSystemLabel(system)}`}
      description="Choose how Cogwork can authenticate to this system."
      submitLabel="Connect"
      onEstablish={establish}
    />
  );
}

function ReconnectConnectionDialog({ item }: { readonly item: ConnectionItem }) {
  const {
    actions: { reconnect },
  } = useConnections();
  const account = item.connection?.account ?? "";
  return (
    <ConnectionEstablishmentDialog
      system={item.system}
      account={account}
      triggerLabel="Re-connect"
      title={`Re-connect ${connectionSystemLabel(item.system)}`}
      description={`Replace the credential for ${account}.`}
      submitLabel="Re-connect"
      onEstablish={reconnect}
    />
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
          <AlertDialogTitle>Remove {connectionSystemLabel(item.system)} Connection?</AlertDialogTitle>
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

function ConnectionSystemTile({ system }: { readonly system: ConnectionSystem }) {
  const Icon = system === "github" ? GithubIcon : LinearIcon;
  return (
    <ItemMedia variant="icon" className="size-9 rounded-lg bg-muted text-foreground">
      <Icon className="size-4.5" />
    </ItemMedia>
  );
}

function ConnectionStatusBadge({ item }: { readonly item: ConnectionItem }) {
  const { label, tone } = connectionStatus(item);
  if (tone === "neutral") return <Badge variant="outline">{label}</Badge>;
  return (
    <Badge variant={tone === "positive" ? "secondary" : "destructive"}>
      {tone === "positive" ? (
        <RiCheckLine data-icon="inline-start" />
      ) : (
        <RiAlertLine data-icon="inline-start" />
      )}
      {label}
    </Badge>
  );
}

// Only an installed Plugin has a detail route to reach — `pluginDetailOf` matches on the install
// record, so an uninstalled one would land on Missing and bounce back to the facet anyway.
const pluginLink = (plugin: PluginItem) =>
  plugin.record
    ? linkOptions({ to: "/customize/plugin/$pluginId", params: { pluginId: plugin.pluginId } })
    : linkOptions({ to: "/customize/$facet", params: { facet: "plugins" } });

function ConnectionPlugin({ item }: { readonly item: ConnectionItem }) {
  const {
    state: { plugins, pluginsLoad },
  } = useConnections();
  // Unknown, unreachable, and empty are three different things. Only the third one may claim that
  // nothing requires this Connection.
  if (pluginsLoad === "loading") return <p className="text-sm text-muted-foreground">Loading Plugins.</p>;
  if (pluginsLoad === "failed") return <p className="text-sm text-muted-foreground">Plugins unavailable.</p>;
  const plugin = pluginRequiring(plugins, item.system);
  if (!plugin) return <p className="text-sm text-muted-foreground">No Plugin requires this Connection.</p>;
  return (
    <Item size="xs" variant="muted">
      <ItemContent>
        <ItemTitle>
          <Link {...pluginLink(plugin)} className="hover:underline">
            {plugin.name}
          </Link>
        </ItemTitle>
        <ItemDescription className="line-clamp-1">{plugin.summary}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Badge variant={plugin.record ? "secondary" : "outline"}>
          {plugin.record ? "Installed" : "Available"}
        </Badge>
      </ItemActions>
    </Item>
  );
}

function ConnectionCard({ item }: { readonly item: ConnectionItem }) {
  return (
    // Subgrid pins header, body, and footer to rows shared with every sibling card, so a Connection
    // that needs six Plugins does not shove its neighbour's footer up the page.
    <Card className="row-span-3 grid grid-rows-subgrid">
      <CardHeader>
        <div className="flex items-center gap-3">
          <ConnectionSystemTile system={item.system} />
          <div className="flex min-w-0 flex-col">
            <CardTitle>{connectionSystemLabel(item.system)}</CardTitle>
            <CardDescription className="truncate">{item.connection?.account ?? "No account"}</CardDescription>
          </div>
        </div>
        <CardAction>
          <ConnectionStatusBadge item={item} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {item.readiness._tag === "NotReady" && item.connection ? (
          <p className="text-sm text-destructive">{item.readiness.reason}</p>
        ) : null}
        <ConnectionPlugin item={item} />
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
          <AlertDescription>{failure}</AlertDescription>
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
