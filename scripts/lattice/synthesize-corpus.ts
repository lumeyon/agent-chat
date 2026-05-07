#!/usr/bin/env bun
// synthesize-corpus.ts — template-based variant generator for the
// canonical-equivalence corpus.
//
// Hand-curating 1500-2000 pairs is expensive and high-variance. For
// categories where the transformation is mechanical (surface form,
// contractions, register, scope quantifiers, tense aspect, simple
// negation), deterministic templates produce reliable variants from
// a seed pool of natural questions.
//
// Each Transform takes a seed question and returns the (category, label,
// q2) of a generated pair, OR null if the transform doesn't apply.
// Pairs are deduplicated against the existing corpus and against each
// other before being appended.
//
// Categories NOT handled by this script (need hand-curation or LLM):
//   - voice (active↔passive needs grammar awareness)
//   - different_referent (needs domain antonym knowledge)
//   - different_question_word (limited mechanical templates)
//   - granularity_narrowing/broadening (semantic, not surface)
//   - inflection (broader morphology than tense flip)
//   - filler_politeness (already template-friendly but limited unique forms;
//     handled via prepend_filler/append_filler below)
//
// Usage:
//   bun scripts/lattice/synthesize-corpus.ts --self-test
//     # Run unit tests on the transforms.
//
//   bun scripts/lattice/synthesize-corpus.ts --dry-run [--max <N>]
//     # Print proposed new pairs without writing.
//
//   bun scripts/lattice/synthesize-corpus.ts --append [--max <N>]
//     # Append new pairs to tests/canonical-equivalence-corpus.v1.jsonl.

import * as fs from "node:fs";
import * as path from "node:path";

type Label = "merge" | "separate";

interface Variant {
  q2: string;
  category: string;
  label: Label;
  subcategory?: string;
}

interface Transform {
  name: string;
  apply(q1: string): Variant | null;
}

// ─── Transforms ────────────────────────────────────────────────────────────

// Surface form: punctuation/case/whitespace differences. MERGE.

const upperCase: Transform = {
  name: "surface_form.uppercase",
  apply(q1) {
    const q2 = q1.toUpperCase();
    if (q2 === q1) return null;
    return { q2, category: "surface_form", label: "merge" };
  },
};

const lowerCase: Transform = {
  name: "surface_form.lowercase",
  apply(q1) {
    const q2 = q1.toLowerCase();
    if (q2 === q1) return null;
    return { q2, category: "surface_form", label: "merge" };
  },
};

const trailingWhitespace: Transform = {
  name: "surface_form.trailing_ws",
  apply(q1) {
    const q2 = q1 + "  ";
    if (q2 === q1) return null;
    return { q2, category: "surface_form", label: "merge" };
  },
};

const trailingExclaim: Transform = {
  name: "surface_form.exclaim",
  apply(q1) {
    if (!q1.endsWith("?")) return null; // only on questions
    const q2 = q1.slice(0, -1) + "?!";
    return { q2, category: "surface_form", label: "merge" };
  },
};

const droppedPunct: Transform = {
  name: "surface_form.no_punct",
  apply(q1) {
    if (!/[?.!]$/.test(q1)) return null;
    const q2 = q1.replace(/[?.!]+$/, "");
    if (q2 === q1) return null;
    return { q2, category: "surface_form", label: "merge" };
  },
};

// Contractions: standard expansion table. MERGE.
// Matches contracted form anywhere; expands to the long form.

