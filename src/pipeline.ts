/**
 * The pipeline for one submission.
 *
 * clone → inventory → install → build → test
 *
 * Stops at the first failing stage. The verdict names the stage that failed,
 * so "didn't work" is never the answer; "dependencies would not install" is.
 */
import type { Sandbox, Executor, RepoResult, StageResult, Stage, Verdict, Inventory, ExecResult } from './types.js';
import { takeInventory } from './inventory.js';
import { checkMidnight } from './checks/midnight.js';
import type { ContractCheck } from './checks/midnight.js';

export interface PipelineOptions {
  cloneTimeoutMs: number;
  installTimeoutMs: number;
  buildTimeoutMs: number;
  testTimeoutMs: number;
  /** Keep (and checkpoint) sandboxes for failed repos. */
  keepFailures: boolean;
  /** Minimum source files to count as more than an empty repo. */
  minSourceFiles: number;
}

export const defaultPipelineOptions: PipelineOptions = {
  cloneTimeoutMs: 3 * 60_000,
  installTimeoutMs: 10 * 60_000,
  buildTimeoutMs: 10 * 60_000,
  testTimeoutMs: 5 * 60_000,
  keepFailures: true,
  minSourceFiles: 3,
};

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

function tail(r: ExecResult, lines = 40): string {
  const combined = (r.stdout + '\n' + r.stderr).replace(ANSI, '').split('\n').filter(Boolean);
  return combined.slice(-lines).join('\n').slice(-6000);
}

function stageOf(stage: Stage, r: ExecResult, command?: string): StageResult {
  return { stage, command, exitCode: r.exitCode, durationMs: r.durationMs, timedOut: r.timedOut, tail: tail(r) };
}

/** Commands per build system. Returned as null when the step does not apply. */
// Compact (Midnight's contract language) ships its own CLI; hackathon repos assume it is on PATH.
// The installer puts the binary in ~/.local/bin; `compact update` fetches the compiler via the GitHub API.
export const COMPACT_TOOLCHAIN = `export PATH="$HOME/.local/bin:$HOME/.compact/bin:$PATH"; command -v compact >/dev/null || curl --proto '=https' --tlsv1.2 -LsSf https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh; compact compile --version >/dev/null 2>&1 || compact update`;
const TOOLCHAIN_PATH = `export PATH="$HOME/.local/bin:$HOME/.compact/bin:$PATH" &&`;

// The Sprite image ships Node and npm only. Rather than hoping a global install lands on
// PATH, resolve each package manager to the real binary if present, else run it via npx.
const PM = {
  pnpm: `$(command -v pnpm || echo "npx -y pnpm")`,
  yarn: `$(command -v yarn || echo "npx -y yarn")`,
  bun: `$(command -v bun || echo "npx -y bun")`,
};

function jsRun(inv: Inventory): string {
  switch (inv.buildSystem) {
    case 'yarn': return `${PM.yarn}`;
    case 'pnpm': return `${PM.pnpm} run`;
    case 'bun': return `${PM.bun} run`;
    default: return 'npm run';
  }
}

function commandsFor(inv: Inventory): { install: string | null; compile: string | null; build: string | null; test: string | null } {
  const d = inv.projectDir;
  const cd = `cd "$WORKDIR/${d}" &&`;
  const isJs = ['npm', 'yarn', 'pnpm', 'bun'].includes(inv.buildSystem);
  const compile = isJs && inv.contractCompileScript
    ? `${cd} ${TOOLCHAIN_PATH} ${jsRun(inv)} ${inv.contractCompileScript}`
    : null;
  const base = baseCommandsFor(inv, cd);
  return { ...base, compile };
}

/** Toolchains the repo cannot be expected to vendor. A failure here is ours, not the submission's. */
function toolchainFor(inv: Inventory): { name: string; command: string } | null {
  if (inv.hasCompactContracts && inv.contractCompileScript) return { name: 'compact', command: COMPACT_TOOLCHAIN };
  return null;
}

