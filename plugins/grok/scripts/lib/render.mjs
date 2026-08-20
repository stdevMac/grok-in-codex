import { preferPlanArtifactText, primaryArtifacts } from "./artifacts.mjs";

function escapeCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function primaryArtifactsFromJob(job) {
  const list = primaryArtifacts(job?.artifacts || [], { limit: 5 });
  return list.map((a) => (typeof a === "string" ? a : a.path)).filter(Boolean);
}

function short(value, max = 80) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}…`;
}

function formatLineRange(finding) {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

export function renderSetupReport(payload) {
  const lines = ["# Grok setup", ""];
  lines.push(`- **CLI**: ${payload.available ? "found" : "missing"}`);
  if (payload.binary) {
    lines.push(`- **Binary**: \`${payload.binary}\``);
  }
  if (payload.version) {
    lines.push(`- **Version**: ${payload.version}`);
  }
  if (payload.versionOk === false) {
    lines.push(
      `- **Version floor**: ⚠ below minimum ${payload.minVersion || "0.2.118"} (some features may fail)`
    );
  } else if (payload.versionOk) {
    lines.push(`- **Version floor**: ok (≥ ${payload.minVersion || "0.2.118"})`);
  }
  lines.push(`- **Auth**: ${payload.authenticated ? "ok" : "not ready"}`);
  if (payload.authDetail) {
    lines.push(`- **Auth detail**: ${payload.authDetail}`);
  }
  if (payload.defaultModel) {
    lines.push(`- **Default model**: ${payload.defaultModel}`);
  }
  if (payload.availableModels?.length) {
    lines.push(`- **Available models**: ${payload.availableModels.join(", ")}`);
  } else if (payload.modelsOk === false && payload.modelsDetail) {
    lines.push(`- **Models**: issues — ${short(payload.modelsDetail, 120)}`);
  }
  if (payload.doctorDetail) {
    lines.push(`- **Doctor**: ${payload.doctorOk ? "ok" : "issues"} — ${short(payload.doctorDetail, 120)}`);
  }
  lines.push(
    `- **Stop review gate**: ${payload.stopReviewGate ? "enabled" : "disabled"}`
  );
  if (payload.ready) {
    lines.push(
      "",
      "Grok is ready. Commands: rescue, plan, review, workflow, design, execute-plan, babysit, document, image, video, sessions.",
      "Agents under `/agents`: `grok:grok-rescue`, `grok:grok-plan`, `grok:grok-review`, `grok:grok-workflow`, `grok:grok-design`, `grok:grok-execute`, `grok:grok-babysit`, `grok:grok-document`, `grok:grok-media`."
    );
  } else {
    lines.push("", "## Next steps");
    for (const step of payload.nextSteps ?? []) {
      lines.push(`- ${step}`);
    }
  }
  lines.push(
    "",
    "## Optional",
    "",
    "- Enable stop-gate: `/grok:setup --enable-review-gate`",
    "- Disable stop-gate: `/grok:setup --disable-review-gate`"
  );
  return `${lines.join("\n")}\n`;
}

/**
 * Append usage / postPending / artifacts blocks shared by task + structured review results.
 */
