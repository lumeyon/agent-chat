// Unit tests for extractAnswer. Cover the response shapes we observe in
// real runs (claude + codex output a mix of plain text, markdown, and
// chain-of-thought).

import { test, expect, describe } from "bun:test";
import { extractAnswer } from "./extract.ts";

describe("extractAnswer — canonical shapes", () => {
  test("plain 'Answer: C' on last line", () => {
    expect(extractAnswer("Reasoning here.\n\nAnswer: C")).toBe("C");
  });

  test("'Answer: A.' with trailing period", () => {
    expect(extractAnswer("...explained.\n\nAnswer: A.")).toBe("A");
  });

  test("markdown-bold 'Answer: **C**'", () => {
    expect(extractAnswer("Reasoning.\n\nAnswer: **C**")).toBe("C");
  });

  test("markdown-bold full '**Answer: D**'", () => {
    expect(extractAnswer("...so:\n\n**Answer: D**")).toBe("D");
  });

  test("'Answer: (B)' with parens", () => {
    expect(extractAnswer("...\nAnswer: (B)")).toBe("B");
  });

  test("'Answer is C' without colon", () => {
    expect(extractAnswer("After analysis, the answer is C")).toBe("C");
  });

  test("lowercase 'answer:'", () => {
    expect(extractAnswer("Final analysis.\nanswer: A")).toBe("A");
  });

  test("ALL-CAPS 'ANSWER:'", () => {
    expect(extractAnswer("ANSWER: D")).toBe("D");
  });
});

describe("extractAnswer — chain-of-thought disambiguation", () => {
  test("LAST 'Answer: X' wins (CoT eliminates distractors first)", () => {
    const response = [
      "Let me consider the options:",
      "Answer A would suggest the photon model is correct, but...",
      "Answer B is the wave-particle duality view, no.",
      "Answer C aligns with the quantization rule.",
      "",
      "Answer: C",
    ].join("\n");
    expect(extractAnswer(response)).toBe("C");
  });

  test("LAST 'Answer is X' wins when CoT mentions multiple options", () => {
    const response = [
      "Initially I thought the answer is B, but on reflection",
      "the answer is A because of the recoil momentum.",
    ].join("\n");
    expect(extractAnswer(response)).toBe("A");
  });
});

describe("extractAnswer — bare-letter fallbacks", () => {
  test("bare '(B)' on last non-empty line", () => {
    expect(extractAnswer("Reasoning here.\n\n(B)")).toBe("B");
  });

  test("bare 'C.' on last line", () => {
    expect(extractAnswer("Long explanation.\n\nC.")).toBe("C");
  });

  test("bare 'D' on last line (no punctuation)", () => {
    expect(extractAnswer("Reasoning.\n\nD")).toBe("D");
  });

  test("single-letter response with no preamble", () => {
    expect(extractAnswer("A")).toBe("A");
  });

  test("single-letter response with markdown bold", () => {
    expect(extractAnswer("**B**")).toBe("B");
  });
});

describe("extractAnswer — null / refusal cases", () => {
  test("empty response returns null", () => {
    expect(extractAnswer("")).toBeNull();
  });

  test("whitespace-only response returns null", () => {
    expect(extractAnswer("   \n\t \n")).toBeNull();
  });

  test("API refusal (Claude usage policy) returns null", () => {
    const refusal =
      "API Error: Claude Code is unable to respond to this request, " +
      "which appears to violate our Usage Policy " +
      "(https://www.anthropic.com/legal/aup). Try rephrasing the request " +
      "or attempting a different approach.";
    expect(extractAnswer(refusal)).toBeNull();
  });

  test("response with no answer letter at all returns null", () => {
    expect(extractAnswer("I cannot determine which option is correct without more context.")).toBeNull();
  });

  test("response with letter outside A-D returns null", () => {
    expect(extractAnswer("Reasoning.\n\nAnswer: E")).toBeNull();
  });

  test("response with E on last bare line returns null (out of range)", () => {
    expect(extractAnswer("Reasoning.\n\nE")).toBeNull();
  });
});

describe("extractAnswer — edge cases", () => {
  test("response with answer letter inside a word doesn't match", () => {
    // 'A' inside 'Atom' or 'Analysis' would false-positive without
    // word-boundary discipline.
    expect(extractAnswer("Atomic theory predicts this.")).toBeNull();
    expect(extractAnswer("Bandwidth analysis shows...")).toBeNull();
  });

  test("'Answer: C' trumps a bare 'D' on a later line that's not last", () => {
    // The "Answer: X" pattern should win even if there's a stray letter
    // somewhere later in the response (as long as the stray letter
    // isn't itself in the "Answer:" pattern).
    const response = "Answer: C\n\n(Footnote: option D would be wrong because of...)";
    expect(extractAnswer(response)).toBe("C");
  });

  test("multiple 'Answer: X' lines — last wins", () => {
    const response = "Initial: Answer: B\nWait, let me reconsider.\nAnswer: D";
    expect(extractAnswer(response)).toBe("D");
  });

  test("chain-of-thought ending with 'Answer: X' followed by extra commentary", () => {
    // If the model adds a trailing sentence after "Answer: X", the regex
    // still picks it up (since we scan the whole response).
    const response = "Reasoning.\n\nAnswer: A\n\nThis is the most consistent option.";
    expect(extractAnswer(response)).toBe("A");
  });
});
