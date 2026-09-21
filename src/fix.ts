/**
 * hackfix: give a failing build to an agent with a shell, a time limit, and one instruction.
 *
 * For every build_failed (optionally install_failed) row in a hackjudge run:
 *   1. rewind its machine to the checkpoint taken when the build broke
 *   2. narrow the machine's network to package registries and the model API
 *   3. put an agent on the machine and tell it: make it build, touch as little as you can,
 *      then write FIX.md explaining what was wrong in words a student can act on
 *   4. the HARNESS re-runs the exact command that failed. The agent does not grade itself.
 *   5. measure the diff, read the note, checkpoint the result
 *
 * The agent runs ON the machine (Claude Code, headless), not on the laptop with the machine as
 * a tool. That is the point of a computer for agents: it has the shell, the toolchain and the
 * broken repo already, so the harness only has to ask a question and check the answer.
 */
import type { RepoResult, Stage, StageResult } from './types.js';
import type { SpritesExecutor, SpriteSandbox } from './executors/sprites.js';

export interface FixOptions {
  /** Wall-clock budget for the agent, in ms. */
  agentTimeoutMs: number;
  /** Cap on agent turns (tool calls + replies). */
  maxTurns: number;
  /** Changed lines above which a working fix is reported as "large" rather than "trivial". */
  trivialLineCeiling: number;
  /** Credential for the agent, placed in the machine's environment. Never logged.
   *  Either an Anthropic API key (billed per token, exact cost reported) or a Claude Code
   *  OAuth token from `claude setup-token` (uses your subscription; cost is an estimate). */
  credential: { kind: 'api_key' | 'oauth_token'; value: string } | null;
  /** Domains the machine may reach while the agent works. */
  allowDomains: string[];
  /** Apply the network allowlist (turn off if the org policy already restricts egress). */
  restrictNetwork: boolean;
  /** Checkpoint the machine after the agent finishes, fixed or not. */
  checkpointAfter: boolean;
  /** Model for the agent (passed to Claude Code --model). Empty = Claude Code's default. */
  model: string;
}

export const defaultFixOptions: FixOptions = {
  agentTimeoutMs: 10 * 60_000,
  maxTurns: 40,
  trivialLineCeiling: 20,
  credential: process.env.CLAUDE_CODE_OAUTH_TOKEN
    ? { kind: 'oauth_token', value: process.env.CLAUDE_CODE_OAUTH_TOKEN }
    : process.env.ANTHROPIC_API_KEY
      ? { kind: 'api_key', value: process.env.ANTHROPIC_API_KEY }
      : null,
  allowDomains: [
    'api.anthropic.com',
    'registry.npmjs.org', 'registry.yarnpkg.com', 'registry.npmmirror.com',
    'pypi.org', 'files.pythonhosted.org',
    'crates.io', 'static.crates.io', 'index.crates.io',
    'proxy.golang.org', 'sum.golang.org', 'storage.googleapis.com',
    'github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com', 'codeload.github.com',
    'nodejs.org', 'deb.nodesource.com',
    'downloads.claude.ai', 'claude.ai',
    // hosts builds legitimately fetch from at build time; blocking them makes the agent "fix" our fence
    'fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'unpkg.com', 'esm.sh',
    'binaries.prisma.sh', 'sh.rustup.rs', 'static.rust-lang.org', 'get.foundry.sh',
    // toolchains that download themselves: the Compact compiler lists releases via the GitHub API
    // and downloads from GitHub's asset CDN; the ZK step fetches reference strings.
    'api.github.com', 'release-assets.githubusercontent.com', 'srs.midnight.network',
  ],
  restrictNetwork: true,
  checkpointAfter: true,
  model: process.env.HACKFIX_MODEL ?? '',
};

export type FixOutcome =
  | 'fixed'            // the failing command now exits 0
  | 'not_fixed'        // agent finished; command still fails
  | 'agent_timeout'    // agent hit the wall-clock budget
  | 'agent_error'      // agent could not run (install, auth, crash)
  | 'restore_failed'   // could not rewind the machine
  | 'fence_blocked'    // behind our network fence the build fails for a NEW reason (a blocked host). Ours, not theirs. No agent ran.
  | 'build_hangs'      // the verification build itself exceeded its timeout; we cannot say whether the agent fixed it
  | 'skipped';         // no checkpoint reference or no failing command recorded

