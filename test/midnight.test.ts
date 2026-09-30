import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  compilerForPragma,
  compilerAsOf,
  bestTemplateMatch,
} from "../src/checks/midnight.js";

test("compilerForPragma: a pinned or upper-bounded language version selects a compiler (minor + 8)", () => {
  assert.equal(compilerForPragma("pragma language_version 0.23;"), "0.31");
  assert.equal(compilerForPragma(">= 0.16 && <= 0.18"), "0.26");
  assert.equal(compilerForPragma("0.26"), "0.34");
});

test("compilerForPragma: a pure lower bound is satisfied by the latest compiler, so it selects nothing", () => {
  assert.equal(compilerForPragma(">= 0.20"), null);
  assert.equal(compilerForPragma(null), null);
  assert.equal(compilerForPragma("no version here"), null);
});

test("compilerAsOf: picks the newest release on or before the date", () => {
  assert.equal(compilerAsOf("2026-03-30T12:00:00Z"), "0.31.0");
  assert.equal(compilerAsOf("2026-06-12"), "0.31.1");
  assert.equal(compilerAsOf("2026-09-01"), "0.34.0");
  assert.equal(
    compilerAsOf("2020-01-01"),
    "0.22.0",
    "before the first release, fall back to the oldest",
  );
  assert.equal(compilerAsOf(null), null);
});

test("bestTemplateMatch: an unmodified starter scores 1.0 against itself", () => {
  const counter = readFileSync(
    new URL("../src/checks/templates/example-counter.compact", import.meta.url),
    "utf8",
  );
  const m = bestTemplateMatch(counter);
  assert.ok(m);
  assert.equal(m.name, "example-counter");
  assert.equal(m.similarity, 1);
});

test("bestTemplateMatch: comments and the pragma line do not affect the score", () => {
  const counter = readFileSync(
    new URL("../src/checks/templates/example-counter.compact", import.meta.url),
    "utf8",
  );
  const edited =
    counter
      .replace(
        /pragma language_version[^;]*;/,
        "pragma language_version >= 0.99;",
      )
      .replace(/\/\/.*$/gm, "// a completely different comment") +
    "\n/* trailing block comment the team added */\n";
  const m = bestTemplateMatch(edited);
  assert.ok(m);
  assert.equal(m.similarity, 1);
});

test("bestTemplateMatch: KNOWN LIMIT: renaming identifiers in a tiny template drops it below the threshold", () => {
  // The counter starter is ~17 tokens, so token-set similarity is fragile on it. A team that
  // renames two identifiers is no longer flagged as template_contract. Larger starters survive
  // renaming; this test documents the gap so a future identifier-normalizing check can close it.
  const counter = readFileSync(
    new URL("../src/checks/templates/example-counter.compact", import.meta.url),
    "utf8",
  );
  const renamed = counter
    .replace(/round/g, "tally")
    .replace(/increment/g, "bump");
  const m = bestTemplateMatch(renamed);
  assert.ok(m);
  assert.ok(
    m.similarity < 0.85,
    `similarity ${m.similarity}: if this now passes the threshold, the limitation is fixed and this test should be inverted`,
  );
});

test("bestTemplateMatch: a contract with real private state does not look like a template", () => {
  const src = `
    pragma language_version >= 0.16;
    import CompactStandardLibrary;
    export ledger votes: Map<Bytes<32>, Uint<64>>;
    export ledger voters: Set<Bytes<32>>;
    witness secretKey(): Bytes<32>;
    export circuit vote(option: Bytes<32>): [] {
      const pk = disclose(persistentHash<Bytes<32>>(secretKey()));
      assert(!voters.member(pk), "already voted");
      voters.insert(pk);
      votes.insert(option, votes.lookup(option) + 1);
    }
  `;
  const m = bestTemplateMatch(src);
  assert.ok(m);
  assert.ok(m.similarity < 0.85, `similarity ${m.similarity} should be < 0.85`);
});
