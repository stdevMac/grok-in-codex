import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGrokArgs,
  buildGrokBackgroundWrapperSource,
  formatStreamProgressMessage,
  getStreamProgressHelperSource,
  humanizeGrokFailure,
  parseGrokModelsOutput,
  parseGrokJsonOutput
} from "../plugins/grok/scripts/lib/grok.mjs";

test("parseGrokModelsOutput discovers the CLI default and available models", () => {
  const parsed = parseGrokModelsOutput({
    status: 0,
    stdout: [
      "You are logged in with grok.com.",
      "Default model: grok-4.6",
      "Available models:",
      "  * grok-4.6 (default)",
      "  - grok-4.5"
    ].join("\n")
  });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.defaultModel, "grok-4.6");
  assert.deepEqual(parsed.availableModels, ["grok-4.6", "grok-4.5"]);
});

test("parseGrokModelsOutput fails closed when models cannot be discovered", () => {
  const parsed = parseGrokModelsOutput({ status: 1, stderr: "not logged in" });
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.availableModels, []);
});

test("parseGrokModelsOutput ignores unrelated bulleted diagnostics", () => {
  const parsed = parseGrokModelsOutput({
    status: 0,
    stdout: "Default model: grok-4.6\nAvailable models:\n  * grok-4.6 (default)",
    stderr: "Warnings:\n  - config key ignored"
  });
  assert.deepEqual(parsed.availableModels, ["grok-4.6"]);
});

test("parseGrokJsonOutput reads success payload", () => {
  const parsed = parseGrokJsonOutput(
    JSON.stringify({
      text: "hello",
      stopReason: "EndTurn",
      sessionId: "sess-1",
      requestId: "req-1"
    })
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.text, "hello");
  assert.equal(parsed.sessionId, "sess-1");
});

test("parseGrokJsonOutput reads error payload", () => {
  const parsed = parseGrokJsonOutput(JSON.stringify({ type: "error", message: "nope" }));
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /nope/);
});

test("buildGrokArgs write mode uses yolo", () => {
  const args = buildGrokArgs({ prompt: "hi", write: true, model: "grok-4.5" });
  assert.ok(args.includes("--yolo"));
  assert.ok(args.includes("-m"));
  assert.ok(args.includes("grok-4.5"));
});

test("buildGrokArgs read-only mode uses denylist not allowlist", () => {
  const args = buildGrokArgs({ prompt: "review", write: false });
  assert.ok(!args.includes("--yolo"));
  assert.ok(!args.includes("--tools"));
  assert.ok(args.includes("--disallowed-tools"));
  assert.ok(args.some((a) => String(a).includes("run_terminal_cmd")));
  assert.ok(args.includes("--rules"));
});

test("buildGrokArgs media mode avoids tools allowlist and yolo", () => {
  const args = buildGrokArgs({
    prompt: "draw a banner",
    media: true,
    write: false,
    yolo: false
  });
  assert.ok(!args.includes("--tools"));
  assert.ok(!args.includes("--yolo"));
  assert.ok(args.includes("--disallowed-tools"));
  assert.ok(args.some((a) => String(a).includes("run_terminal_cmd")));
});

test("humanizeGrokFailure maps RequirementError tool dumps", () => {
  const msg = humanizeGrokFailure({
    stderr:
      'RequirementError { message: "run_terminal_cmd background param constraint with --tools allowlist" }',
    exitCode: 1
  });
  assert.match(msg, /tool configuration/i);
  assert.match(msg, /disallowed-tools/i);
  assert.ok(!/RequirementError \{/.test(msg));
});

test("humanizeGrokFailure maps auth failures", () => {
  const msg = humanizeGrokFailure({ stderr: "Error: not logged in" });
  assert.match(msg, /not authenticated/i);
  assert.match(msg, /grok login/i);
});

test("parseGrokJsonOutput humanizes bare RequirementError text", () => {
  const parsed = parseGrokJsonOutput(
    'Error: RequirementError { kind: "tools", detail: "run_terminal_cmd background" }'
  );
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /tool configuration|requirement error/i);
});

