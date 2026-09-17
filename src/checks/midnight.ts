/**
 * Sponsor-tech verification, Midnight edition.
 *
 * Every sponsored hackathon asks the same question: did the team actually use our
 * technology, or put our logo on a slide? Judges answer it by reading READMEs. This
 * module answers it by looking at the contract and compiling it.
 *
 * It produces a ladder, not a score:
 *   no_contract        no .compact file in the repo
 *   template_contract  the contract is (nearly) a starter-kit example, unmodified
 *   ledger_only        a real contract, but no private inputs: nothing here needed ZK
 *   private_state      declares witnesses (private inputs) and/or discloses selectively
 *
 * And it compiles each contract twice: with the compiler its pragma asks for (falling
 * back to the newest that existed on the repo's last commit date), and with today's.
 * The gap between those two answers is toolchain drift, measured rather than asserted.
 *
 * Other ecosystems get their own file in this directory. The pipeline only knows the
 * shape of the result.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sandbox, Inventory } from '../types.js';

export type ContractLadder = 'no_contract' | 'template_contract' | 'ledger_only' | 'private_state';

export interface ContractCheck {
  ecosystem: 'midnight';
  files: string[];
  ladder: ContractLadder;
  /** Counts across all contract files. */
  witnesses: number;
  discloses: number;
  ledgers: number;
  circuits: number;
  pragmaVersions: string[];
  /** Best match against known starter contracts, if any is close. */
  templateMatch: { name: string; similarity: number } | null;
  /** @midnight-ntwrk/* packages declared in any package.json. */
  midnightJsDeps: string[];
  /** Source files importing @midnight-ntwrk/* */
  midnightJsImportFiles: number;
  /** Compiler the contract asked for (from its pragma), else the newest as of the last commit. */
  pinnedCompiler: string | null;
  pinnedBy: 'pragma' | 'date' | null;
  /** Per-file outcome with the pinned compiler: files that compiled / files tried. */
  filesCompiledPinned: string;
  filesCompiledLatest: string;
  latestCompiler: string | null;
  /** null = could not run the compiler at all (our problem, not theirs). */
  compilesPinned: boolean | null;
  compilesLatest: boolean | null;
  compileTailPinned?: string;
  compileTailLatest?: string;
  durationMs: number;
}

/**
 * compactc releases, from tags on midnightntwrk/compact (archived Sept 2026; development
 * moved to LFDT-Minokawa/compact). Dates are the tagged commit's date, which is close to
 * but not exactly the release date. Only versions that actually exist on the release
 * server are listed, so `compact update <v>` will succeed.
 */
const COMPILER_RELEASES: Array<{ version: string; date: string }> = [
  { version: '0.22.0', date: '2025-04-16' },
  { version: '0.23.0', date: '2025-05-02' },
  { version: '0.24.0', date: '2025-05-02' },
  { version: '0.25.0', date: '2025-08-10' },
  { version: '0.26.0', date: '2025-09-09' },
  { version: '0.28.0', date: '2026-01-27' },
  { version: '0.29.0', date: '2026-01-27' },
  { version: '0.30.0', date: '2026-03-01' },
  { version: '0.31.0', date: '2026-03-24' },
  { version: '0.31.1', date: '2026-06-12' },
  { version: '0.34.0', date: '2026-08-16' },
];

/**
 * The contract's `pragma language_version` names the language it was written for, and the
 * changelog pairs every toolchain with a language version at a fixed offset: language 0.26
 * is toolchain 0.34, 0.23 is 0.31, 0.18 is 0.26. Minor plus eight, as far back as 0.16/0.24.
 * When a pragma pins or upper-bounds a version, that is the compiler the team used.
 */
export function compilerForPragma(pragma: string | null): string | null {
  if (!pragma) return null;
  const versions = [...pragma.matchAll(/(\d+)\.(\d+)(?:\.(\d+))?/g)].map((m) => ({ major: +m[1], minor: +m[2] }));
  if (!versions.length) return null;
  // A pure lower bound (">= x") is satisfied by the latest compiler; only pins and upper bounds select one.
  const hasUpperOrExact = /<|==|^\s*\d/.test(pragma.trim()) || !/>=|>/.test(pragma);
  if (!hasUpperOrExact) return null;
  const lang = versions.reduce((a, b) => (b.minor > a.minor ? b : a));
  if (lang.major !== 0 || lang.minor < 14) return null;
  return `0.${lang.minor + 8}`;
}

