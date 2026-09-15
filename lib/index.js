// dsh-engineer-tools — engineering work-tools for DeepSeek Harness.
//
// A Cordis plugin bundle that registers model-facing Host Tools. It is written
// as plain ESM (no build step) and mirrors the pattern used by the built-in
// @deepseek-ai/dsh-tool-bash: register a Tool via ctx.tools.register(defineTool(...))
// and run commands through the sandboxed ctx.shell service.
//
// To add another tool, copy one of the register blocks inside apply() and adjust
// the name/description/parameters/execute. Keep execute small: shell out, shape
// the result, return plain JSON.

import { defineTool } from "@deepseek-ai/dsh-tools";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const name = "engineer-tools";
// Both `shell` and `tools` are hard dependencies: the plugin waits until the
// host mounts them (the Cordis Guard rejects undeclared ctx access).
export const inject = ["shell", "tools"];

// Shared result schema for command-running tools.
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    stdout: { type: "string" },
    stderr: { type: "string" },
    exitCode: { oneOf: [{ type: "integer" }, { type: "null" }] },
    timedOut: { type: "boolean" },
  },
};

// Run a command through the dsh sandboxed shell and normalize the result.
async function runShell(ctx, exec, command, timeoutMs) {
  const shell = ctx.shell;
  const request = { command, signal: exec.signal };
  if (timeoutMs !== undefined) request.timeoutMs = timeoutMs;
  const result = await shell.run(shell.resolve(request));
  return {
    stdout: result.stdout?.text ?? "",
    stderr: result.stderr?.text ?? "",
    exitCode: result.exitCode ?? 0,
    timedOut: result.timedOut ?? false,
  };
}

function renderResult(_args, value) {
  let body = value.stdout.length > 0 ? value.stdout : "(no output)";
  if (value.stderr && value.stderr.length > 0) {
    if (!body.endsWith("\n")) body += "\n";
    body += `[stderr]\n${value.stderr}`;
  }
  if (value.exitCode) body += `\n[exit code: ${value.exitCode}]`;
  if (value.timedOut) body += "\n[timed out]";
  return [{ type: "text", text: body }];
}

// Package-manager detection from lockfiles in the workspace root.
function detectManager() {
  const cwd = process.cwd();
  if (existsSync(join(cwd, "bun.lockb"))) return "bun";
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

// Commands that run directly (no `run` verb) for each manager.
const DIRECT_CMDS = new Set([
  "install", "ci", "outdated", "audit", "publish", "link", "unlink",
  "prune", "dedupe", "rebuild", "exec", "dlx", "add", "remove", "rm",
  "update", "up", "why", "create", "init", "workspace", "x",
]);

function buildCommand(manager, script) {
  const direct = DIRECT_CMDS.has(script);
  switch (manager) {
    case "npm":
      return direct ? `npm ${script}` : `npm run ${script}`;
    case "pnpm":
      return direct ? `pnpm ${script}` : `pnpm run ${script}`;
    case "yarn":
      return `yarn ${script}`; // yarn resolves both scripts and built-ins
    case "bun":
      return direct ? `bun ${script}` : `bun run ${script}`;
    default:
      return `npm run ${script}`;
  }
}

export function apply(ctx) {
  // ── git: scoped git runner ──────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "git",
    description:
      "Run a git subcommand in the session workspace and return its output. " +
      "Prefer this over raw bash for git inspection: status, diff, log, branch, show, grep, etc.",
    parameters: {
      subcommand: {
        type: "string",
        required: true,
        description:
          "Git subcommand and arguments without the 'git' prefix. Examples: " +
          "'status --short', 'log --oneline -10', 'diff HEAD~1', 'branch -vv', 'show HEAD'.",
      },
      timeoutMs: {
        type: "number",
        description: "Optional timeout in milliseconds.",
      },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderResult },
    async execute(args, exec) {
      return runShell(ctx, exec, `git ${args.subcommand}`, args.timeoutMs);
    },
  }));

  // ── dev: package-manager runner with auto-detect ───────────────────────
  ctx.tools.register(defineTool({
    name: "dev",
    description:
      "Run a package-manager command in the workspace (npm/pnpm/yarn/bun). " +
      "Use for scripts (test/build/lint) and lifecycle commands (install/outdated/audit). " +
      "Manager is auto-detected from lockfiles, or set explicitly.",
    parameters: {
      script: {
        type: "string",
        required: true,
        description:
          "Script or command to run. Examples: 'test', 'build', 'lint', 'install', 'outdated', 'audit'.",
      },
      manager: {
        type: "string",
        enum: ["auto", "npm", "pnpm", "yarn", "bun"],
        description: "Package manager. 'auto' detects from lockfile (default).",
      },
      timeoutMs: {
        type: "number",
        description: "Optional timeout in milliseconds.",
      },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const manager =
        args.manager && args.manager !== "auto" ? args.manager : detectManager();
      const command = buildCommand(manager, args.script);
      return runShell(ctx, exec, command, args.timeoutMs);
    },
  }));
}
