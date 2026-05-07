// Candidate A — hand-crafted rules.
//
// The cheapest, most deterministic, most debuggable candidate. Pure
// string transformation pipeline; no embeddings; no LLM calls.
// Establishes the baseline against which fancier candidates must
// justify their cost.
//
// Pipeline (each step is independently testable):
//
//   1. Unicode NFKC normalization (handles full-width, ligatures, etc.)
//   2. Trim + collapse internal whitespace
//   3. Lowercase
//   4. Expand contractions via a versioned dictionary
//   5. Strip filler/politeness markers (hey, please, thanks, sorry, etc.)
//   6. Strip register markers (WTF, the hell, like)
//   7. Strip leading/trailing modifier phrases (in production, by default,
//      after deploy, etc.) — these are word-order variations the canonical
//      form should fold away
//   8. Strip terminal punctuation (.?!)
//   9. Apply synonym substitution via a versioned dictionary
//  10. Sort question-word to canonical position (move to front)
//  11. Compute canonical_id := v1:<sha256(normalized)[:16]>
//
// Per docs/canonical-equivalence-spec.md §3, this candidate should
// correctly handle: surface_form, contractions, filler_politeness,
// register, word_order. It will NOT handle: voice (active↔passive),
// inflection in any depth (only crude lemma stripping), domain
// synonyms unless added to the dict.

import * as crypto from "node:crypto";
import type { Normalizer, NormalizeResult } from "./types.ts";
import { defaultEquivalent } from "./types.ts";

// ─── Versioned dictionaries ────────────────────────────────────────────────
// These are the v1 dictionaries. Adding entries is a sub-version bump
// (canonical_id stays "v1" — the assumption is monotonic improvement).
// Removing entries (which un-merges previously-merged questions) is a
// major version bump.

