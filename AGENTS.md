# Repository Guidelines

Canonical agent/contributor guidance for this repository lives in [CLAUDE.md](CLAUDE.md) —
project structure, build/test/lint commands, code style, testing safety rules
(never run the full suite inside a managed tmux session), security notes, and
the deployment workflow are all maintained there. Please read it before making
changes, and keep it the single source of truth rather than duplicating
sections here.

Quick pointers:

- Type check: `tsc --noEmit` · Lint: `npm run lint` · Format: `npm run format:check`
- Tests: `npm test` (the CI gate, safe to run bare) or `npm test -- test/<file>.test.ts` for one file
- Route tests use `app.inject()`; new tests needing ports must pick a unique `const PORT =`
- Branch off `master` for all work; Conventional Commit-style messages (`fix(mobile): ...`)
- Never commit secrets or local state from `~/.codeman/`

## Codexless Pipeline

Read [`skills/codexless-pipeline/SKILL.md`](skills/codexless-pipeline/SKILL.md)
before changing the external integration registry, webhook, SSE projections, or
External Jobs panel. Keep Codexless jobs separate from native Codeman sessions;
the integration is an authenticated, durable projection channel, not a generic
event broadcast mechanism.
