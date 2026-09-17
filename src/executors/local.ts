/**
 * Local executor: one temp directory per submission, commands run through bash.
 *
 * This is the dry-run path. It has none of the isolation guarantees the Sprites
 * executor has (a hostile install script can see your machine), so only use it on
 * repos you would be willing to `npm install` by hand. It exists so the pipeline
 * can be developed and debugged without spending sandbox minutes.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Executor, Sandbox, ExecOpts, ExecResult } from '../types.js';

export interface LocalExecutorOptions {
  /** Where to copy failed workdirs so they can be inspected. Defaults to results/failures. */
  failureDir?: string;
}

function runBash(command: string, cwd: string, timeoutMs: number, env?: Record<string, string>): Promise<ExecResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('bash', ['-lc', command], {
      cwd,
      env: { ...process.env, ...env, CI: 'true', FORCE_COLOR: '0', NO_COLOR: '1', npm_config_fund: 'false', npm_config_audit: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = 2_000_000; // keep memory bounded on chatty installs
    child.stdout.on('data', (d) => { if (stdout.length < cap) stdout += d.toString(); });
    child.stderr.on('data', (d) => { if (stderr.length < cap) stderr += d.toString(); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1, durationMs: Date.now() - started, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(err), exitCode: -1, durationMs: Date.now() - started, timedOut });
    });
  });
}

class LocalSandbox implements Sandbox {
  readonly workdir = 'repo';
  constructor(readonly id: string, private readonly root: string, private readonly failureDir: string) {}

  async exec(command: string, opts: ExecOpts = {}): Promise<ExecResult> {
    const cwd = opts.cwd ? join(this.root, opts.cwd) : this.root;
    return runBash(command, cwd, opts.timeoutMs ?? 10 * 60_000, opts.env);
  }

  async checkpoint(comment: string): Promise<string | null> {
    // Local "checkpoint": copy the failed working tree somewhere inspectable.
    await mkdir(this.failureDir, { recursive: true });
    const dest = join(this.failureDir, this.id);
    await rm(dest, { recursive: true, force: true });
    await cp(this.root, dest, { recursive: true, force: true, filter: (src) => !src.includes('/node_modules/') });
    await import('node:fs/promises').then((fs) => fs.writeFile(join(dest, 'CHECKPOINT.txt'), comment + '\n'));
    return dest;
  }

  async destroy(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

export class LocalExecutor implements Executor {
  readonly name = 'local' as const;
  constructor(private readonly opts: LocalExecutorOptions = {}) {}

  async create(name: string): Promise<Sandbox> {
    const root = await mkdtemp(join(tmpdir(), `hackjudge-${name}-`));
    return new LocalSandbox(name, root, this.opts.failureDir ?? join(process.cwd(), 'results', 'failures'));
  }
}
