#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { expandArgv, parseArgs } from "./lib/args.mjs";
import {
  collectDesignArtifacts,
  collectDocumentArtifacts,
  collectPlanArtifacts,
  collectWorkflowArtifacts,
  normalizeArtifactList,
  preferPlanArtifactText,
  resolveExecutePlanDesignPath
} from "./lib/artifacts.mjs";
import { parseBabysitInvocation, buildBabysitPrompt, babysitSupportsBackground } from "./lib/babysit.mjs";
import {
  CONTROL_ARRAY_OPTIONS,
  CONTROL_BOOLEAN_OPTIONS,
  CONTROL_VALUE_OPTIONS,
  MIN_GROK_VERSION,
  applyControlToGrokOptions,
  compareSemver,
  controlFromParsedOptions,
  controlToJobConfig
} from "./lib/control.mjs";
import { buildDesignPrompt, buildExecutePlanPrompt, buildPlanModePrompt } from "./lib/design.mjs";
import { buildDocumentPrompt, normalizeDocumentType } from "./lib/documents.mjs";
import { collectStopGateContext, resolveReviewTarget } from "./lib/git.mjs";
import {
  getGrokAuthStatus,
  getGrokAvailability,
  getGrokModelsStatus,
  humanizeGrokFailure,
  parseGrokJsonOutput,
  runGrok,
  runGrokDoctor,
  spawnGrokBackground
} from "./lib/grok.mjs";
import {
  AmbiguousJobError,
  generateJobId,
  getConfig,
  getLastTaskSessionId,
  listJobs,
  listRunningJobs,
  listTaskSessions,
  nowIso,
  readJobFile,
  readJobProgress,
  recordTaskSession,
  resolveJob,
  resolveJobLogFile,
  resolveJobPidFile,
  resolveJobProgressFile,
  setConfig,
  shouldAttemptBackgroundFinalize,
  tailLog,
  tryReadResultPayload,
  upsertJob,
  writeJobFile
} from "./lib/jobs.mjs";
import {
  buildImagePrompt,
  buildVideoPrompt,
  collectMediaArtifacts,
  extractArtifactPaths,
  resolveMediaOutputDir
} from "./lib/media.mjs";
import { normalizeEffort, normalizeModel } from "./lib/model-options.mjs";
import { readPidFile, runCommand, terminateProcessTree, writePidFile } from "./lib/process.mjs";
import {
  renderBackgroundStarted,
  renderCancelReport,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult,
  renderTransferReport
} from "./lib/render.mjs";
import {
  buildStructuredReviewPrompt,
  getReviewSchemaPath,
  postPendingForFinishedJob,
  reviewHasBlockingFindings,
  tryParseStructuredReview
} from "./lib/review.mjs";
import { exportSession, listSessions, searchSessions } from "./lib/sessions.mjs";
import { buildTransferPlan } from "./lib/transfer.mjs";
import { extractUsageFromParsed, extractUsageFromStdout } from "./lib/usage.mjs";
import {
  buildWorkflowPrompt,
  discoverWorkflows,
  parseWorkflowArgs
} from "./lib/workflow.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function printUsage() {
  console.log(
    [
      "Usage:",
      "  setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  task [--background] [--read-only] [--resume-last|--resume-session <id>|--fresh]",
      "       [--model <id|fast|deep>] [--effort <level>] [--worktree [name]] [--check]",
      "       [--best-of-n <n>] [--sandbox <profile>] [--plan] [--permission-mode <mode>]",
      "       [--agent <name>] [--no-subagents] [--memory|--no-memory]",
      "       [--allow RULE]... [--deny RULE]... [--disable-web-search] [--fork-session]",
      "       [--max-turns <n>] [prompt]",
      "  plan [--background] [--model <id>] [--effort <level>] [control flags...] [prompt]",
      "  task-resume-candidate [--json]",
      "  review [--background] [--adversarial] [--post-pending] [--base <ref>]",
      "         [--scope auto|working-tree|branch] [--pr <number>] [--model <id>] [focus]",
      "  workflow list [--json]",
      "  workflow run <name> [--arg key=value]... [--validate-only] [--background] ...",
      "  design [--background] [--model deep] [brief]",
      "  execute-plan [<design-doc>|--latest] [--concurrency N] [--dry-run] [--auto-pr]",
      "               [--no-graphite] [--resume PLAN_ID] [--instructions text] [--background]",
      "  babysit add|list|check|remove [pr...] [--background]",
      "  document --type pptx|pdf|docx [--background] [brief]",
      "  sessions list|search|export ...",
      "  image [--background] [--edit <path>] [--aspect <ratio>] [--model <id>] [prompt]",
      "  video [--background] [--image <path>] [--ref <path>]... [--duration 6|10]",
      "        [--aspect <ratio>] [--model <id>] [prompt]",
      "  transfer [--source <claude-transcript.jsonl>] [--json]",
      "  stop-gate-review [--json]",
      "  status [job-id] [--all] [--json]",
      "  result [job-id] [--json]",
      "  cancel [job-id] [--json]"
    ].join("\n")
  );
}

