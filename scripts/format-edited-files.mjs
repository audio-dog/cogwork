import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const patchPaths = (patch) =>
  [...patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)].map((match) => match[1]);

const singleFilePath = (value) =>
  isRecord(value) && typeof value.file_path === "string" ? [value.file_path] : [];

const codexPaths = (payload) => {
  if (!isRecord(payload)) return [];
  if (payload.tool_name === "apply_patch") {
    return isRecord(payload.tool_input) && typeof payload.tool_input.command === "string"
      ? patchPaths(payload.tool_input.command)
      : [];
  }
  if (payload.tool_name !== "Edit" && payload.tool_name !== "Write") return [];
  return singleFilePath(payload.tool_input);
};

export const pathsFromPayload = (payload) => {
  if (!isRecord(payload)) return null;
  if (payload.hook_event_name === "PostToolUse") return codexPaths(payload);
  if (payload.hook_event_name === "afterFileEdit") return singleFilePath(payload);
  if (payload.hook_event_name === undefined) return singleFilePath(payload);
  return [];
};

const within = (path, root) => {
  const fromRoot = relative(root, path);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
};

const eligibleFile = async (path, root) => {
  try {
    const canonical = await realpath(resolve(root, path));
    if (!within(canonical, root)) return null;
    const info = await stat(canonical);
    return info.isFile() && info.nlink === 1 ? canonical : null;
  } catch {
    return null;
  }
};

export const eligibleFiles = async (paths, checkout) => {
  const root = await realpath(checkout);
  const candidates = await Promise.all(paths.map((path) => eligibleFile(path, root)));
  return [...new Set(candidates.filter((path) => path !== null))];
};

const readInput = async () => {
  if (process.stdin.isTTY) return { payload: null, raw: "" };
  try {
    process.stdin.setEncoding("utf8");
    const raw = (await Array.fromAsync(process.stdin)).join("");
    return { payload: raw.trim() === "" ? null : JSON.parse(raw), raw };
  } catch {
    return { payload: null, raw: "invalid" };
  }
};

const formatWorkspace = (checkout) => {
  const result = spawnSync("pnpm", ["exec", "biome", "check", ".", "--write"], {
    cwd: checkout,
    stdio: "inherit",
  });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
};

const formatEditedFile = async (checkout, path) => {
  if (typeof constants.O_NOFOLLOW !== "number") return 0;

  try {
    const file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1) return 0;
      const input = await file.readFile("utf8");
      const result = spawnSync(
        "pnpm",
        [
          "exec",
          "biome",
          "check",
          "--write",
          "--no-errors-on-unmatched",
          "--files-ignore-unknown=true",
          `--stdin-file-path=${path}`,
        ],
        { cwd: checkout, encoding: "utf8", input },
      );
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.error) {
        console.error(result.error.message);
        return 1;
      }
      const canWrite = typeof result.stdout === "string" && (result.status === 0 || result.stdout.length > 0);
      if (canWrite && result.stdout !== input) {
        await file.truncate(0);
        await file.write(result.stdout, 0, "utf8");
      }
      return result.status ?? 1;
    } finally {
      await file.close();
    }
  } catch {
    return 0;
  }
};

const formatEditedFiles = async (checkout, files) => {
  const statuses = [];
  for (const file of files) statuses.push(await formatEditedFile(checkout, file));
  process.exitCode = statuses.find((status) => status !== 0) ?? 0;
};

const run = async () => {
  const checkout = process.cwd();
  const { payload, raw } = await readInput();
  const paths = pathsFromPayload(payload);
  if (paths === null) {
    if (raw.trim() !== "") return;
    formatWorkspace(checkout);
    return;
  }

  const files = await eligibleFiles(paths, checkout);
  if (files.length === 0) return;
  await formatEditedFiles(checkout, files);
};

if (import.meta.main) await run();