export interface FixResult {
  repo: string;
  cohort: string;
  spriteName: string;
  checkpointId: string | null;
  /** Which checkpoint the machine was rewound to before the agent ran. */
  restoredFrom?: string | null;
  failedStage?: Stage;
  failedCommand?: string;
  outcome: FixOutcome;
  /** Files and lines the agent changed, FIX.md and lockfiles excluded. */
  diffFiles: number;
  /** A lockfile changed too (a dependency was added or re-pinned); counted separately, not in the lines. */
  lockfileChanged: boolean;
  diffLinesAdded: number;
  diffLinesRemoved: number;
  untrackedFiles: number;
  /** Whether the diff sits under the trivial ceiling (only meaningful when fixed). */
  trivial: boolean | null;
  /** Contents of FIX.md, if the agent wrote one. Private: never published. */
  note: string | null;
  /** `git diff --stat` of what the agent changed, FIX.md excluded. Private. */
  diffStat: string | null;
  /** The diff itself, capped at 24KB. Private: it is the team's code. Kept so fixes can be categorized. */
  diff: string | null;
  /** Red flags in the diff that would make a build pass without fixing anything. */
  suspicious: string[];
  /** Hosts the fenced build tried to reach and could not, when that differs from the judge's failure. */
  blockedHosts?: string[];
  /** Files under $HOME (toolchains, global packages) the agent touched. Outside the repo is out of bounds. */
  touchedOutsideRepo?: string[];
  agent: { turns: number | null; costUsd: number | null; durationMs: number | null; model: string | null; exitCode?: number; raw?: string; stderrTail?: string };
  /** 'api_key' means costUsd is what you were billed; 'oauth_token' means it is Claude Code's estimate against a subscription. */
  credentialKind: 'api_key' | 'oauth_token' | null;
  verify: { exitCode: number; tail: string } | null;
  networkRestricted: boolean;
  afterCheckpointRef: string | null;
  startedAt: string;
  finishedAt: string;
  totalMs: number;
  error?: string;
}

