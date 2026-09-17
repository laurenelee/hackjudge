/**
 * Inventory: what is actually in this repo?
 *
 * Everything here runs inside the sandbox via shell, so it works identically on
 * the local executor and on a Sprite. We list files once and reason about the list.
 */
import type { Sandbox, Inventory, BuildSystem } from './types.js';

const SOURCE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'sol', 'compact', 'java', 'kt', 'rb', 'php',
  'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'swift', 'dart', 'vue', 'svelte', 'move', 'cairo', 'circom', 'nr',
]);

const IGNORED_DIRS = ['node_modules', '.git', 'dist', 'build', 'target', '.next', 'vendor', '__pycache__', '.venv', 'venv'];

interface PkgJson {
  scripts?: Record<string, string>;
  workspaces?: unknown;
}

function extOf(path: string): string {
  const base = path.split('/').pop() ?? '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '.' : path.slice(0, i);
}

function depth(path: string): number {
  return path === '.' ? 0 : path.split('/').length;
}

/**
 * Choose the directory we will try to build. Preference order:
 *  1. repo root if it has a manifest
 *  2. shallowest directory with a manifest, tie-broken toward names that suggest the "main" app
 */
function pickProjectDir(manifestDirs: string[]): string {
  if (manifestDirs.includes('.')) return '.';
  const score = (d: string) => {
    const name = d.split('/').pop()!.toLowerCase();
    let s = depth(d) * 10;
    if (/^(app|web|frontend|client|ui|dapp|contract|contracts|api|backend|server|src|packages\/.*)$/.test(name)) s -= 3;
    if (/example|demo|test|docs?$/.test(name)) s += 5;
    return s;
  };
  return [...manifestDirs].sort((a, b) => score(a) - score(b))[0] ?? '.';
}

