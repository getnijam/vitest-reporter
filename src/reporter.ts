import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';
import { readFile } from 'node:fs/promises';
import { NijamClient } from './client.js';
import { ExecutionBuffer } from './buffer.js';
import { detectRunContext, detectGitRoot } from './ci.js';
import { log, setSilent } from './log.js';
import type {
  ExecutionStatus,
  FinalizeRunPayload,
  NijamReporterOptions,
  TestExecutionPayload,
} from './types.js';

const SETUP_DOCS = 'https://docs.nijam.dev/reporter/vitest/';

/**
 * Minimal structural types for the bits of Vitest we read. Vitest duck-types reporter
 * objects (no named interface to implement) and its concrete types move between major
 * versions, so we model only what we use — keeping this compatible across Vitest 1–4.
 *
 * Two task representations exist:
 *  - **legacy task tree** (Vitest 1–2): `onFinished(files)` with nested `.tasks`.
 *  - **reported tasks API** (Vitest 3–4): `onTestRunEnd(testModules)` with `TestCase`s.
 * We support both and guard against double-submission with `this.finished`.
 */
interface CommonResult {
  errors?: Array<{ message?: string; stack?: string }>;
}

// ---- legacy task tree (Vitest 1–2) ----
interface LegacyResult extends CommonResult {
  state?: string;
  duration?: number;
  retryCount?: number;
  startTime?: number;
}
interface LegacyTask {
  id: string;
  type?: string;
  name: string;
  result?: LegacyResult;
  location?: { line?: number };
  tasks?: LegacyTask[];
  projectName?: string;
}
interface LegacyFile extends LegacyTask {
  filepath: string;
}

// ---- reported tasks API (Vitest 3–4) ----
interface ReportedParent {
  type?: string;
  name?: string;
  parent?: ReportedParent;
}
interface ReportedCase {
  id: string;
  name: string;
  location?: { line?: number };
  parent?: ReportedParent;
  project?: { name?: string };
  result(): { state?: string } & CommonResult;
  diagnostic(): { duration?: number; startTime?: number; retryCount?: number } | undefined;
}
interface ReportedModule {
  moduleId: string;
  children: { allTests(): Iterable<ReportedCase> };
}

interface VitestContext {
  config?: { root?: string };
}

/** Framework-neutral test record both extraction paths normalize into. */
interface NormalizedTest {
  testId: string;
  title: string;
  titlePath: string[];
  filepath: string;
  status: ExecutionStatus;
  durationMs: number;
  retry: number;
  errorMessage?: string;
  line?: number;
  /** ms epoch when the test started, if Vitest reported it. */
  startTime?: number;
  projectName?: string;
}

/**
 * Nijam Vitest reporter. Captures runs and ships them to the Nijam API.
 *
 * Golden rule (shared with the Playwright reporter): NEVER throw from a reporter
 * hook. Every async block is wrapped in try/catch; on failure we log via [nijam] and
 * continue (or no-op the run). Vitest has no traces, so there is no artifact upload.
 */
export default class NijamReporter {
  private readonly options: NijamReporterOptions;
  private disabled = false;
  private finished = false;
  private runId: string | null = null;
  private runUrl: string | null = null;
  private startedAt = new Date().toISOString();
  private rootDir = '';
  private gitRoot = '';
  private readonly sourceFiles = new Map<string, string>();
  private readonly uploadSource: boolean;
  private readonly autoComplete: boolean;

  private client!: NijamClient;
  private buffer!: ExecutionBuffer;

  constructor(options: NijamReporterOptions) {
    // Clone — never mutate the input options object Vitest owns.
    this.options = { ...options };
    setSilent(this.options.silent ?? false);
    this.uploadSource = this.options.uploadSource !== false;
    const envAutoCompleteOff = ['false', '0', 'no', 'off'].includes(
      (process.env.NIJAM_AUTO_COMPLETE ?? '').trim().toLowerCase(),
    );
    this.autoComplete = this.options.autoComplete ?? !envAutoCompleteOff;

    if (!this.options.apiKey || !this.options.projectId) {
      log.warn(
        `missing ${!this.options.apiKey ? 'apiKey' : 'projectId'} — reporter disabled. See ${SETUP_DOCS}`,
      );
      this.disabled = true;
      return;
    }

    this.client = new NijamClient(this.options.apiKey, this.options.apiUrl);
    this.buffer = new ExecutionBuffer((batch) => this.flushBatch(batch));
  }

