// import-from-kg.test.ts — Phase 7.5 — verify the bridge from CONVO.md
// to the global lattice produces correct (Question, Answer) records,
// is idempotent on re-import, and skips non-Q/A protocol sections.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { LatticeStore } from "./sqlite-store.ts";
import { importEdgeConvo, parseSections, pairSections } from "./import-from-kg.ts";

let store: LatticeStore;
let edgeDir: string;

beforeEach(() => {
  store = new LatticeStore(":memory:");
  edgeDir = fs.mkdtempSync(path.join(os.tmpdir(), "import-kg-"));
});

afterEach(() => {
  store.close();
  fs.rmSync(edgeDir, { recursive: true, force: true });
});

function writeConvo(...sections: string[]): void {
  const content = [
    "# CONVO — boss ↔ orion",
    "",
    "Protocol: agent-chat",
    "",
    ...sections,
  ].join("\n");
  fs.writeFileSync(path.join(edgeDir, "CONVO.md"), content);
}

function section(agent: string, description: string, utc: string, body: string, arrow: string = "orion"): string {
  return [
    "---",
    "",
    `## ${agent} — ${description} (UTC ${utc})`,
    "",
    body,
    "",
    `→ ${arrow}`,
    "",
  ].join("\n");
}

describe("parseSections — header pattern", () => {
  test("parses canonical agent-chat section headers", () => {
    const text = [
      "# Header banner",
      "",
      "## boss — user turn (UTC 2026-05-07T10:00:00Z)",
      "",
      "What is the deadline?",
      "",
      "→ orion",
      "",
      "---",
      "",
      "## orion — assistant response (UTC 2026-05-07T10:00:00Z)",
      "",
      "Friday at 5pm.",
      "",
      "→ boss",
      "",
    ].join("\n");
    const sections = parseSections(text);
    expect(sections.length).toBe(2);
    expect(sections[0].agent).toBe("boss");
    expect(sections[0].description).toBe("user turn");
    expect(sections[0].body).toBe("What is the deadline?");
    expect(sections[1].agent).toBe("orion");
    expect(sections[1].body).toBe("Friday at 5pm.");
  });

  test("skips embedded ## subheadings inside section bodies", () => {
    const text = [
      "## boss — user turn (UTC 2026-05-07T10:00:00Z)",
      "",
      "Here's a question.",
      "",
      "## sub-heading inside body",
      "",
      "More content.",
      "",
      "→ orion",
      "",
    ].join("\n");
    const sections = parseSections(text);
    // Only ONE protocol section (the first); the embedded `## sub-heading`
    // doesn't match the canonical agent-chat header pattern (no `<agent> —`
    // and no `(UTC ...)`).
    expect(sections.length).toBe(1);
  });

  test("strips trailing arrow + separator from body", () => {
    const text = [
      "## boss — user turn (UTC 2026-05-07T10:00:00Z)",
      "",
      "What is X?",
      "",
      "→ orion",
      "",
      "---",
    ].join("\n");
    const sections = parseSections(text);
    expect(sections[0].body).toBe("What is X?");
  });

  // Regression for keystone's NL5 K-imp-2 finding: the trailing-marker
  // stripper used `/m` flag, which makes `$` match end-of-LINE, not
  // end-of-string. Internal `---` lines or `→ name` arrows in body
  // text were stripped along with the legitimate trailing markers.
  test("K-imp-2: internal --- in body is preserved (only TRAILING separator stripped)", () => {
    const text = [
      "## boss — user turn (UTC 2026-05-07T10:00:00Z)",
      "",
      "Section A",
      "---",
      "Section B (after a horizontal rule)",
      "",
      "→ orion",
      "",
      "---",
    ].join("\n");
    const sections = parseSections(text);
    expect(sections.length).toBe(1);
    // Pre-fix: body would be "Section A" (everything after the first
    // internal `---` is stripped because `/m` matches per-line).
    // Post-fix: body must contain BOTH "Section A" and "Section B".
    expect(sections[0].body).toContain("Section A");
    expect(sections[0].body).toContain("Section B");
  });

  test("K-imp-2: internal '→ name' arrow in body is preserved (only TRAILING arrow stripped)", () => {
    // The /m flag bug triggers when an internal line ENDS with "→ word".
    // Pre-fix the do-while loop strips it because $ matches end-of-line.
    const text = [
      "## boss — user turn (UTC 2026-05-07T10:00:00Z)",
      "",
      "First line of body content.",
      "We previously routed it → orion",   // ENDS with `→ orion` — matches /m regex
      "And the response landed.",
      "",
      "→ orion",
    ].join("\n");
    const sections = parseSections(text);
    expect(sections.length).toBe(1);
    // Pre-fix: line 2 was "We previously routed it → orion" and got
    // stripped to "We previously routed it" by /[\n\s]*→\s*\S+\s*$/m.
    // Post-fix: only the TRAILING "→ orion" arrow strips; the internal
    // arrow on line 2 stays.
    expect(sections[0].body).toContain("We previously routed it → orion");
    expect(sections[0].body).toContain("And the response landed");
  });

  test("K-imp-2: internal --- separator in body is preserved (only TRAILING --- stripped)", () => {
    // Same bug, separator variant. Pre-fix the regex strips internal `---`.
    const text = [
      "## boss — user turn (UTC 2026-05-07T10:00:00Z)",
      "",
      "Section A first.",
      "---",
      "Section B after the rule.",
      "",
      "→ orion",
      "",
      "---",
    ].join("\n");
    const sections = parseSections(text);
    expect(sections.length).toBe(1);
    // Post-fix: the internal `---` line should remain in the body.
    // (Pre-fix the do-while loop strips ALL --- lines, internal and
    // trailing alike.)
    expect(sections[0].body).toContain("---");
  });
});

