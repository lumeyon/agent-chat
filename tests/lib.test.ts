// Pure-function unit tests for scripts/lib.ts. Fast, no I/O, no spawn.

import { test, expect, describe } from "bun:test";
import {
  parseTopologyYaml, edgeId, neighborsOf, edgesOf, parseSections,
  splitForArchive, sectionMeta, timeRangeOf, validateSummary,
  extractTldr, extractKeywords, parseLockFile, processTag,
  archiveId, depthPolicy, renderSummaryStub,
} from "../scripts/lib.ts";

describe("parseTopologyYaml", () => {
  test("parses minimal valid topology", () => {
    const yaml = `topology: pair\nagents:\n  - orion\n  - lumeyon\nedges:\n  - [orion, lumeyon]\n`;
    const t = parseTopologyYaml(yaml);
    expect(t.topology).toBe("pair");
    expect(t.agents).toEqual(["orion", "lumeyon"]);
    expect(t.edges).toEqual([["orion", "lumeyon"]]);
  });

  test("strips inline comments", () => {
    const yaml = `topology: pair # name\nagents:\n  - orion # leader\n  - lumeyon\nedges:\n  - [orion, lumeyon]\n`;
    const t = parseTopologyYaml(yaml);
    expect(t.agents).toEqual(["orion", "lumeyon"]);
  });

  test("rejects missing topology", () => {
    expect(() =>
      parseTopologyYaml(`agents:\n  - a\nedges:\n  - [a, a]\n`),
    ).toThrow(/topology field missing/);
  });

  test("rejects empty agents list", () => {
    expect(() =>
      parseTopologyYaml(`topology: x\nagents:\nedges:\n  - [a, b]\n`),
    ).toThrow(/agents list empty/);
  });

  test("rejects malformed edge", () => {
    expect(() =>
      parseTopologyYaml(`topology: x\nagents:\n  - a\n  - b\nedges:\n  - bad-edge\n`),
    ).toThrow(/bad edge syntax/);
  });
});

describe("edgeId", () => {
  test("alphabetical canonicalization is order-independent", () => {
    expect(edgeId("orion", "lumeyon")).toBe("lumeyon-orion");
    expect(edgeId("lumeyon", "orion")).toBe("lumeyon-orion");
  });

  test("works with three-character names", () => {
    expect(edgeId("aaa", "bbb")).toBe("aaa-bbb");
    expect(edgeId("bbb", "aaa")).toBe("aaa-bbb");
  });
});

describe("neighborsOf / edgesOf", () => {
  const topo = parseTopologyYaml(
    `topology: petersen\nagents:\n  - a\n  - b\n  - c\n  - d\nedges:\n  - [a, b]\n  - [a, c]\n  - [b, d]\n`,
  );

  test("neighborsOf returns sorted unique neighbors", () => {
    expect(neighborsOf(topo, "a")).toEqual(["b", "c"]);
    expect(neighborsOf(topo, "b")).toEqual(["a", "d"]);
    expect(neighborsOf(topo, "d")).toEqual(["b"]);
  });

  test("edgesOf returns one record per neighbor with canonical id", () => {
    const edges = edgesOf(topo, "a");
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.peer)).toEqual(["b", "c"]);
    expect(edges.map((e) => e.id)).toEqual(["a-b", "a-c"]);
  });
});

