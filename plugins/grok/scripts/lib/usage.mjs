/**
 * Extract spend/usage fields from headless Grok JSON (or streaming end event).
 */
export function extractUsageFromParsed(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  // Prefer full parsed object; streaming may nest under type:end
  let root = parsed;
  if (parsed.parsed && typeof parsed.parsed === "object") {
    root = parsed.parsed;
  }
  if (root.type === "end" || root.type === "result") {
    // already terminal shape
  }

  const usage = root.usage && typeof root.usage === "object" ? root.usage : null;
  const hasSpend =
    usage != null ||
    root.total_cost_usd != null ||
    root.total_cost_usd_ticks != null ||
    root.cost_is_partial ||
    root.num_turns != null ||
    root.modelUsage != null ||
    root.usage_is_incomplete;

  if (!hasSpend) {
    return null;
  }

  return {
    input_tokens: usage?.input_tokens ?? null,
    output_tokens: usage?.output_tokens ?? null,
    total_tokens: usage?.total_tokens ?? null,
    cache_read_input_tokens: usage?.cache_read_input_tokens ?? null,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? null,
    reasoning_tokens: usage?.reasoning_tokens ?? null,
    total_cost_usd: root.total_cost_usd ?? null,
    total_cost_usd_ticks: root.total_cost_usd_ticks ?? null,
    cost_is_partial: Boolean(root.cost_is_partial),
    num_turns: root.num_turns ?? null,
    modelUsage: root.modelUsage ?? null,
    usage_is_incomplete: Boolean(root.usage_is_incomplete)
  };
}

/**
 * Scan NDJSON streaming-json stdout for the final `end` event usage.
 */
export function extractUsageFromStdout(stdout) {
  if (!stdout || typeof stdout !== "string") {
    return null;
  }
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  // Single JSON object
  if (trimmed.startsWith("{") && !trimmed.includes("\n")) {
    try {
      return extractUsageFromParsed(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }

  // NDJSON: walk lines bottom-up for type end / result
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj && (obj.type === "end" || obj.type === "result" || obj.usage || obj.total_cost_usd != null || obj.total_cost_usd_ticks != null || obj.cost_is_partial)) {
        const usage = extractUsageFromParsed(obj);
        if (usage) {
          return usage;
        }
      }
    } catch {
      // continue
    }
  }

  // Full-document JSON at end of stream
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return extractUsageFromParsed(JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)));
    } catch {
      return null;
    }
  }

  return null;
}

export function formatUsageSummary(usage) {
  if (!usage) {
    return null;
  }
  const parts = [];
  if (usage.num_turns != null) {
    parts.push(`turns: ${usage.num_turns}`);
  }
  if (usage.total_tokens != null) {
    parts.push(`tokens: ${usage.total_tokens}`);
  } else if (usage.input_tokens != null || usage.output_tokens != null) {
    parts.push(`tokens: in ${usage.input_tokens ?? "?"} / out ${usage.output_tokens ?? "?"}`);
  }
  if (usage.total_cost_usd != null && !usage.usage_is_incomplete && !usage.cost_is_partial) {
    parts.push(`cost: $${Number(usage.total_cost_usd).toFixed(4)}`);
  }
  if (usage.usage_is_incomplete) {
    parts.push("usage incomplete");
  }
  if (usage.cost_is_partial) {
    parts.push("cost partial");
  }
  return parts.length ? parts.join(" · ") : null;
}
