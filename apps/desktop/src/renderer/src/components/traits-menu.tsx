import { HarnessModelOptionDescriptor, type ModelOptionSelections } from "@cogwork/contracts";
import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@cogwork/ui/components/dropdown-menu";
import { cn } from "@cogwork/ui/lib/utils";
import { RiArrowDownSLine } from "@remixicon/react";
import { Fragment } from "react";
import {
  type AvailableHarnessCatalog,
  type ModelOptionState,
  modelOptionChoice,
} from "../features/operation-settings";

interface TraitsMenuProps {
  readonly state: {
    readonly catalog: AvailableHarnessCatalog;
    readonly model: AvailableHarnessCatalog["models"][number];
    readonly options: ReadonlyArray<ModelOptionState>;
  };
  readonly actions: {
    readonly select: (options: ModelOptionSelections) => void;
  };
  readonly meta: {
    readonly disabled: boolean;
  };
}

interface TraitChoice {
  readonly radioValue: string;
  readonly label: string;
  readonly optionValue: string | boolean;
  readonly isDefault: boolean;
}

const traitChoices = (descriptor: ModelOptionState["descriptor"]) =>
  HarnessModelOptionDescriptor.match(descriptor, {
    boolean: ({ defaultValue }) =>
      [
        { radioValue: "true", label: "On", optionValue: true, isDefault: defaultValue },
        { radioValue: "false", label: "Off", optionValue: false, isDefault: !defaultValue },
      ] satisfies ReadonlyArray<TraitChoice>,
    select: ({ defaultValue, values }) =>
      values.map(({ value, label }) => ({
        radioValue: value,
        label,
        optionValue: value,
        isDefault: value === defaultValue,
      })),
  });

const traitLabel = (option: ModelOptionState) => {
  if (option.staleValue !== undefined) {
    return `${option.descriptor.label}: ${String(option.staleValue)}`;
  }
  return HarnessModelOptionDescriptor.match(option.descriptor, {
    boolean: ({ label }) => (option.value === true ? label : `${label} Off`),
    select: ({ values }) => values.find(({ value }) => value === option.value)?.label ?? String(option.value),
  });
};

const selectedOptions = (options: ReadonlyArray<ModelOptionState>) =>
  Object.fromEntries(options.map(({ descriptor, value }) => [descriptor.id, value]));

const traitSourceLabels: Record<ModelOptionState["source"], string> = {
  own: "custom",
  inherited: "inherited",
  default: "default",
  stale: "stale",
};

export function TraitsMenu({ state, actions, meta }: TraitsMenuProps) {
  if (state.options.length === 0) return null;
  const options = selectedOptions(state.options);
  const summaries = state.options.map((option) => ({
    key: option.descriptor.id,
    label: traitLabel(option),
    source: option.source,
  }));
  const summary = summaries.map(({ label }) => label).join(" · ");
  const accessibleSummary = summaries
    .map(({ label, source }) => `${label} (${traitSourceLabels[source]})`)
    .join(" · ");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={meta.disabled}
        render={
          <Button
            variant="outline"
            className="max-w-64 justify-start"
            aria-label={`Traits: ${accessibleSummary}`}
            title={summary}
          >
            <span className="truncate">
              {summaries.map(({ key, label, source }, index) => (
                <Fragment key={key}>
                  {index > 0 ? " · " : null}
                  <span
                    data-source={source}
                    className={cn(
                      source === "inherited" && "text-muted-foreground",
                      source === "default" && "text-muted-foreground italic",
                      source === "stale" && "text-destructive",
                    )}
                  >
                    {label}
                  </span>
                </Fragment>
              ))}
            </span>
            <RiArrowDownSLine data-icon="inline-end" />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="w-56">
        {state.options.map((option, index) => {
          const choices = traitChoices(option.descriptor).map((choice) => ({
            ...choice,
            selection: modelOptionChoice(
              state.catalog,
              state.model,
              options,
              option.descriptor.id,
              choice.optionValue,
            ),
          }));
          return (
            <Fragment key={option.descriptor.id}>
              {index > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuGroup>
                <DropdownMenuLabel>{option.descriptor.label}</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={option.staleValue === undefined ? String(option.value) : undefined}
                  onValueChange={(value) => {
                    const choice = choices.find((candidate) => candidate.radioValue === value);
                    if (!choice?.selection) return;
                    actions.select(choice.selection);
                  }}
                >
                  {choices.map((choice) => {
                    return (
                      <DropdownMenuRadioItem
                        key={choice.radioValue}
                        value={choice.radioValue}
                        disabled={!choice.selection}
                        closeOnClick
                      >
                        {choice.label}
                        {choice.isDefault ? <Badge variant="ghost">Default</Badge> : null}
                      </DropdownMenuRadioItem>
                    );
                  })}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