describe("pairSections — Q/A pairing", () => {
  test("pairs adjacent (user-turn, assistant-response)", () => {
    const sections = [
      { agent: "boss",  description: "user turn",          utc: "t0", body: "Q1" },
      { agent: "orion", description: "assistant response", utc: "t0", body: "A1" },
      { agent: "boss",  description: "user turn",          utc: "t1", body: "Q2" },
      { agent: "orion", description: "assistant response", utc: "t1", body: "A2" },
    ];
    const pairs = pairSections(sections);
    expect(pairs.length).toBe(2);
    expect(pairs[0].user.body).toBe("Q1");
    expect(pairs[0].assistant.body).toBe("A1");
    expect(pairs[1].user.body).toBe("Q2");
  });

  test("skips handoffs and other non-Q/A patterns", () => {
    const sections = [
      { agent: "orion", description: "handoff to lumeyon",   utc: "t0", body: "..." },
      { agent: "boss",  description: "user turn",            utc: "t1", body: "Q1" },
      { agent: "orion", description: "assistant response",   utc: "t1", body: "A1" },
      { agent: "boss",  description: "propose subgraph",     utc: "t2", body: "..." },
    ];
    const pairs = pairSections(sections);
    expect(pairs.length).toBe(1);
    expect(pairs[0].user.body).toBe("Q1");
  });

  test("user-turn followed by ANOTHER user-turn produces no pair", () => {
    const sections = [
      { agent: "boss", description: "user turn", utc: "t0", body: "Q1" },
      { agent: "boss", description: "user turn", utc: "t1", body: "Q2" },
    ];
    expect(pairSections(sections)).toEqual([]);
  });

  test("AI-to-AI: adjacent different-agent sections with arbitrary topics pair", () => {
    const sections = [
      { agent: "orion",   description: "kickoff: hardening audit",      utc: "t0", body: "Q from orion" },
      { agent: "lumeyon", description: "lib.ts audit + relay status",   utc: "t1", body: "A from lumeyon" },
    ];
    const pairs = pairSections(sections);
    expect(pairs.length).toBe(1);
    expect(pairs[0].user.agent).toBe("orion");
    expect(pairs[0].assistant.agent).toBe("lumeyon");
    expect(pairs[0].kind).toBe("ai_to_ai");
  });

  test("AI-to-AI: 4-section back-and-forth produces 2 pairs (not 3)", () => {
    // orion → lumeyon → orion → lumeyon should give (orion,lumeyon)
    // and (orion,lumeyon), not (orion,lumeyon)+(lumeyon,orion)+(orion,lumeyon).
    // Sections already consumed by the previous pair must be skipped.
    const sections = [
      { agent: "orion",   description: "topic A", utc: "t0", body: "1" },
      { agent: "lumeyon", description: "topic B", utc: "t1", body: "2" },
      { agent: "orion",   description: "topic C", utc: "t2", body: "3" },
      { agent: "lumeyon", description: "topic D", utc: "t3", body: "4" },
    ];
    const pairs = pairSections(sections);
    expect(pairs.length).toBe(2);
    expect(pairs[0].user.body).toBe("1");
    expect(pairs[0].assistant.body).toBe("2");
    expect(pairs[1].user.body).toBe("3");
    expect(pairs[1].assistant.body).toBe("4");
  });

  test("AI-to-AI: handoff sections do NOT pair", () => {
    const sections = [
      { agent: "orion",   description: "handoff to lumeyon",     utc: "t0", body: "..." },
      { agent: "lumeyon", description: "lib.ts audit",           utc: "t1", body: "real content" },
    ];
    const pairs = pairSections(sections);
    expect(pairs.length).toBe(0);
  });

  test("AI-to-AI: parking sections do NOT pair", () => {
    const sections = [
      { agent: "orion",   description: "parked: converged",       utc: "t0", body: "..." },
      { agent: "lumeyon", description: "next slice analysis",     utc: "t1", body: "real content" },
    ];
    const pairs = pairSections(sections);
    expect(pairs.length).toBe(0);
  });

  test("same-agent adjacent sections do NOT pair (no self-dialogue)", () => {
    const sections = [
      { agent: "orion", description: "topic A", utc: "t0", body: "1" },
      { agent: "orion", description: "topic B", utc: "t1", body: "2" },
    ];
    const pairs = pairSections(sections);
    expect(pairs.length).toBe(0);
  });

  test("mixed: human→AI then AI→AI in sequence both produce pairs", () => {
    const sections = [
      { agent: "boss",    description: "user turn",          utc: "t0", body: "Q from boss" },
      { agent: "orion",   description: "assistant response", utc: "t0", body: "A from orion" },
      { agent: "orion",   description: "follow-up to lumeyon", utc: "t1", body: "Q from orion" },
      { agent: "lumeyon", description: "audit finding",      utc: "t2", body: "A from lumeyon" },
    ];
    const pairs = pairSections(sections);
    expect(pairs.length).toBe(2);
    expect(pairs[0].kind).toBe("human_to_ai");
    expect(pairs[1].kind).toBe("ai_to_ai");
  });
});