export function compilerAsOf(isoDate: string | null): string | null {
  if (!isoDate) return null;
  const day = isoDate.slice(0, 10);
  const eligible = COMPILER_RELEASES.filter((r) => r.date <= day);
  return eligible.at(-1)?.version ?? COMPILER_RELEASES[0].version;
}

const COMPACT_PATH = `export PATH="$HOME/.local/bin:$HOME/.compact/bin:$PATH"`;
const COMPACT_INSTALL_CLI = `${COMPACT_PATH}; command -v compact >/dev/null || curl --proto '=https' --tlsv1.2 -LsSf https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh >/dev/null 2>&1; ${COMPACT_PATH}; command -v compact`;

// ---- template similarity -------------------------------------------------------------

function normalizeCompact(src: string): string[] {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/pragma\s+language_version[^;]*;/g, ' ')
    .split(/[^A-Za-z0-9_<>"]+/)
    .filter(Boolean);
}

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

let templates: Array<{ name: string; tokens: string[] }> | null = null;
function loadTemplates(): Array<{ name: string; tokens: string[] }> {
  if (templates) return templates;
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'templates');
  templates = readdirSync(dir)
    .filter((f) => f.endsWith('.compact'))
    .map((f) => ({ name: f.replace(/\.compact$/, ''), tokens: normalizeCompact(readFileSync(join(dir, f), 'utf8')) }));
  return templates;
}

export function bestTemplateMatch(src: string): { name: string; similarity: number } | null {
  const toks = normalizeCompact(src);
  let best: { name: string; similarity: number } | null = null;
  for (const t of loadTemplates()) {
    const s = jaccard(toks, t.tokens);
    if (!best || s > best.similarity) best = { name: t.name, similarity: Math.round(s * 1000) / 1000 };
  }
  return best;
}

/** Above this, the contract is the starter with the names changed. Calibrated loosely; report the number too. */
const TEMPLATE_THRESHOLD = 0.85;

// ---- the check -------------------------------------------------------------------------

