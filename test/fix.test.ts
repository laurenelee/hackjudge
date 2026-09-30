import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCheckpointRef,
  newlyBlockedHosts,
  summarizeFixes,
} from "../src/fix.js";
import type { FixResult } from "../src/fix.js";

test("parseCheckpointRef splits name and checkpoint id", () => {
  assert.deepEqual(parseCheckpointRef("sprite:hj-abc123@v3"), {
    name: "hj-abc123",
    id: "v3",
  });
  assert.deepEqual(parseCheckpointRef("sprite:hj-abc123"), {
    name: "hj-abc123",
    id: null,
  });
  assert.equal(parseCheckpointRef("local:/tmp/x"), null);
  assert.equal(parseCheckpointRef(null), null);
  assert.equal(parseCheckpointRef(undefined), null);
});

test("newlyBlockedHosts: a host the judge never saw means the fence changed the problem", () => {
  const judgeTail =
    'error TS2307: Cannot find module "@midnight-ntwrk/compact-runtime"';
  const out =
    "curl: (6) Could not resolve host: release-assets.githubusercontent.com";
  assert.deepEqual(newlyBlockedHosts(out, judgeTail), [
    "release-assets.githubusercontent.com",
  ]);
});

test("newlyBlockedHosts: the same host the judge already failed on is their problem, not the fence", () => {
  const judgeTail = "getaddrinfo ENOTFOUND api.example-service.io";
  const out = "getaddrinfo ENOTFOUND api.example-service.io";
  assert.deepEqual(newlyBlockedHosts(out, judgeTail), []);
});

test("newlyBlockedHosts: no network error at all means nothing is blocked", () => {
  assert.deepEqual(
    newlyBlockedHosts(
      'error: expected ";" at line 12',
      'error: expected ";" at line 12',
    ),
    [],
  );
});

test("newlyBlockedHosts: a network error naming no host, when the judge saw none, is still a fence symptom", () => {
  const out = "FetchError: Failed to fetch";
  assert.deepEqual(newlyBlockedHosts(out, "Type error in src/index.ts"), [
    "(unnamed host)",
  ]);
});

test("newlyBlockedHosts: file names that look like hosts are ignored", () => {
  const out =
    "Failed to fetch while loading src/contracts/counter.compact and dist/index.js";
  assert.deepEqual(newlyBlockedHosts(out, "unrelated judge output"), [
    "(unnamed host)",
  ]);
});

function result(over: Partial<FixResult>): FixResult {
  return {
    repo: "https://github.com/example/repo",
    spriteName: "hj-x",
    checkpointId: "v3",
    failedStage: "build",
    failingCommand: "npm run build",
    outcome: "fixed",
    diffFiles: 1,
    lockfileChanged: false,
    diffLinesAdded: 3,
    diffLinesRemoved: 1,
    untrackedFiles: 0,
    trivial: true,
    note: "fixed a path",
    diffStat: "",
    diff: "",
    suspicious: [],
    agent: {
      turns: 5,
      costUsd: 0.1,
      durationMs: 60_000,
      model: "claude-haiku",
      raw: "",
    },
    verify: { exitCode: 0, tail: "" },
    networkRestricted: true,
    credentialKind: "api_key",
    startedAt: "2026-09-20T00:00:00.000Z",
    totalMs: 90_000,
    ...over,
  } as FixResult;
}

test("summarizeFixes counts outcomes, medians and cost", () => {
  const s = summarizeFixes("run", "src", "2026-09-20T00:00:00.000Z", [
    result({
      diffLinesAdded: 2,
      diffLinesRemoved: 2,
      agent: {
        turns: 3,
        costUsd: 0.05,
        durationMs: 30_000,
        model: "claude-haiku",
        raw: "",
      },
    }),
    result({
      diffLinesAdded: 6,
      diffLinesRemoved: 3,
      agent: {
        turns: 8,
        costUsd: 0.1,
        durationMs: 90_000,
        model: "claude-haiku",
        raw: "",
      },
    }),
    result({
      diffLinesAdded: 40,
      diffLinesRemoved: 7,
      trivial: false,
      agent: {
        turns: 20,
        costUsd: 0.9,
        durationMs: 300_000,
        model: "claude-opus",
        raw: "",
      },
    }),
    result({
      outcome: "not_fixed",
      trivial: null,
      agent: {
        turns: 40,
        costUsd: 0.15,
        durationMs: 400_000,
        model: "claude-haiku",
        raw: "",
      },
    }),
    result({
      outcome: "fence_blocked",
      trivial: null,
      agent: {
        turns: null,
        costUsd: null,
        durationMs: null,
        model: null,
        raw: "",
      },
    }),
  ]);
  assert.equal(s.byOutcome.fixed, 3);
  assert.equal(s.byOutcome.not_fixed, 1);
  assert.equal(s.byOutcome.fence_blocked, 1);
  assert.equal(
    s.attempted,
    4,
    "fence_blocked never reached the agent, so it is not an attempt",
  );
  assert.equal(s.fixedTrivial, 2);
  assert.equal(s.fixedLarge, 1);
  assert.equal(
    s.medianDiffLinesFixed,
    9,
    "source lines across the three fixes are 4, 9, 47",
  );
  assert.equal(s.totalCostUsd, 1.2);
  assert.equal(s.byModel["claude-haiku"].attempted, 3);
  assert.equal(s.byModel["claude-haiku"].fixed, 2);
  assert.equal(s.byModel["claude-opus"].fixed, 1);
  assert.equal(s.costBasis, "billed");
});
