#!/usr/bin/env node
/**
 * hackjudge: run every submission, one sandbox each.
 *
 *   npm run judge -- --input data/sample.csv --executor local --limit 5
 *   SPRITES_TOKEN=... npm run judge -- --input data/sample.csv --executor sprites --concurrency 8
 *   npm run judge -- --cleanup            # delete leftover sprites from earlier runs
 *
 * Input CSV columns: repo,cohort,stage  (header required; extra columns ignored)
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { Executor, RepoResult } from './types.js';
import { LocalExecutor } from './executors/local.js';
import { SpritesExecutor } from './executors/sprites.js';
import { judgeOne, defaultPipelineOptions } from './pipeline.js';
import { Reporter, printSummary } from './report.js';

interface Row { repo: string; cohort: string; stage: string }

function parseCsv(text: string): Row[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const iRepo = idx('repo');
  if (iRepo === -1) throw new Error('input CSV needs a "repo" column');
  const iCohort = idx('cohort');
  const iStage = idx('stage');
  return lines.slice(1).map((l) => {
    const c = l.split(',');
    return { repo: c[iRepo].trim(), cohort: iCohort >= 0 ? c[iCohort]?.trim() ?? '' : '', stage: iStage >= 0 ? c[iStage]?.trim() ?? '' : '' };
  });
}

async function pool<T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      input: { type: 'string', short: 'i', default: 'data/sample.csv' },
      executor: { type: 'string', short: 'e', default: 'local' },
      concurrency: { type: 'string', short: 'c', default: '2' },
      limit: { type: 'string', short: 'n' },
      offset: { type: 'string', default: '0' },
      cohort: { type: 'string' },
      out: { type: 'string', short: 'o', default: 'results' },
      'keep-failures': { type: 'boolean', default: true },
      cleanup: { type: 'boolean', default: false },
      region: { type: 'string' },
    },
  });

  if (values.cleanup) {
    const ex = new SpritesExecutor();
    const n = await ex.cleanup();
    console.log(`deleted ${n} sprites`);
    return;
  }

  let rows = parseCsv(await readFile(values.input!, 'utf8'));
  if (values.cohort) rows = rows.filter((r) => r.cohort === values.cohort);
  const offset = parseInt(values.offset!, 10) || 0;
  rows = rows.slice(offset, values.limit ? offset + parseInt(values.limit, 10) : undefined);

  const executor: Executor = values.executor === 'sprites'
    ? new SpritesExecutor({ region: values.region })
    : new LocalExecutor();

  const runId = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${executor.name}`;
  const reporter = new Reporter(values.out!, runId);
  await reporter.init();
  const startedAt = new Date().toISOString();
  const concurrency = parseInt(values.concurrency!, 10) || 2;

  console.log(`hackjudge: ${rows.length} repos, executor=${executor.name}, concurrency=${concurrency}, run=${runId}`);

  const opts = { ...defaultPipelineOptions, keepFailures: values['keep-failures']! };
  let done = 0;
  await pool(rows, concurrency, async (row): Promise<RepoResult> => {
    const r = await judgeOne(executor, row.repo, row.cohort, row.stage, opts);
    await reporter.record(r);
    done++;
    const short = row.repo.replace('https://github.com/', '');
    console.log(`[${String(done).padStart(3)}/${rows.length}] ${r.verdict.padEnd(16)} ${Math.round(r.totalMs / 1000).toString().padStart(4)}s  ${short}${r.failedStage ? `  (${r.failedStage})` : ''}${r.error ? '  !' : ''}`);
    return r;
  });

  const summary = reporter.summarize(executor.name, startedAt);
  const summaryPath = await reporter.writeSummary(summary);
  const csvPath = await reporter.writeCsv();
  console.log('\n' + printSummary(summary));
  console.log(`\nsummary: ${summaryPath}\nper-repo: ${csvPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
