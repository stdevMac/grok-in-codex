import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCompanion } from "../plugins/grok/mcp/server.mjs";
import { humanizeGrokFailure } from "../plugins/grok/scripts/lib/grok.mjs";

// A strict CLI fixture catches flags that permissive success-only mocks miss.
// No network or installed Grok binary is used by these tests.
const fixture = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'version') { console.log('grok 1.0.24'); process.exit(0); }
if (args.includes('--check')) { console.error("error: unexpected argument '--check' found"); process.exit(2); }
if (process.env.MOCK_REQUIRE_DEFAULT_EFFORT && args.includes('--effort')) {
  console.error('Unexpected effort override; expected CLI config inheritance'); process.exit(2);
}
const effort = args[args.indexOf('--effort') + 1];
if (args.includes('--effort') && !['high','medium','low'].includes(effort)) {
  console.error("Error: --effort/--reasoning-effort: unknown effort level '" + effort + "'; use one of: high, medium, low");
  process.exit(1);
}
const prompt = fs.readFileSync(args[args.indexOf('--prompt-file') + 1], 'utf8');
if (args.includes('streaming-json')) {
  console.log(JSON.stringify({type:'text', data:prompt}));
  console.log(JSON.stringify({type:'end', sessionId:'00000000-0000-4000-8000-000000000001'}));
} else {
  console.log(JSON.stringify({text:prompt, sessionId:'00000000-0000-4000-8000-000000000001'}));
}
`;

async function withFixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-cli-compat-"));
  const cwd = path.join(root, "workspace");
  const binary = path.join(root, "grok-fixture.cjs");
  fs.mkdirSync(cwd);
  fs.writeFileSync(binary, fixture, { mode: 0o755 });
  const previous = { ...process.env };
  process.env.GROK_BINARY = binary;
  process.env.GROK_CODEX_PLUGIN_STATE = path.join(root, "state");
  delete process.env.CODEX_PLUGIN_DATA;
  try {
    await fn(cwd);
  } finally {
    for (const key of ["GROK_BINARY", "GROK_CODEX_PLUGIN_STATE", "CODEX_PLUGIN_DATA", "MOCK_REQUIRE_DEFAULT_EFFORT"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("MCP self-check survives foreground and background launches without --check", async () => {
  await withFixture(async (cwd) => {
    for (const background of [false, true]) {
      const response = await runCompanion("grok_rescue", {
        cwd, prompt: "Verify the fixture", check: true, effort: "high",
        fresh: true, background, json: true
      });
      assert.equal(response.isError, false, JSON.stringify(response));
      let result = JSON.parse(response.content[0].text);
      if (background) {
        const jobId = result.jobId;
        const deadline = Date.now() + 5000;
        do {
          await new Promise((resolve) => setTimeout(resolve, 30));
          const reply = await runCompanion("grok_result", { cwd, jobId, json: true });
          result = JSON.parse(reply.content[0].text);
        } while (result.status === "running" && Date.now() < deadline);
      }
      assert.equal(result.status, "completed", JSON.stringify(result));
      const text = background ? result.resultText : result.text;
      assert.match(text, /Verify the fixture/);
      assert.match(text, /run the relevant focused checks/);
    }
  });
});

test("MCP reports unsupported effort without silently retrying at a lower level", async () => {
  await withFixture(async (cwd) => {
    const reply = await runCompanion("grok_rescue", {
      cwd, prompt: "Verify the fixture", effort: "xhigh", fresh: true, json: true
    });
    assert.equal(reply.isError, true);
    const result = JSON.parse(reply.content[0].text);
    assert.equal(result.status, "failed");
    assert.match(result.error, /high, medium, low/);
    assert.match(result.error, /has not substituted/);
  });
});

test("rescue deep alias and design inherit configured effort when omitted", async () => {
  await withFixture(async (cwd) => {
    process.env.MOCK_REQUIRE_DEFAULT_EFFORT = "1";
    for (const tool of ["grok_rescue", "grok_design"]) {
      const reply = await runCompanion(tool, {
        cwd, prompt: "Verify the fixture", model: "deep", json: true
      });
      assert.equal(reply.isError, false, JSON.stringify(reply));
      assert.equal(JSON.parse(reply.content[0].text).status, "completed");
    }
  });
});

test("worktree-ref alone fails before launching in the original directory", async () => {
  await withFixture(async (cwd) => {
    const reply = await runCompanion("grok_rescue", {
      cwd, prompt: "Verify the fixture", worktreeRef: "main", json: true
    });
    assert.equal(reply.isError, true);
    assert.match(reply.content[0].text, /isolated Git worktree/);
  });
});

test("effort diagnostics retain unknown future capability lists", () => {
  assert.match(humanizeGrokFailure({stderr:
    "Error: unknown effort level 'high'; use one of: adaptive, thorough"
  }), /adaptive, thorough/);
});
