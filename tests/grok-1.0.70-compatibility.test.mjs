import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildGrokArgs, buildGrokBackgroundWrapperSource, parseGrokJsonOutput, runGrok, spawnGrokBackground } from "../plugins/grok/scripts/lib/grok.mjs";
import { buildCompanionInvocation, listToolDefinitions, runCompanion } from "../plugins/grok/mcp/server.mjs";
import { extractUsageFromParsed } from "../plugins/grok/scripts/lib/usage.mjs";
import { resolveJobsDir, readJobFile, writeJobFile, upsertJob } from "../plugins/grok/scripts/lib/jobs.mjs";

const companion = path.resolve("plugins/grok/scripts/grok-companion.mjs");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-1070-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, "mock-grok");
  fs.writeFileSync(binary, `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] === "version") { console.log("grok 1.0.70 (mock)"); process.exit(0); }
if (process.env.CAPTURE) fs.appendFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.env.STREAM) process.stdout.write(process.env.STREAM);
else console.log(JSON.stringify({text:"ok", sessionId:"mock-session", requestId:"req", stopReason:"end_turn"}));
process.exit(Number(process.env.MOCK_EXIT || 0));
`);
  fs.chmodSync(binary, 0o755);
  return { root, binary, env: { ...process.env, GROK_BINARY: binary, GROK_CODEX_PLUGIN_STATE: path.join(root, "state"), CODEX_PLUGIN_DATA: "", CAPTURE: path.join(root, "calls") } };
}
function invoke(f, args) {
  return spawnSync(process.execPath, [companion, ...args], { cwd: f.root, env: f.env, encoding: "utf8" });
}

test("retired options fail before companion jobs or Grok invocations and disappear from MCP schema", (t) => {
  const f = fixture(t);
  for (const args of [["--check"], ["--best-of-n", "3"], ["--check=true"], ["--best-of-n=2"]]) {
    const run = invoke(f, ["task", ...args, "fix tests", "--json"]);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr + run.stdout, /1\.0\.70.*does not support/);
  }
  assert.equal(fs.existsSync(f.env.GROK_CODEX_PLUGIN_STATE), false);
  assert.equal(fs.existsSync(f.env.CAPTURE), false);
  for (const options of [{ check: true }, { bestOfN: 3 }]) {
    for (const fn of [buildGrokArgs, runGrok, spawnGrokBackground]) {
      assert.throws(() => fn({ prompt: "fix", ...options }), /Remove these options/);
    }
    assert.throws(() => buildCompanionInvocation("grok_rescue", { prompt: "fix", ...options }), /1\.0\.70/);
    assert.throws(() => runCompanion("grok_rescue", { cwd: f.root, prompt: "fix", ...options }), /1\.0\.70/);
  }
  const schema = listToolDefinitions().find(x => x.name === "grok_rescue").inputSchema.properties;
  assert.equal(schema.check, undefined);
  assert.equal(schema.bestOfN, undefined);
  const args = buildGrokArgs({ prompt: "fix", check: false, bestOfN: 1 });
  assert.equal(args.includes("--check"), false);
  assert.equal(args.includes("--best-of-n"), false);
});

test("companion forwards max/xhigh, deep preset, named sandbox and inherited off to mock unchanged", (t) => {
  const f = fixture(t);
  f.env.GROK_SANDBOX = "inherited-profile";
  for (const [options, effort, sandbox] of [
    [["--effort", "max", "--sandbox", "MyCustomProfile"], "max", "MyCustomProfile"],
    [["--effort", "xhigh", "--sandbox", "off"], "xhigh", "off"],
    [["--model", "deep", "--sandbox", "ws"], "high", "workspace"],
    [["--model", "deep", "--effort", "max", "--sandbox", "ro"], "max", "read-only"]
  ]) {
    const run = invoke(f, ["task", ...options, "fix tests", "--json"]);
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const args = JSON.parse(fs.readFileSync(f.env.CAPTURE, "utf8").trim().split("\n").at(-1));
    assert.equal(args[args.indexOf("--effort") + 1], effort);
    assert.equal(args[args.indexOf("--sandbox") + 1], sandbox);
  }
  const invalid = invoke(f, ["task", "--effort", "invalid", "fix"]);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Invalid --effort/);
});

