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
import * as Schema from "effect/Schema";
import { type ReactNode, useId, useState } from "react";
import {
  CredentialSourceTag,
  EstablishmentFieldsValidator,
  emptyEstablishmentFields,
  establishmentFrom,
} from "../features/connection-form";
import { connectionSystemLabel } from "../features/connections-view";

const isCredentialSourceTag = Schema.is(CredentialSourceTag);

function CredentialSourceOption({
  id,
  value,
  children,
}: {
  readonly id: string;
  readonly value: CredentialSourceTag;
  readonly children: ReactNode;
}) {
  return (
    <FieldLabel htmlFor={`${id}-${value}`}>
      <Field orientation="horizontal">
        <RadioGroupItem id={`${id}-${value}`} value={value} />
        <FieldContent>{children}</FieldContent>
      </Field>
    </FieldLabel>
  );
}

function GitHubCredentialSources({ id }: { readonly id: string }) {
  return (
    <>
      <CredentialSourceOption id={id} value="ApiKey">
        <FieldTitle>API key</FieldTitle>
        <FieldDescription>Kept in the Credential store, never the Control store.</FieldDescription>
      </CredentialSourceOption>
      <CredentialSourceOption id={id} value="GitHubCli">
        <FieldTitle>GitHub CLI (gh)</FieldTitle>
        <FieldDescription>
          Uses the login saved by <code>gh auth login</code>. Cogwork never stores this token.
        </FieldDescription>
      </CredentialSourceOption>
      <CredentialSourceOption id={id} value="Env">
        <FieldTitle>Environment variable</FieldTitle>
        <FieldDescription>
          Cogwork stores the variable&apos;s name, never its value. The daemon reads it from its process
          environment.
        </FieldDescription>
      </CredentialSourceOption>
    </>
  );
}

function LinearCredentialSources({ id }: { readonly id: string }) {
  return (
    <>
      <CredentialSourceOption id={id} value="ApiKey">
        <FieldTitle>API key</FieldTitle>
        <FieldDescription>Kept in the Credential store, never the Control store.</FieldDescription>
      </CredentialSourceOption>
      <CredentialSourceOption id={id} value="Env">
        <FieldTitle>Environment variable</FieldTitle>
        <FieldDescription>
          Cogwork stores the variable&apos;s name, never its value. The daemon reads it from its process
          environment.
        </FieldDescription>
      </CredentialSourceOption>
      <CredentialSourceOption id={id} value="Stored">
        <FieldTitle>Saved login</FieldTitle>
        <FieldDescription>
          Uses the browser grant saved by <code>cogwork login linear</code>.
        </FieldDescription>
      </CredentialSourceOption>
    </>
  );
}

const credentialSources = {
  github: GitHubCredentialSources,
  linear: LinearCredentialSources,
} satisfies Record<Exclude<ConnectionSystem, "granola" | "slack">, typeof GitHubCredentialSources>;

function CredentialSourceOptions({
  id,
  system,
}: {
  readonly id: string;
  readonly system: Exclude<ConnectionSystem, "granola" | "slack">;
}) {
  const Sources = credentialSources[system];
  return <Sources id={id} />;
}

function CredentialSourceField({
  id,
  system,
  value,
  onChange,
}: {
  readonly id: string;
  readonly system: Exclude<ConnectionSystem, "granola" | "slack">;
  readonly value: CredentialSourceTag;
  readonly onChange: (next: CredentialSourceTag) => void;
}) {
  return (
    <FieldSet>
      <FieldLegend variant="label">Credential source</FieldLegend>
      <RadioGroup value={value} onValueChange={(next) => isCredentialSourceTag(next) && onChange(next)}>
        <CredentialSourceOptions id={id} system={system} />
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
  const showsCredentialSource = system !== "granola" && system !== "slack";
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
            {system !== "github" && account === undefined ? (
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

            {showsCredentialSource ? (
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
            ) : null}

            <form.Subscribe selector={(state) => state.values.source}>
              {(source) => {
                if (source === "Stored" || source === "GitHubCli") return null;
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