function appendResultEnrichment(lines, payload) {
  if (payload.usage) {
    lines.push("");
    lines.push("## Usage");
    lines.push("");
    if (payload.usage.num_turns != null) {
      lines.push(`- **Turns**: ${payload.usage.num_turns}`);
    }
    if (payload.usage.total_tokens != null) {
      lines.push(
        `- **Tokens**: ${payload.usage.total_tokens} total (in ${payload.usage.input_tokens ?? "?"} / out ${payload.usage.output_tokens ?? "?"}${payload.usage.cache_read_input_tokens != null ? ` / cache_read ${payload.usage.cache_read_input_tokens}` : ""})`
      );
    } else if (payload.usage.input_tokens != null || payload.usage.output_tokens != null) {
      lines.push(
        `- **Tokens**: in ${payload.usage.input_tokens ?? "?"} / out ${payload.usage.output_tokens ?? "?"}`
      );
    }
    if (payload.usage.total_cost_usd != null && !payload.usage.usage_is_incomplete) {
      lines.push(`- **Cost**: $${Number(payload.usage.total_cost_usd).toFixed(4)}`);
    }
    if (payload.usage.usage_is_incomplete) {
      lines.push("- **Note**: usage incomplete");
    }
  }

  if (payload.postPending) {
    lines.push("");
    lines.push("## GitHub pending review");
    lines.push("");
    if (payload.postPending.ok && payload.postPending.skipped) {
      lines.push(`- **Posted**: skipped (${payload.postPending.reason || "policy"})`);
      if (payload.postPending.message) {
        lines.push(`- **Detail**: ${payload.postPending.message}`);
      }
    } else if (payload.postPending.ok) {
      lines.push(`- **Posted**: yes`);
      if (payload.postPending.url) {
        lines.push(`- **Submit at**: ${payload.postPending.url}`);
      }
    } else {
      lines.push(`- **Posted**: no`);
      if (payload.postPending.error) {
        lines.push(`- **Error**: ${payload.postPending.error}`);
      }
      if (payload.postPending.findingsPath) {
        lines.push(`- **Recoverable findings**: \`${payload.postPending.findingsPath}\``);
      }
    }
  }

  if (payload.artifacts?.length) {
    lines.push("");
    lines.push("## Artifacts");
    lines.push("");
    for (const artifact of payload.artifacts) {
      if (typeof artifact === "string") {
        lines.push(`- \`${artifact}\``);
      } else {
        lines.push(
          `- \`${artifact.path}\`${artifact.kind ? ` (${artifact.kind})` : ""}${artifact.label ? ` — ${artifact.label}` : ""}`
        );
      }
    }
  }
}

export function renderStructuredReview(payload) {
  const review = payload.review;
  const lines = [];
  lines.push(`# Grok ${payload.kind || "review"} result`);
  lines.push("");
  lines.push(`- **Job**: \`${payload.jobId}\``);
  lines.push(`- **Status**: ${payload.status}`);
  lines.push(`- **Verdict**: ${review.verdict}`);
  if (payload.model) {
    lines.push(`- **Model**: ${payload.model}`);
  }
  if (payload.grokSessionId) {
    lines.push(`- **Grok session**: \`${payload.grokSessionId}\``);
  }
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(review.summary);
  lines.push("");
  lines.push("## Findings");
  lines.push("");
  if (!review.findings.length) {
    lines.push("_No findings._");
  } else {
    for (const finding of review.findings) {
      lines.push(
        `### [${finding.severity}] ${finding.title}`,
        "",
        `- **File**: \`${finding.file}${formatLineRange(finding)}\``,
        "",
        finding.body
      );
      if (finding.recommendation) {
        lines.push("", `**Recommendation:** ${finding.recommendation}`);
      }
      lines.push("");
    }
  }
  if (review.next_steps?.length) {
    lines.push("## Next steps", "");
    for (const step of review.next_steps) {
      lines.push(`- ${step}`);
    }
    lines.push("");
  }
  // Criterion 3: structured reviews still surface usage / postPending / artifacts
  appendResultEnrichment(lines, payload);
  lines.push("", "## Follow-ups", "", `- \`/grok:status ${payload.jobId}\``, `- \`/grok:result ${payload.jobId}\``);
  return `${lines.join("\n")}\n`;
}

export function renderTaskResult(payload) {
  if (payload.review) {
    return renderStructuredReview(payload);
  }

  const lines = [];
  lines.push(`# Grok ${payload.kind || "task"} result`);
  lines.push("");
  lines.push(`- **Job**: \`${payload.jobId}\``);
  lines.push(`- **Status**: ${payload.status}`);
  if (payload.model) {
    lines.push(`- **Model**: ${payload.model}`);
  }
  if (payload.bestOfN) {
    lines.push(`- **Best-of-N**: ${payload.bestOfN}`);
  }
  if (payload.worktree) {
    lines.push(`- **Worktree**: enabled`);
  }
  if (payload.check) {
    lines.push(`- **Self-check**: enabled`);
  }
  if (payload.grokSessionId) {
    lines.push(`- **Grok session**: \`${payload.grokSessionId}\``);
    lines.push(`- **Resume in Grok TUI**: \`grok --resume ${payload.grokSessionId}\``);
  }
  if (payload.kind === "image" || payload.kind === "video") {
    lines.push("- **Mode**: media generation (default tools + denylist; companion copies into `.grok-media/`)");
    if (payload.mediaDir) {
      lines.push(`- **Output dir**: \`${payload.mediaDir}\``);
    }
  } else if (payload.kind === "plan" || payload.config?.planMode) {
    lines.push("- **Mode**: plan (`--permission-mode plan`)");
  } else if (payload.write) {
    lines.push("- **Mode**: write-capable (`--yolo`)");
  } else {
    lines.push("- **Mode**: read-only (denylist)");
  }
  appendResultEnrichment(lines, payload);
  lines.push("");
  lines.push("## Output");
  lines.push("");
  lines.push(payload.text || payload.error || "(empty)");
  if (payload.error && payload.text) {
    lines.push("", "## Error", "", payload.error);
  }
  lines.push("");
  lines.push("## Follow-ups");
  lines.push("");
  lines.push(`- \`/grok:status ${payload.jobId}\``);
  lines.push(`- \`/grok:result ${payload.jobId}\``);
  if (payload.grokSessionId && (payload.kind === "task" || payload.kind === "plan")) {
    lines.push(
      `- \`/grok:rescue --resume-session ${payload.grokSessionId} continue from this session\``
    );
  }
  return `${lines.join("\n")}\n`;
}

