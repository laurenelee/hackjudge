# hackjudge

Judges read the README and watch the video. Nobody runs the code.

hackjudge runs it. Give it a list of submission repos and it puts each one in its
own fresh sandbox, clones it, installs dependencies, compiles whatever there is to
compile, runs whatever tests exist, and records exactly which step the submission
got to. Failures are checkpointed so a judge (or the team) can open the exact
broken state instead of guessing from a log.

It is not a scoring tool. It answers one question judges cannot answer by reading:
does this thing build?

## The ladder

Every submission lands on exactly one rung.

| verdict | meaning |
| --- | --- |
| `unreachable` | could not clone: deleted, private, or the link was never a repo |
| `empty` | repo exists but has fewer than 3 source files |
| `not_evaluable` | has code, but either no build system we recognise or a toolchain *we* could not obtain (this is our failure, not theirs) |
| `install_failed` | dependencies would not install |
| `build_failed` | installed, but compile or build failed (`failedStage` says which) |
| `installed_no_build` | installed; there was no build or compile step to check |
| `built_no_tests` | built; no tests to run |
| `tests_failed` | built; tests exist and fail |
| `tests_passed` | built; tests pass |

"Built" in the summary means `built_no_tests`, `tests_failed` or `tests_passed`.
`installed_no_build` is reported separately: nothing failed, but nothing was
checked either, and pretending otherwise would flatter the number.

## Running it

Input is a CSV with a header and at least a `repo` column. `cohort` and `stage`
are carried through to the results so you can slice by event.

```csv
repo,cohort,stage
https://github.com/org/project,event-a,submission
```

### Dry run, locally

The local executor runs every step on the machine you are sitting at. It has no
isolation. Use it to develop the pipeline on repos you already trust.

```sh
npm install
npm run judge -- --input data/sample.csv --executor local --limit 5
```

### The real run, on Sprites

One [Sprite](https://sprites.dev) per submission. Failed sprites are checkpointed
and kept; passing sprites are deleted.

```sh
# one-time: sign in with your Fly.io account, then create a token at sprites.dev/account
npm i -g @fly/sprite-cli   # or follow docs.sprites.dev/cli/installation
sprite org auth

export SPRITES_TOKEN="..."
npm run judge -- --input data/sample.csv --executor sprites --concurrency 8
```

Options: `--cohort <name>` to run one event, `--limit N` / `--offset N` to run a
slice, `--region <code>`, `--no-keep-failures` to delete everything regardless.

When you have finished looking at the failures: `npm run judge -- --cleanup`
deletes every sprite the tool created (they are all named `hj-*`).

## Output

`results/<run>.jsonl` has one line per repo with the inventory, every stage's
exit code and the last 40 lines of its output. `results/<run>.csv` is the same,
one row per repo, for a spreadsheet. `results/<run>.summary.json` is counts and
rates only.

Only the summary is safe to publish. The other two name repos and quote their
build output, and a student's weekend project does not belong in a blog post
about failure rates.

## What it does not do

It does not run the app, hit a demo URL, or judge quality. It does not know
whether a project that builds does what its README says. It treats "no build
step" honestly rather than optimistically. It will report a repo as
`not_evaluable` when the toolchain it needs cannot be fetched into the sandbox,
because that is a fact about our environment, not about the submission.

## Layout

```
src/cli.ts               argument parsing, concurrency pool, run loop
src/pipeline.ts          clone → inventory → install → compile → build → test
src/inventory.ts         what is in the repo; which build system; which directory
src/executors/local.ts   temp dir + bash, for development
src/executors/sprites.ts one Sprite per repo, checkpoint on failure
src/report.ts            jsonl, csv, summary
```
