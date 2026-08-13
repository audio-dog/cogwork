import type { NeedsHumanItem, TriageRole, WorkspaceId } from "@cogwork/contracts";
import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Field, FieldGroup, FieldLabel } from "@cogwork/ui/components/field";
import { Spinner } from "@cogwork/ui/components/spinner";
import { Textarea } from "@cogwork/ui/components/textarea";
import { ToggleGroup, ToggleGroupItem } from "@cogwork/ui/components/toggle-group";
import { useAtom } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { useState } from "react";
import { reclassifyAtom } from "../daemon/atoms";
import { needsHumanReasonLabel } from "../features/feed";

const roles: ReadonlyArray<{ readonly role: TriageRole; readonly label: string }> = [
  { role: "ready-for-agent", label: "Send back to agent" },
  { role: "needs-info", label: "Needs info" },
  { role: "ready-for-human", label: "Ready for human" },
  { role: "wontfix", label: "Won't fix" },
];

export function TriageApproval({ workspace, item }: { workspace: WorkspaceId; item: NeedsHumanItem }) {
  const [role, setRole] = useState<TriageRole>("ready-for-agent");
  const [note, setNote] = useState("");
  const [result, reclassify] = useAtom(reclassifyAtom);

  const trimmed = note.trim();
  const apply = () =>
    reclassify({
      payload: { workspace, workItem: item.id, role, ...(trimmed ? { note: trimmed } : {}) },
    });

  return (
    <section className="flex flex-col gap-3">
      <Badge variant="outline">{needsHumanReasonLabel[item.reason]}</Badge>
      {item.proposal ? (
        <p className="rounded-md bg-muted/50 p-2 text-xs whitespace-pre-wrap text-muted-foreground">
          {item.proposal}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground italic">No proposal recorded.</p>
      )}

      <FieldGroup>
        <Field>
          <FieldLabel>Decision</FieldLabel>
          <ToggleGroup
            className="flex-col items-stretch"
            orientation="vertical"
            value={[role]}
            onValueChange={(value) => {
              const next = roles.find((option) => option.role === value[0]);
              if (next) setRole(next.role);
            }}
          >
            {roles.map(({ role: value, label }) => (
              <ToggleGroupItem key={value} value={value} variant="outline">
                {label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
        <Field>
          <FieldLabel htmlFor="triage-note">Note</FieldLabel>
          <Textarea
            id="triage-note"
            placeholder="Answer the question or explain the override…"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
      </FieldGroup>

      <Button disabled={result.waiting} size="sm" onClick={apply}>
        {result.waiting && <Spinner data-icon="inline-start" />}
        Apply
      </Button>
      {result._tag === "Failure" && (
        <span className="text-xs text-destructive">{Cause.pretty(result.cause)}</span>
      )}
    </section>
  );
}
