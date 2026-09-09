const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const pullsCollection = /(?:^|[\s'"/])repos\/[^/\s'"?]+\/[^/\s'"?]+\/pulls(?:[?\s'";]|$)/i;
const explicitVerb = /(?:^|\s)(?:-X|--request|--method)(?:=|\s*)([A-Za-z]+)/i;
const apiField = /(?:^|\s)(?:-f|-F|--field|--raw-field|--input)(?:=|\s+)/;
const requestBody =
  /(?:^|\s)(?:-d|--data(?:-raw|-binary|-urlencode|-ascii)?|--json|--form|--post-data|--post-file)(?:=|\s+)/;
const graphqlMutation = /\bcreatePullRequest\s*\(/;
const clientSubcommand = /(?:^|[\s|;&(<])gh\b[^|;&]*?\bpr\s+create\b/i;
const httpClient = /(?:^|[\s|;&(<])(?:gh\s+api|curl|wget|http)\b/i;
const shellRunsTheQuote = /(?:^|[\s|;&(])(?:(?:ba|z|k|d|a)?sh\s+-[a-z]*c|eval)\b|<<</i;
const bareWordQuote = /(^|[\s|;&(<])(['"])([\w.@+/-]+)\2/g;
const quotedSpan = /'[^']*'|"[^"]*"/g;
const executablePrefix = /(^|[\s|;&(<])(?:\\|(?:[\w.@+-]*\/)+)/g;

// A quoted span is usually text the agent passes on, so a commit subject or a work-item comment that
// names the refused command must not itself be refused. Three shapes still run what they quote: a
// shell given the span as its script, `eval`, and a here-string. Quoting or path-qualifying the
// command word changes nothing about what runs, so both are normalized away first.
const executedText = (command) => {
  const unwrapped = command.replace(bareWordQuote, "$1$3");
  const script = shellRunsTheQuote.test(unwrapped)
    ? unwrapped.replaceAll(/['"]/g, " ")
    : unwrapped.replace(quotedSpan, " ");
  return script.replace(executablePrefix, "$1");
};

const carriesRequestBody = (command) => {
  const verb = explicitVerb.exec(command)?.[1];
  if (verb !== undefined) return verb.toUpperCase() === "POST";
  return apiField.test(command) || requestBody.test(command);
};

export const createsPullRequest = (command) => {
  if (typeof command !== "string") return false;
  const executed = executedText(command);
  if (clientSubcommand.test(executed)) return true;
  if (!httpClient.test(executed)) return false;
  return (pullsCollection.test(command) && carriesRequestBody(command)) || graphqlMutation.test(command);
};

export const shouldRefuse = (payload) =>
  isRecord(payload) && isRecord(payload.tool_input) && createsPullRequest(payload.tool_input.command);

// Codex reads the whole reason back to the agent. A refused agent searches the repository for that
// wording. An empty reason makes Codex ignore the refusal and run the command.
export const refusal = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "The engine opens the pull request. Report ready-for-pr instead.",
  },
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

const run = async () => {
  if (!shouldRefuse(await readPayload())) return;
  process.stdout.write(`${JSON.stringify(refusal)}\n`);
};

if (import.meta.main) await run();