export async function checkMidnight(sb: Sandbox, inv: Inventory): Promise<ContractCheck> {
  const t0 = Date.now();
  const result: ContractCheck = {
    ecosystem: 'midnight',
    files: [],
    ladder: 'no_contract',
    witnesses: 0,
    discloses: 0,
    ledgers: 0,
    circuits: 0,
    pragmaVersions: [],
    templateMatch: null,
    midnightJsDeps: [],
    midnightJsImportFiles: 0,
    pinnedCompiler: null,
    pinnedBy: null,
    filesCompiledPinned: '',
    filesCompiledLatest: '',
    latestCompiler: null,
    compilesPinned: null,
    compilesLatest: null,
    durationMs: 0,
  };

  // MidnightJS usage is checkable even without a contract.
  const deps = await sb.exec(
    `cd ${sb.workdir} && find . -name package.json -not -path '*/node_modules/*' -maxdepth 4 -exec cat {} + 2>/dev/null | grep -o '"@midnight-ntwrk/[^"]*"' | sort -u`,
    { timeoutMs: 30_000 },
  );
  result.midnightJsDeps = deps.stdout.split('\n').map((s) => s.replace(/"/g, '').trim()).filter(Boolean);
  const imports = await sb.exec(
    `cd ${sb.workdir} && grep -rl --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next '@midnight-ntwrk/' . 2>/dev/null | wc -l`,
    { timeoutMs: 30_000 },
  );
  result.midnightJsImportFiles = parseInt(imports.stdout.trim(), 10) || 0;

  if (!inv.hasCompactContracts) {
    result.durationMs = Date.now() - t0;
    return result;
  }

  // Contract sources. Cap at 10 files and 200KB each; hackathon contracts are small.
  const list = await sb.exec(
    `cd ${sb.workdir} && find . -name '*.compact' -not -path '*/node_modules/*' -not -path '*/managed/*' | head -10`,
    { timeoutMs: 30_000 },
  );
  result.files = list.stdout.split('\n').map((s) => s.trim().replace(/^\.\//, '')).filter(Boolean);

  const sources: string[] = [];
  for (const f of result.files) {
    const r = await sb.exec(`head -c 200000 "${sb.workdir}/${f}"`, { timeoutMs: 15_000 });
    sources.push(r.stdout);
  }
  const all = sources.join('\n');
  result.witnesses = (all.match(/^\s*(export\s+)?witness\s+\w+/gm) ?? []).length;
  result.discloses = (all.match(/\bdisclose\s*\(/g) ?? []).length;
  result.ledgers = (all.match(/^\s*(export\s+)?ledger\s+\w+/gm) ?? []).length;
  result.circuits = (all.match(/^\s*(export\s+)?circuit\s+\w+/gm) ?? []).length;
  result.pragmaVersions = [...new Set((all.match(/pragma\s+language_version\s+([^;]+);/g) ?? []).map((m) => m.replace(/pragma\s+language_version\s+/, '').replace(';', '').trim()))];

  // Template match on the largest contract (the "main" one).
  const main = sources.reduce((a, b) => (b.length > a.length ? b : a), '');
  result.templateMatch = main ? bestTemplateMatch(main) : null;

  if (result.templateMatch && result.templateMatch.similarity >= TEMPLATE_THRESHOLD) result.ladder = 'template_contract';
  else if (result.witnesses > 0) result.ladder = 'private_state';
  else result.ladder = 'ledger_only';

  // Compile twice: with the compiler the contract asked for, then with today's.
  // Each file is compiled on its own so one stray module cannot sink the repo; the
  // repo "compiles" when every file does, and the per-file count is reported either way.
  const cli = await sb.exec(COMPACT_INSTALL_CLI, { timeoutMs: 3 * 60_000 });
  if (cli.exitCode === 0) {
    const mainPragma = (main.match(/pragma\s+language_version\s+([^;]+);/) ?? [null, null])[1];
    const byPragma = compilerForPragma(mainPragma);
    result.pinnedCompiler = byPragma ?? compilerAsOf(inv.lastCommitIso);
    result.pinnedBy = byPragma ? 'pragma' : result.pinnedCompiler ? 'date' : null;

    const compileEach = result.files
      .map((f, i) => `if compact compile "${sb.workdir}/${f}" "/tmp/hj-compact-out/${i}" >/tmp/hj-compact-log-${i} 2>&1; then echo "HJ_OK ${i}"; else echo "HJ_FAIL ${i}"; tail -n 3 /tmp/hj-compact-log-${i}; fi`)
      .join('; ');
    const parse = (out: string) => {
      const ok = (out.match(/^HJ_OK \d+$/gm) ?? []).length;
      const fail = (out.match(/^HJ_FAIL \d+$/gm) ?? []).length;
      const tail = out.split('\n').filter((l) => l && !/^HJ_(OK|FAIL)/.test(l)).slice(-12).join('\n').slice(-2000);
      return { ok, fail, tail, tried: ok + fail };
    };

    if (result.pinnedCompiler) {
      const pinned = await sb.exec(
        `${COMPACT_PATH}; compact update ${result.pinnedCompiler} >/tmp/hj-update 2>&1 || { echo HJ_TOOLCHAIN_FAIL; cat /tmp/hj-update; exit 3; }; rm -rf /tmp/hj-compact-out; ${compileEach}`,
        { timeoutMs: 8 * 60_000 },
      );
      if (pinned.exitCode === 3 || /HJ_TOOLCHAIN_FAIL/.test(pinned.stdout)) {
        result.compilesPinned = null;
        result.compileTailPinned = 'toolchain ' + result.pinnedCompiler + ' unavailable: ' + pinned.stdout.split('\n').slice(-3).join(' ').slice(-300);
      } else {
        const r = parse(pinned.stdout + pinned.stderr);
        result.filesCompiledPinned = `${r.ok}/${r.tried}`;
        result.compilesPinned = r.tried > 0 ? r.fail === 0 : null;
        if (r.fail) result.compileTailPinned = r.tail;
      }
    }

    const latest = await sb.exec(
      `${COMPACT_PATH}; compact update >/dev/null 2>&1; compact compile --version 2>/dev/null | head -1; rm -rf /tmp/hj-compact-out; ${compileEach}`,
      { timeoutMs: 8 * 60_000 },
    );
    result.latestCompiler = (latest.stdout.match(/\d+\.\d+\.\d+/) ?? [null])[0];
    const r = parse(latest.stdout + latest.stderr);
    result.filesCompiledLatest = `${r.ok}/${r.tried}`;
    result.compilesLatest = r.tried > 0 ? r.fail === 0 : null;
    if (r.fail) result.compileTailLatest = r.tail;

    // Leave the compiler the contract asked for as the default, so the repo's own
    // compile script (run later in the pipeline) builds the way the team built it.
    if (result.pinnedBy === 'pragma' && result.compilesPinned !== null) {
      await sb.exec(`${COMPACT_PATH}; compact update ${result.pinnedCompiler} >/dev/null 2>&1 || true`, { timeoutMs: 3 * 60_000 });
    }
  }

  result.durationMs = Date.now() - t0;
  return result;
}
