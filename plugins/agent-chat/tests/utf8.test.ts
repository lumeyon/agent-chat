// utf8.test.ts — direct coverage for the shared UTF-8 byte-truncation
// primitive (NL24 extraction). The same primitive is exercised
// indirectly via lattice-context.test.ts (LC4) and ephemeral-peer-
// review.test.ts (E7); these are pure-function smoke tests for the
// primitive itself so future refactors don't silently drift.

import { test, expect, describe } from "bun:test";
import { truncateToUtf8Bytes, utf8ByteLength } from "../scripts/utf8.ts";

describe("utf8ByteLength", () => {
  test("ASCII: bytes match length", () => {
    expect(utf8ByteLength("hello")).toBe(5);
    expect(utf8ByteLength("")).toBe(0);
  });

  test("CJK: 3 bytes per character", () => {
    expect(utf8ByteLength("中")).toBe(3);
    expect(utf8ByteLength("答案以中文表达")).toBe(21);
  });

  test("emoji: 4 bytes per character (surrogate pair in UTF-16)", () => {
    expect(utf8ByteLength("🎉")).toBe(4);
    expect(utf8ByteLength("🎉🎊🎈🎁")).toBe(16);
  });
});

describe("truncateToUtf8Bytes", () => {
  test("under budget: returns unchanged", () => {
    expect(truncateToUtf8Bytes("hello", 100)).toBe("hello");
    expect(truncateToUtf8Bytes("中文", 6)).toBe("中文");  // exactly 6 bytes
  });

  test("ASCII over budget: truncated to byte limit", () => {
    expect(truncateToUtf8Bytes("hello world", 5)).toBe("hello");
    expect(truncateToUtf8Bytes("aaaaaaaaaa", 4)).toBe("aaaa");
  });

  test("CJK over budget: walks back to character boundary", () => {
    // "答案以中文表达" = 7 chars × 3 bytes = 21 bytes.
    // Budget 7 → would land mid-character at byte 7 (which is byte 1 of
    // char 3 "以"); walk back to start of char 3 → 6 bytes (2 full chars).
    const result = truncateToUtf8Bytes("答案以中文表达", 7);
    expect(utf8ByteLength(result)).toBeLessThanOrEqual(7);
    expect(result).toBe("答案");  // 2 chars × 3 bytes = 6 bytes
  });

  test("emoji over budget at odd offset: never splits surrogate pair", () => {
    // "🎉🎉🎉" = 12 bytes. Budget 7 lands mid-emoji-2 (between bytes
    // 1-3 of "🎉"). Post-fix walks back to start of emoji-2 → 4 bytes
    // (1 full emoji).
    const result = truncateToUtf8Bytes("🎉🎉🎉", 7);
    expect(utf8ByteLength(result)).toBeLessThanOrEqual(7);
    expect(result).toBe("🎉");
    // Round-trip MUST succeed (no orphan surrogates).
    const roundtrip = new TextDecoder("utf-8", { fatal: true }).decode(
      new TextEncoder().encode(result),
    );
    expect(roundtrip).toBe(result);
  });

  test("budget=0 returns empty string", () => {
    expect(truncateToUtf8Bytes("anything", 0)).toBe("");
  });

  test("negative budget returns empty string", () => {
    expect(truncateToUtf8Bytes("hello", -1)).toBe("");
    expect(truncateToUtf8Bytes("世界", -100)).toBe("");
  });

  test("empty input returns empty string", () => {
    expect(truncateToUtf8Bytes("", 5)).toBe("");
    expect(truncateToUtf8Bytes("", 0)).toBe("");
  });
});