const CONTRACTION_MAP: Array<[RegExp, string]> = [
  [/\bwhat's\b/gi, "what is"],
  [/\bwhere's\b/gi, "where is"],
  [/\bhow's\b/gi, "how is"],
  [/\bwhy's\b/gi, "why is"],
  [/\bwho's\b/gi, "who is"],
  [/\bdon't\b/gi, "do not"],
  [/\bdoesn't\b/gi, "does not"],
  [/\bdidn't\b/gi, "did not"],
  [/\bcan't\b/gi, "cannot"],
  [/\bwon't\b/gi, "will not"],
  [/\bisn't\b/gi, "is not"],
  [/\baren't\b/gi, "are not"],
  [/\bwasn't\b/gi, "was not"],
  [/\bweren't\b/gi, "were not"],
  [/\bit's\b/gi, "it is"],
  [/\bthat's\b/gi, "that is"],
  [/\byou're\b/gi, "you are"],
  [/\bthey're\b/gi, "they are"],
  [/\bwe're\b/gi, "we are"],
  [/\bI'm\b/g, "I am"],
  [/\bI'll\b/g, "I will"],
  [/\bI've\b/g, "I have"],
  [/\bI'd\b/g, "I would"],
];

const expandContractions: Transform = {
  name: "contractions.expand",
  apply(q1) {
    let q2 = q1;
    let matched = false;
    for (const [re, expansion] of CONTRACTION_MAP) {
      if (re.test(q2)) {
        q2 = q2.replace(re, expansion);
        matched = true;
      }
    }
    if (!matched || q2 === q1) return null;
    return { q2, category: "contractions", label: "merge" };
  },
};

// Filler / politeness: prefix/suffix injection. MERGE.

const PREFIX_FILLERS = ["Hey, ", "Sorry, ", "Quick q — ", "Just curious, ", "Hi! "];
const SUFFIX_FILLERS = [", thanks?", ", please?", ", anyway?"];

function prependFiller(idx: number): Transform {
  return {
    name: `filler_politeness.prepend.${idx}`,
    apply(q1) {
      // Lowercase the first letter so the prepended filler reads naturally.
      const tail = q1.charAt(0).toLowerCase() + q1.slice(1);
      const q2 = PREFIX_FILLERS[idx] + tail;
      return { q2, category: "filler_politeness", label: "merge" };
    },
  };
}

function appendFiller(idx: number): Transform {
  return {
    name: `filler_politeness.append.${idx}`,
    apply(q1) {
      // Replace trailing punctuation with the suffix filler.
      const stripped = q1.replace(/[?.!]+$/, "");
      const q2 = stripped + SUFFIX_FILLERS[idx];
      return { q2, category: "filler_politeness", label: "merge" };
    },
  };
}

// Register: inject casualness markers. MERGE.

const REGISTER_INSERTS = [
  { name: "register.WTF", regex: /\bwhat\b/i, replace: "WTF" },
  { name: "register.thehell", regex: /\bwhy\b/i, replace: "Why the hell" },
  { name: "register.like", regex: /\bdo I\b/i, replace: "do I, like," },
];

function registerTransform(rule: typeof REGISTER_INSERTS[0]): Transform {
  return {
    name: rule.name,
    apply(q1) {
      if (!rule.regex.test(q1)) return null;
      const q2 = q1.replace(rule.regex, rule.replace);
      if (q2 === q1) return null;
      return { q2, category: "register", label: "merge" };
    },
  };
}

// Word order: prepend or move modifier phrases. MERGE.
// Only applies when seed already contains a parenthetical-style modifier.

const WORD_ORDER_PHRASES = [
  "In production, ",
  "On Linux, ",
  "When using async mode, ",
  "After deploy, ",
  "By default, ",
];

function wordOrderTransform(idx: number): Transform {
  const phrase = WORD_ORDER_PHRASES[idx];
  return {
    name: `word_order.prepend.${idx}`,
    apply(q1) {
      // Generate a pair where q1 has the modifier prepended and q2 has it appended.
      // Use seed verbatim as q1 ANCHOR and produce q2 as: take seed, lowercase first char,
      // strip trailing punct, append phrase to end with the original final punct restored.
      // For this to be a useful test, we need a SEED that has this modifier somewhere.
      // Instead: PREPEND to seed. Then in pair construction, q1 is the prepended, q2 is the
      // appended-modifier version. Both convey the same proposition with different word order.
      const trailing = q1.match(/[?.!]+$/)?.[0] ?? "";
      const stripped = q1.replace(/[?.!]+$/, "");
      const lowered = stripped.charAt(0).toLowerCase() + stripped.slice(1);
      const q2 = phrase + lowered + trailing;
      return { q2, category: "word_order", label: "merge", subcategory: "modifier_prepend" };
    },
  };
}

// Negation: insert "not" before the verb. SEPARATE.
// Limited but reliable on simple "does X" / "is X" / "can X" forms.

const NEG_PATTERNS: Array<[RegExp, string]> = [
  [/\bdoes\b/i, "does not"],
  [/\bcan\b/i, "cannot"],
  [/\bis\b/i, "is not"],
  [/\bare\b/i, "are not"],
  [/\bwill\b/i, "will not"],
  [/\bshould\b/i, "should not"],
];

const insertNegation: Transform = {
  name: "negation.insert_not",
  apply(q1) {
    // Skip if seed already contains a negation marker.
    if (/\b(not|don't|doesn't|isn't|aren't|wasn't|weren't|won't|can't|shouldn't|cannot)\b/i.test(q1)) {
      return null;
    }
    for (const [re, repl] of NEG_PATTERNS) {
      if (re.test(q1)) {
        const q2 = q1.replace(re, repl);
        if (q2 !== q1) return { q2, category: "negation", label: "separate", subcategory: "polarity_inversion" };
      }
    }
    return null;
  },
};

// Antonym verb-flips: enable↔disable, add↔remove, etc. SEPARATE.

const ANTONYM_FLIPS: Array<[RegExp, string]> = [
  [/\benable\b/gi, "disable"],
  [/\bdisable\b/gi, "enable"],
  [/\bstart\b/gi, "stop"],
  [/\bstop\b/gi, "start"],
  [/\bopen\b/gi, "close"],
  [/\bclose\b/gi, "open"],
  [/\bgrant\b/gi, "revoke"],
  [/\brevoke\b/gi, "grant"],
  [/\bcommit\b/gi, "rollback"],
  [/\brollback\b/gi, "commit"],
  [/\bshow\b/gi, "hide"],
  [/\bhide\b/gi, "show"],
  [/\bpass\b/gi, "fail"],
  [/\bfail\b/gi, "pass"],
];

const flipAntonyms: Transform = {
  name: "negation.antonym_flip",
  apply(q1) {
    for (const [re, repl] of ANTONYM_FLIPS) {
      if (re.test(q1)) {
        // Apply only the FIRST match; replace single pattern to avoid double-flips.
        re.lastIndex = 0;
        const q2 = q1.replace(re, (m) => {
          // Preserve case of original.
          if (m === m.toUpperCase()) return repl.toUpperCase();
          if (m[0] === m[0].toUpperCase()) return repl[0].toUpperCase() + repl.slice(1);
          return repl;
        });
        if (q2 !== q1) {
          return { q2, category: "negation", label: "separate", subcategory: "antonym_flip" };
        }
      }
    }
    return null;
  },
};

// Aspect: present↔past tense flip. SEPARATE.

const TENSE_FLIPS: Array<[RegExp, string]> = [
  [/\bdoes\b/gi, "did"],
  [/\bis\b/gi, "was"],
  [/\bare\b/gi, "were"],
  [/\bdo\b/gi, "did"],
  [/\bcauses\b/gi, "caused"],
  [/\bhappens\b/gi, "happened"],
  [/\bworks\b/gi, "worked"],
  [/\bruns\b/gi, "ran"],
  [/\bfails\b/gi, "failed"],
  [/\bbreaks\b/gi, "broke"],
];

const flipTense: Transform = {
  name: "different_aspect.tense_flip",
  apply(q1) {
    for (const [re, repl] of TENSE_FLIPS) {
      if (re.test(q1)) {
        re.lastIndex = 0;
        const q2 = q1.replace(re, (m) => {
          if (m[0] === m[0].toUpperCase()) return repl[0].toUpperCase() + repl.slice(1);
          return repl;
        });
        if (q2 !== q1) {
          return { q2, category: "different_aspect", label: "separate", subcategory: "tense_flip" };
        }
      }
    }
    return null;
  },
};

// Scope: insert universal quantifier (always, only, must). SEPARATE.

const SCOPE_INSERTS = [
  { suffix: " always" },
  { suffix: " only" },
  { suffix: " uniquely" },
];

function insertScope(idx: number): Transform {
  return {
    name: `different_scope.insert_quantifier.${idx}`,
    apply(q1) {
      // Insert the quantifier right before the trailing punctuation.
      const trailing = q1.match(/[?.!]+$/)?.[0] ?? "";
      const stripped = q1.replace(/[?.!]+$/, "");
      const q2 = stripped + SCOPE_INSERTS[idx].suffix + trailing;
      // Don't generate if the seed already has a scope marker.
      if (/\b(always|only|never|exclusively|uniquely|necessarily|sometimes|must|can only)\b/i.test(q1)) {
        return null;
      }
      return { q2, category: "different_scope", label: "separate", subcategory: "added_quantifier" };
    },
  };
}

// ─── Seed pool ─────────────────────────────────────────────────────────────
// Curated natural questions covering programming/operations domains.
// Each will be passed through every transform; non-applicable transforms
// return null and are skipped.

const SEEDS: string[] = [
  "What is the deadline?",
  "How do I install dependencies?",
  "Where is the config file?",
  "Why does this leak memory?",
  "What's the deploy timeout?",
  "How do I enable caching?",
  "When does the cron fire?",
  "Where does the build write output?",
  "Why does this test fail intermittently?",
  "What runs on startup?",
  "How does the auth flow work?",
  "Where do logs go?",
  "Why is this query slow?",
  "What handles cache invalidation?",
  "How do builds pass on CI?",
  "Where is the API rate limit set?",
  "Why does X happen?",
  "What does the linter check?",
  "How do I run tests locally?",
  "Where is the migration applied?",
  "Why does the worker hang?",
  "What is the retry policy?",
  "How does the scheduler decide?",
  "Where does state persist?",
  "Why does the dashboard refresh?",
  "What can the parser handle?",
  "How do I commit this?",
  "Where can I read the spec?",
];

// ─── Generation pipeline ────────────────────────────────────────────────────

// Order matters: with --max truncating output, transforms earlier in the
// list run first across all seeds. Put SEPARATE-producing transforms FIRST
// so hard-negative coverage is locked in before we fill the cap with
// surface-form variants. Within each band, interleave to maximize
// category diversity per truncation point.
const ALL_TRANSFORMS: Transform[] = [
  // Hard negatives (SEPARATE)
  insertNegation,
  flipAntonyms,
  flipTense,
  insertScope(0),
  insertScope(1),
  // Surface-y MERGE
  upperCase,
  lowerCase,
  trailingWhitespace,
  trailingExclaim,
  droppedPunct,
  // Contractions (MERGE)
  expandContractions,
  // Filler (MERGE)
  prependFiller(0),
  prependFiller(1),
  prependFiller(2),
  appendFiller(0),
  appendFiller(1),
  // Register (MERGE)
  ...REGISTER_INSERTS.map(registerTransform),
  // Word order (MERGE)
  wordOrderTransform(0),
  wordOrderTransform(1),
  wordOrderTransform(2),
];

interface CorpusEntry {
  id: string;
  q1: string;
  q2: string;
  label: Label;
  category: string;
  subcategory?: string | null;
  provenance: string;
  version: string;
}

// Pair-key uses TRIMMED q1/q2 to match the validator's dedup semantics.
// Two pairs that differ only in surrounding whitespace test the same
// normalization decision, so they're considered duplicates.
function pairKey(a: string, b: string): string {
  return `${a.trim()}\n||\n${b.trim()}`;
}

function loadExistingCorpus(filePath: string): { entries: CorpusEntry[]; pairKeys: Set<string>; maxIdNum: number } {
  const entries: CorpusEntry[] = [];
  const pairKeys = new Set<string>();
  let maxIdNum = 0;
  if (!fs.existsSync(filePath)) return { entries, pairKeys, maxIdNum };
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as CorpusEntry;
      entries.push(e);
      pairKeys.add(pairKey(e.q1, e.q2));
      pairKeys.add(pairKey(e.q2, e.q1));
      const m = e.id.match(/^cor_v1_(\d+)$/);
      if (m) maxIdNum = Math.max(maxIdNum, parseInt(m[1], 10));
    } catch {}
  }
  return { entries, pairKeys, maxIdNum };
}

function generate(seeds: string[], existing: Set<string>, maxNew: number, idStart: number): CorpusEntry[] {
  const out: CorpusEntry[] = [];
  const generatedKeys = new Set<string>(existing);
  let nextId = idStart + 1;
  // Round-robin: outer loop on TRANSFORMS, inner loop on SEEDS. With a
  // --max cap, this gives breadth-first coverage across categories instead
  // of depth-first per seed (which would bias the truncated batch toward
  // whichever category fires most for early seeds).
  for (const t of ALL_TRANSFORMS) {
    for (const seed of seeds) {
      if (out.length >= maxNew) return out;
      const v = t.apply(seed);
      if (!v) continue;
      if (v.q2 === seed) continue;
      const key = pairKey(seed, v.q2);
      const reverseKey = pairKey(v.q2, seed);
      if (generatedKeys.has(key) || generatedKeys.has(reverseKey)) continue;
      generatedKeys.add(key);
      generatedKeys.add(reverseKey);
      const id = `cor_v1_${String(nextId).padStart(4, "0")}`;
      nextId++;
      out.push({
        id,
        q1: seed,
        q2: v.q2,
        label: v.label,
        category: v.category,
        subcategory: v.subcategory ?? null,
        // template-synth uses llm_synth provenance bucket; subcategory
        // disambiguates the specific transform when needed
        provenance: "llm_synth",
        version: "v1",
      });
    }
  }
  return out;
}

// ─── Self-tests ─────────────────────────────────────────────────────────────

function selfTest(): void {
  let failed = 0;
  function check(name: string, cond: boolean, msg?: string) {
    if (cond) {
      console.log(`  ✓ ${name}`);
    } else {
      console.error(`  ✗ ${name}${msg ? ": " + msg : ""}`);
      failed++;
    }
  }

  console.log("transforms:");
  check("uppercase: 'foo' → 'FOO'", upperCase.apply("foo")?.q2 === "FOO");
  check("uppercase: 'FOO' → null (idempotent)", upperCase.apply("FOO") === null);
  check("lowercase: 'FOO' → 'foo'", lowerCase.apply("FOO")?.q2 === "foo");
  check("trailing_ws appends spaces", trailingWhitespace.apply("foo")?.q2 === "foo  ");
  check("exclaim only on questions", trailingExclaim.apply("foo.") === null);
  check("exclaim transforms ?", trailingExclaim.apply("What?")?.q2 === "What?!");

  check(
    "expandContractions: \"what's the deal\" → 'what is the deal'",
    expandContractions.apply("what's the deal")?.q2 === "what is the deal",
  );
  check(
    "expandContractions: 'no contractions' → null",
    expandContractions.apply("no contractions") === null,
  );

  check(
    "insertNegation: 'How does X work?' → 'How does not X work?'",
    insertNegation.apply("How does X work?")?.q2 === "How does not X work?",
  );
  check(
    "insertNegation: refuses double-negation",
    insertNegation.apply("How does X not work?") === null,
  );

  check(
    "flipAntonyms: 'How do I enable X?' → 'How do I disable X?'",
    flipAntonyms.apply("How do I enable X?")?.q2 === "How do I disable X?",
  );

  check(
    "flipTense: 'What does X do?' → 'What did X do?'",
    flipTense.apply("What does X do?")?.q2 === "What did X do?",
  );

  check(
    "insertScope.always: 'What is X?' → 'What is X always?'",
    insertScope(0).apply("What is X?")?.q2 === "What is X always?",
  );
  check(
    "insertScope: refuses already-scoped",
    insertScope(0).apply("What is X always?") === null,
  );

  check(
    "prependFiller: lowercases first letter",
    prependFiller(0).apply("What is X?")?.q2 === "Hey, what is X?",
  );

  console.log();
  if (failed > 0) {
    console.error(`FAILED: ${failed} self-test(s)`);
    process.exit(1);
  }
  console.log("✓ all self-tests pass");
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    selfTest();
    return;
  }
  const dryRun = args.includes("--dry-run");
  const append = args.includes("--append");
  const maxIdx = args.indexOf("--max");
  const maxNew = maxIdx >= 0 ? parseInt(args[maxIdx + 1], 10) : 200;

  if (!dryRun && !append) {
    console.error("usage: synthesize-corpus.ts [--self-test] [--dry-run|--append] [--max N]");
    process.exit(2);
  }

  const corpusPath = path.resolve("tests/canonical-equivalence-corpus.v1.jsonl");
  const { pairKeys, maxIdNum } = loadExistingCorpus(corpusPath);
  console.log(`existing corpus: ${pairKeys.size / 2} unique pairs, max id cor_v1_${String(maxIdNum).padStart(4, "0")}`);

  const generated = generate(SEEDS, pairKeys, maxNew, maxIdNum);
  console.log(`generated: ${generated.length} new pairs (target max=${maxNew})`);

  // Per-category breakdown of what we produced.
  const perCat: Record<string, { merge: number; separate: number }> = {};
  for (const e of generated) {
    const c = perCat[e.category] ?? { merge: 0, separate: 0 };
    c[e.label]++;
    perCat[e.category] = c;
  }
  console.log("by category:");
  for (const [cat, counts] of Object.entries(perCat).sort()) {
    console.log(`  ${cat.padEnd(28)} merge=${counts.merge} separate=${counts.separate}`);
  }

  if (dryRun) {
    console.log();
    console.log("--dry-run: not writing. First 5 pairs:");
    for (const e of generated.slice(0, 5)) {
      console.log(`  ${e.id} [${e.label}/${e.category}] ${JSON.stringify(e.q1)} ↔ ${JSON.stringify(e.q2)}`);
    }
    return;
  }

  // Append to corpus.
  const lines = generated.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.appendFileSync(corpusPath, lines);
  console.log(`appended ${generated.length} pairs to ${corpusPath}`);
}

if (import.meta.main) await main();
