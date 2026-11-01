const SANDBOX_ALIAS = new Map([
  ["ro", "read-only"],
  ["readonly", "read-only"],
  ["ws", "workspace"]
]);
const PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "plan"
]);

/** Shared parseArgs boolean option names for control surface */
export const CONTROL_BOOLEAN_OPTIONS = [
  "plan",
  "no-subagents",
  "disable-web-search",
  "fork-session",
  "memory",
  "no-memory"
];

/** Shared parseArgs value option names for control surface */
export const CONTROL_VALUE_OPTIONS = [
  "sandbox",
  "permission-mode",
  "agent",
  "allow",
  "deny",
  "max-turns"
];

/** Keys that accept repeated flags (array values) */
export const CONTROL_ARRAY_OPTIONS = ["allow", "deny"];

/**
 * Normalize user-facing control options into a stable config object.
 * @param {Record<string, unknown>} raw
 */
export function normalizeControlOptions(raw = {}) {
  const out = {
    sandbox: null,
    permissionMode: null,
    planMode: Boolean(raw.planMode || raw.plan),
    memory: raw.memory === undefined ? null : raw.memory,
    noSubagents: Boolean(raw.noSubagents || raw["no-subagents"]),
    agent: raw.agent ? String(raw.agent).trim() : null,
    allow: flattenStringList(raw.allow),
    deny: flattenStringList(raw.deny),
    disableWebSearch: Boolean(raw.disableWebSearch || raw["disable-web-search"]),
    forkSession: Boolean(raw.forkSession || raw["fork-session"]),
    maxTurns: raw.maxTurns != null ? Number(raw.maxTurns) : raw["max-turns"] != null ? Number(raw["max-turns"]) : null,
    noPlan: Boolean(raw.noPlan || raw["no-plan"])
  };

  if (raw.sandbox != null && raw.sandbox !== false && raw.sandbox !== "") {
    const name = String(raw.sandbox).trim();
    // Named profiles are resolved by Grok's sandbox.toml. Preserve their identity;
    // only exact documented shorthand aliases are rewritten.
    const s = name === "true" ? "workspace" : SANDBOX_ALIAS.get(name) || name;
    if (!s || /[\s\x00-\x1f\x7f]/.test(s) || s.startsWith("-")) {
      throw new Error(`Invalid --sandbox profile name: ${raw.sandbox}`);
    }
    out.sandbox = s;
  }

  const pmRaw = raw.permissionMode ?? raw["permission-mode"];
  if (pmRaw) {
    const pm = String(pmRaw).trim();
    if (!PERMISSION_MODES.has(pm)) {
      throw new Error(
        `Invalid --permission-mode: ${pm}. Expected one of ${[...PERMISSION_MODES].join(", ")}`
      );
    }
    out.permissionMode = pm;
  }

  if (out.planMode && !out.permissionMode) {
    out.permissionMode = "plan";
  }

  if (out.memory !== null && typeof out.memory !== "boolean") {
    const m = String(out.memory).toLowerCase();
    if (m === "on" || m === "true" || m === "1") {
      out.memory = true;
    } else if (m === "off" || m === "false" || m === "0") {
      out.memory = false;
    } else {
      throw new Error(`Invalid --memory value: ${raw.memory}`);
    }
  }

  if (out.maxTurns != null && (!Number.isFinite(out.maxTurns) || out.maxTurns < 1)) {
    throw new Error(`Invalid --max-turns: ${raw.maxTurns ?? raw["max-turns"]}`);
  }

  if (out.agent === "") {
    out.agent = null;
  }

  return out;
}

/**
 * Convert normalized control into fields consumed by buildGrokArgs.
 */
export function controlToGrokFields(control) {
  return {
    sandbox: control.sandbox,
    permissionMode: control.permissionMode,
    noSubagents: control.noSubagents,
    agent: control.agent,
    allow: control.allow || [],
    deny: control.deny || [],
    disableWebSearch: control.disableWebSearch,
    forkSession: control.forkSession,
    maxTurns: control.maxTurns,
    noPlan: control.noPlan,
    memory: control.memory == null ? null : { enable: Boolean(control.memory) }
  };
}

/**
 * Build control config from parseArgs options object.
 */
export function controlFromParsedOptions(options = {}) {
  let memory = null;
  if (options.memory && !options["no-memory"]) {
    memory = true;
  }
  if (options["no-memory"]) {
    memory = false;
  }
  return normalizeControlOptions({
    sandbox: options.sandbox,
    permissionMode: options["permission-mode"],
    planMode: options.plan,
    memory,
    noSubagents: options["no-subagents"],
    agent: options.agent,
    allow: options.allow,
    deny: options.deny,
    disableWebSearch: options["disable-web-search"],
    forkSession: options["fork-session"],
    maxTurns: options["max-turns"],
    noPlan: options["no-plan"]
  });
}

/**
 * Persistable job.config slice from control + task extras.
 */
export function controlToJobConfig(control, extras = {}) {
  return {
    sandbox: control.sandbox,
    permissionMode: control.permissionMode,
    planMode: Boolean(control.planMode),
    memory: control.memory,
    noSubagents: Boolean(control.noSubagents),
    agent: control.agent,
    allow: control.allow || [],
    deny: control.deny || [],
    disableWebSearch: Boolean(control.disableWebSearch),
    forkSession: Boolean(control.forkSession),
    maxTurns: control.maxTurns,
    bestOfN: extras.bestOfN ?? null,
    worktree: extras.worktree ?? null,
    worktreeRef: extras.worktreeRef ?? null,
    check: Boolean(extras.check),
    postPending: Boolean(extras.postPending),
    documentType: extras.documentType ?? null,
    workflowName: extras.workflowName ?? null,
    babysitAction: extras.babysitAction ?? null
  };
}

/**
 * Merge control grok fields into a grokOptions object.
 */
export function applyControlToGrokOptions(grokOptions, control) {
  const fields = controlToGrokFields(control);
  const next = { ...grokOptions, ...fields };
  // Plan mode must not auto-approve writes with yolo
  if (fields.permissionMode === "plan") {
    next.yolo = false;
  }
  if (fields.maxTurns != null && grokOptions.maxTurns == null) {
    next.maxTurns = fields.maxTurns;
  }
  return next;
}

function flattenStringList(value) {
  if (value == null || value === false || value === "") {
    return [];
  }
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of list) {
    for (const part of String(item).split(",")) {
      const trimmed = part.trim();
      if (trimmed) {
        out.push(trimmed);
      }
    }
  }
  return out;
}

/**
 * Compare semver-like version strings (major.minor.patch prefix).
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

export function parseSemver(version) {
  const match = String(version ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return [0, 0, 0];
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export const MIN_GROK_VERSION = "0.2.118";
export const RECOMMENDED_GROK_VERSION = "0.2.118";
