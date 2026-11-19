import type { SandboxHandle, SandboxProvider } from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Effect from "effect/Effect";

const environmentName = (name: string) => (process.platform === "win32" ? name.toUpperCase() : name);

interface EnvironmentRule {
  readonly inherited: ReadonlyArray<string>;
  readonly allowed?: ReadonlyArray<string>;
  readonly denied?: ReadonlyArray<string>;
}

const inheritedEnvironmentNames = ({ inherited, allowed = [], denied = [] }: EnvironmentRule) => {
  const deniedNames = new Set(denied.map(environmentName));
  return new Set([...inherited, ...allowed].map(environmentName).filter((name) => !deniedNames.has(name)));
};

export const environmentVariablesToRemove = (
  environment: ReadonlyArray<string>,
  inherited: ReadonlyArray<string>,
  allowed: ReadonlyArray<string> = [],
  denied: ReadonlyArray<string> = [],
) => {
  const inheritedNames = inheritedEnvironmentNames({ inherited, allowed, denied });
  return environment.filter((name) => !inheritedNames.has(environmentName(name)));
};

const withCurrentEnvironment = <Value>(refreshEnvironment: () => void, action: () => Value) => {
  refreshEnvironment();
  return action();
};

const sandboxWithCurrentEnvironment = (
  sandbox: SandboxHandle,
  refreshEnvironment: () => void,
): SandboxHandle => ({
  ...sandbox,
  process: {
    ...sandbox.process,
    exec: (command, options) =>
      withCurrentEnvironment(refreshEnvironment, () => sandbox.process.exec(command, options)),
    spawn: (command, options) =>
      withCurrentEnvironment(refreshEnvironment, () => sandbox.process.spawn(command, options)),
  },
  git: {
    ...sandbox.git,
    clone: (input) => withCurrentEnvironment(refreshEnvironment, () => sandbox.git.clone(input)),
    status: (directory) => withCurrentEnvironment(refreshEnvironment, () => sandbox.git.status(directory)),
    add: (paths, directory) =>
      withCurrentEnvironment(refreshEnvironment, () => sandbox.git.add(paths, directory)),
    commit: (message, directory) =>
      withCurrentEnvironment(refreshEnvironment, () => sandbox.git.commit(message, directory)),
    push: (directory) => withCurrentEnvironment(refreshEnvironment, () => sandbox.git.push(directory)),
    pull: (directory) => withCurrentEnvironment(refreshEnvironment, () => sandbox.git.pull(directory)),
    branch: (directory) => withCurrentEnvironment(refreshEnvironment, () => sandbox.git.branch(directory)),
  },
  destroy: () => sandbox.destroy(),
});

export const localProcessSandboxProvider = (directory: string, rule: EnvironmentRule) => {
  const scrubEnv: Array<string> = [];
  const refreshEnvironment = () => {
    scrubEnv.splice(
      0,
      scrubEnv.length,
      ...environmentVariablesToRemove(Object.keys(process.env), rule.inherited, rule.allowed, rule.denied),
    );
  };
  refreshEnvironment();
  const handles = new Map<string, SandboxHandle>();
  // A command gets only the provider's short base list plus `passEnv`; `scrubEnv` then removes the
  // base names this rule does not inherit.
  const provider = localProcessSandbox({
    dir: directory,
    passEnv: [...inheritedEnvironmentNames(rule)],
    scrubEnv,
  });
  const register = (sandbox: SandboxHandle) => {
    const current = sandboxWithCurrentEnvironment(sandbox, refreshEnvironment);
    handles.set(current.id, current);
    return current;
  };
  return {
    name: provider.name,
    capabilities: () => provider.capabilities(),
    create: (input) => {
      refreshEnvironment();
      return provider.create(input).then(register);
    },
    resume: (input) => {
      refreshEnvironment();
      return provider.resume(input).then((sandbox) => (sandbox ? register(sandbox) : null));
    },
    destroy: (input) => {
      const handle = handles.get(input.id);
      if (!handle) return provider.destroy(input);
      handles.delete(input.id);
      return handle.destroy();
    },
  } satisfies SandboxProvider;
};

export const withLocalProcessSandbox = <Value, Error, Requirements>(
  directory: string,
  inheritedEnvironment: ReadonlyArray<string>,
  onCreateError: (cause: unknown) => Error,
  use: (sandbox: SandboxHandle) => Effect.Effect<Value, Error, Requirements>,
) =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.tryPromise({
        try: () => localProcessSandboxProvider(directory, { inherited: inheritedEnvironment }).create({}),
        catch: onCreateError,
      }),
      (sandbox) => Effect.tryPromise({ try: () => sandbox.destroy(), catch: () => null }).pipe(Effect.ignore),
    ).pipe(Effect.flatMap(use)),
  );
