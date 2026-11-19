import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, vi } from "vitest";
import { defaultInheritedEnvironment } from "./external-harness-runtime";
import {
  environmentVariablesToRemove,
  withLocalProcessSandbox,
} from "./external-harness-runtime-local-process";

afterEach(() => vi.restoreAllMocks());

describe("external Harness runtime local process sandbox", { timeout: 30_000 }, () => {
  it("removes every environment variable outside the inherited list", () => {
    assert.deepStrictEqual(
      environmentVariablesToRemove(
        ["PATH", "COGWORK_ALLOWED", "COGWORK_REMOVED"],
        ["PATH", "COGWORK_ALLOWED"],
      ),
      ["COGWORK_REMOVED"],
    );
    assert.deepStrictEqual(
      environmentVariablesToRemove(
        ["PATH", "COGWORK_ALLOWED", "COGWORK_REMOVED"],
        ["PATH"],
        ["COGWORK_ALLOWED"],
        ["PATH"],
      ),
      ["PATH", "COGWORK_REMOVED"],
    );
  });

  it("matches environment variable names case-insensitively on Windows", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    assert.deepStrictEqual(environmentVariablesToRemove(["Path", "SECRET"], ["PATH"]), ["SECRET"]);
  });

  it.effect("removes environment variables added after sandbox creation", () => {
    const name = "COGWORK_LATE_EXTERNAL_SECRET";
    return withLocalProcessSandbox(process.cwd(), defaultInheritedEnvironment, String, (sandbox) =>
      Effect.acquireUseRelease(
        Effect.sync(() => Reflect.get(process.env, name)),
        () =>
          Effect.sync(() => Reflect.set(process.env, name, "late-secret")).pipe(
            Effect.andThen(
              Effect.tryPromise({
                try: (signal) =>
                  sandbox.process.exec(
                    `node -e 'process.stdout.write(process.env[process.argv[1]] ?? "")' '${name}'`,
                    { signal },
                  ),
                catch: String,
              }).pipe(Effect.timeout("5 seconds")),
            ),
            Effect.tap((result) => Effect.sync(() => assert.strictEqual(result.stdout, ""))),
          ),
        (previous) =>
          Effect.sync(() =>
            previous === undefined
              ? Reflect.deleteProperty(process.env, name)
              : Reflect.set(process.env, name, previous),
          ),
      ),
    );
  });

  it("keeps the Codex inherited environment unchanged", () => {
    assert.deepStrictEqual(defaultInheritedEnvironment, [
      "HOME",
      "PATH",
      "CODEX_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "USER",
      "LOGNAME",
      "SHELL",
      "TMPDIR",
      "TEMP",
      "TMP",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
    ]);
  });
});
