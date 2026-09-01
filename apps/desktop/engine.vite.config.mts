import { chmodSync, copyFileSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const engineRequire = createRequire(new URL("../../packages/engine/package.json", import.meta.url));
const workspaceRequire = createRequire(new URL("../../package.json", import.meta.url));
const enginePackageRoot = dirname(dirname(engineRequire.resolve("@cogwork/engine")));
const drizzleKitRoot = dirname(engineRequire.resolve("drizzle-kit/payload/sqlite"));
const drizzleOrmRoot = dirname(engineRequire.resolve("drizzle-orm"));
const nodeBinary = workspaceRequire.resolve("node/bin/node");
const outputDir = fileURLToPath(new URL("./out/engine", import.meta.url));

const resolveBuildPlatform = (mode: string) => {
  const buildPlatform = mode === "production" ? process.platform : mode;
  if (buildPlatform === process.platform) return buildPlatform;

  throw new Error(
    `Desktop packages must be built on their target platform: ${buildPlatform} requested on ${process.platform}`,
  );
};

export default defineConfig(({ mode }) => {
  const buildPlatform = resolveBuildPlatform(mode);

  return {
    build: {
      emptyOutDir: true,
      outDir: "out/engine",
      rollupOptions: {
        external: ["drizzle-kit/payload/sqlite"],
        output: {
          entryFileNames: "index.js",
        },
      },
      ssr: "../cli/src/main.ts",
      target: "node24",
    },
    ssr: {
      noExternal: true,
    },
    plugins: [
      {
        name: "stage-engine-runtime",
        closeBundle() {
          const nodeExecutableName = buildPlatform === "win32" ? "node.exe" : "node";
          writeFileSync(join(outputDir, "package.json"), JSON.stringify({ type: "module" }));
          const nodeOutput = join(outputDir, "bin", nodeExecutableName);
          mkdirSync(dirname(nodeOutput), { recursive: true });
          copyFileSync(nodeBinary, nodeOutput);
          chmodSync(nodeOutput, 0o755);
          const drizzleKitOutput = join(outputDir, "node_modules", "drizzle-kit");
          mkdirSync(drizzleKitOutput, { recursive: true });
          copyFileSync(join(drizzleKitRoot, "package.json"), join(drizzleKitOutput, "package.json"));
          copyFileSync(
            join(drizzleKitRoot, "payload-sqlite.mjs"),
            join(drizzleKitOutput, "payload-sqlite.mjs"),
          );
          cpSync(drizzleOrmRoot, join(outputDir, "node_modules", "drizzle-orm"), {
            recursive: true,
          });
          const engineOutput = join(outputDir, "node_modules", "@cogwork", "engine");
          mkdirSync(join(engineOutput, "src"), { recursive: true });
          copyFileSync(join(enginePackageRoot, "package.json"), join(engineOutput, "package.json"));
          copyFileSync(join(enginePackageRoot, "src", "index.ts"), join(engineOutput, "src", "index.ts"));
          cpSync(
            join(enginePackageRoot, "operating-instructions"),
            join(engineOutput, "operating-instructions"),
            {
              recursive: true,
            },
          );
        },
      },
    ],
  };
});