function controlParseConfig(extraBoolean = [], extraValue = []) {
  return {
    booleanOptions: [
      "background",
      "json",
      "verbatim",
      ...CONTROL_BOOLEAN_OPTIONS,
      ...extraBoolean
    ],
    valueOptions: [
      "model",
      "effort",
      "cwd",
      ...CONTROL_VALUE_OPTIONS,
      ...extraValue
    ],
    arrayOptions: [...CONTROL_ARRAY_OPTIONS]
  };
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function titleFromPrompt(prompt, fallback = "Grok task") {
  const compact = String(prompt ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) {
    return fallback;
  }
  return compact.length > 72 ? `${compact.slice(0, 71)}…` : compact;
}

function writePromptFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-companion-"));
  const filePath = path.join(dir, "prompt.md");
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function enrichJob(cwd, job) {
  if (!job) {
    return job;
  }
  const progress = readJobProgress(cwd, job.id);
  const logTail = tailLog(job.logFile, 12);
  return { ...job, progress, logTail };
}

function resolveMediaArtifactsForJob(job, text, sessionId) {
  const cwd = job.workspaceRoot || process.cwd();
  const kind = job.kind === "video" ? "video" : "image";
  const outputDir = job.mediaDir || resolveMediaOutputDir(cwd, kind);
  const startedMs = Date.parse(job.createdAt || "") || Date.now() - 120_000;
  return collectMediaArtifacts({
    cwd,
    kind,
    outputDir,
    sessionId,
    sinceMs: startedMs,
    text
  });
}

function harvestKindArtifacts(cwd, job, text, sessionId) {
  const startedMs = Date.parse(job.createdAt || "") || Date.now() - 120_000;
  if (job.kind === "image" || job.kind === "video") {
    return resolveMediaArtifactsForJob(job, text, sessionId);
  }
  if (job.kind === "plan") {
    return collectPlanArtifacts(cwd, sessionId, { jobId: job.id });
  }
  if (job.kind === "design") {
    return collectDesignArtifacts(cwd, { sessionId, text, jobId: job.id });
  }
  if (job.kind === "workflow") {
    return collectWorkflowArtifacts(cwd, { text, jobId: job.id });
  }
  if (job.kind === "document") {
    return collectDocumentArtifacts(cwd, {
      text,
      sessionId,
      jobId: job.id,
      sinceMs: startedMs
    });
  }
  const paths = extractArtifactPaths(text, job.workspaceRoot || cwd);
  return paths.map((p) => (typeof p === "string" ? { kind: "file", path: p } : p));
}

function finalizeJob(cwd, job, grokResult, extras = {}) {
  const parsed = grokResult.parsed;
  const ok = grokResult.ok;
  const text = parsed?.text || (!ok ? parsed?.error || grokResult.stderr : "") || grokResult.stdout;
  const sessionId = parsed?.sessionId ?? null;
  const status = ok ? "completed" : "failed";
  const finishedAt = nowIso();
  const review = extras.parseReview ? tryParseStructuredReview(text) : null;
  let artifacts =
    extras.artifacts ||
    harvestKindArtifacts(cwd, job, text, sessionId);
  artifacts = normalizeArtifactList(artifacts);

  const usage =
    extractUsageFromParsed(parsed?.parsed || parsed) ||
    extractUsageFromStdout(grokResult.stdout) ||
    null;

  const summary = review
    ? `${review.verdict}: ${titleFromPrompt(review.summary, status)}`
    : titleFromPrompt(text, status);

  const error = ok
    ? null
    : humanizeGrokFailure({
        parsedError: parsed?.error,
        stderr: grokResult.stderr,
        stdout: grokResult.stdout,
        exitCode: grokResult.status
      });

  // Attach flags so post helper can see request even if only extras carried them.
  const jobForPost = {
    ...job,
    wantPostPending: extras.wantPostPending || job.wantPostPending || job.config?.postPending,
    config: {
      ...(job.config || {}),
      postPending: Boolean(
        extras.wantPostPending || job.config?.postPending || job.wantPostPending
      )
    }
  };

  let postPending = extras.postPendingResult || job.postPending || null;
  if (status === "completed" && review) {
    const posted = postPendingForFinishedJob({
      job: jobForPost,
      review,
      cwd,
      runCommandFn: runCommand,
      target: extras.reviewTarget || job.reviewTarget || null
    });
    if (posted) {
      postPending = posted;
    }
  }

  const fullJob = {
    ...job,
    schemaVersion: 3,
    status,
    finishedAt,
    updatedAt: finishedAt,
    summary,
    resultText: text,
    review,
    artifacts,
    usage,
    postPending,
    wantPostPending: Boolean(jobForPost.wantPostPending),
    grokSessionId: sessionId,
    exitCode: grokResult.status,
    error,
    stderr: grokResult.stderr || null
  };

  upsertJob(cwd, {
    id: job.id,
    status,
    finishedAt,
    summary,
    grokSessionId: sessionId,
    exitCode: fullJob.exitCode,
    error: fullJob.error
  });
  writeJobFile(cwd, fullJob);

  if (
    sessionId &&
    (job.kind === "task" || job.kind === "rescue" || job.kind === "plan")
  ) {
    recordTaskSession(cwd, {
      sessionId,
      jobId: job.id,
      title: job.title || fullJob.summary,
      kind: job.kind
    });
  }

  return fullJob;
}

function maybeFinalizeBackgroundJob(cwd, job) {
  // Reconcile when still running *or* reaper false-failed while result.json exists.
  if (!job || !shouldAttemptBackgroundFinalize(job)) {
    return enrichJob(cwd, job);
  }

  const resultPath = job.resultFile;
  const read = tryReadResultPayload(resultPath);
  if (!read.ok) {
    // Defense-in-depth / TOCTOU: shouldAttemptBackgroundFinalize already requires
    // a complete parseable result, so primary corrupt-result failures come from the
    // reaper (process dead). This path only fires if the file changed between checks.
    if (job.status === "running" || job.status === "failed") {
      const finishedAt = nowIso();
      const failed = {
        ...job,
        status: "failed",
        finishedAt,
        updatedAt: finishedAt,
        summary: "Background Grok result file is corrupt or incomplete",
        error: `Background result.json is ${read.reason}`,
        pendingResult: false
      };
      upsertJob(cwd, {
        id: job.id,
        status: "failed",
        finishedAt,
        summary: failed.summary,
        error: failed.error
      });
      writeJobFile(cwd, failed);
      return enrichJob(cwd, failed);
    }
    return enrichJob(cwd, job);
  }
  const payload = read.payload;

  const parsed = parseGrokJsonOutput(payload.stdout || "");
  const ok = payload.exitCode === 0 && parsed.ok;
  const text = parsed.text || parsed.error || payload.stdout || "";
  const sessionId = parsed.sessionId ?? payload.sessionId ?? null;
  const status = ok ? "completed" : "failed";
  const finishedAt = payload.finishedAt || nowIso();
  const review =
    job.kind === "review" || job.kind === "adversarial-review" || job.kind === "stop-gate"
      ? tryParseStructuredReview(text)
      : null;
  const artifacts = normalizeArtifactList(harvestKindArtifacts(cwd, job, text, sessionId));
  // Prefer plan.md body for plan jobs so /grok:result is useful after background.
  const resultText =
    job.kind === "plan" ? preferPlanArtifactText(text, artifacts) : text;
  const usage =
    extractUsageFromParsed(parsed?.parsed || parsed) ||
    extractUsageFromStdout(payload.stdout) ||
    null;

  const error = ok
    ? null
    : humanizeGrokFailure({
        parsedError: parsed.error,
        stderr: payload.stderr,
        stdout: payload.stdout,
        exitCode: payload.exitCode
      });

  const jobForPost = {
    ...job,
    wantPostPending: job.wantPostPending || job.config?.postPending,
    config: {
      ...(job.config || {}),
      postPending: Boolean(job.config?.postPending || job.wantPostPending)
    }
  };

  let postPending = job.postPending || null;
  if (status === "completed" && review) {
    const posted = postPendingForFinishedJob({
      job: jobForPost,
      review,
      cwd,
      runCommandFn: runCommand,
      target: job.reviewTarget || null
    });
    if (posted) {
      postPending = posted;
    }
  }

  const fullJob = {
    ...job,
    schemaVersion: 3,
    status,
    finishedAt,
    updatedAt: finishedAt,
    summary: review
      ? `${review.verdict}: ${titleFromPrompt(review.summary, status)}`
      : titleFromPrompt(resultText, status),
    resultText,
    review,
    artifacts,
    usage,
    postPending,
    wantPostPending: Boolean(jobForPost.wantPostPending),
    grokSessionId: sessionId,
    exitCode: payload.exitCode,
    error,
    stderr: payload.stderr || null,
    pendingResult: false
  };

  upsertJob(cwd, {
    id: job.id,
    status,
    finishedAt,
    summary: fullJob.summary,
    grokSessionId: sessionId,
    exitCode: fullJob.exitCode,
    error: fullJob.error
  });
  writeJobFile(cwd, fullJob);

  if (
    sessionId &&
    (job.kind === "task" || job.kind === "rescue" || job.kind === "plan")
  ) {
    recordTaskSession(cwd, {
      sessionId,
      jobId: job.id,
      title: job.title || fullJob.summary,
      kind: job.kind
    });
  }

  return enrichJob(cwd, fullJob);
}

function createJobShell(cwd, { kind, title, prompt, write, model, effort, extras = {} }) {
  const jobId = generateJobId(kind === "adversarial-review" ? "review" : kind);
  const logFile = resolveJobLogFile(cwd, jobId);
  const resultFile = path.join(path.dirname(logFile), `${jobId}.result.json`);
  const progressFile = resolveJobProgressFile(cwd, jobId);
  const promptFile = writePromptFile(prompt);
  const job = {
    id: jobId,
    schemaVersion: 3,
    kind,
    title,
    prompt,
    status: "running",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    write: Boolean(write),
    model,
    effort,
    workspaceRoot: cwd,
    logFile,
    resultFile,
    progressFile,
    promptFile,
    usage: null,
    artifacts: [],
    ...extras
  };

  upsertJob(cwd, {
    id: jobId,
    kind,
    title,
    status: "running",
    write: Boolean(write),
    model,
    summary: title,
    logFile,
    resultFile
  });
  writeJobFile(cwd, job);
  fs.writeFileSync(logFile, "", "utf8");
  fs.writeFileSync(progressFile, `${JSON.stringify({ phase: "queued", message: "queued", updatedAt: nowIso() }, null, 2)}\n`);
  return job;
}

function runOrBackground(cwd, job, grokOptions, { background, json, renderPayload }) {
  if (background) {
    const spawned = spawnGrokBackground({
      ...grokOptions,
      resultFile: job.resultFile,
      logFile: job.logFile,
      progressFile: job.progressFile
    });
    const pidFile = resolveJobPidFile(cwd, job.id);
    writePidFile(pidFile, spawned.pid);
    const runningJob = {
      ...job,
      pid: spawned.pid,
      pidFile,
      binary: spawned.binary,
      args: spawned.args
    };
    upsertJob(cwd, { id: job.id, pid: spawned.pid, status: "running" });
    writeJobFile(cwd, runningJob);
    const otherRunning = listRunningJobs(cwd)
      .filter((item) => item.id !== job.id)
      .map((item) => ({
        id: item.id,
        kind: item.kind,
        title: item.title || item.summary || null
      }));
    const payload = {
      jobId: job.id,
      kind: job.kind,
      pid: spawned.pid,
      title: job.title,
      status: "running",
      concurrent: true,
      otherRunning
    };
    outputResult(json ? payload : renderBackgroundStarted(payload), Boolean(json));
    return null;
  }

  const grokResult = runGrok(grokOptions);
  const finished = finalizeJob(cwd, job, grokResult, renderPayload?.finalizeExtras || {});
  const payload = renderPayload?.build
    ? renderPayload.build(finished, grokResult)
    : {
        jobId: job.id,
        kind: job.kind,
        status: finished.status,
        model: job.model,
        write: job.write,
        grokSessionId: finished.grokSessionId,
        text: finished.resultText,
        error: finished.error,
        review: finished.review,
        artifacts: finished.artifacts,
        bestOfN: job.bestOfN,
        worktree: job.worktree,
        check: job.check
      };
  outputResult(json ? payload : renderTaskResult(payload), Boolean(json));
  process.exitCode = finished.status === "completed" ? 0 : 1;
  return finished;
}

async function commandSetup(argv) {
  const { options } = parseArgs(argv, {
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });
  const cwd = resolveWorkspaceRoot(process.cwd());

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Pass only one of --enable-review-gate or --disable-review-gate");
  }
  if (options["enable-review-gate"]) {
    setConfig(cwd, { stopReviewGate: true });
  } else if (options["disable-review-gate"]) {
    setConfig(cwd, { stopReviewGate: false });
  }

  const availability = getGrokAvailability();
  const models = availability.available
    ? getGrokModelsStatus()
    : {
        ok: false,
        defaultModel: null,
        availableModels: [],
        detail: availability.reason
      };
  const auth = availability.available
    ? getGrokAuthStatus(models)
    : { authenticated: false, detail: availability.reason };
  const config = getConfig(cwd);

  let versionOk = null;
  if (availability.version) {
    versionOk = compareSemver(availability.version, MIN_GROK_VERSION) >= 0;
  }

  let doctor = null;
  if (availability.available) {
    try {
      doctor = runGrokDoctor();
    } catch (err) {
      doctor = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  const nextSteps = [];
  if (!availability.available) {
    nextSteps.push("Install the Grok Build CLI and ensure `grok` is on your PATH.");
    nextSteps.push("Typical install location: `~/.grok/bin/grok`.");
  } else if (!auth.authenticated) {
    nextSteps.push("Run `grok login` (or login from your host agent shell).");
  }
  if (availability.available && auth.authenticated && !models.ok) {
    nextSteps.push("Run `grok models` and resolve any model configuration error before using the plugin.");
  }
  if (versionOk === false) {
    nextSteps.push(
      `Upgrade Grok CLI to ≥ ${MIN_GROK_VERSION} for full plugin features (current: ${availability.version}).`
    );
  }

  const payload = {
    ready: Boolean(availability.available && auth.authenticated && models.ok),
    available: availability.available,
    binary: availability.binary,
    version: availability.version,
    versionOk,
    minVersion: MIN_GROK_VERSION,
    authenticated: auth.authenticated,
    authDetail: auth.detail,
    modelsOk: models.ok,
    defaultModel: models.defaultModel,
    availableModels: models.availableModels,
    modelsDetail: models.detail,
    doctorOk: doctor ? doctor.ok : null,
    doctorDetail: doctor ? doctor.detail : null,
    stopReviewGate: Boolean(config.stopReviewGate),
    nextSteps,
    pluginRoot: ROOT_DIR
  };

  outputResult(options.json ? payload : renderSetupReport(payload), Boolean(options.json));
  process.exitCode = payload.ready ? 0 : 1;
}

async function commandTaskResumeCandidate(argv) {
  parseArgs(argv, { booleanOptions: ["json"] });
  const cwd = resolveWorkspaceRoot(process.cwd());
  const sessions = listTaskSessions(cwd);
  const sessionId = getLastTaskSessionId(cwd);
  const runningJobs = listRunningJobs(cwd).map((job) => ({
    id: job.id,
    kind: job.kind,
    title: job.title || job.summary || null,
    status: job.status,
    grokSessionId: job.grokSessionId || null
  }));
  outputResult(
    {
      available: Boolean(sessionId) || sessions.length > 0,
      sessionId,
      sessions,
      runningJobs,
      canRunConcurrent: true,
      workspaceRoot: cwd
    },
    true
  );
}

async function commandTask(argv) {
  const expanded = expandArgv(argv);
  const { options, positionals } = parseArgs(expanded, {
    booleanOptions: [
      "background",
      "write",
      "read-only",
      "resume-last",
      "fresh",
      "worktree",
      "check",
      "json",
      "verbatim",
      ...CONTROL_BOOLEAN_OPTIONS
    ],
    valueOptions: [
      "model",
      "effort",
      "max-turns",
      "cwd",
      "best-of-n",
      "worktree-ref",
      "worktree-name",
      "resume-session",
      ...CONTROL_VALUE_OPTIONS
    ],
    arrayOptions: [...CONTROL_ARRAY_OPTIONS],
    aliasMap: {
      "read-only": "read-only",
      "resume-last": "resume-last",
      "resume-session": "resume-session",
      "max-turns": "max-turns",
      "best-of-n": "best-of-n",
      "worktree-ref": "worktree-ref",
      "worktree-name": "worktree-name"
    }
  });

  const cwd = resolveWorkspaceRoot(options.cwd || process.cwd());
  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    throw new Error("Missing task prompt. Example: task fix the failing tests");
  }

  const control = controlFromParsedOptions(options);
  const writeMode = !options["read-only"] && control.permissionMode !== "plan";
  const modelAlias = options.model;
  const model = normalizeModel(options.model);
  const effort = normalizeEffort(options.effort, modelAlias);
  const background = Boolean(options.background);
  const bestOfN = options["best-of-n"] ? Number(options["best-of-n"]) : null;
  const worktree =
    options["worktree-name"] ||
    (options.worktree ? true : false);
  const check = Boolean(options.check);

  let resume = null;
  if (options.fresh) {
    resume = null;
  } else if (options["resume-session"]) {
    resume = String(options["resume-session"]).trim();
    if (!resume) {
      throw new Error("Empty --resume-session value.");
    }
  } else if (options["resume-last"]) {
    resume = getLastTaskSessionId(cwd);
    if (!resume) {
      throw new Error("No previous Grok task session found for this repository. Run without --resume-last.");
    }
  }

  const jobConfig = controlToJobConfig(control, {
    bestOfN,
    worktree: worktree || null,
    worktreeRef: options["worktree-ref"] || null,
    check
  });

  const job = createJobShell(cwd, {
    kind: "task",
    title: titleFromPrompt(prompt),
    prompt,
    write: writeMode,
    model,
    effort,
    extras: {
      resume,
      bestOfN,
      worktree: Boolean(worktree),
      check,
      config: jobConfig
    }
  });

  let grokOptions = {
    promptFile: job.promptFile,
    cwd,
    write: writeMode || control.permissionMode === "plan",
    model,
    effort,
    resume,
    maxTurns: options["max-turns"] ? Number(options["max-turns"]) : undefined,
    bestOfN,
    check,
    worktree,
    worktreeRef: options["worktree-ref"],
    verbatim: Boolean(options.verbatim)
  };
  grokOptions = applyControlToGrokOptions(grokOptions, control);

  runOrBackground(cwd, job, grokOptions, {
    background,
    json: options.json,
    renderPayload: {
      build: (finished) => ({
        jobId: job.id,
        kind: "task",
        status: finished.status,
        model,
        write: writeMode,
        grokSessionId: finished.grokSessionId,
        text: finished.resultText,
        error: finished.error,
        usage: finished.usage,
        artifacts: finished.artifacts,
        config: finished.config || jobConfig,
        bestOfN,
        worktree: Boolean(worktree),
        check
      })
    }
  });
}

async function commandPlan(argv) {
  const expanded = expandArgv(argv);
  const cfg = controlParseConfig();
  const { options, positionals } = parseArgs(expanded, cfg);
  const cwd = resolveWorkspaceRoot(options.cwd || process.cwd());
  const userPrompt = positionals.join(" ").trim();
  if (!userPrompt) {
    throw new Error("Missing plan prompt. Example: plan redesign the retry layer");
  }

  const control = controlFromParsedOptions({ ...options, plan: true });
  const model = normalizeModel(options.model);
  const effort = normalizeEffort(options.effort, options.model);
  const prompt = buildPlanModePrompt(userPrompt);
  const jobConfig = controlToJobConfig(control, {});

  const job = createJobShell(cwd, {
    kind: "plan",
    title: titleFromPrompt(userPrompt, "Grok plan"),
    prompt,
    write: false,
    model,
    effort,
    extras: { config: jobConfig }
  });

  let grokOptions = {
    promptFile: job.promptFile,
    cwd,
    write: true,
    model,
    effort,
    yolo: false
  };
  grokOptions = applyControlToGrokOptions(grokOptions, control);

  runOrBackground(cwd, job, grokOptions, {
    background: Boolean(options.background),
    json: options.json,
    renderPayload: {
      build: (finished) => ({
        jobId: job.id,
        kind: "plan",
        status: finished.status,
        model,
        write: false,
        grokSessionId: finished.grokSessionId,
        text: preferPlanArtifactText(finished.resultText, finished.artifacts),
        error: finished.error,
        usage: finished.usage,
        artifacts: finished.artifacts,
        config: finished.config || jobConfig
      })
    }
  });
}



async function commandReview(argv, { adversarial = false } = {}) {
  const expanded = expandArgv(argv);
  const { options, positionals } = parseArgs(expanded, {
    booleanOptions: [
      "background",
      "json",
      "wait",
      "adversarial",
      "structured",
      "post-pending",
      ...CONTROL_BOOLEAN_OPTIONS
    ],
    valueOptions: ["base", "scope", "model", "effort", "cwd", "pr", ...CONTROL_VALUE_OPTIONS],
    arrayOptions: [...CONTROL_ARRAY_OPTIONS]
  });

  const cwd = resolveWorkspaceRoot(options.cwd || process.cwd());
  const focusText = positionals.join(" ").trim();
  const isAdversarial = adversarial || Boolean(options.adversarial);
  const postPending = Boolean(options["post-pending"]);
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope || "auto",
    pr: options.pr
  });

  if (target.empty) {
    const message = "Nothing to review: working tree/branch/PR diff looks empty.\n";
    outputResult(options.json ? { empty: true, message } : message, Boolean(options.json));
    return;
  }

  if (postPending && !target.pr) {
    throw new Error("--post-pending requires --pr <number>");
  }

  const control = controlFromParsedOptions(options);
  const prompt = buildStructuredReviewPrompt(target, focusText, { adversarial: isAdversarial });
  const model = normalizeModel(options.model);
  const effort = normalizeEffort(options.effort, options.model);
  const kind = isAdversarial ? "adversarial-review" : "review";
  const jobConfig = controlToJobConfig(control, { postPending });
  const job = createJobShell(cwd, {
    kind,
    title: titleFromPrompt(
      focusText || `${isAdversarial ? "Adversarial review" : "Review"} ${target.label}`,
      "Grok review"
    ),
    prompt,
    write: false,
    model,
    effort,
    extras: {
      config: jobConfig,
      wantPostPending: postPending,
      reviewTarget: {
        kind: target.kind,
        label: target.label,
        baseRef: target.baseRef || null,
        pr: target.pr || null,
        headSha: target.headSha || null,
        owner: target.owner || null,
        repo: target.repo || null,
        diff: target.diff || null
      }
    }
  });

  const schema = fs.readFileSync(getReviewSchemaPath(), "utf8");
  let grokOptions = {
    promptFile: job.promptFile,
    cwd,
    write: false,
    model,
    effort,
    jsonSchema: schema
  };
  grokOptions = applyControlToGrokOptions(grokOptions, control);

  // Post-pending runs inside finalizeJob (foreground) and maybeFinalizeBackgroundJob
  // (background + status/result poll) via postPendingForFinishedJob.
  const finalizeExtras = {
    parseReview: true,
    wantPostPending: postPending,
    reviewTarget: job.reviewTarget
  };

  const runResult = runOrBackground(cwd, job, grokOptions, {
    background: Boolean(options.background),
    json: options.json,
    renderPayload: {
      finalizeExtras,
      build: (finished) => ({
        jobId: job.id,
        kind,
        status: finished.status,
        model,
        write: false,
        grokSessionId: finished.grokSessionId,
        text: finished.resultText,
        error: finished.error,
        review: finished.review,
        usage: finished.usage,
        artifacts: finished.artifacts,
        postPending: finished.postPending || null,
        config: jobConfig
      })
    }
  });
  return runResult;
}

