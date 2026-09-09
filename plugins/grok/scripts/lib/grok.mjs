import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { binaryAvailable, runCommand } from "./process.mjs";

// Grok CLI 0.2.93: --tools ALLOWLISTS often fail session create with a
// server-side run_terminal_cmd background-param constraint error. Prefer
// the default toolset + --disallowed-tools denylist instead.
// Also avoid --yolo for media: the permission classifier may deny that flag;
// single-prompt mode already auto-approves tools when the user config allows.
export const READ_ONLY_DISALLOWED_TOOLS =
  "run_terminal_cmd,search_replace,write_file,edit_file";
export const MEDIA_DISALLOWED_TOOLS =
  "run_terminal_cmd,write_file,edit_file,search_replace";

// Deprecated: kept only for tests / callers that still pass tools= explicitly.
export const READ_ONLY_TOOLS = "read_file,grep,list_dir";
export const MEDIA_TOOLS = "image_gen,image_edit,image_to_video,reference_to_video,list_dir,read_file";

export function resolveGrokBinary() {
  const envPath = process.env.GROK_BINARY;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  const which = runCommand("which", ["grok"]);
  if (which.status === 0 && which.stdout.trim()) {
    return which.stdout.trim();
  }

  const homeCandidate = path.join(os.homedir(), ".grok", "bin", "grok");
  if (fs.existsSync(homeCandidate)) {
    return homeCandidate;
  }

  return null;
}

export function getGrokAvailability() {
  const binary = resolveGrokBinary();
  if (!binary) {
    return {
      available: false,
      binary: null,
      version: null,
      versionRaw: null,
      reason: "Grok CLI not found on PATH. Install Grok Build and ensure `grok` is available."
    };
  }

  const versionResult = runCommand(binary, ["version"]);
  const versionRaw =
    versionResult.status === 0 ? versionResult.stdout.trim().split("\n")[0] : null;
  return {
    available: true,
    binary,
    version: versionRaw,
    versionRaw,
    reason: null
  };
}

/**
 * Run `grok doctor` and return stdout/stderr summary (best-effort).
 */
export function runGrokDoctor() {
  const binary = resolveGrokBinary();
  if (!binary) {
    return { ok: false, detail: "Grok CLI not found" };
  }
  const result = runCommand(binary, ["doctor"], { maxBuffer: 2 * 1024 * 1024 });
  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  return {
    ok: result.status === 0,
    detail: stdout || stderr || `doctor exited ${result.status}`,
    stdout,
    stderr,
    status: result.status
  };
}