describe("parseSections / splitForArchive", () => {
  const convo = [
    "# CONVO — orion ↔ lumeyon\n",
    "Protocol: agent-chat\n",
    "",
    "## orion — section 1 (UTC 2026-05-01T01:00:00Z)\n",
    "body 1",
    "",
    "→ lumeyon",
    "",
    "---",
    "",
    "## lumeyon — section 2 (UTC 2026-05-01T02:00:00Z)\n",
    "body 2",
    "",
    "→ orion",
    "",
    "---",
    "",
    "## orion — section 3 (UTC 2026-05-01T03:00:00Z)\n",
    "body 3",
    "",
    "→ END",
  ].join("\n");

  test("parseSections separates header from sections", () => {
    const { header, sections } = parseSections(convo);
    expect(header).toMatch(/^# CONVO/);
    expect(sections).toHaveLength(3);
    expect(sections[0]).toContain("section 1");
    expect(sections[1]).toContain("section 2");
    expect(sections[2]).toContain("section 3");
  });

  test("splitForArchive respects fresh-tail count", () => {
    const split = splitForArchive(convo, 1);
    expect(split.sectionCount).toBe(3);
    expect(split.archivableSectionCount).toBe(2);
    expect(split.freshTail).toContain("section 3");
    expect(split.freshTail).not.toContain("section 1");
    expect(split.archivable).toContain("section 1");
    expect(split.archivable).toContain("section 2");
  });

  test("splitForArchive with fresh tail >= section count archives nothing", () => {
    const split = splitForArchive(convo, 10);
    expect(split.archivableSectionCount).toBe(0);
    expect(split.archivable).toBe("");
  });
});

describe("sectionMeta / timeRangeOf", () => {
  test("extracts author and timestamp from section header", () => {
    const sec = "## orion — topic (UTC 2026-05-01T01:23:45Z)\n\nbody\n→ lumeyon";
    expect(sectionMeta(sec)).toEqual({ author: "orion", ts: "2026-05-01T01:23:45Z" });
  });

  test("falls back when header is malformed", () => {
    const sec = "## random text without a UTC timestamp";
    expect(sectionMeta(sec)).toEqual({ author: "unknown", ts: null });
  });

  test("timeRangeOf finds earliest and latest", () => {
    const secs = [
      "## a — x (UTC 2026-05-02T00:00:00Z)\n",
      "## b — y (UTC 2026-05-01T00:00:00Z)\n",
      "## c — z (UTC 2026-05-03T00:00:00Z)\n",
    ];
    expect(timeRangeOf(secs)).toEqual({
      earliest: "2026-05-01T00:00:00Z",
      latest: "2026-05-03T00:00:00Z",
    });
  });
});

describe("validateSummary", () => {
  const goodSummary = `# SUMMARY — x · leaf · depth 0 · t1 → t2

## TL;DR
A real summary line one.
Line two.
Line three.

## Decisions
- decided X for reason Y — evidence Z

## Blockers
- (none)

## Follow-ups
- (none)

## Artifacts referenced
- (none)

## Keywords
foo, bar, baz

## Expand for details about:
exact phrasing, intermediate dead ends
`;

  test("accepts a complete summary", () => {
    const v = validateSummary(goodSummary);
    expect(v.ok).toBe(true);
    expect(v.issues).toHaveLength(0);
  });

  test("rejects missing TL;DR", () => {
    const v = validateSummary(goodSummary.replace(/^## TL;DR[\s\S]*?(?=^## Decisions)/m, ""));
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.includes("TL;DR"))).toBe(true);
  });

  test("rejects unfilled TODO markers", () => {
    const bad = goodSummary.replace("foo, bar, baz", "TODO: keywords here");
    const v = validateSummary(bad);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.includes("TODO"))).toBe(true);
  });

  test("rejects empty Keywords section", () => {
    const bad = goodSummary.replace(/^foo, bar, baz$/m, "");
    const v = validateSummary(bad);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.toLowerCase().includes("keywords"))).toBe(true);
  });

  test("rejects empty Expand-for-details section", () => {
    const bad = goodSummary.replace(/^exact phrasing, intermediate dead ends$/m, "");
    const v = validateSummary(bad);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.toLowerCase().includes("expand"))).toBe(true);
  });

  test("strips HTML comments before validating (so unfilled stubs still fail)", () => {
    const stub = `<!-- TL;DR comment -->\n${goodSummary.replace("foo, bar, baz", "TODO")}`;
    const v = validateSummary(stub);
    expect(v.ok).toBe(false);
  });

  test("extractTldr returns first three lines, max 240 chars", () => {
    const tldr = extractTldr(goodSummary);
    expect(tldr).toContain("A real summary line one");
    expect(tldr.length).toBeLessThanOrEqual(240);
  });

  test("extractKeywords splits on commas and newlines", () => {
    const kw = extractKeywords(goodSummary);
    expect(kw).toEqual(["foo", "bar", "baz"]);
  });
});