export async function takeInventory(sb: Sandbox): Promise<Inventory> {
  const prune = IGNORED_DIRS.map((d) => `-name ${d}`).join(' -o ');
  const list = await sb.exec(
    `cd ${sb.workdir} && find . \\( ${prune} \\) -prune -o -type f -print | sed 's|^\\./||' | head -20000`,
    { timeoutMs: 60_000 },
  );
  const files = list.stdout.split('\n').map((s) => s.trim()).filter(Boolean);

  const byExtension: Record<string, number> = {};
  let sourceFileCount = 0;
  for (const f of files) {
    const e = extOf(f);
    if (!e) continue;
    byExtension[e] = (byExtension[e] ?? 0) + 1;
    if (SOURCE_EXT.has(e)) sourceFileCount++;
  }

  const has = (re: RegExp) => files.some((f) => re.test(f));
  const dirsWith = (re: RegExp) => [...new Set(files.filter((f) => re.test(f)).map(dirOf))];

  // Manifests we know how to drive.
  const pkgDirs = dirsWith(/(^|\/)package\.json$/);
  const cargoDirs = dirsWith(/(^|\/)Cargo\.toml$/);
  const goDirs = dirsWith(/(^|\/)go\.mod$/);
  const pyDirs = dirsWith(/(^|\/)(pyproject\.toml|requirements\.txt|setup\.py)$/);
  const foundryDirs = dirsWith(/(^|\/)foundry\.toml$/);

  const allManifestDirs = [...new Set([...pkgDirs, ...cargoDirs, ...goDirs, ...pyDirs, ...foundryDirs])];
  const projectDir = pickProjectDir(allManifestDirs);

  let buildSystem: BuildSystem = 'none';
  let hasBuildScript = false;
  let hasTestScript = false;
  let testScriptIsPlaceholder = false;
  let contractCompileScript: string | null = null;

  const inDir = (dirs: string[]) => dirs.includes(projectDir);
  const lockIn = (name: string) => files.includes(projectDir === '.' ? name : `${projectDir}/${name}`);

  if (inDir(foundryDirs)) {
    buildSystem = 'foundry';
    hasBuildScript = true;
    hasTestScript = has(new RegExp(`^${projectDir === '.' ? '' : projectDir + '/'}test/.*\\.t\\.sol$`));
  } else if (inDir(pkgDirs)) {
    const raw = await sb.exec(`cat ${sb.workdir}/${projectDir}/package.json`, { timeoutMs: 15_000 });
    let pkg: PkgJson = {};
    try { pkg = JSON.parse(raw.stdout) as PkgJson; } catch { /* malformed package.json is itself a finding */ }
    const scripts = pkg.scripts ?? {};
    hasBuildScript = typeof scripts.build === 'string';
    hasTestScript = typeof scripts.test === 'string';
    testScriptIsPlaceholder = hasTestScript && /no test specified/i.test(scripts.test!);
    if (lockIn('pnpm-lock.yaml')) buildSystem = 'pnpm';
    else if (lockIn('yarn.lock')) buildSystem = 'yarn';
    else if (lockIn('bun.lockb') || lockIn('bun.lock')) buildSystem = 'bun';
    else buildSystem = 'npm';
    // Contract compilation is usually a separate script the app build depends on.
    for (const name of ['compact', 'compile', 'compile:contract', 'compile-contract', 'build:contract', 'compact:compile']) {
      if (typeof scripts[name] === 'string' && /compact|hardhat|forge/.test(scripts[name]!)) { contractCompileScript = name; break; }
    }
  } else if (inDir(cargoDirs)) {
    buildSystem = 'cargo';
    hasBuildScript = true;
    hasTestScript = true; // cargo test is always runnable; "no tests" surfaces as 0 tests run
  } else if (inDir(goDirs)) {
    buildSystem = 'go';
    hasBuildScript = true;
    hasTestScript = has(/_test\.go$/);
  } else if (inDir(pyDirs)) {
    const pfx = projectDir === '.' ? '' : projectDir + '/';
    if (files.includes(`${pfx}uv.lock`)) buildSystem = 'python-uv';
    else if (files.includes(`${pfx}poetry.lock`)) buildSystem = 'python-poetry';
    else buildSystem = 'python-pip';
    hasBuildScript = false; // Python has no build step in the sense we mean; install is the gate
    hasTestScript = has(/(^|\/)(tests?\/|test_[^/]+\.py$|[^/]+_test\.py$)/);
  }

  const readme = files.find((f) => /^readme(\.md|\.rst|\.txt)?$/i.test(f));
  let readmeBytes = 0;
  if (readme) {
    const r = await sb.exec(`wc -c < "${sb.workdir}/${readme}"`, { timeoutMs: 10_000 });
    readmeBytes = parseInt(r.stdout.trim(), 10) || 0;
  }

  const git = await sb.exec(
    `cd ${sb.workdir} && git rev-list --count HEAD 2>/dev/null; git log -1 --format=%cI 2>/dev/null`,
    { timeoutMs: 15_000 },
  );
  const [countStr, lastIso] = git.stdout.trim().split('\n');

  return {
    fileCount: files.length,
    sourceFileCount,
    byExtension,
    hasReadme: Boolean(readme),
    readmeBytes,
    hasDockerfile: has(/(^|\/)Dockerfile/),
    hasCi: has(/^\.github\/workflows\/.*\.ya?ml$/) || has(/^\.gitlab-ci\.yml$/),
    hasLockfile: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'Cargo.lock', 'go.sum', 'poetry.lock', 'uv.lock'].some(lockIn),
    hasCompactContracts: has(/\.compact$/),
    hasSolidity: has(/\.sol$/),
    hasEnvExample: has(/(^|\/)\.env\.(example|sample|template)$/),
    commitCount: parseInt(countStr ?? '0', 10) || 0,
    lastCommitIso: lastIso?.trim() || null,
    projectDir,
    buildSystem,
    hasBuildScript,
    hasTestScript,
    testScriptIsPlaceholder,
    contractCompileScript,
  };
}
