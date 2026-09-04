const messages = {
  noEffectSyncThrow:
    "Rule: do not throw inside Effect.sync. Why: Effect.sync is documented as not throwing, so a thrown value becomes a defect rather than a typed failure and escapes the error channel. Fix: use Effect.try with a catch that builds a typed error, or return Effect.fail for an expected failure.",
  noIifeWrapper:
    "Rule: avoid immediate invocation of inline functions. Why: it hides decisions and sequencing. Fix: bind a named context with const and keep one Match/Option decision in a flat pipeline.",
  noRuntimeRunFork:
    "Rule: avoid Runtime.runFork. Why: it escapes structured concurrency. Fix: use forkScoped, Stream, or runtime-provided layers instead.",
  noSwitch:
    "Rule: no switch statements. Why: they read as a control-flow ladder, and a default case silently swallows new cases instead of failing the build. Fix: use a mapped-type object map keyed by the discriminant, a keyed dictionary of functions, a cond/rule table, or a tuple spec table projected into a Map — see https://github.com/colonylabs/cogwork/issues/102.",
  noWireUnionTagComparison:
    "Rule: do not compare a wire-crossing union discriminant by hand. Why: the comparison is not exhaustive and does not use the generated type guard. Fix: use the union's generated match for a fold or guards for a single-variant test.",
};

const wireFamilies = [
  {
    imports: ["ClassifiedItem"],
    property: "_tag",
    values: new Set(["Eligible", "Claimed", "Blocked", "NeedsHuman"]),
  },
  { imports: ["WorkspaceState"], property: "_tag", values: new Set(["Registered", "Failed"]) },
  {
    imports: ["DaemonEvent"],
    property: "_tag",
    values: new Set([
      "SeedEnd",
      "RunActivity",
      "ItemChanged",
      "ItemRemoved",
      "RunChanged",
      "WorkspaceChanged",
      "WorkspaceRemoved",
      "ControlStoreChanged",
      "PluginsChanged",
      "ConnectionsChanged",
      "SchedulerChanged",
    ]),
  },
  {
    imports: ["PollState", "WorkspaceState"],
    property: "status",
    values: new Set(["ok", "pending", "paused"]),
  },
];

const isNamedMemberCall = (node, objectName, propertyName) =>
  node.type === "CallExpression" &&
  node.callee.type === "MemberExpression" &&
  node.callee.object.type === "Identifier" &&
  node.callee.object.name === objectName &&
  node.callee.property.type === "Identifier" &&
  node.callee.property.name === propertyName;

const unwrapChain = (node) => (node.type === "ChainExpression" ? node.expression : node);

const memberName = (node) => {
  const expression = unwrapChain(node);
  if (expression.type !== "MemberExpression") return undefined;
  if (expression.computed) return expression.property.value;
  return expression.property.name;
};

const stringValue = (node) =>
  node.type === "Literal" && typeof node.value === "string" ? node.value : undefined;

const comparisonParts = (node) => {
  if (node.operator !== "===" && node.operator !== "!==") return undefined;

  const leftProperty = memberName(node.left);
  const rightValue = stringValue(node.right);
  if (leftProperty && rightValue) return { property: leftProperty, value: rightValue };

  const rightProperty = memberName(node.right);
  const leftValue = stringValue(node.left);
  if (rightProperty && leftValue) return { property: rightProperty, value: leftValue };

  return undefined;
};

const importName = (specifier) => specifier.imported?.name ?? specifier.imported?.value;

const importsFromProgram = (node) =>
  new Set(
    node.body.flatMap((statement) => {
      if (statement.type !== "ImportDeclaration") return [];
      return statement.specifiers.map(importName).filter(Boolean);
    }),
  );

const matchesWireFamily = (importedNames, comparison) =>
  wireFamilies.some(
    (family) =>
      family.property === comparison.property &&
      family.values.has(comparison.value) &&
      family.imports.some((name) => importedNames.has(name)),
  );

const reportEffectSyncAncestors = (context, reported, node) => {
  const parent = node.parent;
  if (!parent) return;

  if (isNamedMemberCall(parent, "Effect", "sync") && !reported.has(parent)) {
    reported.add(parent);
    context.report({ messageId: "noEffectSyncThrow", node: parent });
  }

  reportEffectSyncAncestors(context, reported, parent);
};

const noEffectSyncThrow = {
  create: (context) => {
    const reported = new WeakSet();

    return {
      ThrowStatement: (node) => reportEffectSyncAncestors(context, reported, node),
    };
  },
  meta: { messages: { noEffectSyncThrow: messages.noEffectSyncThrow } },
};

const noRuntimeRunFork = {
  create: (context) => ({
    CallExpression: (node) => {
      if (!isNamedMemberCall(node, "Runtime", "runFork")) return;
      context.report({ messageId: "noRuntimeRunFork", node });
    },
  }),
  meta: { messages: { noRuntimeRunFork: messages.noRuntimeRunFork } },
};

const noIifeWrapper = {
  create: (context) => ({
    CallExpression: (node) => {
      if (node.callee.type !== "ArrowFunctionExpression" && node.callee.type !== "FunctionExpression") return;
      context.report({ messageId: "noIifeWrapper", node });
    },
  }),
  meta: { messages: { noIifeWrapper: messages.noIifeWrapper } },
};

const noWireUnionTagComparison = {
  create: (context) => {
    const program = context.sourceCode.ast;
    const importedNames = importsFromProgram(program);

    return {
      BinaryExpression: (node) => {
        const comparison = comparisonParts(node);
        if (!comparison || !matchesWireFamily(importedNames, comparison)) return;
        context.report({ messageId: "noWireUnionTagComparison", node });
      },
    };
  },
  meta: { messages: { noWireUnionTagComparison: messages.noWireUnionTagComparison } },
};

const noSwitch = {
  create: (context) => ({
    SwitchStatement: (node) => context.report({ messageId: "noSwitch", node }),
  }),
  meta: { messages: { noSwitch: messages.noSwitch } },
};

export default {
  meta: { name: "cogwork" },
  rules: {
    "no-effect-sync-throw": noEffectSyncThrow,
    "no-iife-wrapper": noIifeWrapper,
    "no-runtime-runfork": noRuntimeRunFork,
    "no-switch": noSwitch,
    "no-wire-union-tag-comparison": noWireUnionTagComparison,
  },
};
