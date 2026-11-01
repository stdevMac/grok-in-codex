import assert from "node:assert/strict";
import test from "node:test";

import {
  extractUsageFromParsed,
  extractUsageFromStdout,
  formatUsageSummary
} from "../plugins/grok/scripts/lib/usage.mjs";

test("extractUsageFromParsed reads headless json spend fields", () => {
  const usage = extractUsageFromParsed({
    text: "ok",
    num_turns: 7,
    total_cost_usd: 0.0127,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      cache_read_input_tokens: 10
    },
    modelUsage: { "grok-4.5": { inputTokens: 100 } }
  });
  assert.equal(usage.num_turns, 7);
  assert.equal(usage.total_cost_usd, 0.0127);
  assert.equal(usage.input_tokens, 100);
  assert.equal(usage.total_tokens, 150);
  assert.ok(usage.modelUsage);
});

test("extractUsageFromStdout finds NDJSON end event", () => {
  const stdout = [
    JSON.stringify({ type: "text", data: "hi" }),
    JSON.stringify({
      type: "end",
      stopReason: "end_turn",
      sessionId: "s1",
      num_turns: 2,
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      total_cost_usd: 0.001
    })
  ].join("\n");
  const usage = extractUsageFromStdout(stdout);
  assert.equal(usage.num_turns, 2);
  assert.equal(usage.total_tokens, 3);
  assert.equal(usage.total_cost_usd, 0.001);
});

test("formatUsageSummary returns human string", () => {
  const s = formatUsageSummary({
    num_turns: 3,
    total_tokens: 100,
    total_cost_usd: 0.01
  });
  assert.match(s, /turns: 3/);
  assert.match(s, /tokens: 100/);
  assert.match(s, /\$0\.0100/);
});

test("partial cost metadata survives error usage and is visibly incomplete", () => {
  const usage = extractUsageFromParsed({ type: "error", total_cost_usd: 0.5, total_cost_usd_ticks: 500000000, cost_is_partial: true });
  assert.equal(usage.total_cost_usd_ticks, 500000000);
  assert.equal(usage.cost_is_partial, true);
  assert.match(formatUsageSummary(usage), /cost partial/);
  assert.doesNotMatch(formatUsageSummary(usage), /cost: \$/);
  const ticksOnly = extractUsageFromParsed({ type: "error", total_cost_usd_ticks: 50, cost_is_partial: true });
  assert.equal(ticksOnly.total_cost_usd_ticks, 50);
});