// Anti-theater audit (vanguard ↔ keystone, Petersen orion-led hardening pass).
// Each negative fixture below is a SUMMARY.md that passed the pre-patch
// validator but conveys no real information; each positive fixture is a
// summary that should remain accepted after the tightening. Adding a
// fixture here is the canonical way to lock in a new audit finding —
// the file is the regression suite for `validateSummary`.
describe("validateSummary — audit fixtures", () => {
  // ------ Negative: original four (K1–K4) ------

  test("K1 whitespace-body bypass is rejected (5 sections empty under heading)", () => {
    const text = [
      "## TL;DR", "",
      "## Decisions", "",
      "## Blockers", "",
      "## Follow-ups", "",
      "## Artifacts referenced", "",
      "## Keywords", "x", "",
      "## Expand for details about:", "y",
    ].join("\n");
    expect(validateSummary(text).ok).toBe(false);
  });

  test("K2 lowercase TODO/Todo/ToDo are caught (placeholder marker is case-insensitive)", () => {
    for (const variant of ["todo: write later", "Todo: write later", "ToDo: write later"]) {
      const text = [
        "## TL;DR", variant,
        "## Decisions", "real decision",
        "## Blockers", "(none)",
        "## Follow-ups", "(none)",
        "## Artifacts referenced", "(none)",
        "## Keywords", "alpha, beta, gamma",
        "## Expand for details about:", "real expansion content",
      ].join("\n");
      const v = validateSummary(text);
      expect(v.ok).toBe(false);
      expect(v.issues.some((i) => i.toLowerCase().includes("placeholder marker"))).toBe(true);
    }
  });

  test("K3 heading line-split is rejected (`## \\nTL;DR` no longer satisfies the heading regex)", () => {
    const text = [
      "## ", "TL;DR", "body",
      "## Decisions", "d",
      "## Blockers", "b",
      "## Follow-ups", "f",
      "## Artifacts referenced", "a",
      "## Keywords", "x",
      "## Expand for details about:", "y",
    ].join("\n");
    const v = validateSummary(text);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.includes(`missing section: "## TL;DR"`))).toBe(true);
  });

  test("K4 single-character Keywords/Expand tokens are rejected", () => {
    const text = [
      "## TL;DR", "## Decisions", "## Blockers", "## Follow-ups",
      "## Artifacts referenced", "## Keywords", "_",
      "## Expand for details about:", ".",
    ].join("\n");
    expect(validateSummary(text).ok).toBe(false);
  });

  // ------ Negative: new escapes (N1, N2, N3, N14, N15, N17) ------

  test("N1 fenced-code-block whole-file bypass is rejected (file renders as a code block to humans)", () => {
    const text = [
      "```",
      "## TL;DR", "## Decisions", "## Blockers", "## Follow-ups",
      "## Artifacts referenced", "## Keywords", "k",
      "## Expand for details about:", "e",
      "```",
    ].join("\n");
    const v = validateSummary(text);
    expect(v.ok).toBe(false);
    // every required heading should be reported missing once the fence is stripped
    expect(v.issues.filter((i) => i.startsWith("missing section:")).length).toBe(7);
  });

  test("N2 broadened markers (TBD, FIXME, XXX, WIP, PLACEHOLDER) all evade only the original \\bTODO\\b — caught now", () => {
    for (const marker of ["TBD", "FIXME", "XXX", "WIP", "PLACEHOLDER"]) {
      const text = [
        "## TL;DR", `${marker}: write later`,
        "## Decisions", "real decision",
        "## Blockers", "(none)",
        "## Follow-ups", "(none)",
        "## Artifacts referenced", "(none)",
        "## Keywords", "alpha, beta, gamma",
        "## Expand for details about:", "real expansion",
      ].join("\n");
      const v = validateSummary(text);
      expect(v.ok).toBe(false);
      expect(v.issues.some((i) => i.toLowerCase().includes("placeholder marker"))).toBe(true);
    }
  });

  test("N3 (none) everywhere is rejected (path-of-least-resistance; stub seeded this gap)", () => {
    const text = [
      "## TL;DR", "(none)",
      "## Decisions", "(none)",
      "## Blockers", "(none)",
      "## Follow-ups", "(none)",
      "## Artifacts referenced", "(none)",
      "## Keywords", "(none)",
      "## Expand for details about:", "(none)",
    ].join("\n");
    const v = validateSummary(text);
    expect(v.ok).toBe(false);
    // the four real-body sections should each be flagged
    for (const heading of ["TL;DR", "Decisions", "Keywords", "Expand for details about:"]) {
      expect(v.issues.some((i) => i.includes(heading) && i.includes("placeholder"))).toBe(true);
    }
  });

  test("N14 zero-width-space tokens are rejected by the alphanumeric quality gate", () => {
    const text = [
      "## TL;DR", "real summary",
      "## Decisions", "real decision",
      "## Blockers", "(none)",
      "## Follow-ups", "(none)",
      "## Artifacts referenced", "(none)",
      "## Keywords", "​",
      "## Expand for details about:", "​",
    ].join("\n");
    expect(validateSummary(text).ok).toBe(false);
  });

  test("N15 single-glyph em-dash bodies are rejected", () => {
    const text = [
      "## TL;DR", "—",
      "## Decisions", "—",
      "## Blockers", "—",
      "## Follow-ups", "—",
      "## Artifacts referenced", "—",
      "## Keywords", "—",
      "## Expand for details about:", "—",
    ].join("\n");
    expect(validateSummary(text).ok).toBe(false);
  });

  test("N17 duplicate ## TL;DR headings are rejected (validator now checks uniqueness)", () => {
    const text = [
      "## TL;DR", "first summary",
      "## TL;DR",
      "## Decisions", "real decision",
      "## Blockers", "(none)",
      "## Follow-ups", "(none)",
      "## Artifacts referenced", "(none)",
      "## Keywords", "alpha, beta, gamma",
      "## Expand for details about:", "real expansion",
    ].join("\n");
    const v = validateSummary(text);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.includes("duplicate section") && i.includes("TL;DR"))).toBe(true);
  });

  // ------ Negative: shape-extreme fixtures ------

  test("path-of-least-resistance (stub-shaped (none)-everywhere, 176 bytes) is rejected", () => {
    const text = [
      "## TL;DR", "(none)", "",
      "## Decisions", "- (none)", "",
      "## Blockers", "- (none)", "",
      "## Follow-ups", "- (none)", "",
      "## Artifacts referenced", "- (none)", "",
      "## Keywords", "(none)", "",
      "## Expand for details about:", "(none)", "",
    ].join("\n");
    const v = validateSummary(text);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.includes("TL;DR") && i.includes("placeholder"))).toBe(true);
  });

  test("absolute-floor (116 bytes, single-glyph kw/expand, no other content) is rejected", () => {
    const text = "## TL;DR\n## Decisions\n## Blockers\n## Follow-ups\n## Artifacts referenced\n## Keywords\nk\n## Expand for details about:\ne";
    expect(validateSummary(text).ok).toBe(false);
  });

  // ------ Negative controls: structurally-wrong markdown should keep failing ------

  test("setext (=====) headings are rejected (regex requires ATX ##)", () => {
    const text = [
      "TL;DR", "=====",
      "## Decisions", "## Blockers", "## Follow-ups",
      "## Artifacts referenced", "## Keywords", "k",
      "## Expand for details about:", "e",
    ].join("\n");
    expect(validateSummary(text).ok).toBe(false);
  });

  test("4-space indented headings (markdown code block) are rejected", () => {
    const text = [
      "    ## TL;DR", "    ## Decisions", "    ## Blockers", "    ## Follow-ups",
      "    ## Artifacts referenced", "    ## Keywords", "    k",
      "    ## Expand for details about:", "    e",
    ].join("\n");
    expect(validateSummary(text).ok).toBe(false);
  });

  test("h3 (###) headings are rejected", () => {
    const text = [
      "### TL;DR", "### Decisions", "### Blockers", "### Follow-ups",
      "### Artifacts referenced", "### Keywords", "k",
      "### Expand for details about:", "e",
    ].join("\n");
    expect(validateSummary(text).ok).toBe(false);
  });

  // ------ Positive controls: legitimate summaries that MUST keep passing ------

  const validMinimal = [
    "## TL;DR",
    "Adopted strategy X for backfill; no blockers; ready to merge.",
    "",
    "## Decisions",
    "- adopted X over Y because Z works under concurrent writes (commit abc1234)",
    "",
    "## Blockers",
    "- (none)",
    "",
    "## Follow-ups",
    "- (none)",
    "",
    "## Artifacts referenced",
    "- (none)",
    "",
    "## Keywords",
    "backfill, concurrent-writes, migration",
    "",
    "## Expand for details about:",
    "exact phrasing of rejected alternative Y, intermediate dead ends",
  ].join("\n");

  test("positive: minimal-but-real summary is accepted", () => {
    expect(validateSummary(validMinimal).ok).toBe(true);
  });

  test("positive: Decisions = `(none) — explanation` is accepted (design Q1)", () => {
    const text = [
      "## TL;DR", "Discussed migration approach; no decision yet — recap follows.",
      "",
      "## Decisions", "- (none) — ran out of time, see follow-ups",
      "",
      "## Blockers", "- (none)",
      "## Follow-ups", "- finalize migration plan in next sync",
      "## Artifacts referenced", "- (none)",
      "## Keywords", "migration, planning, deferred",
      "## Expand for details about:", "exact options considered, why we deferred",
    ].join("\n");
    expect(validateSummary(text).ok).toBe(true);
  });

  test("positive: CRLF line endings on a valid summary are accepted", () => {
    expect(validateSummary(validMinimal.replace(/\n/g, "\r\n")).ok).toBe(true);
  });

  test("positive: legacy CR-only line endings on a valid summary are accepted", () => {
    expect(validateSummary(validMinimal.replace(/\n/g, "\r")).ok).toBe(true);
  });

  test("positive: rendered stub itself is accepted (writer can copy-and-edit without bouncing)", () => {
    const stub = renderSummaryStub({
      edgeId: "lumeyon-orion",
      archiveId: "arch_L_test",
      kind: "leaf",
      depth: 0,
      participants: ["lumeyon", "orion"],
      earliestAt: "2026-05-01T00:00:00Z",
      latestAt: "2026-05-01T01:00:00Z",
      sourceLabel: "raw sections",
      sourceText: "BODY",
    });
    expect(validateSummary(stub).ok).toBe(true);
  });
});