async function commandWorkflow(argv) {
  const expanded = expandArgv(argv);
  const sub = expanded[0];
  const rest = expanded.slice(1);

  if (!sub || sub === "list") {
    const { options } = parseArgs(rest, { booleanOptions: ["json"] });
    const cwd = resolveWorkspaceRoot(process.cwd());
    const workflows = discoverWorkflows(cwd);
    const payload = { workflows, count: workflows.length };
    if (options.json) {
      outputResult(payload, true);
    } else {
      const lines = ["# Grok workflows", ""];
      if (!workflows.length) {
        lines.push("_No workflows found in `.grok/workflows/` or `~/.grok/workflows/`._");
      } else {
        for (const wf of workflows) {
          lines.push(
            `- **${wf.name}** (${wf.scope}) — \`${wf.path}\`${wf.description ? `: ${wf.description}` : ""}`
          );
        }
      }
      lines.push("", "Run: `workflow run <name> [--arg key=value]...`");
      outputResult(`${lines.join("\n")}\n`, false);
    }
    return;
  }

  if (sub === "run") {
    const { options, positionals } = parseArgs(rest, {
      booleanOptions: [
        "background",
        "json",
        "validate-only",
        ...CONTROL_BOOLEAN_OPTIONS
      ],
      valueOptions: ["model", "effort", "cwd", "arg", ...CONTROL_VALUE_OPTIONS],
      arrayOptions: ["arg", ...CONTROL_ARRAY_OPTIONS]
    });
    const name = positionals[0];
    if (!name) {
      throw new Error("workflow run requires a name. Example: workflow run review-changes");
    }
    const cwd = resolveWorkspaceRoot(options.cwd || process.cwd());
    const argList = [].concat(options.arg || []);
    const args = parseWorkflowArgs(argList);
    const control = controlFromParsedOptions(options);
    const validateOnly = Boolean(options["validate-only"]);
    const prompt = buildWorkflowPrompt({
      name,
      args,
      validateOnly
    });
    const model = normalizeModel(options.model);
    const effort = normalizeEffort(options.effort, options.model);
    const jobConfig = controlToJobConfig(control, { workflowName: name });
    // validate-only must not grant yolo write+shell — smoke-check only.
    const writeCapable = !validateOnly;

    const job = createJobShell(cwd, {
      kind: "workflow",
      title: titleFromPrompt(`workflow ${name}`, "Grok workflow"),
      prompt,
      write: writeCapable,
      model,
      effort,
      extras: { config: jobConfig, workflowName: name, validateOnly }
    });

    let grokOptions = {
      promptFile: job.promptFile,
      cwd,
      write: writeCapable,
      model,
      effort
    };
    grokOptions = applyControlToGrokOptions(grokOptions, control);

    runOrBackground(cwd, job, grokOptions, {
      background: Boolean(options.background),
      json: options.json,
      renderPayload: {
        build: (finished) => ({
          jobId: job.id,
          kind: "workflow",
          status: finished.status,
          model,
          write: writeCapable,
          grokSessionId: finished.grokSessionId,
          text: finished.resultText,
          error: finished.error,
          usage: finished.usage,
          artifacts: finished.artifacts,
          config: jobConfig
        })
      }
    });
    return;
  }

  throw new Error(`Unknown workflow subcommand: ${sub}. Use list or run.`);
}

