import { type Connection, WorkspaceState } from "@cogwork/contracts";
import { Button } from "@cogwork/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@cogwork/ui/components/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@cogwork/ui/components/field";
import { Input } from "@cogwork/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@cogwork/ui/components/select";
import { SidebarGroupAction } from "@cogwork/ui/components/sidebar";
import { Spinner } from "@cogwork/ui/components/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { useAtomSet } from "@effect/atom-react";
import { RiAddLine, RiFolderOpenLine } from "@remixicon/react";
import { Link, useNavigate } from "@tanstack/react-router";
import * as Exit from "effect/Exit";
import { type FormEvent, useRef, useState } from "react";
import { registerWorkspaceAtom } from "../daemon/atoms";
import { BoardResult, useBoard } from "../features/activity-session";
import { connectionSystemLabel, workspaceConnectionChoices } from "../features/connections-view";
import { daemonFailureMessage } from "../features/daemon-failure";
import { workspaceIdentity } from "../features/workspace-record";
import { type WorkspaceTracker, workspaceRegistrationFrom } from "../features/workspace-registration";
import { trackerItems } from "./workspace-setting-rows";

const textFrom = (data: FormData, name: string) => {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
};

const registrationDraftFrom = (
  form: HTMLFormElement,
  checkoutPath: string,
  tracker: WorkspaceTracker,
  connection: Connection,
) => {
  const data = new FormData(form);
  return {
    checkoutPath,
    tracker,
    issueTrackerConnectionId: connection.id,
    linearTeams: textFrom(data, "linearTeams"),
    linearOrganization: textFrom(data, "linearOrganization"),
    sourceControlConnectionId: "",
  };
};

function useTrackerConnection(tracker: WorkspaceTracker) {
  const board = useBoard();
  const overview = BoardResult.$is("Success")(board) ? board.board.connections : null;
  return workspaceConnectionChoices(overview, []).find((connection) => connection.system === tracker) ?? null;
}

function LinearRegistrationFields() {
  return (
    <>
      <Field>
        <FieldLabel htmlFor="register-workspace-linear-teams">Linear teams</FieldLabel>
        <Input id="register-workspace-linear-teams" name="linearTeams" placeholder="ENG, Platform" required />
      </Field>
      <Field>
        <FieldLabel htmlFor="register-workspace-linear-organization">Linear organization</FieldLabel>
        <Input id="register-workspace-linear-organization" name="linearOrganization" placeholder="acme" />
      </Field>
    </>
  );
}

export function RegisterWorkspaceDialog() {
  const register = useAtomSet(registerWorkspaceAtom, { mode: "promiseExit" });
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [checkoutPath, setCheckoutPath] = useState<string | null>(null);
  const [tracker, setTracker] = useState<WorkspaceTracker>("github");
  const [submitting, setSubmitting] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const openings = useRef(0);
  const connection = useTrackerConnection(tracker);

  const changeOpen = (next: boolean) => {
    openings.current += 1;
    setOpen(next);
    if (!next) return;
    setCheckoutPath(null);
    setRefusal(null);
  };
  const chooseFolder = async () => {
    const folder = await window.cogwork.chooseFolder();
    if (folder) setCheckoutPath(folder);
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || !checkoutPath || !connection) return;
    const registration = workspaceRegistrationFrom(
      registrationDraftFrom(event.currentTarget, checkoutPath, tracker, connection),
    );
    if (!registration) {
      setRefusal("Fill in every field.");
      return;
    }
    setSubmitting(true);
    const opening = openings.current;
    const exit = await register({ payload: { registration } });
    setSubmitting(false);
    if (opening !== openings.current) return;
    if (Exit.isFailure(exit)) {
      setRefusal(daemonFailureMessage(exit.cause));
      return;
    }
    const workspace = workspaceIdentity(exit.value);
    if (!workspace) {
      setRefusal(WorkspaceState.guards.Failed(exit.value) ? exit.value.message : null);
      return;
    }
    setOpen(false);
    navigate({ to: "/workspaces/$workspaceId", params: { workspaceId: workspace } });
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <Tooltip>
        <TooltipTrigger
          render={<DialogTrigger render={<SidebarGroupAction aria-label="Register workspace" />} />}
        >
          <RiAddLine />
        </TooltipTrigger>
        <TooltipContent side="right">Register workspace</TooltipContent>
      </Tooltip>
      <DialogContent className="sm:max-w-lg">
        <form className="contents" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Register workspace</DialogTitle>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="register-workspace-folder">Folder</FieldLabel>
              <Button
                id="register-workspace-folder"
                type="button"
                variant="outline"
                className="justify-start"
                onClick={chooseFolder}
              >
                <RiFolderOpenLine data-icon="inline-start" />
                <span className="truncate">{checkoutPath ?? "Open Folder"}</span>
              </Button>
            </Field>
            <Field>
              <FieldLabel htmlFor="register-workspace-tracker">Issue tracker</FieldLabel>
              <Select
                items={trackerItems}
                value={tracker}
                onValueChange={(value) => {
                  if (value === "github" || value === "linear") setTracker(value);
                }}
              >
                <SelectTrigger id="register-workspace-tracker" className="w-full">
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
            {tracker === "linear" ? <LinearRegistrationFields /> : null}
            {refusal ? <FieldError>{refusal}</FieldError> : null}
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            {connection ? (
              <Button type="submit" disabled={submitting || !checkoutPath}>
                {submitting ? <Spinner data-icon="inline-start" /> : null}
                Register
              </Button>
            ) : (
              <Button nativeButton={false} render={<Link to="/connections" onClick={() => setOpen(false)} />}>
                Connect {connectionSystemLabel(tracker)}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
