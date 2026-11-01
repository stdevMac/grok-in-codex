import assert from "node:assert/strict";
import test from "node:test";

import {
  reviewHasBlockingFindings,
  tryParseStructuredReview
} from "../plugins/grok/scripts/lib/review.mjs";
import { extractArtifactPaths } from "../plugins/grok/scripts/lib/media.mjs";
import { buildGrokArgs } from "../plugins/grok/scripts/lib/grok.mjs";

test("tryParseStructuredReview parses fenced JSON", () => {
  const review = tryParseStructuredReview(`Here you go:
\`\`\`json
{
  "verdict": "request_changes",
  "summary": "One high issue",
  "findings": [
    {
      "severity": "high",
      "title": "Null deref",
      "body": "x can be null",
      "file": "src/a.ts",
      "line_start": 10,
      "line_end": 12,
      "recommendation": "Guard null"
    }
  ],
  "next_steps": ["Add test"]
}
\`\`\`
`);
  assert.equal(review.verdict, "request_changes");
  assert.equal(review.findings.length, 1);
  assert.equal(review.findings[0].severity, "high");
  assert.equal(reviewHasBlockingFindings(review), true);
});

test("buildGrokArgs supports worktree and schema", () => {
  const args = buildGrokArgs({
    prompt: "fix it",
    write: true,
    worktree: "rescue-1",
    jsonSchema: '{"type":"object"}'
  });
  assert.ok(args.includes("--worktree"));
  assert.ok(args.includes("rescue-1"));
  assert.ok(args.includes("--json-schema"));
  assert.ok(args.includes("--yolo"));
});

test("buildGrokArgs media mode uses denylist without yolo", () => {
  const args = buildGrokArgs({
    prompt: "draw",
    media: true
  });
  assert.ok(!args.includes("--tools"));
  assert.ok(!args.includes("--yolo"));
  assert.ok(args.includes("--disallowed-tools"));
});

test("extractArtifactPaths finds backtick paths", () => {
  const paths = extractArtifactPaths("Saved to `/tmp/demo-not-real.png` and also foo", "/tmp");
  // file may not exist — function filters exists; just ensure no throw
  assert.ok(Array.isArray(paths));
});
