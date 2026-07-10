# @nijam/vitest-reporter

Vitest reporter for [Nijam](https://nijam.dev), captures your test runs and ships them
to the Nijam dashboard so you can track what failed, why, and where (error log + failing
line), across CI runs and over time.

> Vitest has no Playwright-style traces, so runs won't include a trace viewer.
> Everything else (failures, error output, the failing line, durations, retries, and your
> test source) is captured.

## Install

```bash
npm install -D @nijam/vitest-reporter
```

## Configure

Add the reporter to your `vitest.config.ts`. Pass the API key via an environment variable
(it's a secret, keep it out of source control):

```ts
import { defineConfig } from 'vitest/config';
import NijamReporter from '@nijam/vitest-reporter';

export default defineConfig({
  test: {
    // Keep 'default' so you still get Vitest's console output.
    reporters: [
      'default',
      new NijamReporter({
        apiKey: process.env.NIJAM_API_KEY, // required
        projectId: '<project-uuid>', // required, from the dashboard
      }),
    ],
    // Capture the failing line for each test (off by default in Vitest).
    includeTaskLocation: true,
  },
});
```

```bash
export NIJAM_API_KEY="nij_sk_…"   # from the Nijam dashboard → Secret keys
npx vitest run
```

## Options

| option         | type    | default                 | what it does                                                   |
| -------------- | ------- | ----------------------- | ------------------------------------------------------------- |
| `apiKey`       | string  |,                       | Ingest API key (required).                                     |
| `projectId`    | string  |,                       | Project UUID (required).                                       |
| `apiUrl`       | string  | `https://api.nijam.dev` | API base URL.                                                  |
| `environment`  | string  |,                       | Free-form environment tag (e.g. `staging`).                   |
| `uploadSource` | boolean | `true`                  | Upload each test file's source so the dashboard can show it.   |
| `autoComplete` | boolean | `true`                  | Finalize the run when the process ends. `false` for fan-out.   |
| `silent`       | boolean | `false`                 | Suppress `[nijam]` log lines.                                  |

`apiKey` and `apiUrl` also read from `NIJAM_API_KEY` / `NIJAM_API_URL`; `autoComplete` is
forced off by `NIJAM_AUTO_COMPLETE=false`.

If `apiKey` or `projectId` is missing, the reporter disables itself with one warning -
your tests run exactly as before.

> **Failing line:** Vitest only records each test's source location when
> `test.includeTaskLocation` is `true`. Enable it (as above) so the dashboard can show
> and link the failing line.

## CI metadata

Run context (commit, branch, PR number, CI provider/run URL, commit author) is detected
automatically from GitHub Actions, GitLab CI, CircleCI, Bitbucket Pipelines, or generic
`GIT_*` env vars, falling back to `git`. No configuration needed.

## Sharding

Running `vitest --shard=<i>/<N>` works out of the box. The reporter reads Vitest's
`config.shard`, and every shard of the same CI run **clubs into one Nijam run**: each
test execution is tagged with the 1-based **shard index** it ran on (`i` of `N`), and the
run finalizes only once all `N` shards have reported. Nothing to configure.

```yaml
# GitHub Actions
strategy:
  matrix:
    shard: [1, 2, 3, 4]
steps:
  - run: npx vitest run --shard=${{ matrix.shard }}/4
```

All shards must share the same CI run id (automatic on CI) so they club together.

Splitting test **files** across CI jobs _without_ `--shard`? Vitest reports no shard info
then, so the run's total is unknown up front: set `autoComplete: false` (or
`NIJAM_AUTO_COMPLETE=false`) on every job so none finalizes early, then finalize once from
a single post-matrix step. Unlike the Playwright reporter, this reporter has no
`NIJAM_SHARD_INDEX` / `NIJAM_SHARD_TOTAL` override, it detects only native `--shard`.

## Guarantees

This reporter **never breaks your test run.** Every hook is fail-soft: a network error, a
bad key, or an unreachable API produces a `[nijam]` warning and nothing more.

## License

MIT
