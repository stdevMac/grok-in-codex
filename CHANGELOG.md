# Changelog

## Unreleased

### Fixed
- **Grok CLI model compatibility**: model aliases now defer to the installed CLI's configured default instead of pinning removed model ids. Setup reports the current default and available models.
- **Effort compatibility**: explicit effort ids are validated by the installed CLI rather than a stale plugin allowlist; legacy `max` still maps to `xhigh`.

## 0.5.8

### Fixed
- **MCP workspace scoping**: every tool accepts `cwd` so installed-plugin MCP calls run against the active project (not the plugin cache). Companion spawn uses that directory for jobs, git, and artifacts.

### Notes
- Behavioral parity with grok-in-claude **v0.5.7** retained; this release is Codex-host-specific.


## 0.5.7

### Fixed
- **Live progress floor**: whitespace-only stream tokens no longer blank status; helper returns empty until real content, call sites use `|| "running"`.

### Parity
- Feature parity with [grok-in-claude](https://github.com/stdevMac/grok-in-claude) v0.5.7 mapped to Codex MCP tools + skills.

## 0.5.6

### Fixed
- **Progress helper coverage**: embed `formatStreamProgressMessage` source into the background worker (no drifted copy); tests assert against the embedded string.
- **Version lockstep**: marketplace metadata + plugin entry share package/plugin version.

## 0.5.5

### Fixed
- **Live progress (thinking)**: status tails accumulated `thought` stream events the same way as text.

## 0.5.4

### Fixed
- **Zombie background jobs**: `hasResultFile` requires a complete parseable `result.json` (not mere exists); corrupt/truncated files fail cleanly instead of staying `running` forever.
- **Atomic result write**: background wrapper writes via tmp + `renameSync` so partial files never appear as complete.
- **Live progress**: status message uses a tail of accumulated text, not only the last streamed token.

## 0.5.3

### Fixed
- **Background result race**: do not reaper-fail when complete `result.json` exists; reconcile false-failed jobs on status/result so plan.md is harvested.
- **Plan result text**: apply `preferPlanArtifactText` on all plan result render paths.
- **Session path keys**: try `/var` and `/private/var` encodings when locating session artifacts (macOS).
- **Plugin data trust**: only trust this plugin’s data dirs / `GROK_CODEX_PLUGIN_STATE` / `~/.grok/codex-plugin/state` (reject foreign host plugin dirs).

## 0.5.2

### Fixed
- **expandArgv** + array options (`--allow` / `--deny`) for control surface parsing.
- **`--dry-run` / `--validate-only`**: no longer grant `--yolo` (read-only tool posture).
- **babysit list**: read-only (no yolo); add/check/remove remain write-capable.
- **status log tail**: truncates multi-KB NDJSON `available_commands` lines.

## 0.5.1

### Added
- Design / workflow / plan / document artifact harvest helpers.
- `execute-plan --latest` resolves newest design under `.grok-designs/`.
- Post-pending policy: skip empty findings; empty/oversize diff guards; recoverable findings under `.grok-reviews/`.
- Status/result show usage and artifact paths.
- Mock Grok binary finish-path tests (`tests/helpers/mock-grok.mjs`).
- Routing skill: plan → design → execute-plan depth pipeline.

### Improved
- Stop-gate / setup min CLI version floor (`0.2.118`), denylist posture.
- README documents artifact dirs, control flags, and state env.

## 0.5.0

### Added (depth surface + reliability)
- MCP tools: `grok_plan`, `grok_workflow`, `grok_design`, `grok_execute_plan`, `grok_babysit`, `grok_document`, `grok_sessions`.
- Control surface on long-running jobs: sandbox, plan/permission-mode, agent, no-subagents, memory, allow/deny, disable-web-search, fork-session, max-turns.
- Job schema v3: `config`, `usage`, `artifacts` on finished jobs.
- Background review post-pending finalize path.
- Reliability: complete-result reaper, atomic result write, stream progress accumulate, plan text preference.

## 0.1.0

### Added
- Initial Codex MCP plugin: setup, rescue, review, adversarial review, image, video, status, result, cancel, transfer.
