import { stat } from "node:fs/promises";

const TOKEN_LIMIT = 5_000;
const BYTES_PER_TOKEN = 4;

const formatCount = (count) => count.toLocaleString("en-US");

const estimateTokens = (bytes) => Math.ceil(bytes / BYTES_PER_TOKEN);

const measure = async (path) => ({ path, tokens: estimateTokens((await stat(path)).size) });

const splitInstructions = `Split each file into smaller files before you commit. Do these steps for each file:

1. Find the seams. List the exports and put them in groups, one group for each concept. A group that a
   caller can import without the rest of the file is a module.
2. Make one file for each group. Name the file for its concept in kebab-case. Keep the original name as
   a prefix when the concepts are related: "workflow-run.ts" becomes "workflow-run-retry.ts" and
   "workflow-run-ledger.ts". Do not use names such as "utils.ts", "helpers.ts", or "part-2.ts".
3. Move the code as it is. Change only the imports and the exports. Each caller imports from the file
   that defines the symbol. Do not add an "index.ts" or another file that only re-exports.
4. Split a test file to follow its source file, or by the behavior under test: "workflow-run.test.ts"
   becomes "workflow-run-retry.test.ts". Move shared layers, doubles, and data into a
   "<name>-fixtures.ts" file.
5. Split a Markdown file at its top-level headings into sibling files. Keep a short index in the
   original file that links to each part.
6. Run "pnpm typecheck", "pnpm test", and "pnpm format-and-lint". Then stage the new files and commit
   again.

Do not make a file smaller in other ways: do not remove comments, join lines, shorten names, or move
content into a string or a data file.

If a tool generates the file, or the file comes from a third party, add its path to the "exclude"
pattern of the "file-token-limit" hook in ".pre-commit-config.yaml".`;

const report = (oversized) => {
  const width = Math.max(...oversized.map(({ path }) => path.length));
  const rows = oversized.map(({ path, tokens }) => `  ${path.padEnd(width)}  ${formatCount(tokens)} tokens`);
  return [
    `check-file-tokens: ${oversized.length} staged file(s) are larger than ${formatCount(TOKEN_LIMIT)} tokens.`,
    `A token is ${BYTES_PER_TOKEN} bytes, so the limit is ${formatCount(TOKEN_LIMIT * BYTES_PER_TOKEN)} bytes.`,
    "",
    ...rows,
    "",
    splitInstructions,
  ].join("\n");
};

const run = async () => {
  const measured = await Promise.all(process.argv.slice(2).map(measure));
  const oversized = measured.filter(({ tokens }) => tokens > TOKEN_LIMIT);
  if (oversized.length === 0) return;
  console.error(report(oversized));
  process.exitCode = 1;
};

if (import.meta.main) await run();