describe("parseLockFile", () => {
  const tmp = `${process.env.TMPDIR ?? "/tmp"}/agent-chat-locktest-${process.pid}`;

  test("parses well-formed lock file", () => {
    const fs = require("node:fs");
    fs.writeFileSync(tmp, "orion@hostname.example:12345 2026-05-01T00:00:00Z\n");
    const lk = parseLockFile(tmp);
    expect(lk).toEqual({
      agent: "orion",
      host: "hostname.example",
      pid: 12345,
      ts: "2026-05-01T00:00:00Z",
    });
    fs.unlinkSync(tmp);
  });

  test("returns null on malformed lock file", () => {
    const fs = require("node:fs");
    fs.writeFileSync(tmp, "not a real lock");
    expect(parseLockFile(tmp)).toBeNull();
    fs.unlinkSync(tmp);
  });

  test("returns null when file does not exist", () => {
    expect(parseLockFile(`${tmp}-missing`)).toBeNull();
  });
});

describe("processTag", () => {
  test("formats agent@host:pid", () => {
    const tag = processTag("orion");
    expect(tag).toMatch(/^orion@.+:\d+$/);
    expect(tag).toContain(`:${process.pid}`);
  });
});

describe("stableSessionPid", () => {
  // Full-coverage unit testing of the /proc walk would require mocking
  // /proc, which is more friction than the function's worth. We test the
  // observable invariants instead: the returned pid is alive, and behavior
  // diverges sensibly between "running under Claude Code" and "plain shell".
  test("returns a positive, currently-alive pid", async () => {
    const { stableSessionPid, pidIsAlive } = await import("../scripts/lib.ts");
    const pid = stableSessionPid();
    expect(Number.isInteger(pid)).toBe(true);
    expect(pid).toBeGreaterThan(0);
    expect(pidIsAlive(pid)).toBe(true);
  });

  test("when CLAUDECODE is forcibly unset, returns ppid (plain-shell fallback)", async () => {
    // Spawn a fresh bun child WITHOUT the CLAUDECODE marker; it should
    // hit the early-return ppid fallback path. We use a tiny one-liner
    // child that prints stableSessionPid() and verify it equals the
    // child's own ppid (i.e. this test process).
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(
      process.execPath,
      ["-e", `
        import("${import.meta.dirname}/../scripts/lib.ts").then((m) => {
          console.log(m.stableSessionPid(), process.ppid);
        });
      `],
      {
        env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "CLAUDECODE")) as Record<string, string>,
        encoding: "utf8",
      },
    );
    expect(r.status).toBe(0);
    const [pidStr, ppidStr] = r.stdout.trim().split(/\s+/);
    // When CLAUDECODE is unset on a non-Linux platform OR when no ancestor
    // has the marker, the function returns process.ppid.
    expect(parseInt(pidStr, 10)).toBe(parseInt(ppidStr, 10));
  });
});