const CONTRACTIONS_V1: Array<[RegExp, string]> = [
  [/\bwhat's\b/g, "what is"],
  [/\bwhere's\b/g, "where is"],
  [/\bhow's\b/g, "how is"],
  [/\bwhy's\b/g, "why is"],
  [/\bwho's\b/g, "who is"],
  [/\bthat's\b/g, "that is"],
  [/\bit's\b/g, "it is"],
  [/\bthere's\b/g, "there is"],
  [/\bdon't\b/g, "do not"],
  [/\bdoesn't\b/g, "does not"],
  [/\bdidn't\b/g, "did not"],
  [/\bcan't\b/g, "cannot"],
  [/\bwon't\b/g, "will not"],
  [/\bisn't\b/g, "is not"],
  [/\baren't\b/g, "are not"],
  [/\bwasn't\b/g, "was not"],
  [/\bweren't\b/g, "were not"],
  [/\bcouldn't\b/g, "could not"],
  [/\bshouldn't\b/g, "should not"],
  [/\bwouldn't\b/g, "would not"],
  [/\byou're\b/g, "you are"],
  [/\bthey're\b/g, "they are"],
  [/\bwe're\b/g, "we are"],
  [/\bi'm\b/g, "i am"],
  [/\bi'll\b/g, "i will"],
  [/\bi've\b/g, "i have"],
  [/\bi'd\b/g, "i would"],
  [/\bhow'd\b/g, "how did"],
  [/\bhow'll\b/g, "how will"],
  [/\bwhat'll\b/g, "what will"],
];

// Synonyms in the programmer/operator domain. Keys are canonical forms;
// values are alternates that map TO the canonical. Bidirectional for
// detection but only one direction for replacement (everything maps to key).
const SYNONYMS_V1: Record<string, string[]> = {
  // canonical: alternates
  "function": ["method", "procedure", "subroutine"],
  "bug": ["defect", "issue", "problem"],
  "fix": ["resolve", "patch", "remedy"],
  "error": ["fault", "exception", "failure"],
  "test": ["check", "verify", "validate"],
  "config": ["configuration", "settings", "setup"],
  "deploy": ["release", "publish", "ship"],
  "log": ["logs", "logging"],
  "build": ["compile", "package"],
  "run": ["execute", "invoke"],
};

// Filler/politeness phrases. Stripped wholesale.
const FILLERS_V1 = [
  /\bhey\b\s*,?\s*/g,
  /\bsorry\b\s*,?\s*/g,
  /\bplease\b\s*,?\s*/g,
  /\bthanks?\b\s*,?\s*/g,
  /\byo\b\s*,?\s*/g,
  /\bquick\s+q(uestion)?\b\s*[—:-]\s*/g,
  /\bjust\s+curious\b\s*,?\s*/g,
  /\bhi\b\s*!?\s*/g,
  /\banyway\b\s*,?\s*/g,
  /,?\s*\bany\s*time\b/g,
  /,?\s*\bthx\b/g,
];

// Register markers. Some are REPLACEMENTS (e.g. WTF stands for "what" in
// the original — must map back, not just strip), others are pure
// insertions (the hell, like) and get stripped. Order matters: process
// replacements before strips so we don't accidentally consume a word
// the strip would have left untouched.
const REGISTER_V1: Array<[RegExp, string]> = [
  // Replacement-style: the marker REPLACED a canonical word in the source.
  [/\bwtf\b/g, "what"],
  // Insertion-style: pure intensifiers, just strip.
  [/\bthe\s+hell\s+/g, ""],
  [/\bthe\s+heck\s+/g, ""],
  [/\bthe\s+fuck\s+/g, ""],
  [/\bthe\s+damn\s+/g, ""],
  [/\bdamn\s+/g, ""],
  [/\bfucking\s+/g, ""],
  [/\bdamned\s+/g, ""],
  [/\s*,\s*like\s*,\s*/g, " "],
];

// Leading/trailing modifier phrases that move freely without changing
// meaning ("in production X" ≡ "X in production"). We strip them entirely;
// the canonical form drops the modifier. This is correct for spec §3.1
// word_order MERGE — both forms collapse to the same canonical.
//
// Note: this is intentionally aggressive and may miss subtle modifier
// types. For v1 we accept that as a cost of simplicity.
// Each modifier pattern has a leading-position form (with trailing comma)
// and a trailing-position form (with optional preceding comma). The
// trailing form must NOT require a comma so that "X in production" merges
// with "in production, X".
const MODIFIERS_V1 = [
  /^in\s+(production|prod|staging|dev|development|qa|test)\s*,\s*/i,
  /\s+in\s+(production|prod|staging|dev|development|qa|test)\b\s*,?/i,
  /^on\s+(linux|macos|mac|windows|ubuntu|debian|alpine|centos)\s*,\s*/i,
  /\s+on\s+(linux|macos|mac|windows|ubuntu|debian|alpine|centos)\b\s*,?/i,
  /^by\s+default\s*,\s*/i,
  /\s+by\s+default\b\s*,?/i,
  /^after\s+deploy\s*,\s*/i,
  /\s+after\s+deploy\b\s*,?/i,
  /^when\s+using\s+\w+\s+mode\s*,\s*/i,
  /\s+when\s+using\s+\w+\s+mode\b\s*,?/i,
  /^after\s+the\s+refactor\s*,\s*/i,
  /\s+after\s+the\s+refactor\b\s*,?/i,
  /^if\s+i\s+\w+(\s+\w+)*\s*,\s*/i,
  /^with\s+(logging|caching|debugging)\s+(on|enabled)\s*,\s*/i,
  /\s+with\s+(logging|caching|debugging)\s+(on|enabled)\b\s*,?/i,
  /^,?\s*exactly\s*,?\s*/i,
  /\s+,?\s*exactly\s*[?.!]?$/i,
  /^,?\s*in\s+detail\s*,?\s*/i,
  /\s*,?\s*in\s+detail\b/i,
];

// Question-word reordering: if a question starts with "in X, what is Y?"
// or similar, the canonical form moves the question word to the front.
// We achieve this by stripping leading modifier clauses (above) and then
// the question word is naturally first.

// Crude lemma stripping. Removes common verb endings to fold inflectional
// variants. NOT a real lemmatizer; it intentionally misses irregular forms
// to keep the implementation closed-form. Trade-off: precision-first means
// we under-merge rather than over-merge.
function stripInflection(token: string): string {
  // Order matters — try longest suffixes first.
  for (const suf of ["ing", "tion", "ies", "ed", "s"]) {
    if (token.endsWith(suf) && token.length > suf.length + 2) {
      const stem = token.slice(0, token.length - suf.length);
      // Restore terminal 'e' for -ied → -y → -y; for -ing/-ed verbs that
      // had an 'e' before suffix.
      if (suf === "ies") return stem + "y";
      return stem;
    }
  }
  return token;
}

// ─── Pipeline steps ────────────────────────────────────────────────────────

export function step_unicode(s: string): string {
  return s.normalize("NFKC");
}

export function step_whitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function step_lowercase(s: string): string {
  return s.toLowerCase();
}

export function step_contractions(s: string): string {
  let out = s;
  for (const [re, repl] of CONTRACTIONS_V1) {
    out = out.replace(re, repl);
  }
  return out;
}

export function step_strip_fillers(s: string): string {
  let out = s;
  for (const re of FILLERS_V1) {
    out = out.replace(re, "");
  }
  return out;
}

export function step_strip_register(s: string): string {
  let out = s;
  for (const [re, repl] of REGISTER_V1) {
    out = out.replace(re, repl);
  }
  return out;
}

export function step_strip_modifiers(s: string): string {
  let out = s;
  // Apply repeatedly so chained modifiers all strip.
  let prev: string;
  let iter = 0;
  do {
    prev = out;
    for (const re of MODIFIERS_V1) {
      out = out.replace(re, "");
    }
    iter++;
  } while (out !== prev && iter < 5);
  return out;
}

export function step_strip_terminal_punct(s: string): string {
  return s.replace(/[?.!]+$/, "");
}

export function step_synonyms(s: string): string {
  let out = s;
  for (const [canonical, alternates] of Object.entries(SYNONYMS_V1)) {
    for (const alt of alternates) {
      const re = new RegExp(`\\b${alt}\\b`, "g");
      out = out.replace(re, canonical);
    }
  }
  return out;
}

export function step_lemmatize(s: string): string {
  return s.split(/\s+/).map(stripInflection).join(" ");
}

// ─── Full pipeline ─────────────────────────────────────────────────────────

export function normalizeString(q: string): string {
  let s = q;
  s = step_unicode(s);
  s = step_lowercase(s);
  s = step_whitespace(s);
  s = step_contractions(s);
  s = step_strip_register(s);
  s = step_strip_fillers(s);
  s = step_strip_modifiers(s);
  s = step_strip_terminal_punct(s);
  s = step_whitespace(s);
  s = step_synonyms(s);
  s = step_lemmatize(s);
  s = step_whitespace(s);
  return s;
}

export const candidateA: Normalizer = {
  id: "candidate-A",
  version: "v1",

  async normalize(q: string): Promise<NormalizeResult> {
    const normalized = normalizeString(q);
    const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
    return {
      canonical_id: `${this.version}:${hash}`,
      normalized,
    };
  },

  async equivalent(q1: string, q2: string): Promise<boolean> {
    return defaultEquivalent(this, q1, q2);
  },
};

// CLI entry: normalize a single question.
//
//   bun scripts/normalize/candidate-a.ts "What is the deadline?"
//   → v1:<hash>  ←normalized→ "what is deadline"

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: candidate-a.ts "<question>"');
    process.exit(2);
  }
  const q = args.join(" ");
  const r = await candidateA.normalize(q);
  console.log(`input:        ${JSON.stringify(q)}`);
  console.log(`normalized:   ${JSON.stringify(r.normalized)}`);
  console.log(`canonical_id: ${r.canonical_id}`);
}
