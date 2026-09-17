/**
 * Core types for hackjudge.
 *
 * The pipeline is deliberately simple: clone → inventory → detect → install → build → test.
 * Every stage produces evidence; the verdict is derived from the evidence, never guessed.
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

export interface ExecOpts {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

/**
 * A sandbox is one isolated environment for one submission.
 * Local and Sprites implementations share this surface so the pipeline
 * does not care where it runs.
 */
export interface Sandbox {
  readonly id: string;
  /** Working directory inside the sandbox where the repo is cloned. */
  readonly workdir: string;
  exec(command: string, opts?: ExecOpts): Promise<ExecResult>;
  /**
   * Preserve the current state so a human can inspect the exact failure later.
   * Returns an opaque reference (checkpoint id, path, etc.) or null if unsupported.
   */
  checkpoint(comment: string): Promise<string | null>;
  /** Tear the sandbox down. Called on pass; skipped on failure when keepFailures is set. */
  destroy(): Promise<void>;
}

export interface Executor {
  readonly name: 'local' | 'sprites';
  create(name: string): Promise<Sandbox>;
}

export type BuildSystem =
  | 'npm'
  | 'yarn'
  | 'pnpm'
  | 'bun'
  | 'cargo'
  | 'go'
  | 'python-pip'
  | 'python-poetry'
  | 'python-uv'
  | 'foundry'
  | 'hardhat'
  | 'none';

export type Verdict =
  | 'unreachable'        // could not clone (deleted, private, wrong URL)
  | 'empty'              // repo exists but has no meaningful source
  | 'not_evaluable'      // has source but no build system we recognise
  | 'install_failed'     // dependencies would not install
  | 'build_failed'       // installed, but build/compile step failed
  | 'installed_no_build' // dependencies installed; repo has no build or compile step to check
  | 'built_no_tests'     // built, but no tests exist to run
  | 'tests_failed'       // built, tests exist, tests fail
  | 'tests_passed';      // built and tests pass

export type Stage = 'clone' | 'inventory' | 'install' | 'compile' | 'build' | 'test';

export interface StageResult {
  stage: Stage;
  command?: string;
  exitCode?: number;
  durationMs: number;
  timedOut?: boolean;
  /** Last ~40 lines of combined output, for diagnosis. Never published. */
  tail?: string;
}

export interface Inventory {
  fileCount: number;
  sourceFileCount: number;
  byExtension: Record<string, number>;
  hasReadme: boolean;
  readmeBytes: number;
  hasDockerfile: boolean;
  hasCi: boolean;
  hasLockfile: boolean;
  hasCompactContracts: boolean;
  hasSolidity: boolean;
  hasEnvExample: boolean;
  commitCount: number;
  lastCommitIso: string | null;
  /** Detected project root relative to repo root ('.' when at top level). */
  projectDir: string;
  buildSystem: BuildSystem;
  hasBuildScript: boolean;
  hasTestScript: boolean;
  /** package.json "test" is the npm placeholder that exits 1 */
  testScriptIsPlaceholder: boolean;
  /** A script that compiles smart contracts (Compact, hardhat) before the app build. */
  contractCompileScript: string | null;
}

export interface RepoResult {
  repo: string;
  cohort: string;
  stage: string;
  executor: string;
  sandboxId: string;
  startedAt: string;
  finishedAt: string;
  totalMs: number;
  verdict: Verdict;
  failedStage?: Stage;
  inventory?: Inventory;
  stages: StageResult[];
  /** Where a human can go look at the failure: checkpoint id, local path, etc. */
  checkpointRef?: string | null;
  error?: string;
}

export interface RunSummary {
  runId: string;
  executor: string;
  startedAt: string;
  finishedAt: string;
  total: number;
  byVerdict: Record<Verdict, number>;
  byCohort: Record<string, Record<Verdict, number>>;
  byBuildSystem: Record<string, number>;
  /** Share of evaluable repos (excludes unreachable/empty/not_evaluable) that built. */
  buildRateEvaluable: number;
  /** Share of all repos that built. */
  buildRateAll: number;
  medianWallMs: number;
  totalSandboxSeconds: number;
}