function baseCommandsFor(inv: Inventory, cd: string): { install: string | null; build: string | null; test: string | null } {
  switch (inv.buildSystem) {
    case 'npm':
      return {
        install: `${cd} ${inv.hasLockfile ? 'npm ci --no-audit --no-fund --loglevel=error || npm install --no-audit --no-fund --loglevel=error' : 'npm install --no-audit --no-fund --loglevel=error'}`,
        build: inv.hasBuildScript ? `${cd} npm run build` : null,
        test: inv.hasTestScript && !inv.testScriptIsPlaceholder ? `${cd} npm test` : null,
      };
    case 'yarn':
      return {
        install: `${cd} ${PM.yarn} install --non-interactive 2>&1`,
        build: inv.hasBuildScript ? `${cd} ${PM.yarn} build` : null,
        test: inv.hasTestScript && !inv.testScriptIsPlaceholder ? `${cd} ${PM.yarn} test` : null,
      };
    case 'pnpm':
      return {
        install: `${cd} ${PM.pnpm} install --frozen-lockfile || ${PM.pnpm} install`,
        build: inv.hasBuildScript ? `${cd} ${PM.pnpm} run build` : null,
        test: inv.hasTestScript && !inv.testScriptIsPlaceholder ? `${cd} ${PM.pnpm} test` : null,
      };
    case 'bun':
      return {
        install: `${cd} ${PM.bun} install`,
        build: inv.hasBuildScript ? `${cd} ${PM.bun} run build` : null,
        test: inv.hasTestScript && !inv.testScriptIsPlaceholder ? `${cd} ${PM.bun} test` : null,
      };
    case 'cargo':
      return { install: null, build: `${cd} cargo build --locked 2>&1 || cargo build 2>&1`, test: `${cd} cargo test 2>&1` };
    case 'go':
      return { install: `${cd} go mod download`, build: `${cd} go build ./...`, test: inv.hasTestScript ? `${cd} go test ./...` : null };
    case 'foundry':
      return {
        install: `${cd} (command -v forge >/dev/null || (curl -L https://foundry.paradigm.xyz | bash && ~/.foundry/bin/foundryup)) && (forge install --no-commit 2>/dev/null || true)`,
        build: `${cd} forge build`,
        test: inv.hasTestScript ? `${cd} forge test` : null,
      };
    case 'python-uv':
      return { install: `${cd} (command -v uv >/dev/null || pip install -q uv) && uv sync`, build: null, test: inv.hasTestScript ? `${cd} uv run pytest -q` : null };
    case 'python-poetry':
      return { install: `${cd} (command -v poetry >/dev/null || pip install -q poetry) && poetry install --no-interaction`, build: null, test: inv.hasTestScript ? `${cd} poetry run pytest -q` : null };
    case 'python-pip':
      return {
        install: `${cd} python3 -m venv .venv && . .venv/bin/activate && pip install -q --upgrade pip && (test -f requirements.txt && pip install -q -r requirements.txt || pip install -q -e . )`,
        build: `${cd} . .venv/bin/activate && python -m compileall -q . -x '\\.venv'`,
        test: inv.hasTestScript ? `${cd} . .venv/bin/activate && (pip install -q pytest && pytest -q)` : null,
      };
    default:
      return { install: null, build: null, test: null };
  }
}