export function parseGrokModelsOutput({ stdout = "", stderr = "", status = null } = {}) {
  const stdoutText = String(stdout ?? "");
  const stderrText = String(stderr ?? "");
  const combined = `${stdoutText}\n${stderrText}`;
  const defaultModel = combined.match(/Default model:\s*([^\s]+)/i)?.[1]?.trim() || null;
  const availableModels = [];
  let inAvailableModels = false;

  for (const line of combined.split(/\r?\n/)) {
    if (/^\s*Available models:\s*$/i.test(line)) {
      inAvailableModels = true;
      continue;
    }
    if (!inAvailableModels) {
      continue;
    }
    const match = line.match(/^\s*[*-]\s+([^\s(]+)/);
    if (match && !availableModels.includes(match[1])) {
      availableModels.push(match[1]);
    } else if (line.trim()) {
      inAvailableModels = false;
    }
  }
  if (defaultModel && !availableModels.includes(defaultModel)) {
    availableModels.unshift(defaultModel);
  }

  const ok = status === 0 && Boolean(defaultModel || availableModels.length > 0);
  return {
    ok,
    defaultModel,
    availableModels,
    detail: ok
      ? `Default: ${defaultModel || "unknown"}; available: ${availableModels.join(", ")}`
      : (stderrText || stdoutText || `models exited ${status}`).trim(),
    stdout: stdoutText,
    stderr: stderrText,
    status,
    combined
  };
}

export function getGrokModelsStatus() {
  const binary = resolveGrokBinary();
  if (!binary) {
    return {
      ok: false,
      defaultModel: null,
      availableModels: [],
      detail: "Grok CLI not found",
      stdout: "",
      stderr: "",
      status: null,
      combined: ""
    };
  }

  const result = runCommand(binary, ["models"], { maxBuffer: 2 * 1024 * 1024 });
  return parseGrokModelsOutput(result);
}

export function getGrokAuthStatus(modelsStatus = null) {
  const binary = resolveGrokBinary();
  if (!binary) {
    return { authenticated: false, detail: "Grok CLI not found" };
  }

  const models = modelsStatus ?? getGrokModelsStatus();
  const stdout = String(models.stdout ?? "");
  const stderr = String(models.stderr ?? "");
  const combined = models.combined ?? `${stdout}\n${stderr}`;

  if (models.status === 0 && /logged in|Available models|Default model/i.test(combined)) {
    const loginMatch = combined.match(/logged in with ([^\n.]+)/i);
    return {
      authenticated: true,
      detail: loginMatch ? `Logged in with ${loginMatch[1].trim()}` : "Authenticated"
    };
  }

  if (/not logged in|sign in|login|unauthorized|auth/i.test(combined)) {
    return {
      authenticated: false,
      detail: "Not authenticated. Run `grok login` or `!grok login` from Claude Code."
    };
  }

  if (models.status === 0 && /grok-/i.test(combined)) {
    return { authenticated: true, detail: "Authenticated (models list succeeded)" };
  }

  return {
    authenticated: false,
    detail: (stderr || stdout || "Unable to verify Grok authentication").trim()
  };
}

export function buildGrokArgs(options = {}) {
  const args = [];

  if (options.promptFile) {
    args.push("--prompt-file", options.promptFile);
  } else if (options.prompt != null) {
    args.push("-p", options.prompt);
  } else {
    throw new Error("A prompt or prompt file is required");
  }

  const outputFormat = options.outputFormat ?? (options.jsonSchema ? "json" : "json");
  args.push("--output-format", outputFormat);

  if (options.jsonSchema) {
    args.push("--json-schema", options.jsonSchema);
  }
  if (options.model) {
    args.push("-m", options.model);
  }
  if (options.effort) {
    args.push("--effort", options.effort);
  }
  if (options.cwd) {
    args.push("--cwd", options.cwd);
  }
  if (options.resume) {
    args.push("-r", options.resume);
  } else if (options.continueSession) {
    args.push("-c");
  }
  if (options.maxTurns) {
    args.push("--max-turns", String(options.maxTurns));
  }
  if (options.bestOfN && Number(options.bestOfN) > 1) {
    throw new Error("Headless Grok CLI does not support --best-of-n.");
  }
  if (options.worktree || options.worktreeRef) {
    throw new Error(
      "Headless Grok CLI does not create worktrees. Prepare one externally and pass it as cwd."
    );
  }

  // Control surface (Grok Build 0.2.118+)
  if (options.sandbox) {
    args.push("--sandbox", options.sandbox);
  }
  if (options.permissionMode) {
    args.push("--permission-mode", options.permissionMode);
  }
  if (options.noSubagents) {
    args.push("--no-subagents");
  }
  if (options.agent) {
    args.push("--agent", options.agent);
  }
  if (options.agentsJson) {
    args.push("--agents", options.agentsJson);
  }
  for (const rule of options.allow || []) {
    args.push("--allow", rule);
  }
  for (const rule of options.deny || []) {
    args.push("--deny", rule);
  }
  if (options.disableWebSearch) {
    args.push("--disable-web-search");
  }
  if (options.forkSession) {
    args.push("--fork-session");
  }
  if (options.memory?.enable === true) {
    args.push("--experimental-memory");
  } else if (options.memory?.enable === false) {
    args.push("--no-memory");
  }
  if (options.noPlan) {
    args.push("--no-plan");
  }

  // Tool gating strategy (Grok 0.2.93-safe):
  // - Prefer --disallowed-tools (denylist) over --tools (allowlist).
  // - Only pass --tools when forceToolsAllowlist is true (debug / future CLI).
  if (options.forceToolsAllowlist && options.tools) {
    args.push("--tools", options.tools);
  }

  const isPlanMode = options.permissionMode === "plan";

  if (options.disallowedTools) {
    args.push("--disallowed-tools", options.disallowedTools);
  } else if (options.media) {
    args.push("--disallowed-tools", options.mediaDisallowedTools ?? MEDIA_DISALLOWED_TOOLS);
  } else if (options.write && !isPlanMode) {
    // Full coding agent: default toolset + auto-approve.
    if (options.yolo !== false) {
      args.push("--yolo");
    }
  } else if (!options.write || isPlanMode) {
    // Read-only review / diagnosis / plan mode: strip shell + source editors.
    // Plan mode still allows plan.md via Grok's plan-mode policy.
    if (!isPlanMode) {
      args.push(
        "--disallowed-tools",
        options.readOnlyDisallowedTools ?? READ_ONLY_DISALLOWED_TOOLS
      );
    }
  }

  if (options.rules) {
    args.push("--rules", options.rules);
  } else if (options.media) {
    // Rules supplied by the media command (output dir, no source edits).
  } else if (!options.write) {
    args.push(
      "--rules",
      "Read-only mode: do not modify files, create files, or run mutating shell commands. Review and report only."
    );
  }

  if (options.verbatim) {
    args.push("--verbatim");
  }

  return args;
}

/**
 * Turn raw CLI / Rust dumps into a short human-readable failure message.
 */
export function humanizeGrokFailure(sources = {}) {
  const parts = [sources.parsedError, sources.stderr, sources.stdout, sources.message]
    .filter((v) => v != null && String(v).trim())
    .map((v) => String(v).trim());
  const blob = parts.join("\n");
  if (!blob) {
    if (sources.exitCode != null && sources.exitCode !== 0) {
      return `Grok exited with code ${sources.exitCode}.`;
    }
    return "Grok failed with no error details.";
  }

  const compact = blob.replace(/\s+/g, " ").trim();

  // Tool allowlist / session-create constraint (known on Grok 0.2.93)
  if (
    /RequirementError/i.test(blob) &&
    (/run_terminal_cmd/i.test(blob) || /background/i.test(blob) || /--tools/i.test(blob))
  ) {
    return (
      "Grok CLI rejected the tool configuration while creating a session. " +
      "This usually means a `--tools` allowlist is incompatible with your Grok CLI version. " +
      "This plugin uses `--disallowed-tools` denylists for media and read-only review instead. " +
      "Update the plugin or Grok CLI (`grok version`), then retry."
    );
  }

  if (/RequirementError/i.test(blob)) {
    const brief =
      blob.match(/RequirementError[:\s{]*([^}\n]{10,200})/i)?.[1]?.trim() ||
      compact.slice(0, 180);
    return (
      `Grok CLI requirement error: ${brief}. ` +
      "Check `grok version`, auth (`grok login`), and that your plan supports this feature."
    );
  }

  if (/not logged in|unauthori[sz]ed|authentication required|auth.*fail/i.test(blob)) {
    return "Grok is not authenticated. Run `grok login` (or `!grok login` inside Claude Code).";
  }

  if (/command not found|No such file or directory.*grok|Grok CLI not found/i.test(blob)) {
    return "Grok CLI not found. Install Grok Build and ensure `grok` is on your PATH.";
  }

  if (/rate.?limit|too many requests|429/i.test(blob)) {
    return "Grok rate-limited the request. Wait a moment and retry.";
  }

  if (/unknown effort level|invalid (?:reasoning[- ]?)?effort/i.test(blob)) {
    const supported = blob.match(/(?:use one of|possible values):\s*([^\n\r]+)/i)?.[1]?.trim();
    return (
      "Grok rejected the requested reasoning effort. " +
      (supported ? `The installed CLI reports: ${supported}. ` : "Check the installed CLI's supported effort values. ") +
      "Choose a supported effort explicitly; the plugin has not substituted a different level."
    );
  }

  if (/model .+ not found|unknown model|invalid model/i.test(blob)) {
    return "Grok rejected the model id. Run `grok models`, pass one of the reported ids, or omit --model to use the CLI default.";
  }

  // Prefer structured JSON error message if present in the blob
  try {
    const jsonMatch = blob.match(/\{[\s\S]*"type"\s*:\s*"error"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.message) {
        return humanizeGrokFailure({ message: parsed.message, exitCode: sources.exitCode });
      }
    }
  } catch {
    // fall through
  }

  // Drop obvious Rust debug noise / huge dumps
  const firstUseful =
    blob
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(
        (l) =>
          l &&
          !/^\[stderr\]/i.test(l) &&
          !/^thread '/i.test(l) &&
          !/^note:/i.test(l) &&
          !/^at /i.test(l) &&
          l.length < 400
      ) || compact.slice(0, 280);

  if (sources.exitCode != null && sources.exitCode !== 0) {
    return `Grok failed (exit ${sources.exitCode}): ${firstUseful}`;
  }
  return firstUseful;
}

export function parseGrokJsonOutput(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) {
    return { ok: false, error: "Grok produced empty output", raw: "" };
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const candidates = [...lines].reverse();
  candidates.push(text);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        if (parsed.type === "error") {
          const rawMessage = parsed.message || "Grok returned an error object";
          return {
            ok: false,
            error: humanizeGrokFailure({ parsedError: rawMessage, stdout: text }),
            raw: text,
            parsed
          };
        }
        return {
          ok: true,
          text: typeof parsed.text === "string" ? parsed.text : "",
          sessionId: parsed.sessionId ?? null,
          stopReason: parsed.stopReason ?? null,
          requestId: parsed.requestId ?? null,
          thought: parsed.thought ?? null,
          raw: text,
          parsed
        };
      }
    } catch {
      // try next candidate
    }
  }

  // Non-JSON failure dumps (e.g. Rust RequirementError on stdout/stderr merge)
  if (/RequirementError|Error:|panic/i.test(text) && !/^\s*\{/.test(text)) {
    return {
      ok: false,
      error: humanizeGrokFailure({ stdout: text }),
      raw: text,
      parsed: null
    };
  }

  return {
    ok: true,
    text,
    sessionId: null,
    stopReason: null,
    requestId: null,
    thought: null,
    raw: text,
    parsed: null
  };
}

