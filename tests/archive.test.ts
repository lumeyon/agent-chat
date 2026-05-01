// Archive layer tests: drive archive.ts / condense.ts / search.ts as
// subprocesses against a tmpdir. Validates the seal/commit two-step,
// the validator's anti-theater rules, the leaf→condensed DAG, and the
// grep→describe→expand search escalation.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { mkTmpConversations, rmTmp, runScript, sessionEnv } from "./helpers.ts";

let CONVO_DIR: string;
let ORION_ENV: Record<string, string>;
let EDGE_DIR: string;
let CONVO_FILE: string;

function seedSessionRecord(env: Record<string, string>, agent: string) {
  const key = env.CLAUDE_SESSION_ID!;
  fs.mkdirSync(path.join(CONVO_DIR, ".sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(CONVO_DIR, ".sessions", `${key}.json`),
    JSON.stringify({
      agent, topology: "petersen", session_key: key, claude_session_id: key,
      host: os.hostname(), pid: process.pid,
      started_at: "2026-05-01T00:00:00Z", cwd: CONVO_DIR,
    }),
  );
}

function appendSection(n: number) {
  const block = [
    "",
    "---",
    "",
    `## orion — section ${n} (UTC 2026-05-01T${String(n).padStart(2, "0")}:00:00Z)`,
    "",
    `body for section ${n}, mentions scan-orchestration and verifier-v${n}`,
    "",
    "Decisions:",
    `- decided to ship verifier-v${n}`,
    "",
    "Blockers:",
    "- need vanguard verification",
    "",
    "→ lumeyon",
  ].join("\n");
  fs.appendFileSync(CONVO_FILE, block + "\n");
}

function fillSummary(summaryPath: string, opts: {
  keywords?: string;
  expand?: string;
  withTodo?: boolean;
} = {}) {
  const keywords = opts.keywords ?? "scan-orchestration, verifier, vanguard";
  const expand = opts.expand ?? "exact section bodies, per-section timestamps";
  const todoMark = opts.withTodo ? "TODO: still pending" : "shipping verifier in sequence";
  const text = `# SUMMARY — lumeyon-orion · leaf · depth 0

## TL;DR
Orion is shipping verifier-v1..vN.
${todoMark}.
Vanguard verification is the open blocker.

## Decisions
- Ship verifier-v1..vN incrementally — rationale: blast-radius reduction — evidence: BODY.md.

## Blockers
- Vanguard verification — owner: vanguard.

## Follow-ups
- (none)

## Artifacts referenced
- nodes/customer-delivery

## Keywords
${keywords}

## Expand for details about:
${expand}
`;
  fs.writeFileSync(summaryPath, text);
}

beforeEach(() => {
  CONVO_DIR = mkTmpConversations();
  ORION_ENV = sessionEnv(CONVO_DIR, "orion", "petersen");
  seedSessionRecord(ORION_ENV, "orion");
  // Initialize the edge with orion writing first.
  runScript("turn.ts", ["init", "lumeyon", "orion"], ORION_ENV);
  EDGE_DIR = path.join(CONVO_DIR, "petersen", "lumeyon-orion");
  CONVO_FILE = path.join(EDGE_DIR, "CONVO.md");
});

afterEach(() => { rmTmp(CONVO_DIR); });

describe("archive.ts plan / seal", () => {
  test("plan with no archivable sections reports zero", () => {
    const r = runScript("archive.ts", ["plan", "lumeyon"], ORION_ENV);
    expect(r.stdout).toContain("sections to archive: 0");
  });

  test("plan correctly counts archivable vs fresh tail", () => {
    for (let i = 1; i <= 8; i++) appendSection(i);
    const r = runScript("archive.ts", ["plan", "lumeyon"], ORION_ENV);
    expect(r.stdout).toContain("sections total:      8");
    expect(r.stdout).toContain("sections to archive: 4");
  });

  test("seal refuses unless edge is parked (without --force)", () => {
    for (let i = 1; i <= 8; i++) appendSection(i);
    const r = runScript("archive.ts", ["seal", "lumeyon"], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("not \"parked\"");
  });

  test("seal writes BODY.md, SUMMARY.md stub, META.yaml; truncates CONVO.md", () => {
    for (let i = 1; i <= 8; i++) appendSection(i);
    runScript("turn.ts", ["park", "lumeyon"], ORION_ENV);
    const r = runScript("archive.ts", ["seal", "lumeyon"], ORION_ENV);
    const archMatch = r.stdout.match(/sealed (arch_L_[A-Za-z0-9_]+)/);
    expect(archMatch).not.toBeNull();
    const aid = archMatch![1];
    const adir = path.join(EDGE_DIR, "archives", "leaf", aid);
    expect(fs.existsSync(path.join(adir, "BODY.md"))).toBe(true);
    expect(fs.existsSync(path.join(adir, "SUMMARY.md"))).toBe(true);
    expect(fs.existsSync(path.join(adir, "META.yaml"))).toBe(true);

    // CONVO.md should now contain only header + breadcrumb + 4 fresh-tail sections
    const convo = fs.readFileSync(CONVO_FILE, "utf8");
    expect(convo).toContain("archive breadcrumb:");
    expect(convo).toContain(`archives/leaf/${aid}/`);
    const freshSections = (convo.match(/^## orion — section/gm) ?? []).length;
    expect(freshSections).toBe(4);
  });
});

describe("archive.ts commit (validator)", () => {
  function sealOne(): string {
    for (let i = 1; i <= 8; i++) appendSection(i);
    runScript("turn.ts", ["park", "lumeyon"], ORION_ENV);
    const r = runScript("archive.ts", ["seal", "lumeyon"], ORION_ENV);
    return r.stdout.match(/sealed (arch_L_[A-Za-z0-9_]+)/)![1];
  }

  test("commit refuses a summary that still carries placeholder markers (TODO/FIXME/etc.)", () => {
    // The post-tightening stub passes the validator on its own (so writers
    // do not bounce off the gate after a copy-and-edit). To verify the
    // placeholder-marker gate, write an explicit TODO into the SUMMARY.md
    // after seal and confirm commit rejects it.
    const aid = sealOne();
    const sp = path.join(EDGE_DIR, "archives", "leaf", aid, "SUMMARY.md");
    let body = fs.readFileSync(sp, "utf8");
    body = body.replace(/^## Decisions[\s\S]*?(?=^## Blockers)/m, "## Decisions\nTODO: write the real decision\n\n");
    fs.writeFileSync(sp, body);
    const r = runScript("archive.ts", ["commit", "lumeyon", aid], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("not ready");
  });

  test("commit refuses a summary missing required sections", () => {
    const aid = sealOne();
    const sp = path.join(EDGE_DIR, "archives", "leaf", aid, "SUMMARY.md");
    fs.writeFileSync(sp, "# SUMMARY\n\n## TL;DR\nshort\n");
    const r = runScript("archive.ts", ["commit", "lumeyon", aid], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("missing section");
  });

  test("commit refuses empty Keywords", () => {
    const aid = sealOne();
    const sp = path.join(EDGE_DIR, "archives", "leaf", aid, "SUMMARY.md");
    fillSummary(sp, { keywords: "" });
    const r = runScript("archive.ts", ["commit", "lumeyon", aid], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("keywords");
  });

  test("commit accepts a valid summary and writes index.jsonl", () => {
    const aid = sealOne();
    const sp = path.join(EDGE_DIR, "archives", "leaf", aid, "SUMMARY.md");
    fillSummary(sp);
    const r = runScript("archive.ts", ["commit", "lumeyon", aid], ORION_ENV);
    expect(r.stdout).toContain(`committed ${aid}`);
    const idx = fs.readFileSync(path.join(EDGE_DIR, "index.jsonl"), "utf8");
    const lines = idx.trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.id).toBe(aid);
    expect(entry.depth).toBe(0);
    expect(entry.kind).toBe("leaf");
    expect(entry.keywords).toContain("scan-orchestration");
    expect(entry.tldr.length).toBeGreaterThan(0);
  });
});

describe("condense.ts (DAG) + search.ts", () => {
  // Build two committed leaf archives so we can fold them into d1 and search.
  function buildTwoLeaves(): string[] {
    const ids: string[] = [];
    // First batch
    for (let i = 1; i <= 8; i++) appendSection(i);
    runScript("turn.ts", ["park", "lumeyon"], ORION_ENV);
    let r = runScript("archive.ts", ["seal", "lumeyon"], ORION_ENV);
    const a1 = r.stdout.match(/sealed (arch_L_[A-Za-z0-9_]+)/)![1];
    fillSummary(path.join(EDGE_DIR, "archives", "leaf", a1, "SUMMARY.md"));
    runScript("archive.ts", ["commit", "lumeyon", a1], ORION_ENV);
    ids.push(a1);

    // Second batch — re-take the floor and add more sections
    runScript("turn.ts", ["flip", "lumeyon", "orion"], ORION_ENV, { allowFail: true });
    // (flip from parked is refused per protocol; force the value via lib for the test)
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md.turn"), "orion");
    for (let i = 9; i <= 16; i++) appendSection(i);
    runScript("turn.ts", ["park", "lumeyon"], ORION_ENV);
    r = runScript("archive.ts", ["seal", "lumeyon"], ORION_ENV);
    const a2 = r.stdout.match(/sealed (arch_L_[A-Za-z0-9_]+)/)![1];
    fillSummary(path.join(EDGE_DIR, "archives", "leaf", a2, "SUMMARY.md"), {
      keywords: "rollback, pulsar, design-phase",
      expand: "rollback API sketch details, per-section blockers",
    });
    runScript("archive.ts", ["commit", "lumeyon", a2], ORION_ENV);
    ids.push(a2);
    return ids;
  }

  test("condense seal+commit folds N leaves into one depth-1 archive", () => {
    const [a1, a2] = buildTwoLeaves();
    let r = runScript("condense.ts", ["plan", "lumeyon", "--depth", "0", "--limit", "2"], ORION_ENV);
    expect(r.stdout).toContain("eligible archives:    2");
    r = runScript("condense.ts", ["seal", "lumeyon", "--depth", "0", "--limit", "2"], ORION_ENV);
    const cid = r.stdout.match(/sealed (arch_C_[A-Za-z0-9_]+)/)![1];
    // Find the d1 dir
    const cdir = path.join(EDGE_DIR, "archives", "condensed", "d1", cid);
    expect(fs.existsSync(cdir)).toBe(true);
    fillSummary(path.join(cdir, "SUMMARY.md"), {
      keywords: "verifier, rollback, vanguard, pulsar",
      expand: "which leaf cited each blocker",
    });
    r = runScript("condense.ts", ["commit", "lumeyon", cid], ORION_ENV);
    expect(r.stdout).toContain("folds 2 parent");

    // Verify index.jsonl now has three entries (2 leaves + 1 condensed)
    const idx = fs.readFileSync(path.join(EDGE_DIR, "index.jsonl"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l));
    expect(idx).toHaveLength(3);
    const condensed = idx.find((e) => e.kind === "condensed")!;
    expect(condensed.depth).toBe(1);
    expect(condensed.parents).toEqual([a1, a2]);
    expect(condensed.descendant_count).toBe(2);
  });

  test("search grep hits across keywords / tldr / summaries", () => {
    buildTwoLeaves();
    const r = runScript("search.ts", ["grep", "verifier"], ORION_ENV);
    // verifier appears in section bodies and summary keywords/tldr
    expect(r.stdout).toContain("arch_L_");
  });

  test("search describe prints the SUMMARY.md", () => {
    const [a1] = buildTwoLeaves();
    const r = runScript("search.ts", ["describe", a1], ORION_ENV);
    expect(r.stdout).toContain(a1);
    expect(r.stdout).toContain("## TL;DR");
    expect(r.stdout).toContain("## Keywords");
  });

  test("search expand prints the leaf's BODY.md verbatim", () => {
    const [a1] = buildTwoLeaves();
    const r = runScript("search.ts", ["expand", a1], ORION_ENV);
    expect(r.stdout).toContain("## orion — section 1");
    expect(r.stdout).toContain("verifier-v1");
  });

  test("search expand --children walks a condensed node down to its leaves", () => {
    const [a1, a2] = buildTwoLeaves();
    let r = runScript("condense.ts", ["seal", "lumeyon", "--depth", "0", "--limit", "2"], ORION_ENV);
    const cid = r.stdout.match(/sealed (arch_C_[A-Za-z0-9_]+)/)![1];
    const cdir = path.join(EDGE_DIR, "archives", "condensed", "d1", cid);
    fillSummary(path.join(cdir, "SUMMARY.md"), {
      keywords: "verifier, rollback, condensed",
      expand: "leaf-specific evidence",
    });
    runScript("condense.ts", ["commit", "lumeyon", cid], ORION_ENV);
    r = runScript("search.ts", ["expand", cid, "--children"], ORION_ENV);
    expect(r.stdout).toContain(a1);
    expect(r.stdout).toContain(a2);
    expect(r.stdout).toContain("## TL;DR");
  });

  test("search list returns all archives sorted by time", () => {
    buildTwoLeaves();
    const r = runScript("search.ts", ["list"], ORION_ENV);
    const archCount = (r.stdout.match(/^arch_L_/gm) ?? []).length;
    expect(archCount).toBe(2);
  });
});

describe("archive.ts new commands — abort, verify, doctor (P1, keystone drift-prevention)", () => {
  function sealOne(): string {
    for (let i = 1; i <= 8; i++) appendSection(i);
    runScript("turn.ts", ["park", "lumeyon"], ORION_ENV);
    const r = runScript("archive.ts", ["seal", "lumeyon"], ORION_ENV);
    return r.stdout.match(/sealed (arch_L_[A-Za-z0-9_]+)/)![1];
  }
  function commitOne(aid: string): void {
    fillSummary(path.join(EDGE_DIR, "archives", "leaf", aid, "SUMMARY.md"));
    runScript("archive.ts", ["commit", "lumeyon", aid], ORION_ENV);
  }

  test("seal acquires the edge lock; concurrent seal is refused", () => {
    for (let i = 1; i <= 8; i++) appendSection(i);
    runScript("turn.ts", ["park", "lumeyon"], ORION_ENV);
    // Plant a lock to simulate a peer mid-seal.
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md.turn.lock"), `lumeyon@${os.hostname()}:99999:0 2026-05-01T00:00:00Z\n`);
    const r = runScript("archive.ts", ["seal", "lumeyon"], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("locked");
  });

  test("verify catches sha256 mismatch when BODY.md was tampered with", () => {
    const aid = sealOne();
    commitOne(aid);
    // Tamper with BODY.md.
    const bodyPath = path.join(EDGE_DIR, "archives", "leaf", aid, "BODY.md");
    fs.writeFileSync(bodyPath, fs.readFileSync(bodyPath, "utf8") + "\n<TAMPERED>");
    const r = runScript("archive.ts", ["verify", "lumeyon", aid], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("MISMATCH");
  });

  test("verify reports ok on a clean archive", () => {
    const aid = sealOne();
    commitOne(aid);
    const r = runScript("archive.ts", ["verify", "lumeyon", aid], ORION_ENV);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ok");
  });

  test("abort restores BODY.md back into CONVO.md and removes the archive directory (pre-commit)", () => {
    const aid = sealOne();
    const adir = path.join(EDGE_DIR, "archives", "leaf", aid);
    const body = fs.readFileSync(path.join(adir, "BODY.md"), "utf8");
    expect(body).toContain("section 1");
    // Abort BEFORE commit (status: pending-commit).
    const r = runScript("archive.ts", ["abort", "lumeyon", aid], ORION_ENV);
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(adir)).toBe(false);
    const convo = fs.readFileSync(CONVO_FILE, "utf8");
    expect(convo).toContain("section 1");
    expect(convo).not.toContain("archive breadcrumb:");
  });

  test("abort refuses a sealed archive without --force", () => {
    const aid = sealOne();
    commitOne(aid);
    const r = runScript("archive.ts", ["abort", "lumeyon", aid], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("status=sealed");
  });

  test("doctor reports clean on a healthy archive set", () => {
    const aid = sealOne();
    commitOne(aid);
    const r = runScript("archive.ts", ["doctor", "lumeyon"], ORION_ENV);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("no drift");
  });

  test("doctor reports drift when an archive's path goes missing", () => {
    const aid = sealOne();
    commitOne(aid);
    fs.rmSync(path.join(EDGE_DIR, "archives", "leaf", aid), { recursive: true, force: true });
    const r = runScript("archive.ts", ["doctor", "lumeyon"], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toContain("archive directory missing");
  });

  test("doctor catches BODY.md sha256 drift", () => {
    const aid = sealOne();
    commitOne(aid);
    const bodyPath = path.join(EDGE_DIR, "archives", "leaf", aid, "BODY.md");
    fs.writeFileSync(bodyPath, fs.readFileSync(bodyPath, "utf8") + "\n<TAMPERED>");
    const r = runScript("archive.ts", ["doctor", "lumeyon"], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toContain("BODY.md sha256 mismatch");
  });
});

describe("condense.ts commit refuses missing parents (keystone drift-prevention)", () => {
  function buildTwoLeaves(): [string, string] {
    for (let i = 1; i <= 8; i++) appendSection(i);
    runScript("turn.ts", ["park", "lumeyon"], ORION_ENV);
    const r1 = runScript("archive.ts", ["seal", "lumeyon"], ORION_ENV);
    const a1 = r1.stdout.match(/sealed (arch_L_[A-Za-z0-9_]+)/)![1];
    fillSummary(path.join(EDGE_DIR, "archives", "leaf", a1, "SUMMARY.md"));
    runScript("archive.ts", ["commit", "lumeyon", a1], ORION_ENV);
    // Resume orion's floor by writing the .turn directly (test-only shortcut;
    // production resume would go through `init` or a deliberate hand-off).
    fs.writeFileSync(path.join(EDGE_DIR, "CONVO.md.turn"), "orion");
    for (let i = 9; i <= 16; i++) appendSection(i);
    runScript("turn.ts", ["park", "lumeyon"], ORION_ENV);
    const r2 = runScript("archive.ts", ["seal", "lumeyon"], ORION_ENV);
    const a2 = r2.stdout.match(/sealed (arch_L_[A-Za-z0-9_]+)/)![1];
    fillSummary(path.join(EDGE_DIR, "archives", "leaf", a2, "SUMMARY.md"));
    runScript("archive.ts", ["commit", "lumeyon", a2], ORION_ENV);
    return [a1, a2];
  }

  test("condense commit refuses if a declared parent has been removed from the index since seal", () => {
    const [a1, a2] = buildTwoLeaves();
    // Seal a condensed archive.
    const cs = runScript("condense.ts", ["seal", "lumeyon", "--limit", "2"], ORION_ENV);
    const cid = cs.stdout.match(/sealed (arch_C_[A-Za-z0-9_]+)/)![1];
    const cdir = path.join(EDGE_DIR, "archives", "condensed", "d1", cid);
    fillSummary(path.join(cdir, "SUMMARY.md"), {
      keywords: "verifier, rollback, condensed",
      expand: "leaf-specific evidence",
    });
    // Remove one parent from the index manually (simulating drift).
    const indexPath = path.join(EDGE_DIR, "index.jsonl");
    const lines = fs.readFileSync(indexPath, "utf8").split("\n").filter(Boolean);
    const filtered = lines.filter((l) => !l.includes(`"${a1}"`));
    fs.writeFileSync(indexPath, filtered.join("\n") + "\n");
    const r = runScript("condense.ts", ["commit", "lumeyon", cid], ORION_ENV, { allowFail: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("missing from index");
    expect(r.stderr).toContain(a1);
    // a2 not mentioned because it's still present.
    expect(r.stderr).not.toContain(a2);
  });
});