/** Split "sprite:<name>@<id>" into its parts. */
export function parseCheckpointRef(ref: string | null | undefined): { name: string; id: string | null } | null {
  if (!ref || !ref.startsWith('sprite:')) return null;
  const body = ref.slice('sprite:'.length);
  const at = body.indexOf('@');
  return at === -1 ? { name: body, id: null } : { name: body.slice(0, at), id: body.slice(at + 1) };
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
function tailOf(stdout: string, stderr: string, lines = 40): string {
  return (stdout + '\n' + stderr).replace(ANSI, '').split('\n').filter(Boolean).slice(-lines).join('\n').slice(-6000);
}

function failingStage(r: RepoResult): StageResult | undefined {
  if (!r.failedStage) return undefined;
  return [...r.stages].reverse().find((s) => s.stage === r.failedStage && s.command && s.exitCode !== 0);
}

/** The instruction. One job, stated plainly, with the boundaries the harness will enforce anyway. */
export function agentPrompt(r: RepoResult, failing: StageResult, workdir: string): string {
  const projectDir = r.inventory?.projectDir ?? '.';
  return [
    `You are on a machine where a hackathon project failed to build. The repository is at ${workdir}` +
      (projectDir !== '.' ? ` and the project that failed is in ${workdir}/${projectDir}.` : '.'),
    ``,
    `The command that failed (run from the repository root, with WORKDIR=${workdir}):`,
    ``,
    `    ${failing.command}`,
    ``,
    `The last lines of its output:`,
    ``,
    ...(failing.tail ?? '').split('\n').map((l) => `    ${l}`),
    ``,
    `Your job: make that exact command exit 0 with the smallest change you can.`,
    ``,
    `Rules:`,
    `- Do not add features, rewrite modules, or "improve" anything that is not in the way of the build.`,
    `- Do not delete or weaken tests, and do not change the build command itself to skip work.`,
    `- Do not touch git remotes, do not commit, do not push. Leave your changes in the working tree.`,
    `- Do not upgrade toolchains or change pinned versions unless the error is specifically about a version.`,
    `- Change nothing outside the repository: no edits, symlinks or installs under $HOME (toolchains, ~/.compact,`,
    `  global npm packages). If a required tool version is missing from this machine, that is an environment`,
    `  problem: say so in FIX.md and stop.`,
    `- If the build depends on a secret or a service you cannot have, stop and say so instead of faking it.`,
    `- This machine has restricted network access. If the build fails ONLY because a host is unreachable`,
    `  (DNS blocked, connection refused), that is a limitation of this machine, not a bug in the project.`,
    `  Do not rewrite the project to avoid the host. Write FIX.md with a heading "Environment" naming the host`,
    `  and stop. If there are also real bugs, fix those and describe the environment issue separately.`,
    ``,
    `When the command passes, write a file named FIX.md at ${workdir}/FIX.md with two or three sentences a student`,
    `could act on: what was wrong, and what you changed. Plain language, no praise, no filler. If you could not`,
    `make it build, write FIX.md explaining what you found and why it is not a small fix.`,
    ``,
    `Verify by running the exact command above before you finish.`,
  ].join('\n');
}

const NET_FAIL = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|Could not resolve host|Failed to fetch|failed to fetch|getaddrinfo|Temporary failure in name resolution|Name or service not known|Network is unreachable|Could not connect|dial tcp/i;
const HOST = /\b((?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|sh|network|cloud|app|ai|co|xyz|rs))\b/gi;

/** Hosts named in a network failure in `out` that do not appear in the judge's recorded output. */
export function newlyBlockedHosts(out: string, judgeTail: string): string[] {
  if (!NET_FAIL.test(out)) return [];
  const seen = new Set((judgeTail.match(HOST) ?? []).map((h) => h.toLowerCase()));
  const hosts = new Set<string>();
  let anyHost = false;
  for (const line of out.split('\n')) {
    if (!NET_FAIL.test(line) && !/https?:\/\//.test(line)) continue;
    for (const h of line.match(HOST) ?? []) {
      const l = h.toLowerCase();
      if (/\.(ts|js|json|cjs|mjs|md|compact)$/.test(l)) continue;
      anyHost = true;
      if (!seen.has(l)) hosts.add(l);
    }
  }
  // Same hosts the judge already failed on: their problem, not our fence.
  if (anyHost && !hosts.size) return [];
  // A network error naming no host at all, when the judge saw no network error: still a fence symptom.
  if (!hosts.size && !NET_FAIL.test(judgeTail)) hosts.add('(unnamed host)');
  return [...hosts];
}

interface AgentOutput { turns: number | null; costUsd: number | null; durationMs: number | null; model: string | null; isError: boolean; raw: string }

/** Claude Code's --output-format json prints one JSON object at the end. Everything else is noise. */
function parseAgentOutput(stdout: string): AgentOutput {
  const lines = stdout.trim().split('\n').reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const j = JSON.parse(t) as Record<string, unknown>;
      const usage = (j['usage'] ?? {}) as Record<string, unknown>;
      const modelUsage = (j['modelUsage'] ?? {}) as Record<string, unknown>;
      return {
        turns: typeof j['num_turns'] === 'number' ? (j['num_turns'] as number) : null,
        costUsd: typeof j['total_cost_usd'] === 'number' ? (j['total_cost_usd'] as number) : null,
        durationMs: typeof j['duration_ms'] === 'number' ? (j['duration_ms'] as number) : null,
        model: Object.keys(modelUsage)[0] ?? (typeof usage['model'] === 'string' ? (usage['model'] as string) : null),
        isError: Boolean(j['is_error']),
        raw: t.slice(0, 4000),
      };
    } catch { /* not the summary line */ }
  }
  return { turns: null, costUsd: null, durationMs: null, model: null, isError: true, raw: stdout.slice(-4000) };
}

// Claude Code lands in the machine's global npm prefix; make sure both common locations are on PATH.
const AGENT_PATH = `export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:/usr/local/bin:$PATH"`;
const INSTALL_AGENT = `${AGENT_PATH}; command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code --loglevel=error >/dev/null 2>&1; command -v claude`;

