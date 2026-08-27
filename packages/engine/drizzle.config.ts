import { defineConfig } from "drizzle-kit";

export default defineConfig({ dialect: "sqlite", schema: "./src/control-store-schema.ts" });
