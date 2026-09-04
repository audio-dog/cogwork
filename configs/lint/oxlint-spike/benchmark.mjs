import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const spikeRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(spikeRoot, "../../..");

const resolveBin = (packageName, binName) => {
  const packagePath = require.resolve(`${packageName}/package.json`);
  const packageDirectory = path.dirname(packagePath);
  return path.resolve(packageDirectory, require(packagePath).bin[binName]);
};

const sourceFiles = spawnSync(
  "git",
  ["ls-files", "*.js", "*.jsx", "*.ts", "*.tsx", "*.mjs", "*.cjs", "*.mts", "*.cts"],
  { cwd: repoRoot, encoding: "utf8" },
)
  .stdout.split("\n")
  .filter(Boolean)
  .filter((file) => !file.startsWith("configs/lint/tests/fixtures/"))
  .filter((file) => !file.endsWith(".gen.ts"));

const oxlintBin = resolveBin("oxlint", "oxlint");
const biomeBin = resolveBin("@biomejs/biome", "biome");
const configPath = (name) => path.join(spikeRoot, name);

const scenarios = [
  {
    args: ["-A", "all", "--silent", "-c", configPath("oxlint-zero.json"), ...sourceFiles],
    command: oxlintBin,
    name: "oxlint-zero",
  },
  {
    args: ["-A", "all", "--silent", "-c", configPath("oxlint-one.json"), ...sourceFiles],
    command: oxlintBin,
    name: "oxlint-one",
  },
  {
    args: ["-A", "all", "--silent", "-c", configPath("oxlint-five.json"), ...sourceFiles],
    command: oxlintBin,
    name: "oxlint-five",
  },
  {
    args: [
      "lint",
      "--max-diagnostics=none",
      `--config-path=${configPath("biome-zero.json")}`,
      ...sourceFiles,
    ],
    command: biomeBin,
    name: "biome-zero",
  },
  {
    args: [
      "lint",
      "--max-diagnostics=none",
      `--config-path=${configPath("biome-five.json")}`,
      ...sourceFiles,
    ],
    command: biomeBin,
    name: "biome-five",
  },
];

const parseTime = (output, label) => {
  const match = output.match(new RegExp(`^${label}\\s+(\\d+(?:\\.\\d+)?)$`, "m"));
  if (!match) throw new Error(`Missing ${label} time in:\n${output}`);
  return Number(match[1]);
};

const measure = ({ args, command, name }) => {
  const result = spawnSync("/usr/bin/time", ["-p", command, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${name} failed:\n${result.stdout}${result.stderr}`);

  const userSeconds = parseTime(result.stderr, "user");
  const systemSeconds = parseTime(result.stderr, "sys");
  return { cpuSeconds: userSeconds + systemSeconds, wallSeconds: parseTime(result.stderr, "real") };
};

const median = (values) => {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
};

const summarize = (samples) => ({
  cpuSeconds: median(samples.map(({ cpuSeconds }) => cpuSeconds)),
  wallSeconds: median(samples.map(({ wallSeconds }) => wallSeconds)),
});

const roundsArgument = process.argv.slice(2).find((argument) => argument !== "--");
const rounds = Number.parseInt(roundsArgument ?? "7", 10);
if (!Number.isInteger(rounds) || rounds < 5) throw new Error("Pass at least 5 rounds");

for (const scenario of scenarios) measure(scenario);

const samples = new Map(scenarios.map(({ name }) => [name, []]));
for (const round of Array.from({ length: rounds }, (_, index) => index)) {
  const order = scenarios.map((_, index) => scenarios[(index + round) % scenarios.length]);
  for (const scenario of order) samples.get(scenario.name).push(measure(scenario));
}

const summary = Object.fromEntries([...samples].map(([name, values]) => [name, summarize(values)]));
const marginal = (full, baseline, rules) => ({
  cpuSeconds: (summary[full].cpuSeconds - summary[baseline].cpuSeconds) / rules,
  wallSeconds: (summary[full].wallSeconds - summary[baseline].wallSeconds) / rules,
});
const additionalOxlintRule = marginal("oxlint-five", "oxlint-one", 4);

console.log(
  JSON.stringify(
    {
      environment: {
        arch: process.arch,
        cpu: os.cpus()[0]?.model,
        logicalCpus: os.cpus().length,
        node: process.version,
        platform: process.platform,
      },
      fileCount: sourceFiles.length,
      marginalPerRule: {
        biomeFive: marginal("biome-five", "biome-zero", 5),
        oxlintFive: marginal("oxlint-five", "oxlint-zero", 5),
        oxlintOne: marginal("oxlint-one", "oxlint-zero", 1),
        oxlintRulesTwoThroughFive: additionalOxlintRule,
      },
      rounds,
      samples: Object.fromEntries(samples),
      summary,
    },
    null,
    2,
  ),
);
