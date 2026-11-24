import { defineRule, type ESTree } from "@oxlint/plugins";

const testFile = /\.test\.tsx?$/;

export default defineRule({
  meta: {
    type: "problem",
    messages: {
      exportInTest:
        "Rule: do not export from a test file. Why: a module that imports a test file also registers and runs that file's tests, so shared code in a test file couples two suites. Fix: move the shared value into a non-test module and import it from there, or keep it local to the test file.",
    },
  },
  create(context) {
    if (!testFile.test(context.filename)) {
      return {};
    }
    const report = (node: ESTree.ModuleDeclaration) => context.report({ node, messageId: "exportInTest" });
    return {
      ExportAllDeclaration: report,
      ExportDefaultDeclaration: report,
      ExportNamedDeclaration: report,
    };
  },
});
