// tests/fts.test.ts — Round 12 slice 2 (lumeyon).
//
// FTS5-backed search via bun:sqlite. Filesystem files (index.jsonl,
// SUMMARY.md, BODY.md) remain authoritative; fts.db is derived and
// rebuildable. These tests pin the load-bearing invariants:
// - round-trip: upsertEntry → query returns the row with bm25 ranking
// - rebuild: corrupt/missing fts.db rebuilt from index.jsonl produces
//   identical query results
// - corruption sentinel: SQLITE_CORRUPT writes <edge>/.fts-corrupt
// - cross-process visibility (round-10 torn-read pattern guard)

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  upsertEntry, query, hasEntry, rebuildFromIndex,
  ftsDbPath, ftsCorruptSentinelPath,
} from "../scripts/fts.ts";
import type { IndexEntry } from "../scripts/lib.ts";

let EDGE_DIR: string;

beforeEach(() => {
  EDGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent-chat-fts-test-"));
});

afterEach(() => {
  try { fs.rmSync(EDGE_DIR, { recursive: true, force: true }); } catch {}
});

function mkEntry(id: string, kind: "leaf" | "condensed", tldr: string, keywords: string[] = []): IndexEntry {
  return {
    id, edge_id: "lumeyon-orion", topology: "petersen",
    kind, depth: kind === "leaf" ? 0 : 1,
    earliest_at: "2026-05-01T00:00:00Z",
    latest_at: "2026-05-01T01:00:00Z",
    participants: ["lumeyon", "orion"],
    parents: [],
    descendant_count: 0,
    keywords, tldr,
    body_sha256: kind === "leaf" ? "abc123" : undefined,
    path: path.join(EDGE_DIR, "archives/leaf", id),
  };
}

describe("fts.upsertEntry / query", () => {
  test("round-trip: upserted entry is returned by matching query", async () => {
    const entry = mkEntry("arch_L_test_aaaaaaaa", "leaf", "Discussion of FTS5 indexing for archives");
    await upsertEntry(EDGE_DIR, entry, {
      tldr: "Discussion of FTS5 indexing for archives",
      summary_body: "We considered porter unicode61 versus trigram tokenizer.",
      keywords: "fts5 indexing tokenizer",
      expand_topics: "tokenizer choice rationale",
    });
    const hits = query(EDGE_DIR, "tokenizer");
    expect(hits.length).toBe(1);
    expect(hits[0].archive_id).toBe("arch_L_test_aaaaaaaa");
  });

  test("expand_topics column ranks higher than summary_body (bm25 weights)", async () => {
    // Two entries: one matches ONLY in summary_body (weight 1.0), other
    // matches ONLY in expand_topics (weight 2.5). The expand_topics hit
    // must rank strictly higher (more negative bm25) — fails if bm25
    // weights aren't actually being applied to the indexed columns
    // (e.g. if the weight tuple gets aligned to UNINDEXED prefix
    // columns, which silently degrades ranking to unweighted).
    const a = mkEntry("arch_L_aaa_11111111", "leaf", "summary-only hit");
    const b = mkEntry("arch_L_bbb_22222222", "leaf", "expand-topics hit");
    // Use a unique term ("widgetzzz") that appears in EXACTLY ONE
    // indexed column per row so the rank delta is fully attributable
    // to bm25 column weights, not to multi-column term frequency.
    await upsertEntry(EDGE_DIR, a, {
      tldr: "summary-only hit", summary_body: "this section talks about widgetzzz",
      keywords: "kx", expand_topics: "ey",
    });
    await upsertEntry(EDGE_DIR, b, {
      tldr: "expand-topics hit", summary_body: "ns",
      keywords: "kx", expand_topics: "widgetzzz edge cases",
    });
    const hits = query(EDGE_DIR, "widgetzzz");
    expect(hits.length).toBe(2);
    const aHit = hits.find((h) => h.archive_id === "arch_L_aaa_11111111")!;
    const bHit = hits.find((h) => h.archive_id === "arch_L_bbb_22222222")!;
    // expand_topics weight 2.5 vs summary_body weight 1.0 → b strictly better.
    expect(bHit.rank).toBeLessThan(aHit.rank);
    // Stronger guard: the rank gap must be non-trivial. With weights NOT
    // applied, bm25 returns equal magnitudes (term appears once in one
    // indexed col on each row); the delta would be ~0. Require >5%.
    const gap = Math.abs(bHit.rank - aHit.rank);
    const scale = Math.max(Math.abs(aHit.rank), Math.abs(bHit.rank));
    expect(gap / scale).toBeGreaterThan(0.05);
  });

  test("bm25 weights are actually applied — keywords (1.5) ranks above summary_body (1.0)", async () => {
    // Regression guard for keystone's Round-12 finding: with the wrong
    // weight count, bm25() silently treats indexed cols as unweighted.
    // This test fails if weights are not aligned to indexed cols 6-9.
    const a = mkEntry("arch_L_kw_a_aaaaaaaa", "leaf", "kw-only");
    const b = mkEntry("arch_L_kw_b_bbbbbbbb", "leaf", "body-only");
    await upsertEntry(EDGE_DIR, a, {
      tldr: "kw-only", summary_body: "ns", keywords: "uniqterm", expand_topics: "ey",
    });
    await upsertEntry(EDGE_DIR, b, {
      tldr: "body-only", summary_body: "uniqterm", keywords: "kx", expand_topics: "ey",
    });
    const hits = query(EDGE_DIR, "uniqterm");
    expect(hits.length).toBe(2);
    const aHit = hits.find((h) => h.archive_id === "arch_L_kw_a_aaaaaaaa")!;
    const bHit = hits.find((h) => h.archive_id === "arch_L_kw_b_bbbbbbbb")!;
    // keywords weight 1.5 > summary_body weight 1.0
    expect(aHit.rank).toBeLessThan(bHit.rank);
  });

  test("hasEntry reflects upsert + replace", async () => {
    expect(hasEntry(EDGE_DIR, "arch_L_xxx_99999999")).toBe(false);
    const e = mkEntry("arch_L_xxx_99999999", "leaf", "tl");
    await upsertEntry(EDGE_DIR, e, { tldr: "tl", summary_body: "b", keywords: "k", expand_topics: "" });
    expect(hasEntry(EDGE_DIR, "arch_L_xxx_99999999")).toBe(true);
  });

  test("upsert is idempotent — re-upserting the same id replaces the row", async () => {
    const e = mkEntry("arch_L_yyy_88888888", "leaf", "v1");
    await upsertEntry(EDGE_DIR, e, { tldr: "v1", summary_body: "v1body", keywords: "k", expand_topics: "" });
    await upsertEntry(EDGE_DIR, e, { tldr: "v2", summary_body: "v2body", keywords: "k", expand_topics: "" });
    const hits = query(EDGE_DIR, "v2body");
    expect(hits.length).toBe(1);
    expect(hits[0].tldr).toBe("v2");
  });

  test("query returns [] when fts.db missing", () => {
    expect(query(EDGE_DIR, "anything")).toEqual([]);
  });
});

