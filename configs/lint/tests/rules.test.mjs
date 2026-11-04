import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixtureRoot, lintWithRule, repoRoot } from "./rule-test-harness.mjs";

const ruleCases = [
  {
    message:
      "Rule: avoid nested IIFEs. Why: they hide sequencing and push wrapper hacks. Fix: bind a named context with const and keep one flat pipeline with a single Match/Option decision.",
    plugin: "iife",
    name: "no-arrow-ladder",
  },
  {
    message:
      "Rule: avoid Effect.all for sequential side-effect steps. Why: it hides imperative sequencing in an array. Fix: use one explicit linear pipeline with Effect.andThen/flatMap and reserve Effect.all for real value aggregation.",
    plugin: "effect-calls",
    name: "no-effect-all-step-sequencing",
  },
  {
    message:
      "Rule: avoid Effect.as. Why: it hides sequencing and turns effects into placeholders. Fix: use Effect.map for value mapping or Effect.asVoid after explicit pipeline steps.",
    plugin: "effect-calls",
    name: "no-effect-as",
  },
  {
    message:
      "Rule: avoid Effect.bind. Why: it hides sequencing inside builder-style accumulation. Fix: use one flat pipe-based Effect flow or one direct top-level Effect.gen with direct yields, not nested generators or wrapper helpers.",
    plugin: "effect-calls",
    name: "no-effect-bind",
  },
  {
    message:
      "Rule: avoid Effect.Do. Why: it pushes Effect code toward imperative builder choreography. Fix: use one flat pipe-based Effect flow or one direct top-level Effect.gen with direct yields, not nested generators or wrapper helpers.",
    plugin: "gated",
    name: "no-effect-do",
  },
  {
    message:
      "Rule: avoid Effect.fn generator wrappers. Why: they hide sequencing and dodge ladder rules. Fix: keep a single flat pipeline or use one Effect.gen.",
    plugin: "effect-calls",
    name: "no-effect-fn-generator",
  },
  {
    message:
      "Rule: avoid nested Effect combinators. Why: they hide sequencing and create laddered control flow. Fix: build context once (Effect.all/Effect.map) and then run a single flat pipeline.",
    plugin: "no-effect-ladder",
    name: "no-effect-ladder",
  },
  {
    message:
      "Rule: do not load an environment file into process.env. Why: cogwork resolves environment references only from the process environment the daemon was started with, so a file read at startup is a configuration source no Connection records. Fix: read the value from the daemon process environment, or record it as a Connection.",
    plugin: "no-env-file-load",
    name: "no-env-file-load",
  },
  {
    message:
      "Rule: avoid Effect.orElse around sequencing chains. Why: it hides error handling and splits the flow. Fix: move error handling to a single terminal decision after the pipeline.",
    plugin: "effect-calls",
    name: "no-effect-orElse-ladder",
  },
  {
    message:
      "Rule: avoid Effect.as for side effects. Why: it hides side effects and turns them into placeholders. Fix: use explicit pipeline steps that return real values with Effect.flatMap, Effect.andThen, or Effect.tap.",
    plugin: "effect-calls",
    name: "no-effect-side-effect-wrapper",
  },
  {
    message:
      "Rule: avoid Effect-step const staging. Why this is wrong: this const stores an intermediate Effect step, then later code has to chase names to reconstruct validation, decision, control flow, and the final Effect. Safe remediation: do not move the step into another helper or wrapper. Inline the step into one visible Effect pipeline at the operation that performs the work; use pipe/flatMap/andThen/tap to keep sequencing continuous. Bind a local only for a final domain-shaped value with an explicit domain type, not for staged Effect inputs.",
    plugin: "staging",
    name: "no-effect-step-const-staging",
  },
  {
    message:
      "Rule: do not return an Effect from Effect.sync. Why: the result is Effect<Effect<...>>, so the inner Effect is constructed and never run — a silent no-op. Fix: use Effect.suspend to defer building it, or call it directly when laziness is not needed.",
    plugin: "effect-calls",
    name: "no-effect-sync-effect",
  },
  {
    message:
      "Rule: do not pass an async thunk to Effect.sync. Why: the result is Effect<Promise<A>>, so the promise is never awaited, a rejection becomes an unhandled rejection instead of a typed failure, and interruption cannot cancel it. Fix: use Effect.tryPromise, whose callback receives an AbortSignal wired to interruption, or Effect.promise when it cannot reject.",
    plugin: "effect-calls",
    name: "no-effect-sync-promise",
  },
  {
    message:
      "Rule: do not throw inside Effect.sync. Why: Effect.sync is documented as not throwing, so a thrown value becomes a defect rather than a typed failure and escapes the error channel. Fix: use Effect.try with a catch that builds a typed error, or return Effect.fail for an expected failure.",
    plugin: "effect-calls",
    name: "no-effect-sync-throw",
  },
  {
    message:
      "Rule: avoid nested Effect.flatMap. Why: it hides sequencing and pushes laddered control flow. Fix: build context once (Effect.all/Effect.map) and run a single flatMap.",
    plugin: "no-flatmap-ladder",
    name: "no-flatmap-ladder",
    severity: "warning",
  },
  {
    message:
      "Rule: avoid immediate invocation of inline functions. Why: it hides decisions and sequencing. Fix: bind a named context with const and keep one Match/Option decision in a flat pipeline.",
    plugin: "iife",
    name: "no-iife-wrapper",
  },
  {
    message:
      "Rule: avoid multi-step sequencing inside Match branches. Why: it hides control flow. Fix: select a value in Match, then run one Effect pipeline outside. Avoid data-encoded conditionals (Option.toArray/forEach) that only rewrap the branch.",
    plugin: "member-calls",
    name: "no-match-effect-branch",
  },
  {
    message:
      "Rule: avoid void Match branches. Why: they hide guard-style control flow. Fix: remove the no-op branch or select a value and run one Effect pipeline outside the Match.",
    plugin: "member-calls",
    name: "no-match-void-branch",
  },
  {
    extension: "tsx",
    message:
      "Rule: the render prop of a Base UI button must agree with nativeButton. Why: <Button> has nativeButton true, so a <a> removes native button semantics (form submission, Enter and Space activation) and Base UI logs a console error. Fix: render a real <button>, or keep <a> and add nativeButton={false}.",
    plugin: "jsx",
    name: "no-native-button-mismatch",
  },
  {
    extension: "tsx",
    message:
      "Rule: a Base UI Select needs an items prop for its SelectValue. Why: SelectValue renders the raw value, not the SelectItem label, so the closed trigger shows a different text than the open list. Fix: pass items={[{ value, label }]} to <Select>, or give SelectValue a children function that renders the label.",
    plugin: "jsx",
    name: "no-select-without-items",
  },
  {
    message:
      "Rule: do not compare a wire-crossing union discriminant by hand. Why: the comparison is not exhaustive and does not use the generated type guard. Fix: use the union's generated match for a fold or guards for a single-variant test.",
    plugin: "gated",
    name: "no-wire-union-tag-comparison",
  },
  {
    message:
      "Rule: avoid deeply nested Effect calls (Effect.xx(Effect.yy(Effect.zz(...)))). Why: they hide sequencing and spread flow. Fix: build values first, then run one flat Effect pipeline.",
    plugin: "effect-calls",
    name: "no-nested-effect-call",
  },
  {
    message:
      "Rule: avoid nested Effect.gen. Why: nested generators hide sequencing. Fix: flatten to a single Effect.gen per method or a single flat pipeline.",
    plugin: "effect-calls",
    name: "no-nested-effect-gen",
  },
  {
    message:
      "Rule: avoid Option.as. Why: it hides selection and encourages placeholder flows. Fix: use Option.map or Option.match and return the value explicitly.",
    plugin: "member-calls",
    name: "no-option-as",
  },
  {
    message:
      "Rule: avoid pipeline fragment staging. Why this is wrong: this operation stages an intermediate pipeline fragment and then returns another pipeline that consumes it, so the reader must chase names to understand the final flow. Safe remediation: keep the producer and final selection in one visible pipeline, or promote a complete named domain operation.",
    plugin: "staging",
    name: "no-pipeline-fragment-staging",
  },
  {
    message:
      "Rule: avoid Runtime.runFork. Why: it escapes structured concurrency. Fix: use forkScoped, Stream, or runtime-provided layers instead.",
    plugin: "member-calls",
    name: "no-runtime-runfork",
  },
  {
    message:
      "Rule: no side effect inside a React state updater. Why: React may run the updater more than once (StrictMode double-invoke, concurrent replay), so a browser-storage write here can run twice or observe stale external state. Fix: compute the next state and return it; write to storage in the event handler or effect (reuse the setter that persists + sets state).",
    plugin: "no-side-effect-in-state-updater",
    name: "no-side-effect-in-state-updater",
  },
  {
    message:
      "Rule: no switch statements. Why: they read as a control-flow ladder, and a default case silently swallows new cases instead of failing the build. Fix: use a mapped-type object map keyed by the discriminant, a keyed dictionary of functions, a cond/rule table, or a tuple spec table projected into a Map — see https://github.com/taylorfsteele/cogwork/issues/102.",
    plugin: "staging",
    name: "no-switch",
  },
  {
    message:
      "Direct useEffect() calls are not allowed. Refactor to derived state, event handlers, the key prop, or a data-fetching library. See .agents/skills/react-no-use-effect. If you must keep it, suppress inline with a reason.",
    plugin: "no-use-effect",
    name: "no-use-effect",
  },
  {
    message:
      "Rule: avoid Effect.zipRight for side effects. Why: it hides side effects and discards values. Fix: use explicit pipeline steps that return real values with Effect.flatMap, Effect.andThen, or Effect.tap.",
    name: "no-effect-side-effect-wrapper-zip-right",
    plugin: "effect-calls",
  },
  {
    message:
      "Rule: avoid map+flatten ladders. Why: they hide sequencing. Fix: build context once (Effect.all/Effect.map) and run a single flatMap.",
    name: "no-flatmap-ladder-flatten",
    plugin: "no-flatmap-ladder",
    severity: "warning",
  },
  {
    message:
      "Rule: avoid multi-step sequencing inside Option.match branches. Why: it hides control flow. Prefer selecting a value in Option.match, then run one Effect pipeline outside. Leaf-level flows with local bindings may keep Option.match but should stay linear.",
    name: "no-match-effect-branch-option",
    plugin: "member-calls",
    severity: "info",
  },
];

