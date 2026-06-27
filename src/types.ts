/** Options passed from the user's vitest.config.ts (constructor arg). */
export type NijamReporterOptions = {
  /** Required, API key from the Nijam dashboard. */
  apiKey: string;
  /** Required, the project's ID (UUID) from the Nijam dashboard. */
  projectId: string;
  /** Optional, defaults to https://api.nijam.dev */
  apiUrl?: string;
  /** Optional, suppress [nijam] log lines (default: false). */
  silent?: boolean;
  /** Optional, free-form environment tag (e.g. "staging"). */
  environment?: string;
  /**
   * Optional, upload each test file's source so the dashboard can show it in the
   * test detail. **On by default**; set `false` to opt out (this ships your test
   * source to Nijam).
   */
  uploadSource?: boolean;
  /**
   * Optional, whether the reporter finalizes the run when the test process ends
   * (**default `true`**). Set `false` when you fan tests across multiple CI jobs that
   * all club into one Nijam run (shared CI run id), so a single post-matrix step marks
   * the run complete. Also settable via the `NIJAM_AUTO_COMPLETE=false` env var.
   */
  autoComplete?: boolean;
};

/** CI / git metadata detected from the environment. */
export type RunContext = {
  commitSha?: string;
  branch?: string;
  prNumber?: string;
  ciProvider?: string;
  /** CI run attempt (e.g. GITHUB_RUN_ATTEMPT), re-runs get a fresh Nijam run. */
  ciRunAttempt?: string;
  ciRunId?: string;
  ciRunUrl?: string;
  repository?: string;
  authorEmail?: string;
  authorName?: string;
};

/** Payload sent to POST /v1/runs to open a run. */
export type CreateRunPayload = RunContext & {
  projectId: string;
  environment?: string;
  startedAt: string;
};

/**
 * Vitest reports pass/fail/skip/todo. We map todo → skipped, and a missing result
 * (e.g. a test that never ran) → skipped. There are no traces, so no artifact kinds.
 */
export type ExecutionStatus = 'passed' | 'failed' | 'skipped' | 'interrupted';

/** A single test execution, buffered and flushed in batches. */
export type TestExecutionPayload = {
  /** Client-generated id (PK), mirrors the Playwright reporter. */
  id: string;
  testId: string;
  title: string;
  titlePath: string[];
  file: string;
  projectName?: string;
  status: ExecutionStatus;
  durationMs: number;
  retry: number;
  errorMessage?: string;
  /** 1-based source line of the test (requires `includeTaskLocation: true` in vitest). */
  line?: number;
  startedAt: string;
};

/** Payload sent to PATCH /v1/runs/:id to finalize. */
export type FinalizeRunPayload = {
  status: 'passed' | 'failed' | 'timedout' | 'interrupted';
  finishedAt: string;
  stats: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    flaky: number;
  };
};
