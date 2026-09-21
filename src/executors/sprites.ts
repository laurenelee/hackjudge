/**
 * Sprites executor: one Sprite per submission.
 *
 * Why one per submission rather than a shared runner: a hackathon repo's install
 * step can do anything (postinstall scripts, global installs, writing to $HOME).
 * Sharing a runner means submission N's environment is whatever submissions 1..N-1
 * left behind. A fresh microVM per repo makes every result independent.
 *
 * On failure we checkpoint the Sprite and leave it in place so a judge (or the
 * hacker) can open the exact broken state. On pass we delete it: there is nothing
 * to look at.
 */
import { SpritesClient, ExecError } from '@fly/sprites';
import type { Sprite } from '@fly/sprites';
import type { Executor, Sandbox, ExecOpts, ExecResult } from '../types.js';

export interface SpritesExecutorOptions {
  token?: string;
  /** Prefix for sprite names so a run can be found and cleaned up later. */
  prefix?: string;
  region?: string;
  ramMB?: number;
  cpus?: number;
  storageGB?: number;
  /** Extra time, in ms, for the sprite to become ready. */
  labels?: string[];
}

class SpriteSandbox implements Sandbox {
  readonly workdir = '/home/sprite/repo';
  constructor(readonly id: string, private readonly sprite: Sprite) {}