const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
const end = { type: "end", sessionId: "session-1070", requestId: "request-1070", stopReason: "end_turn", usage, num_turns: 2, total_cost_usd: 0.25, modelUsage: { test: { costUSD: 0.25 } }, usage_is_incomplete: false };
const cases = [
  ["successful end", [{ type: "text", data: "answer" }, end], 0, "completed"],
  ["non-default stop", [{ type: "text", data: "partial" }, { ...end, stopReason: "max_turn_requests" }], 0, "completed"],
  ["stream error after partial text", [{ type: "text", data: "partial" }, { ...end, type: "error", message: "fixture diagnostic", stopReason: "rate_limit", usage_is_incomplete: true }], 7, "failed"],
  ["stream error despite exit zero", [{ type: "text", data: "partial" }, { ...end, type: "error", message: "fixture diagnostic", stopReason: "error" }], 0, "failed"],
  ["missing terminal event", [{ type: "text", data: "partial" }], 0, "completed"],
  ["partial cost", [{ type: "text", data: "partial" }, { ...end, total_cost_usd_ticks: 250000000, cost_is_partial: true }], 0, "completed"],
  ["incomplete usage", [{ type: "text", data: "partial" }, { ...end, usage: { input_tokens: 10 }, total_cost_usd: null, usage_is_incomplete: true }], 0, "completed"]
];
for (const [name, events, exitCode, status] of cases) {
  test(`background wrapper and companion preserve ${name}`, (t) => {
    const f = fixture(t);
    f.env.STREAM = events.map(x => JSON.stringify(x)).join("\n"); // exercise final line without newline
    f.env.MOCK_EXIT = String(exitCode);
    const resultFile = path.join(f.root, "result.json");
    const progressFile = path.join(f.root, "progress.json");
    const wrapper = buildGrokBackgroundWrapperSource({ binary: f.binary, args: [], resultFile, progressFile, cwd: f.root, streaming: true });
    const run = spawnSync(process.execPath, ["-e", wrapper], { env: f.env, encoding: "utf8" });
    assert.equal(run.status, exitCode, run.stderr);
    const payload = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    assert.equal(payload.exitCode, exitCode);
    const parsed = parseGrokJsonOutput(payload.stdout);
    const terminal = events.findLast(x => ["end", "error"].includes(x.type));
    assert.equal(parsed.text, events[0].data);
    assert.equal(parsed.stopReason, terminal?.stopReason ?? null);
    assert.equal(parsed.requestId, terminal?.requestId ?? null);
    assert.equal(parsed.sessionId, terminal?.sessionId ?? null);
    assert.equal(parsed.parsed.terminalEventReceived, Boolean(terminal));
    assert.deepEqual(extractUsageFromParsed(parsed), terminal ? extractUsageFromParsed(terminal) : extractUsageFromParsed({ usage_is_incomplete: true }));
    if (terminal?.type === "error") assert.match(parsed.error, /fixture diagnostic/);
    const prevState = process.env.GROK_CODEX_PLUGIN_STATE;
    const prevData = process.env.CODEX_PLUGIN_DATA;
    process.env.GROK_CODEX_PLUGIN_STATE = f.env.GROK_CODEX_PLUGIN_STATE;
    process.env.CODEX_PLUGIN_DATA = "";
    try {
      const job = { id: "replayed", kind: "task", status: "running", title: name, workspaceRoot: f.root, resultFile, createdAt: new Date().toISOString() };
      fs.mkdirSync(resolveJobsDir(f.root), { recursive: true });
      writeJobFile(f.root, job);
      upsertJob(f.root, job);
      const finalized = invoke(f, ["result", job.id, "--json"]);
      assert.equal(finalized.status, status === "failed" ? 1 : 0, finalized.stderr);
      const publicJob = JSON.parse(finalized.stdout);
      const stored = readJobFile(f.root, job.id);
      if (terminal) {
        // Replay the same terminal payload as foreground JSON to compare persisted metadata.
        const foreground = invoke({ ...f, env: { ...f.env, STREAM: JSON.stringify({ ...terminal, text: events[0].data }) } }, ["task", "fix", "--json"]);
        assert.equal(foreground.status, status === "failed" ? 1 : 0, foreground.stderr);
        const output = JSON.parse(foreground.stdout);
        const foregroundJob = readJobFile(f.root, output.jobId);
        for (const key of ["stopReason", "requestId", "grokSessionId", "usage", "exitCode", "resultText", "status"]) {
          assert.deepEqual(stored[key], foregroundJob[key], key);
        }
        assert.equal(output.requestId, terminal.requestId);
        assert.equal(output.stopReason, terminal.stopReason);
      }
      for (const result of [publicJob, stored]) {
        assert.equal(result.status, status);
        assert.equal(result.stopReason, terminal?.stopReason ?? null);
        assert.equal(result.requestId, terminal?.requestId ?? null);
        assert.equal(result.grokSessionId, terminal?.sessionId ?? null);
        assert.equal(result.resultText, events[0].data);
        assert.equal(result.exitCode, exitCode);
        assert.equal(result.terminalEventReceived, Boolean(terminal));
        assert.deepEqual(result.usage, extractUsageFromParsed(parsed));
        if (name === "partial cost") {
          assert.equal(result.usage.cost_is_partial, true);
          assert.equal(result.usage.total_cost_usd_ticks, 250000000);
          assert.equal(result.usage.total_cost_usd, 0.25);
        }
        if (terminal?.type === "error") assert.match(result.error, /fixture diagnostic/);
      }
    } finally {
      if (prevState === undefined) delete process.env.GROK_CODEX_PLUGIN_STATE; else process.env.GROK_CODEX_PLUGIN_STATE = prevState;
      if (prevData === undefined) delete process.env.CODEX_PLUGIN_DATA; else process.env.CODEX_PLUGIN_DATA = prevData;
    }
    assert.equal(fs.readdirSync(f.root).some(x => x.startsWith("result.json.tmp")), false);
  });
}
