// extract.ts — robust extraction of A/B/C/D from an LLM's free-form
// response. The benchmark prompt asks the model to output exactly
// "Answer: X" on the last line, but real LLM responses vary:
//
//   - "Answer: C"                          (canonical)
//   - "**Answer: C**"                      (markdown bold)
//   - "Answer: **C**"                      (just the letter bold)
//   - "Answer is C."                       (no colon)
//   - "Answer: (C)"                        (parens)
//   - "the answer is C"                    (lowercase)
//   - "Answer: D would be wrong because... Answer: A"  (chain-of-thought first attempt)
//   - "(A)"                                 (just the letter on the last line)
//   - "C"                                   (single-letter response)
//   - "" / refusal / API error              (no answer present)
//
// Strategy:
//   1. Find ALL "Answer: X" / "Answer is X" matches; return the LAST one
//      (lets chain-of-thought eliminate distractors before stating the
//      final answer).
//   2. If nothing matched, fall back to the LAST non-empty line and
//      check if it's a bare "(X)" / "X." / "X" pattern.
//
// Returns null when no letter can be confidently extracted (refusal,
// empty response, or model went off-script entirely).

const ANSWER_RE = /(?:Answer|answer|ANSWER)\s*(?:is)?\s*[:\-]?\s*\*{0,2}\(?([ABCD])\)?\*{0,2}/g;

const BARE_LAST_LINE_RE = /^\(?([ABCD])\)?[\.\:\)]?$/;

export function extractAnswer(response: string): string | null {
  if (!response) return null;
  const trimmed = response.trim();
  if (!trimmed) return null;

  // Pass 1: find all "Answer: X" matches; return the last one.
  let lastLetter: string | null = null;
  let m: RegExpExecArray | null;
  ANSWER_RE.lastIndex = 0;  // safety: reset between calls (regex is module-level)
  while ((m = ANSWER_RE.exec(response)) !== null) {
    lastLetter = m[1].toUpperCase();
  }
  if (lastLetter) return lastLetter;

  // Pass 2: bare letter on the last non-empty line.
  const lines = response.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length > 0) {
    const last = lines[lines.length - 1];
    const m2 = BARE_LAST_LINE_RE.exec(last);
    if (m2) return m2[1];
  }

  // Pass 3: a single-letter (A/B/C/D) response, possibly with surrounding
  // markdown markup. Common when models are asked terse questions and
  // reply with just the letter.
  if (trimmed.length <= 5) {
    const m3 = /^\*{0,2}\(?([ABCD])\)?\*{0,2}\.?$/.exec(trimmed);
    if (m3) return m3[1];
  }

  return null;
}