  async exec(command: string, opts: ExecOpts = {}): Promise<ExecResult> {
    const started = Date.now();
    const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    // Two things the SDK does that its Node-style surface does not advertise:
    //  1. sprite.exec(cmd) splits on whitespace and runs argv[0] directly. There is no shell,
    //     so `&&`, quotes, pipes and $VARS mean nothing. We use execFile with an explicit
    //     login shell instead (login so the image's lazy toolchain loaders are sourced).
    //  2. Any non-zero exit is thrown as ExecError rather than returned. We want the exit
    //     code and the output either way, so we catch it and unwrap.
    try {
      const r = await this.sprite.execFile('bash', ['-lc', command], {
        cwd: opts.cwd ?? undefined,
        env: { CI: 'true', FORCE_COLOR: '0', NO_COLOR: '1', npm_config_fund: 'false', npm_config_audit: 'false', ...opts.env },
        timeout: timeoutMs,
        maxBuffer: 20 * 1024 * 1024,
      });
      return {
        stdout: String(r.stdout ?? ''),
        stderr: String(r.stderr ?? ''),
        exitCode: r.exitCode,
        durationMs: Date.now() - started,
        timedOut: false,
      };
    } catch (err: unknown) {
      if (err instanceof ExecError) {
        return {
          stdout: String(err.stdout ?? ''),
          stderr: String(err.stderr ?? ''),
          exitCode: err.exitCode,
          durationMs: Date.now() - started,
          timedOut: false,
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      const timedOut = /timeout|timed out|abort/i.test(msg);
      return { stdout: '', stderr: msg, exitCode: -1, durationMs: Date.now() - started, timedOut };
    }
  }

  async checkpoint(comment: string): Promise<string | null> {
    const stream = await this.sprite.createCheckpoint(comment);
    let id: string | null = null;
    try {
      for (;;) {
        const msg = await stream.next();
        if (!msg) break;
        // Messages carry progress; the terminal one includes the checkpoint id when available.
        const anyMsg = msg as unknown as Record<string, unknown>;
        const maybeId = (anyMsg['checkpoint_id'] ?? anyMsg['checkpointId'] ?? anyMsg['id']) as string | undefined;
        if (maybeId) id = maybeId;
        if (anyMsg['type'] === 'error') throw new Error(String(anyMsg['error'] ?? 'checkpoint error'));
      }
    } finally {
      await stream.close?.();
    }
    if (!id) {
      // Fall back to listing. The list is not guaranteed to be in creation order, and the machine
      // also carries automatic checkpoints (the "initial checkpoint", "pre-restore" snapshots), so
      // find ours by comment, newest first. Trusting list order once recorded a pre-clone snapshot
      // as a build failure, and restoring it wiped the repo.
      const list = await this.sprite.listCheckpoints();
      const ours = list
        .filter((c) => c.comment === comment)
        .sort((a, b) => new Date(b.createTime).getTime() - new Date(a.createTime).getTime());
      id = ours[0]?.id ?? null;
    }
    return id ? `sprite:${this.sprite.name}@${id}` : `sprite:${this.sprite.name}`;
  }

  async destroy(): Promise<void> {
    await this.sprite.delete();
  }

  /** Every checkpoint on this machine, oldest first. */
  async checkpoints(): Promise<Array<{ id: string; createTime: Date; comment?: string; isAuto?: boolean }>> {
    const list = await this.sprite.listCheckpoints();
    return [...list].sort((a, b) => new Date(a.createTime).getTime() - new Date(b.createTime).getTime());
  }

  /** Rewind the machine to a checkpoint taken earlier (e.g. the moment a build failed). */
  async restore(checkpointId: string): Promise<void> {
    const stream = await this.sprite.restoreCheckpoint(checkpointId);
    try {
      await stream.processAll((msg) => {
        const anyMsg = msg as unknown as Record<string, unknown>;
        if (anyMsg['type'] === 'error') throw new Error(String(anyMsg['error'] ?? 'restore error'));
      });
    } finally {
      await stream.close?.();
    }
  }

  /** Undo a previous allowlist (policies survive checkpoint restores; they belong to the machine). */
  async openNetwork(): Promise<void> {
    await this.sprite.updateNetworkPolicy({ rules: [{ domain: '*', action: 'allow' }] });
  }

  /**
   * Restrict what this machine can reach. Rules are evaluated in order; the trailing
   * deny keeps anything not listed (including git pushes to arbitrary hosts) off the wire.
   */
  async setNetworkAllowlist(domains: string[]): Promise<void> {
    await this.sprite.updateNetworkPolicy({
      rules: [
        ...domains.map((domain) => ({ domain, action: 'allow' as const })),
        { domain: '*', action: 'deny' as const },
      ],
    });
  }
}

export type { SpriteSandbox };

export class SpritesExecutor implements Executor {
  readonly name = 'sprites' as const;
  private readonly client: SpritesClient;
  private readonly opts: Required<Pick<SpritesExecutorOptions, 'prefix'>> & SpritesExecutorOptions;

  constructor(opts: SpritesExecutorOptions = {}) {
    const token = opts.token ?? process.env.SPRITES_TOKEN;
    if (!token) {
      throw new Error('SPRITES_TOKEN is not set. Run `sprite org auth` or create a token at sprites.dev/account.');
    }
    this.client = new SpritesClient(token);
    this.opts = { prefix: 'hj', ...opts };
  }

  async create(name: string): Promise<Sandbox> {
    const spriteName = `${this.opts.prefix}-${name}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60);
    const sprite = await this.client.createSprite(spriteName, {
      config: {
        ramMB: this.opts.ramMB ?? 2048,
        cpus: this.opts.cpus ?? 2,
        region: this.opts.region,
        storageGB: this.opts.storageGB,
      },
      labels: ['hackjudge', ...(this.opts.labels ?? [])],
      waitForCapacity: true,
      runtime: 'dev',
    });
    return new SpriteSandbox(spriteName, sprite);
  }

  /** Attach to a machine an earlier run left behind, by the name in its checkpointRef. */
  async attach(spriteName: string): Promise<SpriteSandbox> {
    const sprite = await this.client.getSprite(spriteName);
    return new SpriteSandbox(spriteName, sprite);
  }

  /** Delete every sprite from a previous run. Use after you have looked at the failures. */
  async cleanup(prefix = this.opts.prefix): Promise<number> {
    const sprites = await this.client.listAllSprites(`${prefix}-`);
    for (const s of sprites) await s.delete();
    return sprites.length;
  }
}
