// Smoke test for dsh-engineer-tools.
//
// Unlike the sibling client plugins, this one is a HOST plugin: it registers
// model-facing tools on the cordis context instead of shipping a browser
// bundle. So there is no client entry to evaluate — the test drives the real
// `apply()` against a fake ctx that records registrations, then exercises each
// tool's `execute` through a stubbed `ctx.shell`.
//
// Covered:
//   P1  the module exports name / inject / apply in the shape cordis expects
//   P2  apply() registers exactly the two documented tools
//   P3  both tools carry a compiled object schema with a required argument
//   P4  the git tool forwards its subcommand verbatim to `git <subcommand>`
//   P5  the dev tool detects npm/pnpm/yarn/bun from lockfiles, honours an
//       explicit `manager`, and picks the `run` verb per manager
//   P6  render() turns a shell result into text, with stderr / exit code /
//       timeout markers
//   P7  execute() rejects arguments that violate the declared schema
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mod = await import("../lib/index.js");

// ── P1: module shape ───────────────────────────────────────────────────────
assert.equal(mod.name, "engineer-tools");
assert.deepEqual(mod.inject, ["shell", "tools"], "inject list changed");
assert.equal(typeof mod.apply, "function", "apply must be exported");
console.log("P1 module shape ok (name=engineer-tools, inject=[shell, tools])");

// ── harness: fake ctx ──────────────────────────────────────────────────────
const registered = [];
const shellSpecs = [];
let shellResult = {
  stdout: { text: "ok" },
  stderr: { text: "" },
  exitCode: 0,
  timedOut: false,
};

const ctx = {
  tools: { register: (tool) => registered.push(tool) },
  shell: {
    resolve: (request) => ({ ...request, resolved: true }),
    run: async (spec) => {
      shellSpecs.push(spec);
      return shellResult;
    },
  },
};

mod.apply(ctx);

// ── P2: registrations ──────────────────────────────────────────────────────
const names = registered.map((t) => t.name).sort();
assert.deepEqual(names, ["dev", "git"], `unexpected tools: ${names.join(", ")}`);
const git = registered.find((t) => t.name === "git");
const dev = registered.find((t) => t.name === "dev");
assert.ok(git.description.includes("git"));
assert.ok(dev.description.includes("package-manager"));
console.log("P2 registered tools:", names.join(", "));

// ── P3: compiled schemas ───────────────────────────────────────────────────
for (const tool of [git, dev]) {
  assert.equal(tool.parameters.type, "object", `${tool.name} must take an object`);
  assert.ok(tool.output.schema.properties.stdout, `${tool.name} output schema lacks stdout`);
  assert.ok(
    tool.output.schema.properties.exitCode,
    `${tool.name} output schema lacks exitCode`,
  );
}
assert.deepEqual(git.parameters.required, ["subcommand"]);
assert.deepEqual(dev.parameters.required, ["script"]);
assert.deepEqual(dev.parameters.properties.manager.enum, ["auto", "npm", "pnpm", "yarn", "bun"]);
console.log("P3 compiled schemas ok (required args + output shape)");

const exec = { signal: undefined };
const lastCommand = () => shellSpecs.at(-1)?.command;

// ── P4: git tool ───────────────────────────────────────────────────────────
const gitOut = await git.execute({ subcommand: "log --oneline -3" }, exec);
assert.equal(lastCommand(), "git log --oneline -3");
assert.equal(gitOut.exitCode, 0);
assert.equal(gitOut.stdout, "ok");
// the caller's abort signal must reach the shell request
assert.ok(shellSpecs.at(-1).resolved, "the request must go through shell.resolve()");
console.log("P4 git tool forwards subcommand verbatim");

// ── P5: dev tool — manager detection and verb selection ────────────────────
const tmp = mkdtempSync(join(tmpdir(), "dsh-engineer-tools-"));
const origin = process.cwd();
const LOCKFILES = ["bun.lockb", "pnpm-lock.yaml", "yarn.lock"];

const reset = () => {
  for (const f of LOCKFILES) rmSync(join(tmp, f), { force: true });
};

try {
  process.chdir(tmp);

  // script verbs get `run` appended, except yarn, which resolves both itself
  const scriptCases = [
    [null, "npm run test"],
    ["bun.lockb", "bun run test"],
    ["pnpm-lock.yaml", "pnpm run test"],
    ["yarn.lock", "yarn test"],
  ];
  for (const [lock, expected] of scriptCases) {
    reset();
    if (lock) writeFileSync(join(tmp, lock), "");
    await dev.execute({ script: "test" }, exec);
    assert.equal(lastCommand(), expected, `detection with ${lock ?? "no lockfile"}`);
  }

  // lifecycle verbs run directly per manager
  const directCases = [
    [null, "npm install"],
    ["bun.lockb", "bun install"],
    ["pnpm-lock.yaml", "pnpm install"],
    ["yarn.lock", "yarn install"],
  ];
  for (const [lock, expected] of directCases) {
    reset();
    if (lock) writeFileSync(join(tmp, lock), "");
    await dev.execute({ script: "install" }, exec);
    assert.equal(lastCommand(), expected, `install with ${lock ?? "no lockfile"}`);
  }

  // an explicit manager wins over detection, including "auto"
  reset();
  writeFileSync(join(tmp, "pnpm-lock.yaml"), "");
  await dev.execute({ script: "build", manager: "npm" }, exec);
  assert.equal(lastCommand(), "npm run build", "explicit manager must override detection");
  await dev.execute({ script: "build", manager: "auto" }, exec);
  assert.equal(lastCommand(), "pnpm run build", "manager: auto must fall back to the lockfile");
  console.log("P5 dev tool: detection, verb selection, and override all ok");
} finally {
  process.chdir(origin);
  rmSync(tmp, { recursive: true, force: true });
}

// ── P6: render ─────────────────────────────────────────────────────────────
const render = git.output.render;
assert.deepEqual(render({}, { stdout: "hello", stderr: "", exitCode: 0, timedOut: false }), [
  { type: "text", text: "hello" },
]);
assert.deepEqual(
  render({}, { stdout: "", stderr: "boom", exitCode: 2, timedOut: true }),
  [{ type: "text", text: "(no output)\n[stderr]\nboom\n[exit code: 2]\n[timed out]" }],
);
// a silent success still renders something rather than an empty block
assert.deepEqual(render({}, { stdout: "", stderr: "", exitCode: 0, timedOut: false }), [
  { type: "text", text: "(no output)" },
]);
console.log("P6 render ok (stdout, stderr, exit code, timeout markers)");

// ── P7: schema validation ──────────────────────────────────────────────────
await assert.rejects(() => git.execute({}, exec), "a missing required arg must be rejected");
await assert.rejects(
  () => dev.execute({ script: "test", manager: "cargo" }, exec),
  "an out-of-enum manager must be rejected",
);
console.log("P7 argument validation ok (missing required arg + bad enum rejected)");

// ── the result the harness surfaces to the model is a plain JSON object ────
shellResult = { stdout: { text: "main\n" }, stderr: { text: "" }, exitCode: 0, timedOut: false };
const shaped = await git.execute({ subcommand: "branch" }, exec);
assert.deepEqual(Object.keys(shaped).sort(), ["exitCode", "stderr", "stdout", "timedOut"]);
console.log("result shape:", JSON.stringify(shaped));

console.log("ALL CHECKS PASSED");