test("formatStreamProgressMessage tails accumulated text", () => {
  assert.equal(formatStreamProgressMessage("  hello   world  "), "hello world");
  const long = "a".repeat(200);
  const msg = formatStreamProgressMessage(long);
  assert.equal(msg.length, 160);
  assert.equal(msg, "a".repeat(160));
});

test("formatStreamProgressMessage is empty until non-whitespace content exists", () => {
  // Grok emits truthy whitespace-only thought/text chunks; helper must not invent
  // a prefix-only line — call sites floor empty to "running".
  assert.equal(formatStreamProgressMessage(""), "");
  assert.equal(formatStreamProgressMessage("   "), "");
  assert.equal(formatStreamProgressMessage(" \n\t "), "");
  assert.equal(formatStreamProgressMessage("", { prefix: "thinking: " }), "");
  assert.equal(formatStreamProgressMessage("  ", { prefix: "thinking: " }), "");
  // Floor pattern used by the background worker
  assert.equal(formatStreamProgressMessage(" \n") || "running", "running");
  assert.equal(
    formatStreamProgressMessage("  ", { prefix: "thinking: " }) || "running",
    "running"
  );
});

test("formatStreamProgressMessage tails thinking with prefix (not single token)", () => {
  // Live repro: thought events stream as tiny chunks; progress must show a tail of all of them.
  let thoughtAcc = "";
  for (const chunk of [" frame", "...", " how control.mjs is used", " across the plugin"]) {
    thoughtAcc += chunk;
  }
  const msg = formatStreamProgressMessage(thoughtAcc, { prefix: "thinking: " });
  assert.match(msg, /^thinking: /);
  assert.match(msg, /across the plugin/);
  assert.ok(!/^thinking:  frame\.\.\.$/.test(msg), "must not show only first token");
  // Last token alone would be " across the plugin" — full tail is longer.
  assert.ok(msg.length > "thinking:  across the plugin".length);
});

test("background wrapper embeds the same progress helper tests exercise", () => {
  const helperSrc = getStreamProgressHelperSource();
  assert.equal(helperSrc, formatStreamProgressMessage.toString());

  // The string that lands in the worker is the live function body — evaluate it.
  const embedded = new Function(`${helperSrc}; return formatStreamProgressMessage;`)();
  assert.equal(embedded("  hello   world  "), "hello world");
  assert.equal(embedded("a".repeat(200)).length, 160);
  assert.equal(embedded(" \n") || "running", "running");
  assert.equal(embedded("  ", { prefix: "thinking: " }) || "running", "running");

  let thoughtAcc = "";
  for (const chunk of [" frame", "...", " how control.mjs is used", " across the plugin"]) {
    thoughtAcc += chunk;
  }
  const thinking = embedded(thoughtAcc, { prefix: "thinking: " });
  assert.match(thinking, /^thinking: /);
  assert.match(thinking, /across the plugin/);

  const wrapper = buildGrokBackgroundWrapperSource({
    binary: "/usr/bin/true",
    args: ["-p", "hi"],
    resultFile: "/tmp/result.json",
    progressFile: "/tmp/progress.json",
    cwd: "/tmp",
    streaming: true
  });
  assert.ok(
    wrapper.includes(helperSrc),
    "worker script must contain the helper source (not a drifted copy)"
  );
  assert.ok(!wrapper.includes("formatProgressTail"), "old inline copy must be gone");
  assert.match(wrapper, /formatStreamProgressMessage\(thoughtAcc/);
  assert.match(wrapper, /formatStreamProgressMessage\(textAcc/);
  // Call-site floor: empty helper result must not blank /status
  assert.match(
    wrapper,
    /formatStreamProgressMessage\(textAcc,\s*\{\}\)\s*\|\|\s*"running"/
  );
  assert.match(wrapper, /\|\|\s*"running"/g);
  const floors = wrapper.match(/\|\|\s*"running"/g) || [];
  assert.equal(floors.length, 2, "text and thought branches both floor empty progress");
});