async function commandDesign(argv) {
  const expanded = expandArgv(argv);
  const { options, positionals } = parseArgs(expanded, controlParseConfig());
  const cwd = resolveWorkspaceRoot(options.cwd || process.cwd());
  const brief = positionals.join(" ").trim();
  if (!brief) {
    throw new Error("Missing design brief. Example: design add multi-tenant billing");
  }
  const control = controlFromParsedOptions(options);
  const model = normalizeModel(options.model || "deep");
  const effort = normalizeEffort(options.effort || "high", options.model || "deep");
  const prompt = buildDesignPrompt(brief);
  const jobConfig = controlToJobConfig(control, {});

  const job = createJobShell(cwd, {
    kind: "design",
    title: titleFromPrompt(brief, "Grok design"),
    prompt,
    write: true,
    model,
    effort,
    extras: { config: jobConfig }
  });

  let grokOptions = {
    promptFile: job.promptFile,
    cwd,
    write: true,
    model,
    effort
  };
  grokOptions = applyControlToGrokOptions(grokOptions, control);

  runOrBackground(cwd, job, grokOptions, {
    background: Boolean(options.background),
    json: options.json,
    renderPayload: {
      build: (finished) => ({
        jobId: job.id,
        kind: "design",
        status: finished.status,
        model,
        write: true,
        grokSessionId: finished.grokSessionId,
        text: finished.resultText,
        error: finished.error,
        usage: finished.usage,
        artifacts: finished.artifacts,
        config: jobConfig
      })
    }
  });
}