  /** Vitest calls this once at startup with the Vitest instance. */
  async onInit(ctx: VitestContext): Promise<void> {
    if (this.disabled) return;
    try {
      this.rootDir = ctx.config?.root ?? process.cwd();
      this.gitRoot = detectGitRoot() ?? '';
      const context = detectRunContext(this.options);
      this.startedAt = new Date().toISOString();
      const created = await this.client.createRun({
        ...context,
        projectId: this.options.projectId,
        environment: this.options.environment,
        startedAt: this.startedAt,
      });
      if (!created) {
        this.disabled = true;
        log.warn('could not create run; reporting disabled for this run');
        return;
      }
      this.runId = created.id;
      this.runUrl = created.url ?? null;
      log.info(
        this.runUrl ? `run started — view it at ${this.runUrl}` : `run started (${created.id})`,
      );
    } catch (err) {
      this.disabled = true;
      log.warn(`onInit failed: ${describe(err)}`);
    }
  }

  /** Vitest 3–4: final hook with the reported-tasks API. */
  async onTestRunEnd(testModules: ReadonlyArray<ReportedModule> = [], errors: unknown[] = []): Promise<void> {
    if (this.disabled || this.finished || !this.runId) return;
    try {
      const tests = this.collectReported(testModules);
      await this.submit(tests, errors.length > 0);
    } catch (err) {
      log.warn(`onTestRunEnd failed: ${describe(err)}`);
    }
  }

  /** Vitest 1–2: final hook with the legacy task tree. */
  async onFinished(files: LegacyFile[] = [], errors: unknown[] = []): Promise<void> {
    if (this.disabled || this.finished || !this.runId) return;
    try {
      const tests = this.collectLegacy(files);
      await this.submit(tests, errors.length > 0);
    } catch (err) {
      log.warn(`onFinished failed: ${describe(err)}`);
    }
  }

  /** Build payloads from the normalized tests, flush, upload sources, finalize. */
  private async submit(tests: NormalizedTest[], hadTopLevelErrors: boolean): Promise<void> {
    if (!this.runId) return;
    this.finished = true; // guard: v3 may fire both final hooks

    const stats = { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 };
    for (const t of tests) {
      tallyStats(stats, t.status, t.retry);
      const file = relativeFile(t.filepath, this.rootDir, this.gitRoot);
      if (this.uploadSource && t.filepath && !this.sourceFiles.has(file)) {
        this.sourceFiles.set(file, t.filepath);
      }
      const payload: TestExecutionPayload = {
        id: randomUUID(),
        testId: t.testId,
        title: t.title,
        titlePath: t.titlePath,
        file,
        projectName: t.projectName,
        status: t.status,
        durationMs: Math.round(t.durationMs),
        retry: t.retry,
        errorMessage: t.errorMessage,
        line: t.line,
        startedAt: t.startTime ? new Date(t.startTime).toISOString() : this.startedAt,
      };
      this.buffer.add(payload);
    }

    await this.buffer.drain();
    if (this.uploadSource) await this.uploadSources();

    if (!this.autoComplete) {
      log.info('this job done — complete the run via your post-matrix step');
      if (this.runUrl) log.info(`view the run at ${this.runUrl}`);
      return;
    }

    const payload: FinalizeRunPayload = {
      status: stats.failed > 0 || hadTopLevelErrors ? 'failed' : 'passed',
      finishedAt: new Date().toISOString(),
      stats,
    };
    await this.client.finalizeRun(this.runId, payload);
    log.info(
      `run finalized (${stats.passed}/${stats.total} passed)${this.runUrl ? ` — view it at ${this.runUrl}` : ''}`,
    );
  }

  private async flushBatch(batch: TestExecutionPayload[]): Promise<void> {
    if (!this.runId) return;
    await this.client.sendExecutions(this.runId, batch);
  }