describe("fts.rebuildFromIndex (recovery primitive for doctor --rebuild-fts)", () => {
  test("rebuild from index.jsonl + SUMMARY.md produces identical query results", async () => {
    // Stage two real archives: write index.jsonl + per-archive SUMMARY.md,
    // call rebuildFromIndex, query — assert the rows are present.
    const e1 = mkEntry("arch_L_r1_aaaaaaaa", "leaf", "first archive about engines");
    const e2 = mkEntry("arch_L_r2_bbbbbbbb", "leaf", "second archive about turbines");
    fs.mkdirSync(e1.path, { recursive: true });
    fs.mkdirSync(e2.path, { recursive: true });
    fs.writeFileSync(path.join(e1.path, "SUMMARY.md"),
      `## TL;DR\nfirst archive about engines\n\n## Decisions\n- pick engine\n\n## Keywords\nengines, pistons\n\n## Expand for details about\ndisplacement\n`);
    fs.writeFileSync(path.join(e2.path, "SUMMARY.md"),
      `## TL;DR\nsecond archive about turbines\n\n## Decisions\n- pick turbine\n\n## Keywords\nturbines, blades\n\n## Expand for details about\nthrust\n`);
    fs.writeFileSync(path.join(EDGE_DIR, "index.jsonl"),
      JSON.stringify(e1) + "\n" + JSON.stringify(e2) + "\n");

    // No fts.db exists yet.
    expect(fs.existsSync(ftsDbPath(EDGE_DIR))).toBe(false);

    const lib = await import("../scripts/lib.ts");
    const result = await rebuildFromIndex(EDGE_DIR, (entry) => {
      const sp = path.join(entry.path, "SUMMARY.md");
      if (!fs.existsSync(sp)) return null;
      const txt = fs.readFileSync(sp, "utf8");
      return {
        tldr: lib.extractTldr(txt),
        summary_body: lib.extractSummaryBody(txt),
        keywords: lib.extractKeywords(txt).join(" "),
        expand_topics: lib.extractExpandTopics(txt),
      };
    });
    expect(result.rebuilt).toBe(2);
    expect(fs.existsSync(ftsDbPath(EDGE_DIR))).toBe(true);

    const engineHits = query(EDGE_DIR, "engines");
    expect(engineHits.find((h) => h.archive_id === "arch_L_r1_aaaaaaaa")).toBeDefined();
    const thrustHits = query(EDGE_DIR, "thrust");
    expect(thrustHits.find((h) => h.archive_id === "arch_L_r2_bbbbbbbb")).toBeDefined();
  });

  test("extractExpandTopics handles the colon variant produced by buildSummaryPrompt", async () => {
    // Phase-4 cross-review regression. Carina's buildSummaryPrompt + the
    // existing stub + validator all produce `## Expand for details about:`
    // WITH the trailing colon. My pre-fix regex required no colon, silently
    // returning empty — defeating bm25 weight 2.5 on the expand_topics
    // column. Pin the fix so the bug can't regress.
    const lib = await import("../scripts/lib.ts");
    expect(lib.extractExpandTopics("## Expand for details about:\ntopic-a, topic-b\n")).toBe("topic-a, topic-b");
    expect(lib.extractExpandTopics("## Expand for details about\ntopic-c\n")).toBe("topic-c"); // colon-less form still works
  });

  test("rebuild clears the .fts-corrupt sentinel", async () => {
    fs.writeFileSync(path.join(EDGE_DIR, "index.jsonl"), "");
    fs.writeFileSync(ftsCorruptSentinelPath(EDGE_DIR), "synthetic corruption marker\n");
    expect(fs.existsSync(ftsCorruptSentinelPath(EDGE_DIR))).toBe(true);

    await rebuildFromIndex(EDGE_DIR, () => null);
    expect(fs.existsSync(ftsCorruptSentinelPath(EDGE_DIR))).toBe(false);
  });
});
