import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { createsPullRequest, refusal, shouldRefuse } from "./refuse-pull-request-creation.mjs";

const scriptPath = fileURLToPath(new URL("./refuse-pull-request-creation.mjs", import.meta.url));
const checkout = join(import.meta.dirname, "..");

const refusedCommands = [
  "gh pr create --base main --head 475-refuse",
  "gh pr create --draft --fill",
  "gh --repo colonylabs/cogwork pr create --head 475-refuse",
  "git push -u origin HEAD && gh pr create --title Done --body Ready",
  "gh api --method POST /repos/colonylabs/cogwork/pulls -f title=Done",
  "gh --hostname github.com api --method POST /repos/colonylabs/cogwork/pulls -f title=Done",
  "gh api repos/colonylabs/cogwork/pulls -f title=Done -f head=475-refuse -f base=main",
  `gh api graphql -f query='mutation { createPullRequest(input: $input) { pullRequest { url } } }'`,
  "curl -X POST https://api.github.com/repos/colonylabs/cogwork/pulls -d @body.json",
  String.raw`curl -X POST \
https://api.github.com/repos/colonylabs/cogwork/pulls \
-d @body.json`,
  'curl -X POST "https://api.github.com/repos/colonylabs/cogwork/pulls" -d @body.json',
  "curl -X GET https://api.github.com/repos/colonylabs/cogwork/pulls && curl -X POST https://api.github.com/repos/colonylabs/cogwork/pulls -d @body.json",
  "curl -d 'note -X GET' -X POST https://api.github.com/repos/colonylabs/cogwork/pulls",
  "curl https://api.github.com/repos/colonylabs/cogwork/pulls -d@body.json",
  "curl -x proxy:8080 -d @body.json https://api.github.com/repos/colonylabs/cogwork/pulls",
  `curl https://api.github.com/repos/colonylabs/cogwork/pulls --data '{"title":"Done"}'`,
  `curl https://api.github.com/graphql -d '{"query":"mutation{createPullRequest(input:$i){pullRequest{url}}}"}'`,
  "wget --post-file=body.json https://api.github.com/repos/colonylabs/cogwork/pulls",
  `curl -XPOST https://api.github.com/repos/colonylabs/cogwork/pulls --json '{"title":"Done"}'`,
  `curl --data-ascii '{"title":"Done"}' https://api.github.com/repos/colonylabs/cogwork/pulls`,
  "curl --form title=Done https://api.github.com/repos/colonylabs/cogwork/pulls",
  "curl -F title=Done https://api.github.com/repos/colonylabs/cogwork/pulls",
  `sh -c 'gh pr create --fill'`,
  `bash -c "gh pr create --fill"`,
  `zsh -lc 'curl -X POST https://api.github.com/repos/colonylabs/cogwork/pulls -d @body.json'`,
  `eval "gh pr create --fill"`,
  `bash <<< "gh pr create --fill"`,
  `sh -c "/usr/bin/gh pr create --fill"`,
  `"gh" pr create --fill`,
  `"curl" -X POST https://api.github.com/repos/colonylabs/cogwork/pulls -d @body.json`,
  "/opt/homebrew/bin/gh pr create --fill",
  "/usr/bin/curl -X POST https://api.github.com/repos/colonylabs/cogwork/pulls -d @body.json",
  String.raw`\gh pr create --fill`,
  String.raw`\curl -X POST https://api.github.com/repos/colonylabs/cogwork/pulls -d @body.json`,
  "echo `gh pr create --fill`",
];

