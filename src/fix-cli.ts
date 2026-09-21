#!/usr/bin/env node
/**
 * hackfix: hand every broken build from a hackjudge run to an agent, then check its work.
 *
 *   ANTHROPIC_API_KEY=... SPRITES_TOKEN=... npm run fix -- --results results/<run>.jsonl --limit 3
 */
import { readFile, mkdir, appendFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { parseArgs } from 'node:util';
import type { RepoResult, Verdict } from './types.js';
import { SpritesExecutor } from './executors/sprites.js';
import { fixOne, inspectOne, defaultFixOptions, summarizeFixes, printFixSummary } from './fix.js';
import type { FixResult } from './fix.js';

const USAGE = `hackfix: give each broken build to an agent with a shell, a time limit, and one instruction.

  npm run fix -- --results results/<run>.jsonl --limit 3
  npm run fix -- --results results/<run>.jsonl --concurrency 2 --minutes 10

options
  -r, --results <jsonl>     a hackjudge run's per-repo results (has checkpointRef + the failing command)
      --verdicts <list>     which verdicts to attempt                       [build_failed]
                            e.g. build_failed,install_failed
  -c, --concurrency <n>     machines worked on at once                      [2]
  -n, --limit <n>           only the first n matching rows
      --offset <n>          skip the first n matching rows                  [0]
      --minutes <n>         wall-clock budget per agent                     [10]
      --max-turns <n>       agent turn cap                                  [40]
      --ceiling <lines>     changed lines under which a fix counts as trivial [20]
      --no-restrict         skip the per-machine network allowlist
      --no-checkpoint       do not checkpoint machines after the agent runs
      --inspect             only print what is on each target machine (repo present? checkpoints?)
      --model <name>        model for the agent (Claude Code --model), e.g. sonnet, opus   [Claude Code default]
      --resume <fix jsonl>  skip machines already recorded in an earlier hackfix results file and
                            append to it, so a run can be stopped and continued
      --only <names>        only these machines (comma-separated sprite names), e.g. for a paired rerun
      --stage <name>        only rows whose judge failure was at this stage (build|compile|install)
  -o, --out <dir>           where results go                                [results]
  -h, --help

Needs SPRITES_TOKEN (the machines) and one credential for the agent: CLAUDE_CODE_OAUTH_TOKEN
(from \`claude setup-token\`, uses your Claude subscription) or ANTHROPIC_API_KEY (billed per token,
exact cost reported). None of them is written anywhere.`;

async function pool<T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) { console.log(USAGE); return; }
  const { values } = parseArgs({
    options: {
      results: { type: 'string', short: 'r' },
      verdicts: { type: 'string', default: 'build_failed' },
      concurrency: { type: 'string', short: 'c', default: '2' },
      limit: { type: 'string', short: 'n' },
      offset: { type: 'string', default: '0' },
      minutes: { type: 'string', default: '10' },
      'max-turns': { type: 'string', default: '40' },
      ceiling: { type: 'string', default: '20' },
      restrict: { type: 'boolean', default: true },
      checkpoint: { type: 'boolean', default: true },
      inspect: { type: 'boolean', default: false },
      model: { type: 'string' },
      resume: { type: 'string' },
      only: { type: 'string' },
      stage: { type: 'string' },
      out: { type: 'string', short: 'o', default: 'results' },
    },
  });
  if (!values.results) { console.error('--results <run>.jsonl is required\n'); console.log(USAGE); process.exit(2); }
  if (!values.inspect && !process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    console.error('No agent credential. Either:\n  claude setup-token   (on your own machine; then export CLAUDE_CODE_OAUTH_TOKEN=...)\n  or export ANTHROPIC_API_KEY=...');
    process.exit(2);
  }

  const wanted = new Set(values.verdicts!.split(',').map((s) => s.trim()) as Verdict[]);
  const rows: RepoResult[] = (await readFile(values.results, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as RepoResult);
  let targets = rows.filter((r) => wanted.has(r.verdict) && r.checkpointRef);
  if (values.stage) targets = targets.filter((r) => r.failedStage === values.stage);
  if (values.only) {
    const only = new Set(values.only.split(',').map((x) => x.trim()).filter(Boolean));
    targets = targets.filter((r) => only.has((r.checkpointRef ?? '').replace(/^sprite:/, '').split('@')[0]));
  }
  const offset = parseInt(values.offset!, 10) || 0;
  targets = targets.slice(offset, values.limit ? offset + parseInt(values.limit, 10) : undefined);

  const executor = new SpritesExecutor();
  if (values.inspect) {
    for (const r of targets) console.log(await inspectOne(executor, r));
    return;
  }
  const sourceRun = basename(values.results).replace(/\.jsonl$/, '');
  await mkdir(values.out!, { recursive: true });
  // --resume: pick up an earlier run's file, skip what it already has, append to it.
  let prior: FixResult[] = [];
  let runId: string;
  let jsonlPath: string;
  if (values.resume) {
    prior = (await readFile(values.resume, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as FixResult);
    // Retry machines whose earlier attempt never reached the agent (restore or agent setup failed);
    // keep everything the agent actually got to work on.
    const RETRY = new Set(['restore_failed', 'agent_error', 'fence_blocked']);
    const doneNames = new Set(prior.filter((p) => !RETRY.has(p.outcome)).map((p) => p.spriteName));
    prior = prior.filter((p) => !RETRY.has(p.outcome));
    const before = targets.length;
    targets = targets.filter((r) => { const ref = r.checkpointRef ?? ''; return !doneNames.has(ref.replace(/^sprite:/, '').split('@')[0]); });
    runId = basename(values.resume).replace(/\.jsonl$/, '');
    jsonlPath = values.resume;
    console.log(`hackfix: resuming ${runId}: ${prior.length} already done, ${targets.length} of ${before} left`);
  } else {
    runId = `fix-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
    jsonlPath = join(values.out!, `${runId}.jsonl`);
  }
  const startedAt = new Date().toISOString();
  const concurrency = parseInt(values.concurrency!, 10) || 2;

  const opts = {
    ...defaultFixOptions,
    agentTimeoutMs: (parseInt(values.minutes!, 10) || 10) * 60_000,
    maxTurns: parseInt(values['max-turns']!, 10) || 40,
    trivialLineCeiling: parseInt(values.ceiling!, 10) || 20,
    restrictNetwork: values.restrict!,
    checkpointAfter: values.checkpoint!,
    model: values.model ?? defaultFixOptions.model,
  };
  if (opts.model) console.log(`hackfix: agent model: ${opts.model}`);

  const cred = process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'subscription (oauth token)' : 'api key';
  console.log(`hackfix: agent credential: ${cred}`);
  console.log(`hackfix: ${targets.length} machines (${[...wanted].join(',')}) from ${sourceRun}, concurrency=${concurrency}, budget ${values.minutes} min each, run=${runId}`);

  let done = prior.length;
  const total = prior.length + targets.length;
  const results = await pool(targets, concurrency, async (r): Promise<FixResult> => {
    const res = await fixOne(executor, r, opts);
    await appendFile(jsonlPath, JSON.stringify(res) + '\n');
    done++;
    const diff = res.outcome === 'fixed' ? `  +${res.diffLinesAdded}/-${res.diffLinesRemoved} in ${res.diffFiles} file${res.diffFiles === 1 ? '' : 's'}${res.lockfileChanged ? ' +lockfile' : ''}${res.trivial ? '' : ' (large)'}` : '';
    const cost = res.agent.costUsd !== null ? `  $${res.agent.costUsd.toFixed(2)}` : '';
    const flags = res.suspicious.length ? `  ⚑ ${res.suspicious.join('; ')}` : '';
    console.log(`[${String(done).padStart(3)}/${total}] ${res.outcome.padEnd(15)} ${Math.round(res.totalMs / 1000).toString().padStart(4)}s${cost}${diff}  ${res.spriteName}${flags}${res.error ? `  ! ${res.error.slice(0, 110)}` : ''}`);
    return res;
  });

  const summary = summarizeFixes(runId, sourceRun, prior[0]?.startedAt ?? startedAt, [...prior, ...results]);
  const summaryPath = join(values.out!, `${runId}.summary.json`);
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.log('\n' + printFixSummary(summary));
  console.log(`\nsummary: ${summaryPath}\nper-repo (private; has FIX.md text): ${jsonlPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