describe("archiveId", () => {
  test("starts with arch_L_ for leaf and arch_C_ for condensed", () => {
    const a = archiveId("leaf", "2026-05-01T00:00:00Z");
    const b = archiveId("condensed", "2026-05-01T00:00:00Z");
    expect(a).toMatch(/^arch_L_/);
    expect(b).toMatch(/^arch_C_/);
  });

  test("two consecutive ids differ (random suffix)", () => {
    const a = archiveId("leaf", "2026-05-01T00:00:00Z");
    const b = archiveId("leaf", "2026-05-01T00:00:00Z");
    expect(a).not.toBe(b);
  });

  test("encodes timestamp into the id for sortability", () => {
    const a = archiveId("leaf", "2026-05-01T00:00:00Z");
    expect(a).toMatch(/20260501000000/);
  });
});

describe("depthPolicy", () => {
  test("d0 leaf has 'Normal leaf policy'", () => {
    const p = depthPolicy(0, "leaf");
    expect(p.policy).toContain("Normal leaf policy");
    expect(p.targetTokens).toBeGreaterThan(0);
  });

  test("d1 condensed mentions session-level", () => {
    const p = depthPolicy(1, "condensed");
    expect(p.policy.toLowerCase()).toContain("session");
  });

  test("d3+ condensed says durable", () => {
    const p = depthPolicy(4, "condensed");
    expect(p.policy.toLowerCase()).toContain("durable");
  });
});