async function commandExecutePlan(argv) {
  const expanded = expandArgv(argv);
  const { options, positionals } = parseArgs(expanded, {
    booleanOptions: [
      "background",
      "json",
      "dry-run",
      "auto-pr",
      "no-graphite",
      "latest",
      ...CONTROL_BOOLEAN_OPTIONS
    ],
    valueOptions: [
      "model",
      "effort",
      "cwd",
      "concurrency",
      "instructions",
      "resume",
      ...CONTROL_VALUE_OPTIONS
    ],
    arrayOptions: [...CONTROL_ARRAY_OPTIONS]
  });
  const cwd = resolveWorkspaceRoot(options.cwd || process.cwd());
  const designDocPath = positionals[0] || null;
  const resumePlanId = options.resume || null;
  const wantLatest = Boolean(options.latest) || designDocPath === "latest";

  if (!designDocPath && !resumePlanId && !wantLatest) {
    throw new Error(
      "execute-plan requires <design-doc-path>, --latest (newest under .grok-designs/), or --resume <PLAN_ID>"
    );
  }

  let absDoc = null;
  if (!resumePlanId || designDocPath || wantLatest) {
    if (resumePlanId && !designDocPath && !wantLatest) {
      absDoc = null;
    } else {
      absDoc = resolveExecutePlanDesignPath(cwd, designDocPath, {
        latest: wantLatest || !designDocPath
      });
    }
  }

  const control = controlFromParsedOptions(options);
  const model = normalizeModel(options.model);
  const effort = normalizeEffort(options.effort, options.model);
  const dryRun = Boolean(options["dry-run"]);
  const prompt = buildExecutePlanPrompt(absDoc, {
    concurrency: options.concurrency ? Number(options.concurrency) : 4,
    dryRun,
    autoPr: Boolean(options["auto-pr"]),
    noGraphite: Boolean(options["no-graphite"]),
    instructions: options.instructions || "",
    resumePlanId
  });
  const jobConfig = controlToJobConfig(control, {});
  // Dry-run must not get --yolo; report linearized order only.
  const writeCapable = !dryRun;

  const job = createJobShell(cwd, {
    kind: "execute-plan",
    title: titleFromPrompt(
      resumePlanId
        ? `execute-plan resume ${resumePlanId}`
        : `execute-plan ${absDoc || designDocPath || "latest"}`,
      "Grok execute-plan"
    ),
    prompt,
    write: writeCapable,
    model,
    effort,
    extras: { config: jobConfig, designDocPath: absDoc, resumePlanId, dryRun }
  });

  let grokOptions = {
    promptFile: job.promptFile,
    cwd,
    write: writeCapable,
    model,
    effort
  };
  grokOptions = applyControlToGrokOptions(grokOptions, control);

  runOrBackground(cwd, job, grokOptions, {
    background: Boolean(options.background),
    json: options.json,
    renderPayload: {
      build: (finished) => ({
        jobId: job.id,
        kind: "execute-plan",
        status: finished.status,
        model,
        write: writeCapable,
        grokSessionId: finished.grokSessionId,
        text: finished.resultText,
        error: finished.error,
        usage: finished.usage,
        artifacts: finished.artifacts,
        config: jobConfig
      })
    }
  });
}