export async function judgeOne(
  executor: Executor,
  repo: string,
  cohort: string,
  stage: string,
  opts: PipelineOptions = defaultPipelineOptions,
): Promise<RepoResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const slug = repo.replace(/^https?:\/\/github\.com\//, '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase().slice(0, 40);
  const sandboxId = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
  const stages: StageResult[] = [];
  let verdict: Verdict = 'unreachable';
  let failedStage: Stage | undefined;
  let inventory: Inventory | undefined;
  let contract: ContractCheck | undefined;
  let checkpointRef: string | null | undefined;
  let error: string | undefined;

  let sb: Sandbox | null = null;
  try {
    sb = await executor.create(sandboxId);
    const env = { WORKDIR: sb.workdir, GIT_TERMINAL_PROMPT: '0' };

    // 1. clone (shallow: we judge the submitted state, not history)
    const clone = await sb.exec(
      `rm -rf "$WORKDIR" && git clone --depth 50 --recurse-submodules --shallow-submodules "${repo}" "$WORKDIR"`,
      { timeoutMs: opts.cloneTimeoutMs, env },
    );
    stages.push(stageOf('clone', clone, 'git clone'));
    if (clone.exitCode !== 0) {
      // Only GitHub saying no counts against the submission. Anything else (no git, no
      // network, a broken harness command) is our environment and is reported as such.
      const out = clone.stdout + clone.stderr;
      const githubSaidNo = /Repository not found|could not read Username|Authentication failed|remote: Not Found|is disabled|access denied|Please make sure you have the correct access rights/i.test(out);
      verdict = githubSaidNo ? 'unreachable' : 'not_evaluable';
      if (!githubSaidNo) error = 'clone failed for a reason other than GitHub refusing (environment?)';
      failedStage = 'clone';
      return finish();
    }

    // 2. inventory
    const tInv = Date.now();
    inventory = await takeInventory(sb);
    stages.push({ stage: 'inventory', durationMs: Date.now() - tInv });

    if (inventory.sourceFileCount < opts.minSourceFiles) {
      verdict = 'empty';
      failedStage = 'inventory';
      return finish();
    }

    // 2b. sponsor-tech verification. Runs before install so it is independent of whether
    // the app around the contract builds. Only Midnight for now; see src/checks/.
    if (inventory.hasCompactContracts || inventory.byExtension['ts'] || inventory.byExtension['js']) {
      try {
        contract = await checkMidnight(sb, inventory);
      } catch (err) {
        error = `contract check: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (inventory.buildSystem === 'none') {
      verdict = 'not_evaluable';
      failedStage = 'inventory';
      return finish();
    }

    const cmds = commandsFor(inventory);

    // 3. install
    if (cmds.install) {
      const r = await sb.exec(cmds.install, { timeoutMs: opts.installTimeoutMs, env });
      stages.push(stageOf('install', r, cmds.install));
      if (r.exitCode !== 0) {
        const missingTool = /(pnpm|yarn|bun|npx|npm|cargo|go|python3|pip|forge|uv|poetry): (command )?not found/i.exec(r.stdout + r.stderr);
        if (missingTool) {
          verdict = 'not_evaluable';
          failedStage = 'install';
          error = `toolchain ${missingTool[1]} unavailable in sandbox`;
          return finish();
        }
        verdict = 'install_failed';
        failedStage = 'install';
        return finish(true);
      }
    }

    // 4a. toolchain the submission depends on but does not ship (e.g. the Compact compiler).
    // If *we* cannot get the toolchain, the repo is not evaluable; that is not a failed build.
    const toolchain = toolchainFor(inventory);
    if (toolchain) {
      const r = await sb.exec(toolchain.command, { timeoutMs: opts.installTimeoutMs, env });
      if (r.exitCode !== 0) {
        stages.push(stageOf('compile', r, `toolchain:${toolchain.name}`));
        verdict = 'not_evaluable';
        failedStage = 'compile';
        error = `toolchain ${toolchain.name} unavailable in sandbox`;
        return finish();
      }
    }

    // 4b. contract compile (Compact / hardhat), when the repo has a script for it
    if (cmds.compile) {
      const r = await sb.exec(cmds.compile, { timeoutMs: opts.buildTimeoutMs, env });
      stages.push(stageOf('compile', r, cmds.compile));
      if (r.exitCode !== 0) {
        verdict = 'build_failed';
        failedStage = 'compile';
        return finish(true);
      }
    }

    // 4c. build
    if (!cmds.build && !cmds.compile) {
      verdict = 'installed_no_build';
      return finish();
    }
    if (cmds.build) {
      const r = await sb.exec(cmds.build, { timeoutMs: opts.buildTimeoutMs, env });
      stages.push(stageOf('build', r, cmds.build));
      if (r.exitCode !== 0) {
        verdict = 'build_failed';
        failedStage = 'build';
        return finish(true);
      }
    }

    // 5. test
    if (!cmds.test) {
      verdict = 'built_no_tests';
      return finish();
    }
    const r = await sb.exec(cmds.test, { timeoutMs: opts.testTimeoutMs, env });
    stages.push(stageOf('test', r, cmds.test));
    if (r.exitCode !== 0) {
      verdict = 'tests_failed';
      failedStage = 'test';
      return finish(true);
    }
    verdict = 'tests_passed';
    return finish();
  } catch (err) {
    error = err instanceof Error ? err.stack ?? err.message : String(err);
    return finish();
  }

  async function finish(preserve = false): Promise<RepoResult> {
    if (sb) {
      try {
        if (preserve && opts.keepFailures) {
          checkpointRef = await sb.checkpoint(`hackjudge ${verdict} at ${failedStage} for ${repo}`);
        } else {
          await sb.destroy();
        }
      } catch (err) {
        error = (error ? error + '\n' : '') + `teardown: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    return {
      repo,
      cohort,
      stage,
      executor: executor.name,
      sandboxId,
      startedAt,
      finishedAt: new Date().toISOString(),
      totalMs: Date.now() - t0,
      verdict,
      failedStage,
      inventory,
      contract,
      stages,
      checkpointRef,
      error,
    };
  }
}
