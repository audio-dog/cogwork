import { definePlugin } from "@oxlint/plugins";

import noExportInTest from "./rules/no-export-in-test.ts";

export default definePlugin({
  meta: { name: "cogwork" },
  rules: { "no-export-in-test": noExportInTest },
});