export function runGrok(options = {}) {
  const availability = getGrokAvailability();
  if (!availability.available) {
    throw new Error(availability.reason);
  }

  const args = buildGrokArgs(options);
  const result = runCommand(availability.binary, args, {
    cwd: options.cwd,
    maxBuffer: options.maxBuffer ?? 40 * 1024 * 1024,
    env: {
      ...process.env,
      ...(options.env ?? {}),
      RUST_LOG: options.rustLog ?? process.env.RUST_LOG ?? "off"
    }
  });

  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const parsed = parseGrokJsonOutput(stdout);
  const ok = result.status === 0 && parsed.ok;

  if (!ok) {
    parsed.error = humanizeGrokFailure({
      parsedError: parsed.error,
      stderr,
      stdout,
      exitCode: result.status
    });
  }

  return {
    binary: availability.binary,
    args,
    status: result.status,
    signal: result.signal,
    stdout,
    stderr,
    parsed,
    ok
  };
}

/**
 * Compact stream progress for /grok:status: collapse whitespace and keep a tail
 * of accumulated tokens (not a single event).
 *
 * Returns "" when there is no non-whitespace content yet (even if `prefix` is
 * set). Callers should floor empty results to `"running"` so early whitespace-
 * only stream tokens (Grok does emit `"data":" \\n"`) do not blank status.
 *
 * This function's source is embedded into the background worker via
 * {@link getStreamProgressHelperSource} / `Function.prototype.toString` so
 * tests and the live path share one implementation (no drifted copy).
 *
 * @param {string} accumulated
 * @param {{ prefix?: string, maxLen?: number }} [opts]
 */