describe("importEdgeConvo — full import", () => {
  test("imports a basic Q/A pair", () => {
    writeConvo(
      section("boss",  "user turn",          "2026-05-07T10:00:00Z", "What is the deadline?"),
      section("orion", "assistant response", "2026-05-07T10:00:00Z", "Friday at 5pm.", "boss"),
    );

    const result = importEdgeConvo(store, edgeDir, "petersen/boss-orion");
    expect(result.pairs_found).toBe(1);
    expect(result.questions_inserted).toBe(1);
    expect(result.answers_inserted).toBe(1);

    const stats = store.stats();
    expect(stats.questions).toBe(1);
    expect(stats.answers).toBe(1);
  });

  test("question is keyed by canonical_id (paraphrases unify)", () => {
    writeConvo(
      section("boss",  "user turn",          "2026-05-07T10:00:00Z", "What is the deadline?"),
      section("orion", "assistant response", "2026-05-07T10:00:00Z", "Friday."),
      section("boss",  "user turn",          "2026-05-07T10:01:00Z", "WTF is the deadline?"),
      section("orion", "assistant response", "2026-05-07T10:01:00Z", "Friday at 5pm."),
    );

    const result = importEdgeConvo(store, edgeDir);
    // Both user turns canonicalize to the same Question id (Candidate A
    // strips "wtf" → "what" and the rest of the pipeline maps identical
    // tokens). So we get ONE question with TWO answers.
    expect(result.pairs_found).toBe(2);
    expect(result.questions_inserted).toBe(1);
    expect(result.questions_already_existed).toBe(1);
    expect(result.answers_inserted).toBe(2);

    const stats = store.stats();
    expect(stats.questions).toBe(1);
    expect(stats.answers).toBe(2);
  });

  test("idempotent — re-importing produces no new rows", () => {
    writeConvo(
      section("boss",  "user turn",          "2026-05-07T10:00:00Z", "What is X?"),
      section("orion", "assistant response", "2026-05-07T10:00:00Z", "It's X."),
    );

    importEdgeConvo(store, edgeDir);
    const r2 = importEdgeConvo(store, edgeDir);
    expect(r2.questions_inserted).toBe(0);
    expect(r2.answers_inserted).toBe(0);
    expect(r2.questions_already_existed).toBe(1);
    expect(r2.answers_already_existed).toBe(1);
  });

  test("imported answers carry quality_tier=5 and explanation placeholder", () => {
    writeConvo(
      section("boss",  "user turn",          "2026-05-07T10:00:00Z", "What is X?"),
      section("orion", "assistant response", "2026-05-07T10:00:00Z", "X is the thing."),
    );

    importEdgeConvo(store, edgeDir);
    const answers = store.queryAnswers({});
    expect(answers.length).toBe(1);
    expect(answers[0].quality_tier).toBe(5);
    expect(answers[0].validator_id).toBeNull();
    expect(answers[0].explanation).toContain("auto-imported");
    expect(answers[0].status).toBe("accepted");
  });

  test("question.best_answer_id is set after successful import", () => {
    writeConvo(
      section("boss",  "user turn",          "2026-05-07T10:00:00Z", "What is X?"),
      section("orion", "assistant response", "2026-05-07T10:00:00Z", "X is the thing."),
    );

    importEdgeConvo(store, edgeDir);
    const questions = store.queryQuestions({});
    expect(questions.length).toBe(1);
    expect(questions[0].best_answer_id).not.toBeNull();
    expect(questions[0].status).toBe("answered");
  });

  test("non-existent CONVO.md returns zeros", () => {
    const result = importEdgeConvo(store, edgeDir);
    expect(result.pairs_found).toBe(0);
    expect(result.questions_inserted).toBe(0);
  });

  test("CONVO.md with only banner content produces no Q/A", () => {
    writeConvo();  // just the header banner, no sections
    const result = importEdgeConvo(store, edgeDir);
    expect(result.pairs_found).toBe(0);
    expect(result.questions_inserted).toBe(0);
  });

  // Iter-11: ephemeral peer review responses are SUBSTANTIVE content
  // (the peer's actual review), not transcript scrape. Importer detects
  // them by the section description prefix and tags them as authored
  // (tier 3, real explanation) instead of auto-imported (tier 5,
  // placeholder).
  test("ephemeral peer review response sections are imported as authored content", () => {
    writeConvo(
      section("orion",   "ephemeral peer review request: foo.ts",    "2026-05-07T10:00:00Z", "Review /path/foo.ts...", "lumeyon"),
      section("lumeyon", "ephemeral peer review response: foo.ts",   "2026-05-07T10:01:00Z", "- bug X\n- bug Y\n- bug Z", "parked"),
    );
    importEdgeConvo(store, edgeDir);

    const lumeyonAnswers = store.queryAnswers({ by_agent: "lumeyon" });
    expect(lumeyonAnswers.length).toBe(1);
    const a = lumeyonAnswers[0];
    expect(a.quality_tier).toBe(3);
    expect(a.explanation).not.toContain("auto-imported");
    expect(a.explanation).toContain("Peer review response from lumeyon");
  });

  test("re-importing upgrades a pre-existing auto-imported peer-review answer", () => {
    // Step 1: pre-iter-11, import as auto-imported placeholder via
    // recordAnswer directly (simulating the old import path).
    writeConvo(
      section("orion",   "ephemeral peer review request: bar.ts",    "2026-05-07T10:00:00Z", "Review /path/bar.ts...", "keystone"),
      section("keystone","old assistant response",                   "2026-05-07T10:01:00Z", "- finding 1\n- finding 2", "parked"),
    );
    importEdgeConvo(store, edgeDir);
    const before = store.queryAnswers({ by_agent: "keystone" })[0];
    expect(before.quality_tier).toBe(5);
    expect(before.explanation).toContain("auto-imported");

    // Step 2: rewrite the assistant section's description to the new
    // ephemeral peer review prefix and re-import. The PRIMARY KEY
    // conflict path detects the upgrade and updates explanation + tier.
    writeConvo(
      section("orion",   "ephemeral peer review request: bar.ts",    "2026-05-07T10:00:00Z", "Review /path/bar.ts...", "keystone"),
      section("keystone","ephemeral peer review response: bar.ts",   "2026-05-07T10:01:00Z", "- finding 1\n- finding 2", "parked"),
    );
    importEdgeConvo(store, edgeDir);
    const after = store.queryAnswers({ by_agent: "keystone" })[0];
    expect(after.id).toBe(before.id);  // same answer (deterministic id)
    expect(after.quality_tier).toBe(3);  // upgraded
    expect(after.explanation).not.toContain("auto-imported");
    expect(after.explanation).toContain("Peer review response from keystone");
  });
});

