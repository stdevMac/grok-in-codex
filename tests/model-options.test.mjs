import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeEffort,
  normalizeModel,
  withSelfCheckInstruction
} from "../plugins/grok/scripts/lib/model-options.mjs";

test("model aliases defer to the installed CLI default instead of stale ids", () => {
  for (const alias of ["fast", "default", "deep", "grok"]) {
    assert.equal(normalizeModel(alias), null);
  }
  assert.equal(normalizeModel("grok-4.6"), "grok-4.6");
});

test("self-check is expressed in the prompt for CLIs without --check", () => {
  const prompt = withSelfCheckInstruction("Fix the bug", true);
  assert.match(prompt, /^Fix the bug/);
  assert.match(prompt, /run the relevant focused checks/i);
  assert.equal(withSelfCheckInstruction("Fix the bug", false), "Fix the bug");
});

test("deep keeps its effort preset and explicit efforts pass through", () => {
  assert.equal(normalizeEffort(undefined, "deep"), "high");
  assert.equal(normalizeEffort(undefined, "fast"), null);
  assert.equal(normalizeEffort("xhigh", "fast"), "xhigh");
  assert.equal(normalizeEffort("future-effort", null), "future-effort");
  assert.equal(normalizeEffort("max", null), "max");
  assert.equal(normalizeEffort(" LOW ", "deep"), "low");
});
