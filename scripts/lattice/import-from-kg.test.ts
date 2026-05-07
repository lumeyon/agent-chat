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