describe("importEdgeConvo — sealed archive walking", () => {
  function writeArchive(arcId: string, ...sections: string[]): void {
    const arcDir = path.join(edgeDir, "archives", "leaf", arcId);
    fs.mkdirSync(arcDir, { recursive: true });
    fs.writeFileSync(path.join(arcDir, "BODY.md"), sections.join("\n"));
    fs.writeFileSync(path.join(arcDir, "META.yaml"), "id: " + arcId + "\n");
    fs.writeFileSync(path.join(arcDir, "SUMMARY.md"), "summary placeholder\n");
  }

  test("archives_walked counts every leaf with BODY.md", () => {
    writeConvo();  // empty live convo
    writeArchive("arch_1",
      section("boss",  "user turn",          "2026-05-07T08:00:00Z", "Q1"),
      section("orion", "assistant response", "2026-05-07T08:00:00Z", "A1"),
    );
    writeArchive("arch_2",
      section("boss",  "user turn",          "2026-05-07T09:00:00Z", "Q2"),
      section("orion", "assistant response", "2026-05-07T09:00:00Z", "A2"),
    );
    const result = importEdgeConvo(store, edgeDir);
    expect(result.archives_walked).toBe(2);
    expect(result.pairs_found).toBe(2);
    expect(result.questions_inserted).toBe(2);
    expect(result.answers_inserted).toBe(2);
  });

  test("CONVO.md + archives are imported together", () => {
    writeConvo(
      section("boss",  "user turn",          "2026-05-07T10:00:00Z", "live Q"),
      section("orion", "assistant response", "2026-05-07T10:00:00Z", "live A"),
    );
    writeArchive("arch_1",
      section("boss",  "user turn",          "2026-05-07T08:00:00Z", "archived Q"),
      section("orion", "assistant response", "2026-05-07T08:00:00Z", "archived A"),
    );
    const result = importEdgeConvo(store, edgeDir);
    expect(result.archives_walked).toBe(1);
    expect(result.pairs_found).toBe(2);
    expect(result.questions_inserted).toBe(2);
  });

  test("archive without BODY.md is skipped", () => {
    writeConvo();
    fs.mkdirSync(path.join(edgeDir, "archives", "leaf", "incomplete_arc"), { recursive: true });
    fs.writeFileSync(path.join(edgeDir, "archives", "leaf", "incomplete_arc", "META.yaml"), "id: incomplete\n");
    // No BODY.md — should be ignored.
    const result = importEdgeConvo(store, edgeDir);
    expect(result.archives_walked).toBe(0);
  });

  test("idempotent across CONVO + archives", () => {
    writeConvo(
      section("boss",  "user turn",          "2026-05-07T10:00:00Z", "live Q"),
      section("orion", "assistant response", "2026-05-07T10:00:00Z", "live A"),
    );
    writeArchive("arch_1",
      section("boss",  "user turn",          "2026-05-07T08:00:00Z", "archived Q"),
      section("orion", "assistant response", "2026-05-07T08:00:00Z", "archived A"),
    );
    importEdgeConvo(store, edgeDir);
    const r2 = importEdgeConvo(store, edgeDir);
    expect(r2.questions_inserted).toBe(0);
    expect(r2.answers_inserted).toBe(0);
    expect(r2.questions_already_existed).toBe(2);
    expect(r2.answers_already_existed).toBe(2);
  });
});