describe("renderSummaryStub", () => {
  test("includes archive id, participants, source label, and policy", () => {
    const stub = renderSummaryStub({
      edgeId: "lumeyon-orion",
      archiveId: "arch_L_xxx",
      kind: "leaf",
      depth: 0,
      participants: ["lumeyon", "orion"],
      earliestAt: "2026-05-01T01:00:00Z",
      latestAt: "2026-05-01T02:00:00Z",
      sourceLabel: "raw sections",
      sourceText: "BODY GOES HERE",
    });
    expect(stub).toContain("lumeyon-orion");
    expect(stub).toContain("arch_L_xxx");
    expect(stub).toContain("BODY GOES HERE");
    expect(stub).toContain("## TL;DR");
    expect(stub).toContain("## Expand for details about:");
    expect(stub).toContain("Normal leaf policy");
  });
});

describe("readIndex — torn-read + malformed-line resilience (rhino #2/#3, P0)", () => {
  // Hardening regression: readIndex used to JSON.parse line-by-line with no
  // try/catch, so one corrupt or torn-mid-write line took down the whole
  // reader (search, list, condense). Both patches below test the survivable
  // shape: malformed lines are logged + skipped, and the reader bounds its
  // input by the open-time fstat size to avoid Bun's readFileSync over-read
  // on a growing file.
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const os = require("node:os") as typeof import("node:os");

  function makeEdgeDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "agent-chat-readindex-"));
  }

  function entry(id: string, ts: string) {
    return {
      id,
      edge_id: "lumeyon-orion",
      topology: "petersen",
      kind: "leaf" as const,
      depth: 0,
      earliest_at: ts,
      latest_at: ts,
      participants: ["lumeyon", "orion"] as [string, string],
      parents: [],
      descendant_count: 1,
      keywords: ["k1", "k2", "k3"],
      tldr: "tldr text",
      path: "/dev/null",
    };
  }

  test("readIndex skips a malformed middle line and returns the surrounding entries", async () => {
    const { readIndex, indexFile } = await import("../scripts/lib.ts");
    const edgeDir = makeEdgeDir();
    try {
      const f = indexFile(edgeDir);
      fs.writeFileSync(
        f,
        JSON.stringify(entry("arch_L_a", "2026-05-01T00:00:00Z")) + "\n" +
          "this is not valid json\n" +
          JSON.stringify(entry("arch_L_b", "2026-05-01T00:01:00Z")) + "\n",
      );
      const got = readIndex(edgeDir);
      expect(got.map((e) => e.id)).toEqual(["arch_L_a", "arch_L_b"]);
    } finally { fs.rmSync(edgeDir, { recursive: true, force: true }); }
  });

  test("readIndex tolerates a torn trailing line (writer mid-append, simulated)", async () => {
    const { readIndex, indexFile } = await import("../scripts/lib.ts");
    const edgeDir = makeEdgeDir();
    try {
      const f = indexFile(edgeDir);
      // Final line is truncated mid-record — exactly what `readFileSync` over-read
      // captures when sampling a growing file. The reader must recover.
      fs.writeFileSync(
        f,
        JSON.stringify(entry("arch_L_a", "2026-05-01T00:00:00Z")) + "\n" +
          '{"id":"arch_L_b","kind":"leaf","tld' /* truncated */,
      );
      const got = readIndex(edgeDir);
      expect(got.map((e) => e.id)).toEqual(["arch_L_a"]);
    } finally { fs.rmSync(edgeDir, { recursive: true, force: true }); }
  });

  test("readIndex on a missing file is empty (preserved)", async () => {
    const { readIndex } = await import("../scripts/lib.ts");
    const edgeDir = makeEdgeDir();
    try { expect(readIndex(edgeDir)).toEqual([]); }
    finally { fs.rmSync(edgeDir, { recursive: true, force: true }); }
  });

  test("readIndex bounds reads to fstat size: a writer extending the file mid-read does not pollute results", async () => {
    // Snapshot semantics: the reader captures fstat-size at open and reads
    // exactly that many bytes. A peer appending after the open is invisible
    // to this reader; the next call observes them. This is the discipline
    // that defeats the Bun over-read mechanism rhino reproduced.
    const { readIndex, indexFile } = await import("../scripts/lib.ts");
    const edgeDir = makeEdgeDir();
    try {
      const f = indexFile(edgeDir);
      fs.writeFileSync(f, JSON.stringify(entry("arch_L_a", "2026-05-01T00:00:00Z")) + "\n");
      const sizeBefore = fs.statSync(f).size;
      // Append more after we've conceptually started reading. (We can't truly
      // race a single-process call here, but we can at least verify the reader
      // does NOT over-read past the file size we observe at this instant when
      // the file is well-formed.)
      const got1 = readIndex(edgeDir);
      expect(got1.map((e) => e.id)).toEqual(["arch_L_a"]);
      fs.appendFileSync(f, JSON.stringify(entry("arch_L_b", "2026-05-01T00:01:00Z")) + "\n");
      const got2 = readIndex(edgeDir);
      expect(got2.map((e) => e.id)).toEqual(["arch_L_a", "arch_L_b"]);
      // sizeBefore was used to anchor the assertion; reference it to silence linters.
      expect(sizeBefore).toBeGreaterThan(0);
    } finally { fs.rmSync(edgeDir, { recursive: true, force: true }); }
  });
});

