import type { OperationModelOption } from "@cogwork/contracts";

export const parseCursorModelList = (output: string) =>
  output.split("\n").flatMap((line) => {
    const id = line.trim().match(/^(\S+) - \S/)?.[1];
    return id ? [id] : [];
  });

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const parameterKey = (parameter: string) => parameter.split("=")[0] ?? parameter;

const bracketed = (model: string) => {
  const [, base, inner] = model.match(/^([^[\]]+)\[(.*)\]$/) ?? [];
  if (!base || inner === undefined) return null;
  return {
    base,
    params: inner
      .split(",")
      .map((parameter) => parameter.trim())
      .filter(Boolean),
  };
};

export const applyCursorModelOptions = (model: string, options: ReadonlyArray<OperationModelOption>) => {
  const chosen = new Map(
    options.flatMap(({ option, value }) => (value.trim() ? [[option.trim(), value.trim()] as const] : [])),
  );
  const selected = [...chosen].map(([option, value]) => `${option}=${value}`);
  if (selected.length === 0) return model;
  const selectedKeys = new Set(chosen.keys());
  const existing = bracketed(model);
  const carried = existing?.params.filter((parameter) => !selectedKeys.has(parameterKey(parameter))) ?? [];
  return `${existing?.base ?? model}[${[...carried, ...selected].join(",")}]`;
};

export const cursorModelFlag = (model: string, options: ReadonlyArray<OperationModelOption>) =>
  shellQuote(applyCursorModelOptions(model, options));
