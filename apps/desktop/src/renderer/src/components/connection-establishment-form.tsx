import type { ConnectionEstablishment, ConnectionSystem } from "@cogwork/contracts";
import { Button } from "@cogwork/ui/components/button";
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
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@cogwork/ui/components/field";
import { Input } from "@cogwork/ui/components/input";
import { RadioGroup, RadioGroupItem } from "@cogwork/ui/components/radio-group";
import { Spinner } from "@cogwork/ui/components/spinner";
import { revalidateLogic, useForm } from "@tanstack/react-form";
import { useId, useState } from "react";
import {
  type CredentialSourceTag,
  credentialSourcesFor,
  EstablishmentFieldsValidator,
  emptyEstablishmentFields,
  establishmentFrom,
} from "../features/connection-form";
import { connectionSystemLabel } from "../features/connections-view";

const sourceHint: Record<CredentialSourceTag, string> = {
  ApiKey: "Kept in the Credential store, never the Control store.",
  Env: "Cogwork stores the variable's name, never its value. The daemon reads it from its process environment.",
  Stored: "Uses the browser grant saved by `cogwork login linear`.",
};

function CredentialSourceField({
  id,
  system,
  value,
  onChange,
}: {
  readonly id: string;
  readonly system: ConnectionSystem;
  readonly value: CredentialSourceTag;
  readonly onChange: (next: CredentialSourceTag) => void;
}) {
  return (
    <FieldSet>
      <FieldLegend variant="label">Credential source</FieldLegend>
      <RadioGroup value={value} onValueChange={(next) => next && onChange(next as CredentialSourceTag)}>
        {credentialSourcesFor(system).map((source) => (
          <FieldLabel key={source.value} htmlFor={`${id}-${source.value}`}>
            <Field orientation="horizontal">
              <RadioGroupItem id={`${id}-${source.value}`} value={source.value} />
              <FieldContent>
                <FieldTitle>{source.label}</FieldTitle>
                <FieldDescription>{sourceHint[source.value]}</FieldDescription>
              </FieldContent>
            </Field>
          </FieldLabel>
        ))}
      </RadioGroup>
    </FieldSet>
  );
}

export function ConnectionEstablishmentDialog({
  system,
  account,
  triggerLabel,
  title,
  description,
  submitLabel,
  onEstablish,
}: {
  readonly system: ConnectionSystem;
  readonly account?: string;
  readonly triggerLabel: string;
  readonly title: string;
  readonly description: string;
  readonly submitLabel: string;
  readonly onEstablish: (establishment: ConnectionEstablishment) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const fieldId = useId();
  const form = useForm({
    defaultValues: emptyEstablishmentFields(system, account),
    validationLogic: revalidateLogic(),
    validators: { onDynamic: EstablishmentFieldsValidator },
    onSubmit: async ({ value }) => {
      setRefusal(null);
      const refused = await onEstablish(establishmentFrom(value));
      if (refused !== null) return setRefusal(refused);
      setOpen(false);
      form.reset();
    },
  });

  const openChange = (next: boolean) => {
    setOpen(next);
    if (!next) setRefusal(null);
  };

  return (
    <Dialog open={open} onOpenChange={openChange}>
      <DialogTrigger render={<Button size="sm" />}>{triggerLabel}</DialogTrigger>
      <DialogContent>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            {account === undefined ? (
              <form.Field name="account">
                {(field) => {
                  const invalid = field.state.meta.isTouched && !field.state.meta.isValid;
                  return (
                    <Field data-invalid={invalid}>
                      <FieldLabel htmlFor={`${fieldId}-account`}>Account</FieldLabel>
                      <Input
                        id={`${fieldId}-account`}
                        name={field.name}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                        aria-invalid={invalid}
                        placeholder="acme"
                        autoComplete="off"
                      />
                      <FieldDescription>
                        The {connectionSystemLabel(system)} account this Connection signs in as.
                      </FieldDescription>
                      {invalid ? <FieldError errors={field.state.meta.errors} /> : null}
                    </Field>
                  );
                }}
              </form.Field>
            ) : null}

            <form.Field name="source">
              {(field) => (
                <CredentialSourceField
                  id={`${fieldId}-source`}
                  system={system}
                  value={field.state.value}
                  onChange={field.handleChange}
                />
              )}
            </form.Field>

            <form.Subscribe selector={(state) => state.values.source}>
              {(source) => {
                if (source === "Stored") return null;
                const secret = source === "ApiKey";
                return (
                  <form.Field name={secret ? "apiKey" : "environment"}>
                    {(field) => {
                      const invalid = field.state.meta.isTouched && !field.state.meta.isValid;
                      return (
                        <Field data-invalid={invalid}>
                          <FieldLabel htmlFor={`${fieldId}-credential`}>
                            {secret ? "API key" : "Environment variable"}
                          </FieldLabel>
                          <Input
                            id={`${fieldId}-credential`}
                            name={field.name}
                            type={secret ? "password" : "text"}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(event) => field.handleChange(event.target.value)}
                            aria-invalid={invalid}
                            autoComplete="off"
                          />
                          {invalid ? <FieldError errors={field.state.meta.errors} /> : null}
                        </Field>
                      );
                    }}
                  </form.Field>
                );
              }}
            </form.Subscribe>

            {refusal ? (
              <Field data-invalid>
                <FieldError>{refusal}</FieldError>
              </Field>
            ) : null}
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <form.Subscribe selector={(state) => state.isSubmitting}>
              {(submitting) => (
                <Button type="submit" disabled={submitting}>
                  {submitting ? <Spinner data-icon="inline-start" /> : null}
                  {submitLabel}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
