#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { NijamClient } from './client.js';
import { detectRunContext } from './ci.js';
import type { FailedTest } from './types.js';

/**
 * `nijam-vitest` CLI. The one subcommand, `fetch-failed`, asks the Nijam API which
 * tests failed in the previous run of this CI run and prints the failing spec FILES,
 * plus (via --export-env) a NIJAM_TEST_NAME_PATTERN regex of the failing test names,
 * so a retry runs ONLY the failures (Vitest has no run-by-line, so it filters by file
 * + test-name pattern):
 *
 *   nijam-vitest fetch-failed --output failed.txt --export-env "$GITHUB_ENV"
 *   [ -s failed.txt ] && npx vitest run $(cat failed.txt) -t "$NIJAM_TEST_NAME_PATTERN"
 *
 * --export-env also writes NIJAM_RUN_GROUP / NIJAM_RUN_ATTEMPT / NIJAM_RERUN so the
 * retry's reporter run clubs under the original run in the dashboard.
 *
 * Like the reporter it stays CI-safe: a fetch failure emits nothing + exits 0 (the
 * caller's `[ -s failed.txt ]` guard runs the full suite), only bad usage exits non-zero.
 */

const HELP = `nijam-vitest, Nijam Vitest helper

Usage:
  nijam-vitest fetch-failed [options]

Fetch the previous run's failed tests so a retry runs only those. Prints the failing
spec files; pair with NIJAM_TEST_NAME_PATTERN (via --export-env) for exact filtering:
  npx vitest run $(cat failed.txt) -t "$NIJAM_TEST_NAME_PATTERN"

Options:
  -o, --output <file>     Write the failing spec files to <file> (default: stdout)
      --export-env <file> Append NIJAM_RUN_GROUP/ATTEMPT/RERUN + NIJAM_TEST_NAME_PATTERN
                          as KEY=value lines (use "$GITHUB_ENV" on GitHub Actions)
      --project <uuid>    Project id (default: $NIJAM_PROJECT_ID)
      --ci-run-id <id>    The original CI run id to pull failures from
                          (default: auto-detected; set on CIs that mint a new id on retry)
      --api-url <url>     API base URL (default: $NIJAM_API_URL or https://api.nijam.dev)
      --api-key <key>     Ingest key (default: $NIJAM_API_KEY)
  -h, --help              Show this help

Env: NIJAM_API_KEY, NIJAM_PROJECT_ID, NIJAM_API_URL
Docs: https://docs.nijam.dev/guides/rerun-failed-tests/`;

interface Flags {
  output?: string;
  exportEnv?: string;
  project?: string;
  ciRunId?: string;
  apiUrl?: string;
  apiKey?: string;
  help?: boolean;
}

type StringFlag = 'output' | 'exportEnv' | 'project' | 'ciRunId' | 'apiUrl' | 'apiKey';

const FLAG_ALIASES: Record<string, StringFlag> = {
  '-o': 'output',
  '--output': 'output',
  '--export-env': 'exportEnv',
  '--project': 'project',
  '--ci-run-id': 'ciRunId',
  '--api-url': 'apiUrl',
  '--api-key': 'apiKey',
};

function out(text: string): void {
  process.stdout.write(text);
}

function err(message: string): void {
  process.stderr.write(`[nijam] ${message}\n`);
}

function parseArgs(argv: string[]): { command?: string; flags: Flags } {
  const flags: Flags = {};
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-h' || arg === '--help') {
      flags.help = true;
    } else if (arg.startsWith('-')) {
      const key = FLAG_ALIASES[arg];
      if (!key) throw new Error(`unknown option: ${arg}`);
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      flags[key] = value;
    } else if (!command) {
      command = arg;
    }
  }
  return { command, flags };
}

/** Escape a test title for safe inclusion in the Vitest -t regex. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build a `-t` regex matching any of the failing tests' names. */
function testNamePattern(tests: FailedTest[]): string {
  const titles = [...new Set(tests.map((t) => t.title))].map(escapeRegex);
  return titles.length ? `(${titles.join('|')})` : '';
}

async function fetchFailed(flags: Flags): Promise<number> {
  const apiKey = flags.apiKey ?? process.env.NIJAM_API_KEY;
  const projectId = flags.project ?? process.env.NIJAM_PROJECT_ID;
  if (!apiKey || !projectId) {
    err(`missing ${!apiKey ? 'API key (NIJAM_API_KEY)' : 'project id (NIJAM_PROJECT_ID)'}`);
    return 2;
  }

  const ctx = detectRunContext();
  const ciRunId = flags.ciRunId ?? ctx.ciRunId;
  if (!ciRunId) {
    err('no CI run id detected; pass --ci-run-id to fetch failures. Running nothing to re-run.');
    if (flags.output) writeFileSync(flags.output, '');
    return 0;
  }

  const client = new NijamClient(apiKey, flags.apiUrl ?? process.env.NIJAM_API_URL);
  const result = await client.fetchFailedTests(projectId, ciRunId);
  const tests = result?.tests ?? [];

  // Vitest filters by file (positional) + test-name pattern; emit the files here.
  const files = [...new Set(tests.map((t) => t.file))];
  const body = files.length ? files.join('\n') + '\n' : '';
  if (flags.output) writeFileSync(flags.output, body);
  else out(body);

  if (flags.exportEnv) {
    const nativeAttempt = ctx.ciRunAttempt ? Number.parseInt(ctx.ciRunAttempt, 10) || 0 : 0;
    const nextAttempt = Math.max((result?.attempt ?? 0) + 1, nativeAttempt || 1);
    appendFileSync(
      flags.exportEnv,
      `NIJAM_RUN_GROUP=${ciRunId}\nNIJAM_RUN_ATTEMPT=${nextAttempt}\nNIJAM_RERUN=1\n` +
        `NIJAM_TEST_NAME_PATTERN=${testNamePattern(tests)}\n`,
    );
  }

  err(
    files.length
      ? `${tests.length} failed test(s) in ${files.length} file(s); feed them to vitest run`
      : 'no failed tests from the previous run; nothing to re-run',
  );
  return 0;
}

async function main(): Promise<void> {
  let parsed: { command?: string; flags: Flags };
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    out(`${HELP}\n`);
    process.exit(2);
  }

  if (parsed.flags.help || !parsed.command) {
    out(`${HELP}\n`);
    process.exit(0);
  }

  if (parsed.command === 'fetch-failed') {
    process.exit(await fetchFailed(parsed.flags));
  }

  err(`unknown command: ${parsed.command}`);
  out(`${HELP}\n`);
  process.exit(2);
}

void main();
