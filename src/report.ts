/**
 * Reporting: per-repo JSONL (private, contains repo names and output tails)
 * and an aggregate summary (safe to publish: counts and rates only).
 */
import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RepoResult, RunSummary, Verdict } from './types.js';

export const VERDICTS: Verdict[] = [
  'unreachable', 'empty', 'not_evaluable', 'install_failed', 'build_failed', 'installed_no_build', 'built_no_tests', 'tests_failed', 'tests_passed',
];

/** "Built" means every checkable step passed. installed_no_build is counted separately: nothing failed, but nothing was checked either. */
const BUILT: Verdict[] = ['built_no_tests', 'tests_failed', 'tests_passed'];
const EVALUABLE: Verdict[] = ['install_failed', 'build_failed', 'installed_no_build', ...BUILT];

function zero(): Record<Verdict, number> {
  return Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>;
}

export class Reporter {
  private readonly results: RepoResult[] = [];
  constructor(private readonly outDir: string, readonly runId: string) {}

  async init(): Promise<void> {
    await mkdir(this.outDir, { recursive: true });
  }

  async record(r: RepoResult): Promise<void> {
    this.results.push(r);
    await appendFile(join(this.outDir, `${this.runId}.jsonl`), JSON.stringify(r) + '\n');
  }

  summarize(executor: string, startedAt: string): RunSummary {
    const byVerdict = zero();
    const byCohort: Record<string, Record<Verdict, number>> = {};
    const byBuildSystem: Record<string, number> = {};
    let sandboxMs = 0;
    for (const r of this.results) {
      byVerdict[r.verdict]++;
      (byCohort[r.cohort] ??= zero())[r.verdict]++;
      const bs = r.inventory?.buildSystem ?? 'unknown';
      byBuildSystem[bs] = (byBuildSystem[bs] ?? 0) + 1;
      sandboxMs += r.totalMs;
    }
    const total = this.results.length;
    const built = BUILT.reduce((n, v) => n + byVerdict[v], 0);
    const evaluable = EVALUABLE.reduce((n, v) => n + byVerdict[v], 0);
    const walls = this.results.map((r) => r.totalMs).sort((a, b) => a - b);
    return {
      runId: this.runId,
      executor,
      startedAt,
      finishedAt: new Date().toISOString(),
      total,
      byVerdict,
      byCohort,
      byBuildSystem,
      buildRateEvaluable: evaluable ? built / evaluable : 0,
      buildRateAll: total ? built / total : 0,
      medianWallMs: walls.length ? walls[Math.floor(walls.length / 2)] : 0,
      totalSandboxSeconds: Math.round(sandboxMs / 1000),
    };
  }

  async writeSummary(summary: RunSummary): Promise<string> {
    const path = join(this.outDir, `${this.runId}.summary.json`);
    await writeFile(path, JSON.stringify(summary, null, 2));
    return path;
  }

  /** A CSV a judge can open. One row per submission. Private. */
  async writeCsv(): Promise<string> {
    const cols = ['repo', 'cohort', 'stage', 'verdict', 'failedStage', 'buildSystem', 'projectDir', 'sourceFiles', 'commits', 'lastCommit', 'hasReadme', 'readmeBytes', 'hasTests', 'hasCi', 'hasDockerfile', 'hasLockfile', 'compact', 'solidity', 'totalSec', 'checkpointRef'];
    const esc = (v: unknown) => {
      const s = v === undefined || v === null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = this.results.map((r) => [
      r.repo, r.cohort, r.stage, r.verdict, r.failedStage ?? '', r.inventory?.buildSystem ?? '', r.inventory?.projectDir ?? '',
      r.inventory?.sourceFileCount ?? '', r.inventory?.commitCount ?? '', r.inventory?.lastCommitIso ?? '',
      r.inventory?.hasReadme ?? '', r.inventory?.readmeBytes ?? '',
      r.inventory ? r.inventory.hasTestScript && !r.inventory.testScriptIsPlaceholder : '',
      r.inventory?.hasCi ?? '', r.inventory?.hasDockerfile ?? '', r.inventory?.hasLockfile ?? '',
      r.inventory?.hasCompactContracts ?? '', r.inventory?.hasSolidity ?? '',
      Math.round(r.totalMs / 1000), r.checkpointRef ?? '',
    ].map(esc).join(','));
    const path = join(this.outDir, `${this.runId}.csv`);
    await writeFile(path, [cols.join(','), ...rows].join('\n') + '\n');
    return path;
  }
}

export function printSummary(s: RunSummary): string {
  const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
  const lines: string[] = [];
  lines.push(`run ${s.runId} on ${s.executor}: ${s.total} submissions`);
  for (const v of VERDICTS) {
    const n = s.byVerdict[v];
    if (n) lines.push(`  ${v.padEnd(19)} ${String(n).padStart(4)}  ${pct(n / s.total)}`);
  }
  lines.push(`  built (of evaluable) ${pct(s.buildRateEvaluable)}   built (of all) ${pct(s.buildRateAll)}`);
  lines.push(`  median wall ${Math.round(s.medianWallMs / 1000)}s, total sandbox time ${s.totalSandboxSeconds}s`);
  for (const [cohort, bv] of Object.entries(s.byCohort)) {
    const t = Object.values(bv).reduce((a, b) => a + b, 0);
    const built = BUILT.reduce((n, v) => n + bv[v], 0);
    lines.push(`  cohort ${cohort}: ${t} repos, ${built} built (${pct(built / t)})`);
  }
  return lines.join('\n');
}