async function commandBabysit(argv) {
  const expanded = expandArgv(argv);
  const { options, positionals } = parseArgs(expanded, {
    booleanOptions: ["background", "json", ...CONTROL_BOOLEAN_OPTIONS],
    valueOptions: ["model", "effort", "cwd", ...CONTROL_VALUE_OPTIONS],
    arrayOptions: [...CONTROL_ARRAY_OPTIONS]
  });
  const { action, prs } = parseBabysitInvocation(positionals);
  const cwd = resolveWorkspaceRoot(options.cwd || process.cwd());
  const control = controlFromParsedOptions(options);
  const model = normalizeModel(options.model);
  const effort = normalizeEffort(options.effort, options.model);
  const prompt = buildBabysitPrompt(action, prs);
  const jobConfig = controlToJobConfig(control, { babysitAction: action });
  const background =
    options.background != null
      ? Boolean(options.background)
      : babysitSupportsBackground(action);
  // list is read-only; add/remove/check may mutate watchlist or code.
  const writeCapable = action !== "list";

  const job = createJobShell(cwd, {
    kind: "babysit",
    title: titleFromPrompt(`babysit ${action} ${prs.join(" ")}`.trim(), "Grok babysit"),
    prompt,
    write: writeCapable,
    model,
    effort,
    extras: { config: jobConfig, babysitAction: action, prs }
  });

  let grokOptions = {
    promptFile: job.promptFile,
    cwd,
    write: writeCapable,
    model,
    effort
  };
  grokOptions = applyControlToGrokOptions(grokOptions, control);

  runOrBackground(cwd, job, grokOptions, {
    background,
    json: options.json,
    renderPayload: {
      build: (finished) => ({
        jobId: job.id,
        kind: "babysit",
        status: finished.status,
        model,
        write: writeCapable,
        grokSessionId: finished.grokSessionId,
        text: finished.resultText,
        error: finished.error,
        usage: finished.usage,
        artifacts: finished.artifacts,
        config: jobConfig
      })
    }
  });
}

async function commandDocument(argv) {
  const expanded = expandArgv(argv);
  const { options, positionals } = parseArgs(expanded, {
    booleanOptions: ["background", "json", ...CONTROL_BOOLEAN_OPTIONS],
    valueOptions: ["type", "model", "effort", "cwd", "out", ...CONTROL_VALUE_OPTIONS],
    arrayOptions: [...CONTROL_ARRAY_OPTIONS]
  });
  const cwd = resolveWorkspaceRoot(options.cwd || process.cwd());
  const docType = normalizeDocumentType(options.type || "docx");
  const brief = positionals.join(" ").trim();
  if (!brief) {
    throw new Error("Missing document brief. Example: document --type pptx Launch deck for Grok plugin");
  }
  const outDir = options.out || path.join(cwd, ".grok-docs");
  const control = controlFromParsedOptions(options);
  const model = normalizeModel(options.model);
  const effort = normalizeEffort(options.effort, options.model);
  const prompt = buildDocumentPrompt({ type: docType, brief, outputDir: outDir });
  const jobConfig = controlToJobConfig(control, { documentType: docType });

  const job = createJobShell(cwd, {
    kind: "document",
    title: titleFromPrompt(`${docType}: ${brief}`, "Grok document"),
    prompt,
    write: true,
    model,
    effort,
    extras: { config: jobConfig, documentType: docType, mediaDir: outDir }
  });

  let grokOptions = {
    promptFile: job.promptFile,
    cwd,
    write: true,
    model,
    effort
  };
  grokOptions = applyControlToGrokOptions(grokOptions, control);

  runOrBackground(cwd, job, grokOptions, {
    background: Boolean(options.background),
    json: options.json,
    renderPayload: {
      build: (finished) => ({
        jobId: job.id,
        kind: "document",
        status: finished.status,
        model,
        write: true,
        grokSessionId: finished.grokSessionId,
        text: finished.resultText,
        error: finished.error,
        usage: finished.usage,
        artifacts: finished.artifacts,
        config: jobConfig
      })
    }
  });
}

