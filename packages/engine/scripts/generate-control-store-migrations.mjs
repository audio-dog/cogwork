// The folder name is the migration identity: drizzle-kit names it `<utc-timestamp>_<slug>`, which is
// the `<id>_<name>` shape Effect's `Migrator.fromRecord` parses and orders by id.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";

const pkg = resolve(import.meta.dirname, "..");
const output = resolve(pkg, "src/control-store-migrations.gen.ts");
const files = readMigrationFiles({ migrationsFolder: resolve(pkg, "drizzle") });

const entries = files.map(({ name, sql }) => {
  const statements = sql.map((statement) => statement.trim()).filter(Boolean);
  return `  ${JSON.stringify(name)}: apply([\n${statements
    .map((statement) => `    ${JSON.stringify(statement)},`)
    .join("\n")}\n  ]),`;
});

const module = `// Generated from packages/engine/drizzle by scripts/generate-control-store-migrations.mjs.
// Do not edit by hand: run \`pnpm --filter @cogwork/engine drizzle:generate\`.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const apply = Effect.fn("ControlStore.applyMigration")(function* (statements: ReadonlyArray<string>) {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of statements) yield* sql.unsafe(statement);
});

export const migrations = {
${entries.join("\n")}
};
`;

if (process.argv.includes("--check")) {
  const { readFileSync } = await import("node:fs");
  if (readFileSync(output, "utf8") !== module) {
    console.error(
      "control-store-migrations.gen.ts is out of date with packages/engine/drizzle.\nRun `pnpm --filter @cogwork/engine drizzle:generate`.",
    );
    process.exitCode = 1;
  }
} else {
  writeFileSync(output, module);
}