  /** Vitest 3–4 reported-tasks API → normalized tests. */
  private collectReported(modules: ReadonlyArray<ReportedModule>): NormalizedTest[] {
    const out: NormalizedTest[] = [];
    for (const mod of modules) {
      for (const test of mod.children.allTests()) {
        const result = test.result();
        const diag = test.diagnostic();
        out.push({
          testId: test.id,
          title: test.name,
          titlePath: reportedTitlePath(test),
          filepath: mod.moduleId,
          status: mapState(result.state),
          durationMs: diag?.duration ?? 0,
          retry: diag?.retryCount ?? 0,
          errorMessage: firstError(result),
          line: test.location?.line,
          startTime: diag?.startTime,
          projectName: test.project?.name,
        });
      }
    }
    return out;
  }

  /** Vitest 1–2 legacy task tree → normalized tests. */
  private collectLegacy(files: LegacyFile[]): NormalizedTest[] {
    const out: NormalizedTest[] = [];
    const walk = (tasks: LegacyTask[], filepath: string, ancestors: string[]): void => {
      for (const task of tasks) {
        if (task.type === 'suite' && task.tasks && task.tasks.length > 0) {
          walk(task.tasks, filepath, [...ancestors, task.name]);
        } else if (task.type === 'test' || task.type === 'custom') {
          out.push({
            testId: task.id,
            title: task.name,
            titlePath: [...ancestors, task.name],
            filepath,
            status: mapState(task.result?.state),
            durationMs: task.result?.duration ?? 0,
            retry: task.result?.retryCount ?? 0,
            errorMessage: firstError(task.result),
            line: task.location?.line,
            startTime: task.result?.startTime,
            projectName: task.projectName,
          });
        }
      }
    };
    for (const file of files) {
      walk(file.tasks ?? [], file.filepath, []);
    }
    return out;
  }

  /** Read + upload each unique test file's source (≤4 concurrent; soft-fail). */
  private async uploadSources(): Promise<void> {
    if (!this.runId) return;
    const MAX_BYTES = 256 * 1024;
    const entries = [...this.sourceFiles.entries()];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < entries.length) {
        const [rel, abs] = entries[next++]!;
        try {
          const content = await readFile(abs, 'utf8');
          if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) continue; // skip oversized
          await this.client.uploadSource(this.runId!, rel, content);
        } catch (err) {
          log.warn(`source upload failed for ${rel}: ${describe(err)}`);
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }
}

/** Map either task-state vocabulary (legacy pass/fail/skip/todo, reported *ed/pending). */
function mapState(state?: string): ExecutionStatus {
  if (state === 'pass' || state === 'passed') return 'passed';
  if (state === 'fail' || state === 'failed') return 'failed';
  // skip / skipped / todo / pending / run / only / undefined → skipped
  return 'skipped';
}

/** Suite ancestry of a reported TestCase (excludes the file/module + the test itself). */
function reportedTitlePath(test: ReportedCase): string[] {
  const path: string[] = [];
  let p = test.parent;
  while (p && p.type === 'suite' && p.name) {
    path.unshift(p.name);
    p = p.parent;
  }
  path.push(test.name);
  return path;
}

/** Roll one test's outcome into the run totals (flaky = passed after a retry). */
function tallyStats(
  stats: FinalizeRunPayload['stats'],
  status: ExecutionStatus,
  retry: number,
): void {
  stats.total++;
  if (status === 'failed') {
    stats.failed++;
  } else if (status === 'skipped') {
    stats.skipped++;
  } else {
    stats.passed++;
    if (retry > 0) stats.flaky++;
  }
}

function firstError(result: CommonResult | undefined): string | undefined {
  const err = result?.errors?.[0];
  if (!err) return undefined;
  return err.stack || err.message || undefined;
}

/**
 * Test-file path relative to the git repo root when available, else Vitest's root,
 * normalized to `/`. The repo-root form is what the dashboard's "View source" links
 * need; never an absolute machine path.
 */
function relativeFile(file: string, rootDir: string, gitRoot?: string): string {
  for (const base of [gitRoot, rootDir]) {
    if (!base) continue;
    const rel = relative(base, file);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
      return sep === '/' ? rel : rel.split(sep).join('/');
    }
  }
  return file.split(/[\\/]/).pop() || file;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