export async function fixOne(executor: SpritesExecutor, r: RepoResult, opts: FixOptions = defaultFixOptions): Promise<FixResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const ref = parseCheckpointRef(r.checkpointRef);
  const failing = failingStage(r);

  const base: FixResult = {
    repo: r.repo, cohort: r.cohort, spriteName: ref?.name ?? '', checkpointId: ref?.id ?? null,
    failedStage: r.failedStage, failedCommand: failing?.command,
    outcome: 'skipped', diffFiles: 0, lockfileChanged: false, diffLinesAdded: 0, diffLinesRemoved: 0, untrackedFiles: 0, trivial: null,
    note: null, diffStat: null, diff: null, suspicious: [], agent: { turns: null, costUsd: null, durationMs: null, model: null }, verify: null,
    networkRestricted: false, afterCheckpointRef: null, startedAt, finishedAt: startedAt, totalMs: 0,
    credentialKind: opts.credential?.kind ?? null,
  };
  const finish = (patch: Partial<FixResult>): FixResult => {
    const out = { ...base, ...patch, finishedAt: new Date().toISOString() };
    out.totalMs = Date.now() - t0;
    return out;
  };

  if (!ref || !failing?.command) return finish({ error: !ref ? 'no checkpoint reference' : 'no failing command recorded' });
  if (!opts.credential) return finish({ outcome: 'agent_error', error: 'no agent credential: set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or ANTHROPIC_API_KEY' });

  let sb: SpriteSandbox;
  try {
    sb = await executor.attach(ref.name);
  } catch (err) {
    return finish({ outcome: 'restore_failed', error: `attach: ${err instanceof Error ? err.message : String(err)}` });
  }

  // 1. rewind to the moment it broke, so every attempt starts from the same state.
  // Pick the checkpoint by the judge's comment, not by the recorded id: ids are short labels
  // ("v3"), the machine also carries automatic checkpoints, and the judge's id fallback could
  // point at one of those. Restoring an automatic pre-clone snapshot wipes the repo.
  let restoredFrom: string | null = null;
  try {
    const cps = await sb.checkpoints();
    const judged = cps.filter((c) => (c.comment ?? '').startsWith('hackjudge '));
    const target = judged.find((c) => c.id === ref.id) ?? judged.at(-1) ?? null;
    if (target) {
      await sb.restore(target.id);
      restoredFrom = `${target.id} (${target.comment})`;
    } else {
      const has = await sb.exec(`test -d "${sb.workdir}/.git" && echo yes || echo no`, { timeoutMs: 30_000 });
      if (has.stdout.trim() !== 'yes') {
        return finish({ outcome: 'restore_failed', error: `no hackjudge checkpoint on machine and repo is not present; checkpoints: ${cps.map((c) => `${c.id}${c.isAuto ? '(auto)' : ''}:${c.comment ?? ''}`).join(', ') || 'none'}` });
      }
      base.error = 'no hackjudge checkpoint found; using the machine as it stands';
    }
  } catch (err) {
    return finish({ outcome: 'restore_failed', error: `restore: ${err instanceof Error ? err.message : String(err)}` });
  }

  const workdir = sb.workdir;
  const env = { WORKDIR: workdir, GIT_TERMINAL_PROMPT: '0' };

  const present = await sb.exec(`test -d "$WORKDIR/.git" && echo yes || echo no`, { env, timeoutMs: 30_000 });
  if (present.stdout.trim() !== 'yes') {
    return finish({ outcome: 'restore_failed', restoredFrom, error: `repo missing at ${workdir} after restore` });
  }

  // Clean slate for the diff: everything the judge's install step left behind is committed away
  // into a throwaway commit so `git diff` afterwards shows only what the agent did.
  await sb.exec(`cd "$WORKDIR" && git add -A >/dev/null 2>&1; git -c user.name=hackfix -c user.email=hackfix@local commit -qm "hackfix: baseline after install" >/dev/null 2>&1 || true`, { env, timeoutMs: 60_000 });

  // 2. install the agent and prove it can talk to the model, WITH THE NETWORK STILL OPEN.
  // Claude Code's npm package fetches its real binary in a post-install step from a host that is
  // not the npm registry; installing it behind the fence leaves a shim that exits silently.
  const credEnv: Record<string, string> = opts.credential.kind === 'oauth_token'
    ? { CLAUDE_CODE_OAUTH_TOKEN: opts.credential.value }
    : { ANTHROPIC_API_KEY: opts.credential.value };
  const agentEnv: Record<string, string> = { ...env, ...credEnv, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1' };
  const modelFlag = opts.model ? ` --model ${JSON.stringify(opts.model)}` : '';

  if (opts.restrictNetwork) {
    // A fence from an earlier hackfix run survives the restore; open it so the install can reach its hosts.
    try { await sb.openNetwork(); } catch (err) { base.error = `open network: ${err instanceof Error ? err.message : String(err)}`; }
  }
  const install = await sb.exec(INSTALL_AGENT, { timeoutMs: 4 * 60_000, env });
  if (install.exitCode !== 0) {
    return finish({ outcome: 'agent_error', error: `could not install agent (exit ${install.exitCode}): ${tailOf(install.stdout, install.stderr, 8)}` });
  }
  const smoke = await sb.exec(`${AGENT_PATH}; claude --version && claude -p "Reply with exactly the word OK and nothing else." --output-format json --max-turns 1${modelFlag} </dev/null`, { timeoutMs: 3 * 60_000, env: agentEnv });
  if (smoke.exitCode !== 0 || !/OK/.test(smoke.stdout)) {
    return finish({ outcome: 'agent_error', error: `agent smoke test failed (exit ${smoke.exitCode}): ${tailOf(smoke.stdout, smoke.stderr, 8)}` });
  }

  // 3. now narrow the network. Enforced by the platform, not by the prompt.
  let networkRestricted = false;
  if (opts.restrictNetwork) {
    try {
      await sb.setNetworkAllowlist(opts.allowDomains);
      networkRestricted = true;
    } catch (err) {
      // Not fatal: record it, so the result says whether the agent worked with a fence or without one.
      base.error = `network policy: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Baseline, BEHIND the fence: the failure must reproduce, and it must be the same failure the judge
  // saw. If the fenced build now fails on a host it cannot reach that the judge's output never
  // mentioned, the fence changed the problem. That is our limitation, and the agent must not be
  // asked to "fix" it: the result is fence_blocked, naming the host, and we widen the allowlist.
  const before = await sb.exec(failing.command, { timeoutMs: 10 * 60_000, env });
  if (before.timedOut) {
    return finish({ outcome: 'build_hangs', networkRestricted, error: 'baseline build exceeded its timeout before the agent ran', verify: { exitCode: before.exitCode, tail: tailOf(before.stdout, before.stderr) } });
  }
  if (before.exitCode === 0) {
    return finish({ outcome: 'skipped', networkRestricted, error: 'command passes after restore; nothing to fix', verify: { exitCode: 0, tail: tailOf(before.stdout, before.stderr) } });
  }
  const blocked = newlyBlockedHosts(before.stdout + '\n' + before.stderr, failing.tail ?? '');
  if (blocked.length) {
    return finish({ outcome: 'fence_blocked', networkRestricted, blockedHosts: blocked, error: `fenced build fails on host(s) the judge never hit: ${blocked.join(', ')}. Add to allowDomains and rerun.`, verify: { exitCode: before.exitCode, tail: tailOf(before.stdout, before.stderr) } });
  }

  // Mark the toolchain so we can tell afterwards whether the agent stepped outside the repo.
  await sb.exec(`touch "$HOME/.hackfix-marker"`, { env, timeoutMs: 30_000 });

  // 4. the agent
  const prompt = agentPrompt(r, failing, workdir);
  await sb.exec(`cat > "$HOME/hackfix-prompt.txt" <<'HJEOF'\n${prompt}\nHJEOF`, { env, timeoutMs: 30_000 });

  const agentCmd = `${AGENT_PATH}; cd "$WORKDIR" && claude -p "$(cat "$HOME/hackfix-prompt.txt")" ` +
    `--output-format json --max-turns ${opts.maxTurns} ` +
    `--allowedTools "Bash,Read,Edit,Write,Glob,Grep" --permission-mode acceptEdits${modelFlag} </dev/null`;
  const run = await sb.exec(agentCmd, { timeoutMs: opts.agentTimeoutMs, env: agentEnv });
  const agentOut = parseAgentOutput(run.stdout);
  const agent = {
    turns: agentOut.turns, costUsd: agentOut.costUsd, durationMs: agentOut.durationMs ?? run.durationMs, model: agentOut.model,
    exitCode: run.exitCode, raw: agentOut.raw, stderrTail: tailOf('', run.stderr, 12),
  };

  // 5. verification belongs to the harness
  const after = await sb.exec(failing.command, { timeoutMs: 10 * 60_000, env });
  const verify = { exitCode: after.exitCode, tail: tailOf(after.stdout, after.stderr) };
  const outside = await sb.exec(`find "$HOME/.compact" "$HOME/.npm-global" "$HOME/.local" "$HOME/.cargo" "$HOME/go" -newer "$HOME/.hackfix-marker" \\( -type f -o -type l \\) 2>/dev/null | grep -v '/\\.compact/versions/[^/]*/.*\\.zkir' | head -20`, { env, timeoutMs: 60_000 });
  const touchedOutsideRepo = outside.stdout.split('\n').map((l) => l.trim()).filter(Boolean);

  // 6. what changed, and what the agent said
  const numstat = await sb.exec(`cd "$WORKDIR" && git diff --numstat -- . ':(exclude)FIX.md'`, { env, timeoutMs: 60_000 });
  let diffFiles = 0, added = 0, removed = 0, lockfileChanged = false;
  const LOCKFILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock)$/;
  for (const line of numstat.stdout.split('\n').filter(Boolean)) {
    const [a, d, file] = line.split('\t');
    if (LOCKFILE.test(file ?? '')) { lockfileChanged = true; continue; } // npm's work, not the agent's
    diffFiles++;
    added += parseInt(a, 10) || 0;
    removed += parseInt(d, 10) || 0;
  }
  const untracked = await sb.exec(`cd "$WORKDIR" && git ls-files --others --exclude-standard | grep -v '^FIX.md$' | wc -l`, { env, timeoutMs: 60_000 });
  const untrackedFiles = parseInt(untracked.stdout.trim(), 10) || 0;
  const noteRes = await sb.exec(`cat "$WORKDIR/FIX.md" 2>/dev/null || true`, { env, timeoutMs: 30_000 });
  const note = noteRes.stdout.trim() ? noteRes.stdout.trim().slice(0, 4000) : null;
  const statRes = await sb.exec(`cd "$WORKDIR" && git diff --stat -- . ':(exclude)FIX.md'`, { env, timeoutMs: 60_000 });
  const diffStat = statRes.stdout.trim() || null;
  const diffRes = await sb.exec(`cd "$WORKDIR" && git -c core.pager=cat diff -- . ':(exclude)FIX.md' ':(exclude)package-lock.json' ':(exclude)pnpm-lock.yaml' ':(exclude)yarn.lock' ':(exclude)Cargo.lock' ':(exclude)go.sum' | head -c 24000`, { env, timeoutMs: 60_000 });
  const diff = diffRes.stdout.trim() || null;
  // Ways to make a build "pass" without fixing it. Flagged, not judged: a human reads these.
  const suspicious: string[] = [];
  const plus = (diff ?? '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
  if (/@ts-(ignore|nocheck|expect-error)/.test(plus)) suspicious.push('added @ts-ignore/@ts-nocheck');
  if (/"strict":\s*false|"noImplicitAny":\s*false|"skipLibCheck":\s*true|"noEmitOnError":\s*false/.test(plus)) suspicious.push('loosened tsconfig');
  if (/eslint-disable/.test(plus)) suspicious.push('disabled lint');
  if (/\|\|\s*true\b|;\s*exit 0|"build":\s*"echo/.test(plus)) suspicious.push('build script made to always succeed');
  if ((plus.match(/\bas any\b/g) ?? []).length >= 3) suspicious.push('multiple `as any` casts');
  if (untrackedFiles > 0) suspicious.push(`${untrackedFiles} new file(s)`);
  if (/unreachable|cannot (be )?reach|could not resolve|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|blocked by DNS|restricted network|^#+\s*Environment/im.test(note ?? '')) suspicious.push('note reports an unreachable host: an environment limit, not their bug');
  if (diffRes.stdout.length >= 24000) suspicious.push('diff truncated at 24KB');

  if (touchedOutsideRepo.length) suspicious.push(`modified ${touchedOutsideRepo.length} file(s) outside the repo (toolchain/global)`);
  const afterBlocked = newlyBlockedHosts(after.stdout + '\n' + after.stderr, failing.tail ?? '');
  if (afterBlocked.length) suspicious.push(`verification hit blocked host(s): ${afterBlocked.join(', ')}`);

  let outcome: FixOutcome;
  if (after.timedOut) outcome = 'build_hangs';
  else if (after.exitCode === 0) outcome = 'fixed';
  else if (run.timedOut) outcome = 'agent_timeout';
  else if (run.exitCode !== 0 && agentOut.isError && diffFiles === 0 && untrackedFiles === 0) outcome = 'agent_error';
  else outcome = 'not_fixed';

  const trivial = outcome === 'fixed' ? added + removed <= opts.trivialLineCeiling && untrackedFiles === 0 : null;

  let afterCheckpointRef: string | null = null;
  if (opts.checkpointAfter) {
    try { afterCheckpointRef = await sb.checkpoint(`hackfix ${outcome}`); } catch { /* keep going; the result is already known */ }
  }

  return finish({
    outcome, diffFiles, lockfileChanged, diffLinesAdded: added, diffLinesRemoved: removed, untrackedFiles, trivial, note, diffStat, diff, suspicious, agent, verify,
    touchedOutsideRepo, blockedHosts: afterBlocked.length ? afterBlocked : undefined,
    networkRestricted, afterCheckpointRef, restoredFrom,
    error: [base.error, outcome === 'agent_error' ? `agent exit ${run.exitCode}: ${agent.stderrTail || agent.raw || '(no output)'}`.slice(0, 600) : ''].filter(Boolean).join(' | ') || undefined,
  });
}

export interface FixSummary {
  runId: string;
  sourceRun: string;
  startedAt: string;
  finishedAt: string;
  attempted: number;
  byOutcome: Record<FixOutcome, number>;
  fixedTrivial: number;
  fixedLarge: number;
  medianDiffLinesFixed: number | null;
  medianAgentMinutes: number | null;
  totalCostUsd: number | null;
  medianCostUsdFixed: number | null;
  /** Fixed results with at least one red flag in the diff. */
  fixedWithFlags: number;
  /** Which models did the work, and how many machines each. A post must report this if there is more than one. */
  byModel: Record<string, { attempted: number; fixed: number }>;
  byFailedStage: Record<string, { attempted: number; fixed: number }>;
  networkRestrictedAll: boolean;
  /** Whether totalCostUsd is billed (api_key) or Claude Code's estimate (oauth_token). */
  costBasis: 'billed' | 'estimated' | 'unknown';
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function summarizeFixes(runId: string, sourceRun: string, startedAt: string, results: FixResult[]): FixSummary {
  const byOutcome: Record<FixOutcome, number> = { fixed: 0, not_fixed: 0, agent_timeout: 0, agent_error: 0, restore_failed: 0, fence_blocked: 0, build_hangs: 0, skipped: 0 };
  const byFailedStage: Record<string, { attempted: number; fixed: number }> = {};
  for (const r of results) {
    byOutcome[r.outcome]++;
    const k = r.failedStage ?? 'unknown';
    byFailedStage[k] ??= { attempted: 0, fixed: 0 };
    byFailedStage[k].attempted++;
    if (r.outcome === 'fixed') byFailedStage[k].fixed++;
  }
  const fixed = results.filter((r) => r.outcome === 'fixed');
  const costs = results.map((r) => r.agent.costUsd).filter((c): c is number => typeof c === 'number');
  return {
    runId, sourceRun, startedAt, finishedAt: new Date().toISOString(),
    attempted: results.filter((r) => !['skipped', 'restore_failed', 'agent_error', 'fence_blocked'].includes(r.outcome)).length,
    byOutcome,
    fixedTrivial: fixed.filter((r) => r.trivial).length,
    fixedLarge: fixed.filter((r) => r.trivial === false).length,
    medianDiffLinesFixed: median(fixed.map((r) => r.diffLinesAdded + r.diffLinesRemoved)),
    medianAgentMinutes: median(results.filter((r) => r.agent.durationMs).map((r) => Math.round((r.agent.durationMs as number) / 6000) / 10)),
    totalCostUsd: costs.length ? Math.round(costs.reduce((a, b) => a + b, 0) * 100) / 100 : null,
    medianCostUsdFixed: (() => { const m = median(fixed.map((r) => r.agent.costUsd).filter((c): c is number => typeof c === 'number')); return m === null ? null : Math.round(m * 100) / 100; })(),
    fixedWithFlags: fixed.filter((r) => r.suspicious.length > 0).length,
    byModel: results.filter((r) => r.outcome !== 'skipped').reduce<Record<string, { attempted: number; fixed: number }>>((acc, r) => {
      const k = r.agent.model ?? 'unknown';
      acc[k] ??= { attempted: 0, fixed: 0 };
      acc[k].attempted++;
      if (r.outcome === 'fixed') acc[k].fixed++;
      return acc;
    }, {}),
    byFailedStage,
    networkRestrictedAll: results.every((r) => ['skipped', 'restore_failed', 'agent_error'].includes(r.outcome) || r.networkRestricted),
    costBasis: results.some((r) => r.credentialKind === 'api_key') ? 'billed' : results.some((r) => r.credentialKind === 'oauth_token') ? 'estimated' : 'unknown',
  };
}

export function printFixSummary(s: FixSummary): string {
  const lines: string[] = [];
  lines.push(`hackfix ${s.runId} over ${s.sourceRun}: ${s.attempted} broken builds handed to an agent (${Object.values(s.byOutcome).reduce((a, b) => a + b, 0)} machines)`);
  for (const [k, v] of Object.entries(s.byOutcome)) if (v) lines.push(`  ${k.padEnd(16)} ${String(v).padStart(4)}`);
  if (s.byOutcome.fixed) {
    lines.push(`  fixed with <= trivial ceiling: ${s.fixedTrivial}; larger: ${s.fixedLarge}; median diff ${s.medianDiffLinesFixed} lines; ${s.fixedWithFlags} with red flags in the diff`);
  }
  for (const [stage, v] of Object.entries(s.byFailedStage)) lines.push(`  stage ${stage.padEnd(8)} ${v.fixed}/${v.attempted} fixed`);
  if (s.medianAgentMinutes !== null) lines.push(`  median agent time ${s.medianAgentMinutes} min`);
  if (s.totalCostUsd !== null) lines.push(`  model cost (${s.costBasis}): $${s.totalCostUsd} total${s.medianCostUsdFixed !== null ? `, median $${s.medianCostUsdFixed} per fix` : ''}`);
  lines.push(`  network restricted on every machine: ${s.networkRestrictedAll ? 'yes' : 'NO (check errors)'}`);
  const models = Object.entries(s.byModel);
  if (models.length) lines.push(`  model${models.length > 1 ? 's (MIXED: say so if you publish)' : ''}: ${models.map(([m, v]) => `${m} ${v.fixed}/${v.attempted}`).join(', ')}`);
  return lines.join('\n');
}


/** What is actually on a machine: repo present or not, and every checkpoint it has. For --inspect. */
export async function inspectOne(executor: SpritesExecutor, r: RepoResult): Promise<string> {
  const ref = parseCheckpointRef(r.checkpointRef);
  if (!ref) return `${r.repo}: no checkpoint reference`;
  try {
    const sb = await executor.attach(ref.name);
    const has = await sb.exec(`test -d "${sb.workdir}/.git" && echo yes || echo no; ls -a "${sb.workdir}" 2>/dev/null | head -20 | tr '\n' ' '`, { timeoutMs: 30_000 });
    const cps = await sb.checkpoints();
    const lines = [
      `${ref.name}  recorded checkpoint: ${ref.id ?? '(none)'}  repo present: ${has.stdout.split('\n')[0].trim()}`,
      `  top-level: ${has.stdout.split('\n').slice(1).join(' ').trim() || '(empty)'}`,
      ...cps.map((c) => `  ${c.id.padEnd(8)} ${new Date(c.createTime).toISOString()}  ${c.isAuto ? 'auto ' : '     '} ${c.comment ?? ''}`),
    ];
    return lines.join('\n');
  } catch (err) {
    return `${ref.name}: ${err instanceof Error ? err.message : String(err)}`;
  }
}