// Rules are grouped into plugin files: Biome runs one pass over every source file
// per plugin file, so rules that share a root pattern share a file. See issue #433.
const biomeConfig = JSON.parse(readFileSync(path.join(repoRoot, "biome.json"), "utf8"));
// A scoped plugin lives in an override rather than at the top level, and must not
// escape the fixture requirement by hiding there.
const configuredPluginPaths = new Map(
  [biomeConfig, ...biomeConfig.overrides]
    .flatMap((source) => source.plugins ?? [])
    .map((plugin) => [path.basename(plugin, ".grit"), path.resolve(repoRoot, plugin)]),
);

test("every rule names a configured plugin file", () => {
  const missing = ruleCases.filter(({ plugin }) => !configuredPluginPaths.has(plugin));

  assert.deepEqual(missing, []);
});

test("every configured plugin file has rules with fixtures", () => {
  const claimed = new Set(ruleCases.map(({ plugin }) => plugin));
  const unclaimed = [...configuredPluginPaths.keys()].filter((name) => !claimed.has(name)).sort();

  assert.deepEqual(unclaimed, []);
});

// Grouping removed the one-file-per-rule relation that used to force every rule to
// have a fixture. Compare each plugin file's registered messages against the rules
// claiming it instead, so a rule added inside an existing file cannot ship untested.
test("every message a plugin file registers belongs to a tested rule", () => {
  const untested = [...configuredPluginPaths].flatMap(([name, pluginPath]) => {
    const source = readFileSync(pluginPath, "utf8");
    const registered = [...source.matchAll(/message\s*=\s*"((?:[^"\\]|\\.)*)"/g)].map(([, message]) =>
      message.replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
    );
    const tested = new Set(ruleCases.filter((rule) => rule.plugin === name).map((rule) => rule.message));
    return [...new Set(registered)]
      .filter((message) => !tested.has(message))
      .map((message) => ({ name, message }));
  });

  assert.deepEqual(untested, []);
});

for (const ruleCase of ruleCases) {
  const extension = ruleCase.extension ?? "ts";
  const fixtures = path.join(fixtureRoot, ruleCase.name);
  const rulePath = configuredPluginPaths.get(ruleCase.plugin);
  // A fixture can also trip a sibling rule in the same plugin file, so a count
  // assertion would break for reasons unrelated to the rule under test.
  const ownDiagnostics = (result) =>
    result.diagnostics.filter(
      (diagnostic) => diagnostic.category === "plugin" && diagnostic.message === ruleCase.message,
    );

  test(`${ruleCase.name} catches its prohibited pattern`, () => {
    const result = lintWithRule(rulePath, path.join(fixtures, `invalid-example.${extension}`));
    const reported = ownDiagnostics(result);

    assert.equal(reported.length, 1, result.output);
    assert.equal(reported[0].severity, ruleCase.severity ?? "error");
  });

  test(`${ruleCase.name} allows its supported alternative`, () => {
    const result = lintWithRule(rulePath, path.join(fixtures, `valid-example.${extension}`));

    assert.deepEqual(
      result.diagnostics.filter((diagnostic) => diagnostic.category === "plugin"),
      [],
      result.output,
    );
  });
}
