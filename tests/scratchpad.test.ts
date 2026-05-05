// tests/scratchpad.test.ts — Round 15d-α load-bearing tests.
//
// The scratchpad is the structural answer to "the same agent must know
// context from the distant past" under ephemeral-only execution. Tests
// pin: round-trip, size cap with truncation marker, sanitization,
// idempotent writes, ENOENT-tolerance on first read.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let TMP: string;
const ORIG_DIR = process.env.AGENT_CHAT_CONVERSATIONS_DIR;

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "scratchpad-test-"));
  process.env.AGENT_CHAT_CONVERSATIONS_DIR = TMP;
});

afterEach(() => {
  if (ORIG_DIR == null) delete process.env.AGENT_CHAT_CONVERSATIONS_DIR;
  else process.env.AGENT_CHAT_CONVERSATIONS_DIR = ORIG_DIR;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

describe("scratchpad — round-trip + invariants", () => {
  test("readScratch returns empty string for first-run agent (ENOENT-tolerant)", async () => {
    const { readScratch } = await import(`../scripts/lib.ts?t=${Date.now()}`);
    expect(readScratch("orion")).toBe("");
  });

  test("readScratch round-trips writeScratch (basic content)", async () => {
    const { readScratch, writeScratch } = await import(`../scripts/lib.ts?t=${Date.now()}`);
    const content = "# orion's autobiographical memory\n\nStanding context: I am the orchestrator.\n";
    writeScratch("orion", content);
    expect(readScratch("orion")).toBe(content);
  });

  test("writeScratch caps at SCRATCHPAD_MAX_BYTES with truncation marker", async () => {
    const { readScratch, writeScratch, SCRATCHPAD_MAX_BYTES } = await import(`../scripts/lib.ts?t=${Date.now()}`);
    const oversized = "x".repeat(SCRATCHPAD_MAX_BYTES + 1024);
    writeScratch("orion", oversized);
    const read = readScratch("orion");
    expect(read.length).toBeLessThanOrEqual(SCRATCHPAD_MAX_BYTES);
    expect(read).toContain("TRUNCATED at SCRATCHPAD_MAX_BYTES");
  });

  test("scratchPath sanitizes agent names (lyra L1 defense)", async () => {
    const { scratchPath } = await import(`../scripts/lib.ts?t=${Date.now()}`);
    // Path traversal attempt sanitized to underscores.
    const malicious = scratchPath("../../etc/passwd");
    expect(malicious).not.toContain("..");
    expect(malicious).toMatch(/__\.\.__\.\.__etc__passwd\.md|\.\._\.\._etc_passwd\.md|_+etc_passwd\.md/);
  });

  test("multiple writes overwrite (atomic)", async () => {
    const { readScratch, writeScratch } = await import(`../scripts/lib.ts?t=${Date.now()}`);
    writeScratch("carina", "v1 content");
    writeScratch("carina", "v2 content");
    expect(readScratch("carina")).toBe("v2 content");
  });

  test("per-agent isolation — orion's scratchpad does not leak to lumeyon", async () => {
    const { readScratch, writeScratch } = await import(`../scripts/lib.ts?t=${Date.now()}`);
    writeScratch("orion", "orion's notes");
    writeScratch("lumeyon", "lumeyon's notes");
    expect(readScratch("orion")).toBe("orion's notes");
    expect(readScratch("lumeyon")).toBe("lumeyon's notes");
    expect(readScratch("carina")).toBe(""); // never wrote
  });
});