const allowedCommands = [
  "gh pr view 475",
  "gh pr list --state open",
  "gh pr diff 475",
  "gh pr review 475 --approve",
  "gh pr comment 475 --body 'Rebased onto main'",
  "gh issue comment 475 --body 'Ready for review'",
  "gh api /repos/colonylabs/cogwork/pulls",
  "gh api /repos/colonylabs/cogwork/pulls/475/reviews -f event=COMMENT -f body=Looks+good",
  "curl https://api.github.com/repos/colonylabs/cogwork/pulls",
  "curl -f https://api.github.com/repos/colonylabs/cogwork/pulls",
  "git push origin HEAD",
  "git push --force-with-lease origin 475-refuse",
  "gh pr view 475 | grep 'pr create'",
  "grep -rn createPullRequest packages/engine/src",
  "grep -n 'createPullRequest(' schema.graphql",
  "gh api --method GET repos/colonylabs/cogwork/pulls -f head=colonylabs:475-refuse",
  "gh api -X GET /repos/colonylabs/cogwork/pulls -f state=open",
  "git commit -m 'feat(hooks): refuse gh pr create in a Codex Run'",
  `git commit -m "refuse gh pr create"`,
  `git commit -m 'mention eval, bash -c, and <<< before "gh pr create"'`,
  "gh issue comment 475 --body 'I did not run gh pr create; the engine opens it'",
  "gh search issues 'pr create'",
  "gh api /repos/colonylabs/cogwork/issues/475/comments -f body='blocked on gh pr create'",
  "gh api /repos/colonylabs/cogwork/issues/475/comments -f body='POST /repos/colonylabs/cogwork/pulls or createPullRequest(input: $input)'",
];

describe("createsPullRequest", () => {
  for (const command of refusedCommands) {
    it(`refuses ${command}`, () => assert.equal(createsPullRequest(command), true));
  }

  for (const command of allowedCommands) {
    it(`allows ${command}`, () => assert.equal(createsPullRequest(command), false));
  }
});

describe("shouldRefuse", () => {
  it("refuses whatever the caller, because the payload's agent fields are not read", () => {
    const tool_input = { command: "gh pr create --fill" };
    const callers = [
      { tool_name: "Bash", tool_input },
      { agent_id: "agent-1", agent_type: "worker", tool_name: "Bash", tool_input },
    ];

    for (const payload of callers) assert.equal(shouldRefuse(payload), true);
  });

  it("allows a payload that carries no command", () => {
    for (const payload of [null, {}, { tool_input: null }, { tool_input: { command: 7 } }]) {
      assert.equal(shouldRefuse(payload), false);
    }
  });
});

describe("refusal", () => {
  const { permissionDecisionReason } = refusal.hookSpecificOutput;

  it("is the decision Codex reads to deny a tool call", () => {
    assert.deepEqual(refusal, {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "The engine opens the pull request. Report ready-for-pr instead.",
      },
    });
  });

  it("carries a reason, which Codex needs to apply the refusal at all", () => {
    assert.notEqual(permissionDecisionReason.trim(), "");
  });

  it("names no file, setting, or search term that leads to this control", () => {
    for (const term of [
      "hook",
      ".codex",
      "refuse-pull-request-creation",
      "scripts/",
      "matcher",
      "PreToolUse",
    ]) {
      assert.ok(!permissionDecisionReason.toLowerCase().includes(term.toLowerCase()), `reason names ${term}`);
    }
  });
});

describe("refuse-pull-request-creation hook", () => {
  const hook = (payload) =>
    spawnSync(process.execPath, [scriptPath], { encoding: "utf8", input: JSON.stringify(payload) });

  it("writes the refusal and exits clean so Codex reads the decision", () => {
    const result = hook({ tool_name: "Bash", tool_input: { command: "gh pr create --fill" } });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), refusal);
  });

  it("stays silent for an allowed command", () => {
    const result = hook({ tool_name: "Bash", tool_input: { command: "gh pr view 475" } });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });

  it("stays silent for input it cannot read", () => {
    for (const input of ["", "   ", "not json", "[]"]) {
      const result = spawnSync(process.execPath, [scriptPath], { encoding: "utf8", input });
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "");
    }
  });
});

describe("Codex Hook declaration", () => {
  const declaration = JSON.parse(readFileSync(join(checkout, ".codex", "hooks.json"), "utf8"));

  it("runs this script before every shell tool call", () => {
    const [group, ...rest] = declaration.hooks.PreToolUse;
    assert.deepEqual(rest, []);
    assert.equal(group.matcher, "Bash");
    const [handler, ...others] = group.hooks;
    assert.deepEqual(others, []);
    assert.equal(handler.type, "command");
    assert.match(handler.command, /scripts\/refuse-pull-request-creation\.mjs$/);
    // An asynchronous handler cannot deny; Codex applies its decision after the call has run.
    assert.equal(handler.async, undefined);
  });

  it("leaves the formatting Hook in place", () => {
    const [group] = declaration.hooks.PostToolUse;
    assert.equal(group.matcher, "apply_patch|Edit|Write");
    assert.match(group.hooks[0].command, /scripts\/format-edited-files\.mjs$/);
  });
});