export function renderBackgroundStarted(payload) {
  const lines = [
    `# Grok ${payload.kind || "task"} started in background`,
    "",
    `- **Job**: \`${payload.jobId}\``,
    `- **PID**: ${payload.pid ?? "n/a"}`,
    `- **Title**: ${payload.title || "(untitled)"}`,
    `- **Concurrent jobs**: allowed (multiple Grok processes may run in parallel)`
  ];
  if (payload.otherRunning?.length) {
    lines.push(`- **Also running**: ${payload.otherRunning.length}`);
    for (const other of payload.otherRunning) {
      lines.push(`  - \`${other.id}\` (${other.kind || "job"}): ${short(other.title || "", 50)}`);
    }
  }
  lines.push(
    "",
    "Check progress with:",
    "",
    `- \`/grok:status ${payload.jobId}\``,
    `- \`/grok:result ${payload.jobId}\``,
    `- \`/grok:cancel ${payload.jobId}\``
  );
  return `${lines.join("\n")}\n`;
}

export function renderStatusReport(jobs, options = {}) {
  if (!jobs.length) {
    return "No Grok jobs recorded for this repository yet.\n";
  }

  if (options.jobId) {
    const job = jobs[0];
    const lines = [
      `# Job ${job.id}`,
      "",
      `- **Kind**: ${job.kind || "task"}`,
      `- **Status**: ${job.status}`,
      `- **Title**: ${job.title || ""}`,
      `- **Created**: ${job.createdAt || ""}`,
      `- **Updated**: ${job.updatedAt || ""}`
    ];
    if (job.finishedAt) {
      lines.push(`- **Finished**: ${job.finishedAt}`);
    }
    if (job.pid) {
      lines.push(`- **PID**: ${job.pid}`);
    }
    if (job.alive != null) {
      lines.push(`- **Process alive**: ${job.alive ? "yes" : "no"}`);
    }
    if (job.progress?.phase) {
      lines.push(`- **Phase**: ${job.progress.phase}`);
    }
    if (job.progress?.message) {
      lines.push(`- **Progress**: ${job.progress.message}`);
    }
    if (job.grokSessionId) {
      lines.push(`- **Grok session**: \`${job.grokSessionId}\``);
    }
    if (job.summary) {
      lines.push(`- **Summary**: ${job.summary}`);
    }
    if (job.error) {
      lines.push(`- **Error**: ${job.error}`);
    }
    if (job.usage) {
      const u = job.usage;
      const usageBits = [];
      if (u.num_turns != null) usageBits.push(`turns ${u.num_turns}`);
      if (u.total_tokens != null) usageBits.push(`tokens ${u.total_tokens}`);
      if (u.total_cost_usd != null && !u.usage_is_incomplete) {
        usageBits.push(`$${Number(u.total_cost_usd).toFixed(4)}`);
      }
      if (usageBits.length) {
        lines.push(`- **Usage**: ${usageBits.join(" · ")}`);
      }
    }
    if (job.postPending) {
      if (job.postPending.ok && job.postPending.skipped) {
        lines.push(
          `- **Post-pending**: skipped${job.postPending.reason ? ` (${job.postPending.reason})` : ""}`
        );
      } else if (job.postPending.ok) {
        lines.push(
          `- **Post-pending**: posted${job.postPending.url ? ` — ${job.postPending.url}` : ""}`
        );
      } else {
        lines.push(
          `- **Post-pending**: failed${job.postPending.error ? ` — ${job.postPending.error}` : ""}`
        );
        if (job.postPending.findingsPath) {
          lines.push(`- **Recoverable findings**: \`${job.postPending.findingsPath}\``);
        }
      }
    }
    const primary = primaryArtifactsFromJob(job);
    if (primary.length) {
      lines.push(`- **Artifacts**: ${primary.map((p) => `\`${p}\``).join(", ")}`);
    }
    if (job.logFile) {
      lines.push(`- **Log**: \`${job.logFile}\``);
    }
    if (job.logTail?.length) {
      lines.push("", "## Recent log", "", "```", ...job.logTail, "```");
    }
    lines.push("", "Follow-ups:", "", `- \`/grok:result ${job.id}\``, `- \`/grok:cancel ${job.id}\``);
    return `${lines.join("\n")}\n`;
  }

  const runningCount = jobs.filter((job) => job.status === "running").length;
  const lines = [];
  if (runningCount > 1 || options.concurrent) {
    lines.push(
      `# Grok jobs (${runningCount} running in parallel)`,
      "",
      "Multiple agents/jobs can run at once. Pass a job id to `/grok:result` and `/grok:cancel` when more than one is running.",
      ""
    );
  }
  lines.push("| Job | Kind | Status | Progress | Summary |", "| --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const progress =
      job.status === "running"
        ? short(job.progress?.message || job.progress?.phase || "running", 40)
        : "—";
    lines.push(
      `| \`${escapeCell(job.id)}\` | ${escapeCell(job.kind || "task")} | ${escapeCell(job.status)} | ${escapeCell(progress)} | ${escapeCell(short(job.summary || job.title || ""))} |`
    );
  }
  lines.push("", "Use `/grok:status <job-id>` or `/grok:result <job-id>` for details.");
  return `${lines.join("\n")}\n`;
}