async function commandSessions(argv) {
  const expanded = expandArgv(argv);
  const sub = expanded[0] || "list";
  const rest = expanded.slice(1);
  const cwd = resolveWorkspaceRoot(process.cwd());

  if (sub === "list") {
    const { options } = parseArgs(rest, {
      booleanOptions: ["json"],
      valueOptions: ["limit"]
    });
    const sessions = listSessions({
      cwd,
      limit: options.limit ? Number(options.limit) : 20
    });
    const payload = { sessions, count: sessions.length };
    if (options.json) {
      outputResult(payload, true);
    } else {
      const lines = ["# Grok sessions", ""];
      if (!sessions.length) {
        lines.push("_No sessions found for this workspace._");
      } else {
        for (const s of sessions) {
          lines.push(`- \`${s.id}\`${s.title ? ` — ${s.title}` : ""}`);
        }
      }
      lines.push("", "Export: `sessions export <id> [--out path]`");
      outputResult(`${lines.join("\n")}\n`, false);
    }
    return;
  }

  if (sub === "search") {
    const { options, positionals } = parseArgs(rest, {
      booleanOptions: ["json"],
      valueOptions: ["limit"]
    });
    const query = positionals.join(" ").trim();
    if (!query) {
      throw new Error("sessions search requires a query");
    }
    const sessions = searchSessions({
      cwd,
      query,
      limit: options.limit ? Number(options.limit) : 20
    });
    const payload = { sessions, count: sessions.length, query };
    if (options.json) {
      outputResult(payload, true);
    } else {
      const lines = [`# Grok sessions matching “${query}”`, ""];
      for (const s of sessions) {
        lines.push(`- \`${s.id}\`${s.title ? ` — ${s.title}` : ""}`);
      }
      if (!sessions.length) lines.push("_No matches._");
      outputResult(`${lines.join("\n")}\n`, false);
    }
    return;
  }

  if (sub === "export") {
    const { options, positionals } = parseArgs(rest, {
      booleanOptions: ["json"],
      valueOptions: ["out"]
    });
    const sessionId = positionals[0];
    if (!sessionId) {
      throw new Error("sessions export requires a session id");
    }
    const result = exportSession(sessionId, {
      outputPath: options.out || null,
      cwd
    });
    if (options.json) {
      outputResult(result, true);
    } else if (result.outputPath) {
      outputResult(`Exported session \`${sessionId}\` to \`${result.outputPath}\`.\n`, false);
    } else {
      outputResult(result.markdown || "(empty export)\n", false);
    }
    return;
  }

  throw new Error(`Unknown sessions subcommand: ${sub}. Use list|search|export.`);
}

async function commandMedia(argv, kind) {
  const expanded = expandArgv(argv);
  const multiRef = [];
  const filtered = [];
  for (let i = 0; i < expanded.length; i += 1) {
    if (expanded[i] === "--ref" || expanded[i] === "--refs") {
      const value = expanded[i + 1];
      if (!value) {
        throw new Error(`Missing value for ${expanded[i]}`);
      }
      multiRef.push(value);
      i += 1;
      continue;
    }
    filtered.push(expanded[i]);
  }

  const { options, positionals } = parseArgs(filtered, {
    booleanOptions: ["background", "json"],
    valueOptions: ["model", "effort", "edit", "image", "aspect", "duration", "cwd", "out"]
  });

  const cwd = resolveWorkspaceRoot(options.cwd || process.cwd());
  const promptText = positionals.join(" ").trim();
  if (!promptText && !options.edit && !options.image && !multiRef.length) {
    throw new Error(`Missing ${kind} prompt`);
  }

  const outputDir = options.out
    ? path.resolve(cwd, options.out)
    : resolveMediaOutputDir(cwd, kind);
  fs.mkdirSync(outputDir, { recursive: true });

  const model = normalizeModel(options.model);
  const effort = normalizeEffort(options.effort, options.model);
  const prompt =
    kind === "image"
      ? buildImagePrompt({
          prompt: promptText || "Improve or regenerate the asset",
          edit: options.edit ? path.resolve(cwd, options.edit) : null,
          outputDir,
          aspectRatio: options.aspect
        })
      : buildVideoPrompt({
          prompt: promptText || "Create a short product video",
          image: options.image ? path.resolve(cwd, options.image) : null,
          refs: multiRef.map((ref) => path.resolve(cwd, ref)),
          outputDir,
          duration: options.duration,
          aspectRatio: options.aspect
        });

  const job = createJobShell(cwd, {
    kind,
    title: titleFromPrompt(promptText || `${kind} generation`, `Grok ${kind}`),
    prompt,
    write: false,
    model,
    effort,
    extras: { mediaDir: outputDir, media: true }
  });

  // Grok 0.2.93: never pass --tools allowlist here (session create fails).
  // Use default toolset + denylist; do not pass --yolo (classifier may deny it;
  // single-prompt auto-approve still applies when configured).
  // Grok media tools write under ~/.grok/sessions/...; the companion copies into outputDir.
  const grokOptions = {
    promptFile: job.promptFile,
    cwd,
    media: true,
    write: false,
    yolo: false,
    model,
    effort,
    rules: `Media-only mode. Prefer image_gen / image_edit / image_to_video / reference_to_video. Session media paths are fine; the companion copies them into ${outputDir}. Do not edit application source code. Do not run shell commands or try to move files. When finished, print absolute paths to every created file.`
  };

  const finished = runOrBackground(cwd, job, grokOptions, {
    background: Boolean(options.background),
    json: options.json,
    renderPayload: {
      build: (done) => {
        const artifacts =
          done.artifacts?.length
            ? done.artifacts
            : resolveMediaArtifactsForJob(
                { ...job, ...done, mediaDir: outputDir, kind },
                done.resultText || "",
                done.grokSessionId
              );
        return {
          jobId: job.id,
          kind,
          status: done.status,
          model,
          write: false,
          mediaDir: outputDir,
          grokSessionId: done.grokSessionId,
          text: done.resultText,
          error: done.error,
          artifacts: [...new Set(artifacts)]
        };
      }
    }
  });

  // Foreground: re-collect in case session files landed after parse.
  if (finished) {
    finished.artifacts = resolveMediaArtifactsForJob(
      { ...finished, mediaDir: outputDir, kind },
      finished.resultText || "",
      finished.grokSessionId
    );
    writeJobFile(cwd, finished);
  }
}

async function commandTransfer(argv) {
  const { options } = parseArgs(argv, {
    booleanOptions: ["json"],
    valueOptions: ["source"]
  });
  const cwd = resolveWorkspaceRoot(process.cwd());
  const availability = getGrokAvailability();
  const plan = buildTransferPlan(cwd, {
    source: options.source,
    grokBinary: availability.binary
  });
  outputResult(options.json ? plan : renderTransferReport(plan), Boolean(options.json));
  process.exitCode = plan.ok ? 0 : 1;
}