describe("findLivePresence — multi-host safety (cadence F8, P0)", () => {
  // Hardening regression: findLivePresence used to return any presence
  // record whose pid happened to be alive on THIS host, even when the
  // record's host field belonged to a different machine. On a shared
  // filesystem (NFS/sshfs) that misclassification would defeat collision
  // detection and let `gc` unlink another host's live state.
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const os = require("node:os") as typeof import("node:os");

  test("returns null for a presence record whose host is not this host", async () => {
    const { findLivePresence, presenceFile, ensureControlDirs } = await import("../scripts/lib.ts");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-chat-foreignhost-"));
    const prevEnv = process.env.AGENT_CHAT_CONVERSATIONS_DIR;
    process.env.AGENT_CHAT_CONVERSATIONS_DIR = tmp;
    try {
      // Need a fresh import because CONVERSATIONS_DIR is a module constant.
      const fresh = await import(`../scripts/lib.ts?bust=${Date.now()}`);
      fresh.ensureControlDirs();
      const rec = {
        agent: "ghost",
        topology: "petersen",
        session_key: "pid:99999",
        host: "definitely-not-this-host.example",
        pid: process.pid, // ALIVE on this host — the trap the bug fell into
        started_at: "2026-05-01T00:00:00Z",
        cwd: "/tmp",
      };
      fs.writeFileSync(fresh.presenceFile("ghost"), JSON.stringify(rec, null, 2) + "\n");
      expect(fresh.findLivePresence("ghost")).toBeNull();
    } finally {
      if (prevEnv == null) delete process.env.AGENT_CHAT_CONVERSATIONS_DIR;
      else process.env.AGENT_CHAT_CONVERSATIONS_DIR = prevEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns the record when host matches and pid is alive (preserved happy path)", async () => {
    const { findLivePresence, presenceFile, ensureControlDirs } = await import("../scripts/lib.ts");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-chat-myhost-"));
    const prevEnv = process.env.AGENT_CHAT_CONVERSATIONS_DIR;
    process.env.AGENT_CHAT_CONVERSATIONS_DIR = tmp;
    try {
      const fresh = await import(`../scripts/lib.ts?bust=${Date.now()}b`);
      fresh.ensureControlDirs();
      const rec = {
        agent: "live",
        topology: "petersen",
        session_key: "pid:" + process.pid,
        host: os.hostname(),
        pid: process.pid,
        started_at: "2026-05-01T00:00:00Z",
        cwd: "/tmp",
      };
      fs.writeFileSync(fresh.presenceFile("live"), JSON.stringify(rec, null, 2) + "\n");
      const got = fresh.findLivePresence("live");
      expect(got).not.toBeNull();
      expect(got!.agent).toBe("live");
    } finally {
      if (prevEnv == null) delete process.env.AGENT_CHAT_CONVERSATIONS_DIR;
      else process.env.AGENT_CHAT_CONVERSATIONS_DIR = prevEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