// Regression for keystone's NL5 K-imp-8 finding: Date.parse accepts
// non-strict UTC formats (offsets, missing Z, space separator, etc.)
// despite the protocol specifying `UTC YYYY-MM-DDTHH:MM:SSZ`.
// Pre-NL10: Date.parse("2026-05-07T10:00:00+0500") returns a valid ms
//   but interpretation is in the +0500 offset, NOT UTC. Imported
//   timestamp is shifted by 5 hours.
// NL10 fix: validate the strict ISO-8601 UTC format BEFORE parsing;
// reject non-conforming strings (counted in skippedMalformedTimestamps,
// like the existing NaN-check).
describe("importEdgeConvo — K-imp-8 strict UTC validation", () => {
  test("K-imp-8: non-Z timezone offset is rejected (not silently shifted)", () => {
    writeConvo(
      // +0500 offset — Date.parse accepts but interprets as +05:00, not UTC
      section("boss",  "user turn",          "2026-05-07T10:00:00+0500", "Q with offset"),
      section("orion", "assistant response", "2026-05-07T10:00:00+0500", "A with offset"),
    );
    const result = importEdgeConvo(store, edgeDir);
    // Pre-fix: pair imported with shifted timestamp.
    // Post-fix: pair skipped as malformed UTC.
    expect(result.pairs_found).toBe(1);
    expect(result.questions_inserted).toBe(0);
    expect(result.answers_inserted).toBe(0);
  });

  test("K-imp-8: missing Z is rejected (Date.parse interprets as local time)", () => {
    writeConvo(
      section("boss",  "user turn",          "2026-05-07T10:00:00", "Q no Z"),
      section("orion", "assistant response", "2026-05-07T10:00:00", "A no Z"),
    );
    const result = importEdgeConvo(store, edgeDir);
    expect(result.pairs_found).toBe(1);
    expect(result.questions_inserted).toBe(0);
    expect(result.answers_inserted).toBe(0);
  });

  test("K-imp-8: space separator instead of T is rejected", () => {
    writeConvo(
      section("boss",  "user turn",          "2026-05-07 10:00:00Z", "Q space sep"),
      section("orion", "assistant response", "2026-05-07 10:00:00Z", "A space sep"),
    );
    const result = importEdgeConvo(store, edgeDir);
    expect(result.pairs_found).toBe(1);
    expect(result.questions_inserted).toBe(0);
    expect(result.answers_inserted).toBe(0);
  });

  test("K-imp-8: strict ISO-8601 UTC with Z still imports correctly (positive)", () => {
    writeConvo(
      section("boss",  "user turn",          "2026-05-07T10:00:00Z", "Q strict"),
      section("orion", "assistant response", "2026-05-07T10:00:00Z", "A strict"),
    );
    const result = importEdgeConvo(store, edgeDir);
    expect(result.questions_inserted).toBe(1);
    expect(result.answers_inserted).toBe(1);
  });

  test("K-imp-8: ISO-8601 with milliseconds + Z is accepted (the format Date.toISOString produces)", () => {
    writeConvo(
      section("boss",  "user turn",          "2026-05-07T10:00:00.123Z", "Q millis"),
      section("orion", "assistant response", "2026-05-07T10:00:00.456Z", "A millis"),
    );
    const result = importEdgeConvo(store, edgeDir);
    expect(result.questions_inserted).toBe(1);
    expect(result.answers_inserted).toBe(1);
  });
});
