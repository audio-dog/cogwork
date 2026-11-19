import { defineRule, type ESTree } from "@oxlint/plugins";

export const noExportInTest = defineRule({
  meta: {
    type: "problem",
    messages: {
      noExportInTest:
        "Rule: do not export from a test file. Why: a module that imports from a test file also loads that file and registers its tests. Fix: move the shared value to a module that is not a test file, and import it from there.",
    },
  },
  create: (context) => {
    const report = (node: ESTree.Node) => context.report({ node, messageId: "noExportInTest" });

    return {
      ExportAllDeclaration: report,
      ExportDefaultDeclaration: report,
      ExportNamedDeclaration: report,
    };
  },
});
