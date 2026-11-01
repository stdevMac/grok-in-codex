---
name: grok-prompting
description: Internal guidance for composing clear Grok task prompts from Codex rescue handoffs
user-invocable: false
---

# Grok prompting

Reshape a rescue request into a tighter prompt before the single `task` call.

## Shape

1. **Goal** — one sentence
2. **Context** — what failed / what matters
3. **Constraints** — no drive-by refactors, test expectations, worktree if requested
4. **Done when** — measurable checks (ask for verification in the prompt)

## Do

- Preserve file names, errors, and commands the user mentioned
- Ask for verification via tests/build when fixing bugs
- Keep it short

## Do not

- Inspect the repo yourself
- Invent stack traces
- Solve the problem in the prompt
- Embed model/effort/resume flags in the natural-language body
