# CLAUDE.md

Notes for AI assistants and human maintainers working in this repo.

## Test runner: `bun test`, not vitest

The `package.json` `test` script runs `bun test`. Do not switch back to `vitest run` without a plan: vitest 4's worker pool runs on Node, where `Bun.serve` is undefined. The mobile-review HTTP surface (`src/review-server.ts`) and any future Bun-native runtime code rely on Bun globals at runtime — those tests will silently fail or break in confusing ways under vitest. `bun test` is API-compatible with vitest's `describe` / `it` / `expect` / `beforeEach` / `afterEach`, so existing tests run unchanged.

If you have a reason to switch back, first port the Bun-specific runtime to `node:http` or arrange for vitest to spawn workers under bun (no first-class option in vitest 4 as of 2026-04).
