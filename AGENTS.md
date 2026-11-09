# AGENTS.md

## Workspace
- Use pnpm only. Do not use npm or yarn. Run package commands with `pnpm --filter <pkg> <cmd>`.
- Run `pnpm typecheck && pnpm test` before every commit.
- Do not modify generated files (`dist/`, etc.). Do not commit `.env` or secrets.
- Share dependencies only across `packages/*`. Do not introduce reverse dependencies.

## TypeScript (Hard Rules)
- `tsconfig.base.json` enables `strict` and `noUncheckedIndexedAccess`. Do not relax these compiler options.
- Do not use `any`. Use `unknown` and narrow types explicitly.
- Do not use non-null assertions (`!`). Use `?.`, `??`, or type guards.
- Declare optional properties as `apiKeyEnv?: string`, not `: string | undefined`.
- Mark DTO and value-object properties `readonly`. Compare values with explicit `equals()`.
- Never crash the process. Wrap critical paths in `try/catch` and return errors via discriminated unions where applicable.

## Hot-Path Performance
- Concatenate large strings with `push()` + `join('')`. Do not use `+` or `+=` inside loops.
- Pre-allocate arrays when the length is known (`new Array(n)` or `Array.from({ length })`). Avoid blind `push` growth in hot loops.
- Freeze constant and configuration objects with `Object.freeze()`.

## Generality & Model/Benchmark Agnosticism (Hard Rules)
- Never hardcode logic, regular expressions, heuristics, or format hacks for specific benchmarks, datasets, document titles, or models.
- Keep all algorithms, chunking, cache optimizations, protocol parsers, and sub-agent schedulers 100% model-agnostic and benchmark-agnostic.

## Code Hygiene
- Enforce strict DRY. Search for existing implementations before writing any function or abstraction; reuse or merge similar code immediately.
- Leave no dead code. Delete unused imports, exports, dependencies, and files immediately.
- Keep comments minimal. Write all comments, prompts, and directives in ASD-STE100 Simplified Technical English (short sentences, active voice, one idea per sentence).
- Ask before adding any third-party dependency.
