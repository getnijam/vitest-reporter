# @nijam/vitest-reporter, Claude instructions

Vitest reporter for **Nijam**. A reporter object Vitest constructs and calls; it captures
a run and ships it to the Nijam API. Sibling of `@nijam/pw-reporter` and `pytest-nijam`,
reporting into the **same** ingestion endpoints (`/v1/runs`, `…/executions`, `…/source`,
`PATCH /v1/runs/:id`).

**Public-facing artifact**, installed via `npm`, read on GitHub, pasted into users'
`vitest.config.ts`. Code quality, **zero runtime dependencies**, and a runnable README
matter most here. License: **MIT** (separate from the BSL platform).

> Independent repo (`getnijam/vitest-reporter`), not a monorepo. Shares the API wire
> format with the other reporters; the client/ci/buffer/log modules are deliberately
> kept identical to pw-reporter's so a fix in one can be ported to the others.

## The one big difference from pw-reporter
**Vitest has no traces.** No artifact upload path (no trace/screenshot/video). We capture
error log (`result.errors`), failing line (`task.location.line`, only when the user sets
`includeTaskLocation: true`), duration, retries, run stats, and opt-in test source.

## Stack (locked, ask before changing the public option shape)
- TypeScript, strict, `noUncheckedIndexedAccess`.
- **Zero runtime dependencies.** Peer dep: `vitest` (>=1.0). HTTP: native `fetch` only.
- Build: `tsup` → dual ESM/CJS + `.d.ts` (`target: node18`).
- Manual testing only, no automated suite in v0.1.

## Layout
```
src/
  reporter.ts   # NijamReporter (default export), Vitest reporter object
  client.ts     # NijamClient, HTTP to the API (native fetch); identical to pw-reporter
  ci.ts         # detectRunContext, CI/git metadata; identical to pw-reporter
  buffer.ts     # ExecutionBuffer, batch + flush; identical to pw-reporter
  types.ts      # NijamReporterOptions + payload shapes (no ArtifactKind)
  log.ts        # [nijam]-prefixed warn/info; identical to pw-reporter
  index.ts      # public entry, re-exports the reporter + types
```

## Public API (design backward from this)
```ts
import NijamReporter from '@nijam/vitest-reporter';
// vitest.config.ts → test.reporters: ['default', new NijamReporter({ apiKey, projectId, … })]
```
Options: `apiKey` (req), `projectId` (req), `apiUrl?`, `silent?`, `environment?`,
`uploadSource?` (default true), `autoComplete?` (default true). `NIJAM_API_KEY` /
`NIJAM_API_URL` / `NIJAM_AUTO_COMPLETE` env overrides. Missing key/project → warn + disable.

## Lifecycle & behavior
- Vitest **duck-types** reporters (no interface to implement) and its exact type exports
  move across majors, so `reporter.ts` models only the task-tree fields it reads (local
  structural types), no hard `vitest` type import. Keeps it working on Vitest 1/2/3.
- `onInit(ctx)` → read `ctx.config.root`, detect CI/git, `POST /v1/runs`, store `runId`;
  on failure log + no-op the run.
- `onFinished(files, errors)` → walk the file tree into a flat list of tests (recurse
  `type==='suite'`, collect `type==='test'|'custom'`), build one execution per test, drain
  the buffer, upload sources, then `PATCH /v1/runs/:id` to finalize (unless `autoComplete`
  off). Run is failed if any test failed or Vitest reported top-level errors.
- **Field mapping**: `testId`=`task.id`, `title`=`task.name`, `titlePath`=suite ancestry +
  name, `file`=git-root-relative of the file's `filepath`, `line`=`task.location.line`,
  `errorMessage`=`result.errors[0].stack||.message`, `durationMs`=`result.duration`,
  `retry`=`result.retryCount`. Status: pass→passed, fail→failed, skip/todo→skipped.
  Flaky = passed with `retryCount > 0`.
- **HTTP**: Bearer `apiKey`, 30s `AbortController` timeout, no retries, `log.warn` on error.

## Guard rails, do NOT
- ❌ **Throw from a reporter hook**, wrap every async block in try/catch, `log.warn`,
  continue. The reporter MUST NOT break a user's CI. Ever.
- ❌ **Dynamically `import()`**, static top-level imports only.
- ❌ Add runtime dependencies (zero-dep) · pull `vitest` as a regular dep (peer only).
- ❌ Add a trace/artifact upload path, Vitest has no traces.
- ❌ Import Vitest's concrete `Reporter`/task types (version-fragile), keep the local
  structural types in `reporter.ts`.
- ❌ Change `NijamReporterOptions` shape or the API wire format without asking.
- ❌ Ternary hell / IIFEs, lookup objects, early returns, named functions.
- ❌ Let `client.ts`/`ci.ts`/`buffer.ts`/`log.ts` drift from pw-reporter without reason,
  port fixes across the reporters.
- ❌ **Em dashes (U+2014) or en dashes (U+2013) anywhere, never generate one.** Not in CLI/log output, error strings, the README, or code/comments. Use a comma, colon, parentheses, or two sentences for prose; a plain hyphen-minus for ranges, IDs, and compound words. The published package must contain zero em/en dashes.

## Build & publish
- `npm install` · `npm run build` (tsup) · `npm run typecheck` · `npm run dev` (watch).
- Versions: `0.1.0-alpha.N` until launch, then `0.1.0`; semver after. Smoke-test by
  `npm link` into a sample Vitest project and watching behavior.