export function renderStoredJobResult(job) {
  if (!job) {
    return "No job found.\n";
  }

  if (job.status === "running") {
    const lines = [
      `# Job ${job.id} is still running`,
      "",
      `- **Title**: ${job.title || ""}`,
      `- **PID**: ${job.pid ?? "n/a"}`
    ];
    if (job.progress?.message) {
      lines.push(`- **Progress**: ${job.progress.message}`);
    }
    if (job.logTail?.length) {
      lines.push("", "## Recent log", "", "```", ...job.logTail, "```");
    }
    lines.push("", "Wait a bit, then retry `/grok:result`, or check `/grok:status`.", "");
    return lines.join("\n");
  }

  let text = job.resultText || job.summary || "";
  // Background plan results: prefer harvested plan.md even if resultText is narration.
  if (job.kind === "plan") {
    text = preferPlanArtifactText(text, job.artifacts);
  }

  return renderTaskResult({
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    model: job.model,
    grokSessionId: job.grokSessionId,
    write: job.write,
    text,
    error: job.error || null,
    review: job.review || null,
    artifacts: job.artifacts || null,
    usage: job.usage || null,
    config: job.config || null,
    postPending: job.postPending || null,
    bestOfN: job.bestOfN ?? job.config?.bestOfN,
    worktree: job.worktree ?? job.config?.worktree,
    check: job.check ?? job.config?.check
  });
}

export function renderCancelReport(job, killed) {
  return [
    `# Cancel ${job.id}`,
    "",
    `- **Previous status**: ${job.status}`,
    `- **Signal sent**: ${killed ? "yes" : "no (process already stopped)"}`,
    `- **New status**: cancelled`,
    ""
  ].join("\n");
}

export function renderTransferReport(payload) {
  const lines = ["# Transfer Claude session → Grok", ""];
  if (payload.sessionPath) {
    lines.push(`- **Claude transcript**: \`${payload.sessionPath}\``);
  }
  if (payload.importCommand) {
    lines.push(`- **Suggested import**: \`${payload.importCommand}\``);
  }
  if (payload.resumeCommand) {
    lines.push(`- **Then resume**: \`${payload.resumeCommand}\``);
  }
  if (payload.notes?.length) {
    lines.push("", "## Notes", "");
    for (const note of payload.notes) {
      lines.push(`- ${note}`);
    }
  }
  if (payload.error) {
    lines.push("", `**Error:** ${payload.error}`);
  }
  lines.push("");
  return lines.join("\n");
}
