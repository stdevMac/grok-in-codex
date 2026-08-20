const DEFAULT_MODEL_ALIASES = new Set(["fast", "default", "deep", "grok"]);

const PRESET_EFFORT = new Map([
  ["deep", "high"]
]);

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
 * Preserve the deep preset and the legacy max alias, then let the installed CLI
 * validate all other effort names. The CLI is the authoritative capability source.
 */
export function normalizeEffort(effort, modelAlias) {
  if (effort == null && modelAlias && PRESET_EFFORT.has(String(modelAlias).toLowerCase())) {
    return PRESET_EFFORT.get(String(modelAlias).toLowerCase());
  }
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return normalized === "max" ? "xhigh" : normalized;
}
