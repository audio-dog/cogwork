// Turns the Drizzle schema into the statements that create the Control store.
//
// A user's machine has no drizzle-kit, so the statements have to reach the engine as code.
// drizzle-kit emits them; nothing here writes SQL.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const pkg = resolve(import.meta.dirname, "..");
const output = resolve(pkg, "src/control-store-create.gen.ts");
const envelope = JSON.parse(
  execFileSync("drizzle-kit", ["export", "--sql", "--output", "json"], { cwd: pkg, encoding: "utf8" }),
);
if (envelope.status !== "ok") {
  console.error(`drizzle-kit export failed: ${JSON.stringify(envelope)}`);
  process.exit(1);
}

const statements = envelope.statements.map((statement) => statement.trim()).filter(Boolean);
const module = `// Generated from src/control-store-schema.ts by scripts/generate-control-store-create.mjs.
// Do not edit by hand: run \`pnpm --filter @cogwork/engine drizzle:schema\`.
export const createStatements: ReadonlyArray<string> = [
${statements.map((statement) => `  ${JSON.stringify(statement)},`).join("\n")}
];
`;

if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== module) {
    console.error(
      "control-store-create.gen.ts is out of date with the schema.\nRun `pnpm --filter @cogwork/engine drizzle:schema`.",
    );
    process.exitCode = 1;
  }
} else {
  writeFileSync(output, module);
}