async function commandStopGateReview(argv) {
  const { options } = parseArgs(argv, { booleanOptions: ["json"] });
  const cwd = resolveWorkspaceRoot(process.cwd());
  const config = getConfig(cwd);
  if (!config.stopReviewGate) {
    const payload = { enabled: false, blocked: false, message: "Stop review gate is disabled." };
    outputResult(options.json ? payload : "Stop review gate is disabled.\n", Boolean(options.json));
    return;
  }

  const target = collectStopGateContext(cwd);
  if (target.empty) {
    const payload = { enabled: true, blocked: false, empty: true, message: "No changes to review." };
    outputResult(options.json ? payload : "No changes to review for stop gate.\n", Boolean(options.json));
    return;
  }

  const prompt = buildStructuredReviewPrompt(
    target,
    "Stop-gate review of the previous Claude turn. Focus on bugs, security, and data-loss risks.",
    { adversarial: false }
  );
  const job = createJobShell(cwd, {
    kind: "stop-gate",
    title: "Stop-gate review",
    prompt,
    write: false,
    model: null,
    effort: null
  });

  const schema = fs.readFileSync(getReviewSchemaPath(), "utf8");
  // Safer stop-gate posture: denylist editors/shell, no yolo, optional sandbox read-only.
  const grokResult = runGrok({
    promptFile: job.promptFile,
    cwd,
    write: false,
    yolo: false,
    sandbox: "read-only",
    noSubagents: true,
    jsonSchema: schema
  });
  const finished = finalizeJob(cwd, job, grokResult, { parseReview: true });
  const blocked = Boolean(finished.review && reviewHasBlockingFindings(finished.review));
  const payload = {
    enabled: true,
    blocked,
    jobId: job.id,
    review: finished.review,
    text: finished.resultText,
    status: finished.status
  };

  if (options.json) {
    outputResult(payload, true);
  } else if (finished.review) {
    process.stdout.write(
      renderTaskResult({
        jobId: job.id,
        kind: "stop-gate",
        status: finished.status,
        review: finished.review,
        text: finished.resultText,
        grokSessionId: finished.grokSessionId
      })
    );
    if (blocked) {
      process.stdout.write(
        "\n**Stop gate:** blocking issues found (critical/high). Address them before ending the turn.\n"
      );
    }
  } else {
    process.stdout.write(finished.resultText || finished.error || "Stop-gate review finished.\n");
  }

  process.exitCode = blocked ? 2 : finished.status === "completed" ? 0 : 1;
}

async function commandStatus(argv) {
  const { options, positionals } = parseArgs(argv, {
    booleanOptions: ["json", "all"]
  });
  const cwd = resolveWorkspaceRoot(process.cwd());
  const jobId = positionals[0] || null;

  let jobs = listJobs(cwd).map((job) => {
    const stored = readJobFile(cwd, job.id) || job;
    return maybeFinalizeBackgroundJob(cwd, stored);
  });

  if (!options.all) {
    jobs = jobs.slice(0, 15);
  }

  if (jobId) {
    const job = maybeFinalizeBackgroundJob(cwd, resolveJob(cwd, jobId));
    outputResult(options.json ? job : renderStatusReport([job], { jobId }), Boolean(options.json));
    return;
  }

  const config = getConfig(cwd);
  const runningJobs = jobs.filter((job) => job.status === "running");
  const payload = {
    jobs,
    runningCount: runningJobs.length,
    concurrent: runningJobs.length > 1,
    workspaceRoot: cwd,
    stopReviewGate: config.stopReviewGate
  };
  outputResult(options.json ? payload : renderStatusReport(jobs, { concurrent: payload.concurrent }), Boolean(options.json));
}

async function commandResult(argv) {
  const { options, positionals } = parseArgs(argv, { booleanOptions: ["json"] });
  const cwd = resolveWorkspaceRoot(process.cwd());
  const jobId = positionals[0] || null;
  let job = resolveJob(cwd, jobId);
  job = maybeFinalizeBackgroundJob(cwd, readJobFile(cwd, job.id) || job);
  outputResult(options.json ? job : renderStoredJobResult(job), Boolean(options.json));
  process.exitCode = job.status === "completed" ? 0 : job.status === "running" ? 0 : 1;
}

async function commandCancel(argv) {
  const { options, positionals } = parseArgs(argv, { booleanOptions: ["json"] });
  const cwd = resolveWorkspaceRoot(process.cwd());
  const jobId = positionals[0] || null;
  let job = resolveJob(cwd, jobId);
  job = readJobFile(cwd, job.id) || job;

  if (job.status !== "running") {
    const payload = { jobId: job.id, cancelled: false, reason: `Job is already ${job.status}` };
    outputResult(options.json ? payload : `Job \`${job.id}\` is already ${job.status}.\n`, Boolean(options.json));
    return;
  }

  const pid = job.pid ?? readPidFile(resolveJobPidFile(cwd, job.id));
  const killed = pid ? terminateProcessTree(pid, "SIGTERM") : false;
  const finishedAt = nowIso();
  const fullJob = {
    ...job,
    status: "cancelled",
    finishedAt,
    updatedAt: finishedAt,
    summary: "Cancelled by user",
    error: "Cancelled"
  };
  upsertJob(cwd, {
    id: job.id,
    status: "cancelled",
    finishedAt,
    summary: fullJob.summary,
    error: fullJob.error
  });
  writeJobFile(cwd, fullJob);

  const payload = { jobId: job.id, cancelled: true, killed, pid };
  outputResult(options.json ? payload : renderCancelReport(job, killed), Boolean(options.json));
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === "-h" || command === "--help" || command === "help") {
    printUsage();
    return;
  }

  try {
    switch (command) {
      case "setup":
        await commandSetup(rest);
        break;
      case "task":
        await commandTask(rest);
        break;
      case "plan":
        await commandPlan(rest);
        break;
      case "task-resume-candidate":
        await commandTaskResumeCandidate(rest);
        break;
      case "review":
        await commandReview(rest, { adversarial: false });
        break;
      case "adversarial-review":
        await commandReview(rest, { adversarial: true });
        break;
      case "workflow":
        await commandWorkflow(rest);
        break;
      case "design":
        await commandDesign(rest);
        break;
      case "execute-plan":
        await commandExecutePlan(rest);
        break;
      case "babysit":
        await commandBabysit(rest);
        break;
      case "document":
        await commandDocument(rest);
        break;
      case "sessions":
        await commandSessions(rest);
        break;
      case "image":
        await commandMedia(rest, "image");
        break;
      case "video":
        await commandMedia(rest, "video");
        break;
      case "transfer":
        await commandTransfer(rest);
        break;
      case "stop-gate-review":
        await commandStopGateReview(rest);
        break;
      case "status":
        await commandStatus(rest);
        break;
      case "result":
        await commandResult(rest);
        break;
      case "cancel":
        await commandCancel(rest);
        break;
      default:
        printUsage();
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

await main();
