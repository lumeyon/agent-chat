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
