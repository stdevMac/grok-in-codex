const DEFAULT_MODEL_ALIASES = new Set(["fast", "default", "deep", "grok"]);

/**
 * Resolve plugin convenience aliases without pinning a model id that can go stale.
 * Returning null lets the installed Grok CLI select its configured default model.
 */
export function normalizeModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return DEFAULT_MODEL_ALIASES.has(normalized.toLowerCase()) ? null : normalized;
}

/**
 * Omitted effort inherits the CLI configuration, including for model aliases.
 * Let the CLI validate explicit values without substituting another level.
 */
export function normalizeEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return normalized;
}

export function withSelfCheckInstruction(prompt, enabled) {
  const normalized = String(prompt ?? "").trim();
  if (!enabled || !normalized) {
    return normalized;
  }
  return `${normalized}\n\nBefore finishing, run the relevant focused checks, inspect the resulting diff, and report the commands and observed outcomes. Do not claim a check passed unless you ran it.`;
}
