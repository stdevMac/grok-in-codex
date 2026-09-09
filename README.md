# Grok plugin for Codex

Use [Grok](https://grok.com) from inside Codex for code reviews, delegated coding, planning, multi-agent workflows, design→execute pipelines, PR babysitting, and image/video/document generation.

**Plugin version:** 0.5.8. Codex stays the orchestrator. A thin MCP server + companion script hands real work to Grok on your machine via the local CLI (Grok Build ≥ **0.2.118** recommended).

Artifact dirs (gitignored): `.grok-plans/`, `.grok-designs/`, `.grok-workflows/`, `.grok-docs/`, `.grok-reviews/`, `.grok-media/`.

Using Claude Code instead? Use the sibling plugin: [grok-in-claude](https://github.com/stdevMac/grok-in-claude).

## What you get

| Codex MCP tool | Purpose |
| --- | --- |
| `grok_setup` | Check CLI + auth + available models + version floor + doctor; toggle stop review gate |
| `grok_rescue` | Delegate investigation / fixes (write-capable; full control flags) |
| `grok_plan` | Plan mode only (explore → plan.md under `.grok-plans/`) |
| `grok_review` | Structured read-only review (tree / branch / PR; optional `postPending`) |
| `grok_adversarial_review` | Challenge design, tradeoffs, and assumptions |
| `grok_workflow` | List/run Grok Rhai multi-agent workflows |
| `grok_design` | Design doc + PR plan (writer/reviewer loop → `.grok-designs/`) |
| `grok_execute_plan` | Execute a design-doc PR Plan DAG |
| `grok_babysit` | Watch PRs / fix CI & review comments (`list` is read-only) |
| `grok_document` | Generate docx / pdf / pptx → `.grok-docs/` |
| `grok_image` | Generate or edit images → `.grok-media/image/` |
| `grok_video` | Generate short videos → `.grok-media/video/` |
| `grok_sessions` | List / search / export Grok sessions |
| `grok_transfer` | Build context-transfer guidance for Grok |
| `grok_status` | Jobs + live progress / log tail + usage when available |
| `grok_result` | Final output (plan.md preferred for plan jobs; usage + artifacts) |
| `grok_cancel` | Cancel a background job |

**Control flags** (rescue/plan/review and long-running jobs): `sandbox`, `planMode` / `permissionMode`, `agent`, `noSubagents`, `memory` / `noMemory`, `allow` / `deny`, `disableWebSearch`, `forkSession`, `maxTurns`.

Skills: brand/media recipes, routing (including plan→design→execute-plan), runtime contracts, workflows, prompting.

## Requirements

- **Node.js 18.18 or later**
- **[Grok Build CLI](https://grok.com)** (`grok`) on your `PATH`
- **Grok authentication** (`grok login`)
- **GitHub CLI (`gh`)** only if you use `grok_review` with PRs or post-pending

Typical CLI location: `~/.grok/bin/grok` (ensure it is on `PATH`).

## Install

From GitHub:

```bash
codex plugin marketplace add stdevMac/grok-in-codex
codex plugin add grok@grok-in-codex
```

Then start a new Codex thread so the plugin skills and MCP tools are loaded.

### Install locally

```bash
codex plugin marketplace add /path/to/grok-in-codex
codex plugin add grok@grok-in-codex
```

Run setup:

```bash
node plugins/grok/scripts/grok-companion.mjs setup
```

Or ask Codex to call `grok_setup`.

## Quick start

```text
Ask Grok to review this branch against main.
Use Grok to plan the auth rewrite.
Generate a design doc with Grok, then execute the latest plan dry-run.
Start a background Grok rescue job for the retry redesign.
Generate a 16:9 launch banner with Grok.
Show Grok job status.
```

Direct MCP tool examples:

```text
grok_plan prompt="plan the auth rewrite" background=true
grok_design prompt="design multi-tenant billing" background=true
grok_execute_plan latest=true dryRun=true
grok_workflow action=list
grok_review base=main focus="auth, data loss, and race conditions"
grok_rescue prompt="investigate why npm test is failing" background=true
grok_babysit action=list
grok_document type=pdf prompt="one-pager for the launch"
grok_sessions action=list
grok_status
grok_result jobId="plan-abc123"
grok_image aspect="16:9" prompt="Dark developer-tool launch banner"
grok_video image="./.grok-media/image/hero.png" duration="6" prompt="gentle camera push-in"
```

### Workspace selection

Codex starts an installed plugin MCP server from the plugin cache, so pass the active project
directory as `cwd` when calling a Grok tool from an installed plugin. The companion then runs in
that directory and keeps jobs, git inspection, and artifacts scoped to the intended workspace.

For direct local calls, use for example:

```text
grok_review cwd="/path/to/project" base=main
grok_status cwd="/path/to/project" json=true
```

## Depth pipeline

For multi-PR or ambiguous product work, prefer:

1. **`grok_plan`** — explore + harvest `plan.md`
2. **`grok_design`** — design doc + PR plan under `.grok-designs/`
3. **`grok_execute_plan`** with `latest=true` — implement the PR DAG
4. **`grok_review`** / **`grok_babysit`** — quality and CI loop

## Job control semantics

- **Concurrent multi-job support** — no single-job global lock. Prefer `background=true` for long work.
- **Status** — live progress is a tail of accumulated text *and* thought streams; empty/whitespace-only stream tokens floor to `running`.
- **Result** — plan jobs prefer harvested `plan.md` body over narration; finished jobs persist `config`, `usage`, and `artifacts` (v3 schema).
- **Reaper** — dead pid + complete parseable `result.json` reconciles to completed; dead pid + empty/truncated/incomplete result → terminal **failed** with distinct diagnostics (no forever-`running` zombies).
- **Atomic writes** — background workers write `result.json` via tmp + rename (no partial mid-write; no leftover `.tmp.*` after success).
- **PR post-pending** — runs on background completion too; skips empty findings; empty/oversize diffs fail closed with recoverable findings under `.grok-reviews/`.

## CLI posture

- Prefer **denylist** (`--disallowed-tools`) over tools allowlist.
- Media: no yolo / no tools allowlist.
- `dryRun` / `validateOnly` / babysit `list`: **read-only** (no yolo).
- `fast`, `default`, `deep`, and `grok` aliases defer to the installed CLI's configured default model instead of pinning a model id that can expire. `deep` also selects `high` effort.
- Explicit model ids pass through unchanged. Discover current ids with `grok models`.
- Explicit effort ids pass through unchanged to the installed CLI for validation. CLI 1.0.24 accepts `low`, `medium`, and `high`; do not promise `xhigh` or silently substitute another level.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `GROK_BINARY` | Override path to the `grok` CLI (also used by tests with a mock binary) |
| `GROK_CODEX_PLUGIN_STATE` | Explicit job-state root for this plugin |
| `CODEX_PLUGIN_DATA` | Host plugin data dir; trusted only when basename is `grok` / `grok-*` |

Default state root when unset: `~/.grok/codex-plugin/state/`. Codex does **not** share Claude’s `~/.grok/claude-plugin/state` or `GROK_CLAUDE_PLUGIN_STATE`.

## Usage notes

### Rescue

- Write-capable by default.
- Use `readOnly=true` for investigation-only work.
- Use `check=true` to require focused verification before Grok returns.
- For isolation, create a Git worktree first and pass that directory as `cwd`; Grok CLI 1.0.5 does not create worktrees in headless mode.
- Grok CLI 1.0.5 does not support `bestOfN`; run separate isolated jobs explicitly when multiple attempts are needed.
- Full control surface available (sandbox, memory, agent, allow/deny, maxTurns, …).

### Plan / design / execute

- Plan mode harvests into `.grok-plans/`; result body prefers the plan file.
- Design harvests into `.grok-designs/`.
- `grok_execute_plan` with `latest=true` picks the newest design doc; `dryRun=true` is read-only.

### Review

- Read-only; never applies patches.
- `postPending=true` with a PR posts PENDING GitHub review comments when findings exist.

### Media

- Default outputs land under `.grok-media/image/` and `.grok-media/video/`.
- Session media is copied into those dirs when Grok leaves files in its session workspace.

### Jobs

- Background tools return a job id.
- Use `grok_status` / `grok_result` / `grok_cancel` with that id when multiple jobs are active.

## Development

```bash
npm test
node plugins/grok/scripts/grok-companion.mjs setup --json
node plugins/grok/mcp/server.mjs   # stdio NDJSON MCP server
```

## Versioning

Root `package.json`, `plugins/grok/.codex-plugin/plugin.json`, and `.agents/plugins/marketplace.json` (metadata + plugin entry) share the same version string. Bump them together.

## License

Apache-2.0
