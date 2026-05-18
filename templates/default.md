Read AGENTS.md and follow it exactly. Examine the repository before editing so you understand the current implementation, test state, and assignment requirements.

Work on `{{testStage}}`. Get `{{testCommand}}` to fully pass before returning, while preserving behavior for earlier stages.

## Current State

{{currentState}}

Prefer efficient, shared implementation. Keep file sizes reasonable, put reusable code in `dev/src/`, and avoid copying logic between assignments.

Do not use shortcuts, test-specific hacks, or superficial workarounds. Fix the underlying issue in the implementation, and preserve the intended architecture.

Treat file-size, audit, and architecture requirements as real design
requirements, not merely script output. Do not work around them by moving
implementation into unchecked extensions or paths, include fragments,
macro-mediated includes, generated blobs, or by weakening checks. If current
work exposes a pre-existing violation or audit blind spot, fix it as part of
the current work before returning.

After the required stage passes, write `{{testStage}}/retro.md` with a concise retrospective: what was difficult, what was surprising, and any suggested updates to the assignment text, tests, or scaffolding. Commit the retrospective with the completed stage work.

Make cohesive progress commits as you go. Before returning, do a cleanup pass for duplicated or oversized code, remove unnecessary duplication, rerun the relevant tests, commit intended changes, and leave `git status --short` empty.
