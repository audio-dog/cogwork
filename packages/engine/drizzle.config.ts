import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/control-store-schema.ts",
  dbCredentials: { url: join(homedir(), ".cogwork", "control.db") },
});