export function formatStreamProgressMessage(accumulated, opts = {}) {
  const prefix = opts.prefix ?? "";
  const maxLen = opts.maxLen ?? 160;
  const compact = String(accumulated ?? "")
    .replace(/\s+/g, " ")
    .trim();
  // No body yet → empty. Prefix alone ("thinking: ") is not useful progress.
  if (!compact) return "";
  const body = compact.length > maxLen ? compact.slice(-maxLen) : compact;
  return prefix + body;
}

/** Source string interpolated into the background worker script. */
export function getStreamProgressHelperSource() {
  return formatStreamProgressMessage.toString();
}

/**
 * Build the Node `-e` script that runs a detached Grok process and streams
 * progress. Exported so tests can assert the progress helper is embedded.
 */
export function buildGrokBackgroundWrapperSource({
  binary,
  args,
  resultFile,
  logFile = "",
  progressFile = "",
  cwd = process.cwd(),
  streaming = false
}) {
  // Embed the same function the module exports (not a hand-maintained copy).
  const streamProgressHelper = getStreamProgressHelperSource();
  return `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const binary = ${JSON.stringify(binary)};
const args = ${JSON.stringify(args)};
const resultFile = ${JSON.stringify(resultFile)};
const logFile = ${JSON.stringify(logFile || "")};
const progressFile = ${JSON.stringify(progressFile)};
const cwd = ${JSON.stringify(cwd)};
const streaming = ${JSON.stringify(streaming)};

function append(line) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, "[" + new Date().toISOString() + "] " + line + "\\n");
  } catch {}
}

function writeProgress(patch) {
  if (!progressFile) return;
  try {
    let current = {};
    if (fs.existsSync(progressFile)) {
      current = JSON.parse(fs.readFileSync(progressFile, "utf8"));
    }
    const next = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(progressFile, JSON.stringify(next, null, 2) + "\\n");
  } catch {}
}

append("Starting Grok: " + binary + " " + args.join(" "));
writeProgress({ phase: "starting", message: "Launching Grok", lines: 0 });

const child = spawn(binary, args, {
  cwd,
  env: { ...process.env, RUST_LOG: process.env.RUST_LOG || "off" },
  stdio: ["ignore", "pipe", "pipe"]
});

let stdout = "";
let stderr = "";
let textAcc = "";
let thoughtAcc = "";
let sessionId = null;
let lineCount = 0;
let lastMessage = "running";

${streamProgressHelper}

function handleStreamLine(line) {
  lineCount += 1;
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const evt = JSON.parse(trimmed);
    if (evt.type === "text" && evt.data) {
      textAcc += evt.data;
      // Tail of accumulated text; floor empty so whitespace-only tokens keep "running"
      lastMessage = formatStreamProgressMessage(textAcc, {}) || "running";
    } else if (evt.type === "thought" && evt.data) {
      thoughtAcc += evt.data;
      lastMessage =
        formatStreamProgressMessage(thoughtAcc, { prefix: "thinking: " }) || "running";
    } else if (evt.type === "end") {
      sessionId = evt.sessionId || sessionId;
      lastMessage = "finishing";
    } else if (evt.type === "error") {
      lastMessage = evt.message || "error";
    }
    if (evt.sessionId) sessionId = evt.sessionId;
  } catch {
    lastMessage = trimmed.slice(0, 120);
  }
  if (lineCount % 3 === 0 || /end|error/i.test(trimmed)) {
    writeProgress({
      phase: "running",
      message: lastMessage,
      lines: lineCount,
      sessionId
    });
  }
}

let stdoutBuf = "";
child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  stdout += text;
  append(text.trimEnd());
  if (streaming) {
    stdoutBuf += text;
    let idx;
    while ((idx = stdoutBuf.indexOf("\\n")) !== -1) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      handleStreamLine(line);
    }
  }
});
child.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  stderr += text;
  append("[stderr] " + text.trimEnd());
  writeProgress({ phase: "running", message: text.trim().slice(0, 120), lines: lineCount });
});
child.on("close", (code, signal) => {
  if (streaming && stdoutBuf.trim()) {
    handleStreamLine(stdoutBuf);
  }

  let finalStdout = stdout;
  if (streaming) {
    // Reconstruct a json-format-like payload for the companion parser.
    finalStdout = JSON.stringify({
      text: textAcc || stdout,
      stopReason: code === 0 ? "EndTurn" : "Error",
      sessionId,
      requestId: null
    });
  }

  const payload = {
    exitCode: code,
    signal,
    stdout: finalStdout,
    stderr,
    finishedAt: new Date().toISOString(),
    sessionId
  };
  try {
    // Atomic write: only publish result.json when the full payload is on disk.
    // Avoids reaper/finalize seeing a truncated mid-write file as "exists".
    const tmp = resultFile + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\\n");
    fs.renameSync(tmp, resultFile);
    writeProgress({
      phase: code === 0 ? "completed" : "failed",
      message: code === 0 ? "completed" : "failed with code " + code,
      lines: lineCount,
      sessionId
    });
    append("Finished with code " + code);
  } catch (error) {
    append("Failed to write result: " + error.message);
  }
  process.exit(code === null ? 1 : code);
});
`.trim();
}

/**
 * Spawn Grok as a detached background process.
 * Uses streaming-json when progressFile is set so status can show live activity.
 */
export function spawnGrokBackground(options = {}) {
  const availability = getGrokAvailability();
  if (!availability.available) {
    throw new Error(availability.reason);
  }

  const useStreaming = Boolean(options.progressFile);
  const args = buildGrokArgs({
    ...options,
    outputFormat: useStreaming ? "streaming-json" : options.outputFormat ?? "json"
  });
  const resultFile = options.resultFile;
  if (!resultFile) {
    throw new Error("resultFile is required for background runs");
  }

  const wrapper = buildGrokBackgroundWrapperSource({
    binary: availability.binary,
    args,
    resultFile,
    logFile: options.logFile || "",
    progressFile: options.progressFile || "",
    cwd: options.cwd || process.cwd(),
    streaming: useStreaming
  });

  const child = spawn(process.execPath, ["-e", wrapper], {
    cwd: options.cwd,
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  child.unref();
  return { pid: child.pid, binary: availability.binary, args };
}

export function hasNode() {
  return binaryAvailable("node");
}
