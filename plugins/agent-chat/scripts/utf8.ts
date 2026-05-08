// utf8.ts — small UTF-8 byte-truncation utility shared between
// lattice-context.ts (cross-domain push prompt block) and
// ephemeral-peer-review.ts (review prompt module-source truncation).
//
// Pre-NL23/NL24, both files used JS `.length` (UTF-16 code units) and
// `.slice` (also UTF-16) to enforce byte budgets. For non-ASCII content
// (CJK = 3 bytes/char, emoji = 4 bytes/char + surrogate pair, accented
// Latin = 2 bytes/char) the two diverge:
//   - Multi-byte payloads slipped past the budget unchanged when bytes
//     >> code units (carina LC2/LC4 = E7).
//   - .slice could cut mid-surrogate-pair, producing orphan surrogates
//     and broken UTF-8 on output.
//
// This module centralizes the correct primitive so future byte-budget
// callers don't re-introduce the same class of bug.

/** UTF-8 byte length of a string. Equivalent to
 *  `new TextEncoder().encode(s).length` but expressed as a named
 *  intent so call sites read clearly. */
export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Truncate `s` to at most `maxBytes` UTF-8 bytes, ending at a valid
 *  UTF-8 character boundary (never splits a multi-byte sequence). When
 *  the input already fits within the budget, returns it unchanged.
 *
 *  Returns "" when `maxBytes <= 0` (zero-byte budget = nothing fits).
 *  Callers that want a trailing ellipsis or elision marker should
 *  reserve those bytes themselves and call with the smaller budget.
 *
 *  Implementation: encode once, walk back from the cut index past any
 *  UTF-8 continuation bytes (0b10xxxxxx, 0x80..0xBF) until a non-
 *  continuation byte is found — that is, the start of the previous
 *  character. Decode the prefix; the result is guaranteed valid UTF-8. */
export function truncateToUtf8Bytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= maxBytes) return s;
  let cut = maxBytes;
  while (cut > 0 && (bytes[cut] & 0xC0) === 0x80) cut--;
  return new TextDecoder().decode(bytes.subarray(0, cut));
}
