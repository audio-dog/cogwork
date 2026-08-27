import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourceDir = resolve(root, "packages/engine/drizzle");
const output = resolve(root, "packages/engine/src/control-store-migrations.ts");
const files = readdirSync(sourceDir)
  .filter((directory) => directory !== "meta" && !directory.startsWith("."))
  .map((directory) => resolve(sourceDir, directory, "migration.sql"))
  .sort();
const entries = files.map((file, id) => {
  const source = readFileSync(file);
  const statements = source
    .toString("utf8")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  return { id, hash: createHash("sha256").update(source).digest("hex"), statements };
});
const generatedEntries = entries
  .map(({ id, hash, statements }) => {
    const generatedStatements = statements.map((statement) => JSON.stringify(statement));
    const statementArray =
      generatedStatements.length === 1
        ? `[${generatedStatements[0]}]`
        : `[\n${generatedStatements.map((statement) => `      ${statement},`).join("\n")}\n    ]`;
    return `  {\n    id: ${id},\n    hash: ${JSON.stringify(hash)},\n    statements: ${statementArray},\n  },`;
  })
  .join("\n");
const module = `export interface Migration {\n  readonly id: number;\n  readonly hash: string;\n  readonly statements: ReadonlyArray<string>;\n}\n\nexport const migrations: ReadonlyArray<Migration> = [\n${generatedEntries}\n];\n`;

if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== module) process.exitCode = 1;
} else {
  writeFileSync(output, module);
}
