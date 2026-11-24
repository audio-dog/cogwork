import { spawnSync } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const patchPaths = (patch) =>
  [...patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)].map((match) => match[1]);

const singleFilePath = (value) =>
  isRecord(value) && typeof value.file_path === "string" ? [value.file_path] : [];

const codexPaths = (payload) => {
  if (payload.tool_name === "apply_patch") {
    return isRecord(payload.tool_input) && typeof payload.tool_input.command === "string"
      ? patchPaths(payload.tool_input.command)
      : [];
  }
  if (payload.tool_name !== "Edit" && payload.tool_name !== "Write") return [];
  return singleFilePath(payload.tool_input);
};

const pathsFromPayload = (payload) => {
  if (!isRecord(payload)) return [];
  if (payload.hook_event_name === "PostToolUse") return codexPaths(payload);
  return singleFilePath(payload);
};

const within = (path, root) => {
  const fromRoot = relative(root, path);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
};

// Canonicalize first so a symlink cannot smuggle a write outside the checkout. realpath does not
// resolve hard links, so a second link is the only signal that the file also lives outside.
const eligibleFile = async (path, root, workingDirectory) => {
  try {
    const canonical = await realpath(resolve(workingDirectory, path));
    if (!within(canonical, root)) return null;
    const info = await stat(canonical);
    return info.isFile() && info.nlink === 1 ? canonical : null;
  } catch {
    return null;
  }
};

const eligibleFiles = async (paths, root, workingDirectory) => {
  const candidates = await Promise.all(paths.map((path) => eligibleFile(path, root, workingDirectory)));
  return [...new Set(candidates.filter((path) => path !== null))];
};

const readPayload = async () => {
  if (process.stdin.isTTY) return null;
  try {
    process.stdin.setEncoding("utf8");
    const raw = (await Array.fromAsync(process.stdin)).join("");
    return raw.trim() === "" ? null : JSON.parse(raw);
  } catch {
    return null;
  }
};

const runTool = (checkout, tool, args) => {
  const result = spawnSync(join(checkout, "node_modules", ".bin", tool), args, {
    cwd: checkout,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return result.status ?? 1;
};

const tidyFiles = (checkout, files) => {
  const lintStatus = runTool(checkout, "oxlint", ["--fix", "--no-error-on-unmatched-pattern", ...files]);
  const formatStatus = runTool(checkout, "oxfmt", [
    "--write",
    "--disable-nested-config",
    "--no-error-on-unmatched-pattern",
    ...files,
  ]);
  return lintStatus || formatStatus;
};

// The hook runs wherever the harness left the agent, so the checkout comes from this file's own
// location rather than the working directory.
const run = async () => {
  const checkout = await realpath(join(import.meta.dirname, ".."));
  const payload = await readPayload();
  const paths = pathsFromPayload(payload);
  if (paths.length === 0) return;

  const workingDirectory = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  const files = await eligibleFiles(paths, checkout, workingDirectory);
  if (files.length === 0) return;
  process.exitCode = tidyFiles(checkout, files);
};

if (import.meta.main) await run();
