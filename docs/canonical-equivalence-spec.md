# Canonical Equivalence Specification

> **Status:** Phase 1 draft. Decision points awaiting boss are flagged in §4.
> **Purpose:** define what "the same question" means for the [Inquiry Lattice](./inquiry-lattice.md). This spec is the ground truth that the evaluation corpus (Phase 2) measures against and that all candidate normalization functions (Phase 3) optimize for.

## 1. Why this matters

The Inquiry Lattice's defining property is canonical placement: equivalent questions land at the same node regardless of who asked them, in what order, or in what surface form. The lattice IS the inquiry space the way an ROBDD IS the boolean function it represents.

That property only holds if we have a precise, machine-checkable definition of "equivalent." Without it:

- **False merges** (treating distinct questions as equivalent) corrupt the canonical-form property — distinct meanings collapse, the lattice loses information.
- **False separations** (failing to merge true paraphrases) break compression — near-duplicates accumulate, the lattice grows by submission volume rather than intrinsic complexity.

This spec is the single source of truth for what the normalization function MUST handle, MUST NOT handle, and MAY handle as an optimization. It is versioned: changes to this spec produce a new equivalence-class-version (`v1`, `v2`, ...) which becomes part of the canonical_id format (`v<N>:<hash>`).

## 2. Scope

This spec covers questions in the Inquiry Lattice (Question records as defined in inquiry-lattice.md §3). It does NOT cover:

- Answer equivalence (handled separately; multiple competing answers to the same question are intentional).
- Conversation turn equivalence (turns are not deduplicated; the lattice is for questions and answers, not for raw conversation log).
- Cross-lingual equivalence in v1 (English-only — see §4 D1).

## 3. Equivalence categories

Each category is rated:
- **MERGE** — questions in this category MUST be treated as equivalent.
- **SEPARATE** — questions in this category MUST NOT be treated as equivalent.
- **DECISION** — the answer requires boss sign-off; default in §4.

### 3.1 MERGE categories (no debate)

| Category | Definition | Example |
|---|---|---|
| **Surface form** | Differs only in capitalization, whitespace, or punctuation. | `"What is X?"` ↔ `"what is x"` ↔ `"  what is X  "` |
| **Inflection** | Same morphological lemmas, different inflected forms. | `"what causes errors"` ↔ `"what is causing the error"` |
| **Common contractions** | Standard contractions and their expansions. | `"what's X"` ↔ `"what is X"` ↔ `"what does this do"` ↔ `"what's this doing"` |
| **Filler / politeness** | Phatic openers and closers that don't carry semantic content. | `"hey, what is X?"` ↔ `"please, what is X?"` ↔ `"what is X, thanks"` |
| **Voice (active/passive)** | Same proposition expressed in active vs passive voice. | `"what does the parser do"` ↔ `"what is done by the parser"` |
| **Word order (within question structure)** | Reordering of clauses/phrases that preserves meaning. | `"in Python, what is X?"` ↔ `"what is X in Python?"` |

These cases are unambiguous in human judgment and cheap to detect mechanically. The normalization function MUST handle all of them.

### 3.2 SEPARATE categories (no debate)

| Category | Definition | Example |
|---|---|---|
| **Negation** | Same syntactic shell, opposite predicate. | `"what causes X"` vs `"what prevents X"` |
| **Different referent** | Different noun phrase as the question's subject or object. | `"what is the result of X"` vs `"what is the input to X"` |
| **Different question word** | `what`, `why`, `how`, `when`, `where`, `who` are not interchangeable. | `"what is X"` vs `"how is X"` vs `"why is X"` |
| **Different scope** | Different quantifier or restriction. | `"what is X"` vs `"what is X always"` vs `"when is X"` |
| **Different aspect** | Stative vs dynamic, completed vs ongoing. | `"what does X do"` vs `"what did X do"` vs `"what is X doing"` |

These are well-known traps in paraphrase detection. The normalization function MUST NOT merge them. Many embedding-based equivalence tests fail on these (negation in particular has a high false-positive rate at any reasonable cosine threshold), so the normalization function needs explicit safeguards.

### 3.3 DECISION categories (boss sign-off needed)

These are flagged in §4 as open decisions. Default recommendations are noted but not adopted until you confirm.

| Category | Definition | Default proposal |
|---|---|---|
| **D1 Cross-lingual** | Same semantic content, different natural language. | `"what is X?"` vs `"qu'est-ce que X?"` | English-only in v1; defer multilingual to v2 |
| **D2 Domain synonyms** | Domain-specific terms that mean the same thing. | `"method"` ↔ `"function"` (in programming) | Versioned synonym dictionary; SEPARATE if dict missing |
| **D3 Granularity (narrowing)** | One question is a specialization of the other. | `"what is X?"` vs `"what is X in Python?"` | SEPARATE (specialization is a different question) |
| **D4 Granularity (broadening)** | One question generalizes the other. | `"how do I fix Python errors?"` vs `"how do I fix errors?"` | SEPARATE |
| **D5 Implicit context** | Same surface form, different intended context. | `"how do I install this?"` (this = depends on conversation) | SEPARATE; context resolution happens before lattice insertion |
| **D6 Semantic-equivalence threshold** | Cosine threshold θ between embeddings, above which we treat as merge candidates. | θ = 0.92 (precision-first; tunable) |
| **D7 Reformulation tolerance** | Same intent, structurally different phrasing. | `"how to fix bug"` vs `"what's the fix for this bug"` | DECISION — depends on D6 threshold |
| **D8 Casual vs formal register** | Same content, different register. | `"WTF is X?"` vs `"what is X?"` | MERGE (register doesn't change meaning) |

## 4. Decisions awaiting boss

The following decisions affect what the lattice will and won't merge. Each one needs an explicit answer before Phase 2 (corpus assembly) is meaningful, because the corpus is labeled against these decisions.

**D1 — Cross-lingual equivalence:** Should `"what is X?"` and `"qu'est-ce que X?"` merge?

- Default proposal: **No, English-only in v1.** Versioned (multilingual = v2 or v3 work).
- Rationale: cross-lingual paraphrase requires multilingual embeddings (LaBSE, mUSE) that we don't currently use; bolting it on retroactively is straightforward via a v2 normalization function.
- Implication if accepted: corpus is English-only; non-English questions in production land at distinct nodes.

**D2 — Domain synonym handling:** Should `"method"`/`"function"`/`"procedure"` (in programming context) merge? `"bug"`/`"defect"`/`"issue"`?

- Default proposal: **Yes, via a versioned synonym dictionary.** Dictionary version is part of canonical_id (`v1.synonyms.3:<hash>`).
- Rationale: programmer-facing inquiry will repeatedly hit these synonym pairs. Treating them as distinct produces low-value cluster fragmentation.
- Implication if accepted: someone (boss or me) maintains the synonym dict; bad entries cause silent merge errors.
- Alternative: skip the dict, rely entirely on embedding cosine to catch these. Less precise but no maintenance.

**D3 — Granularity narrowing:** Should `"what is X?"` and `"what is X in Python?"` merge?

- Default proposal: **No, SEPARATE.** A specialization is a different question even if it shares the broader question's theme.
- Rationale: the answers to these two questions are typically different (the specialization wants language-specific detail). Merging would lose the distinction.
- Implication if accepted: agents asking specialized questions get distinct lattice nodes; broader prior answers don't auto-apply (they'll surface via cross-domain push, but won't claim to be answers to the specialized question).
- Alternative: MERGE, with the specialized version inheriting from the broader one. More compositionally elegant but harder to reason about.

**D4 — Granularity broadening:** mirror of D3. Should `"how do I fix Python errors?"` and `"how do I fix errors?"` merge?

- Default proposal: **No, SEPARATE.** Same rationale as D3.

**D5 — Implicit context:** Should `"how do I install this?"` be merged across two unrelated conversations where "this" refers to different things?

- Default proposal: **No, SEPARATE.** The lattice should resolve referents before insertion (e.g., a pre-pass that rewrites `"how do I install this?"` → `"how do I install <last-discussed-package>?"` using the conversation context).
- Rationale: lattice equivalence operates on the question itself, not on the conversation it lives in. Implicit-reference questions need to be DEREFERENCED before they can be canonicalized.
- Implementation note: the dereferencing pass is a separate concern from normalization. A question with unresolved pronouns/demonstratives might be flagged as `unresolved` and excluded from canonicalization until context is provided.

**D6 — Semantic-equivalence threshold (θ):** What cosine value, between embeddings of the canonically-normalized strings, should trigger a leaf-level merge?

- Default proposal: **θ = 0.92, precision-first.**
- Rationale: false merges are worse than false separations (latter is recoverable, former isn't). 0.92 is conservative for `Xenova/all-MiniLM-L6-v2`; published benchmarks suggest 0.85-0.90 is "near-paraphrase" territory; we go higher.
- Tunable based on Phase 4 scoring against the corpus.

**D7 — Reformulation tolerance:** Should structurally-different phrasings of the same intent merge?

- Default proposal: **DEPENDS ON D6.** With θ = 0.92, only very-close reformulations merge. With θ = 0.85, more reformulations merge but precision drops.
- Recommendation: defer this question; it's effectively asked-and-answered by the choice of θ.

**D8 — Register (casual vs formal):** Should `"WTF is X?"` and `"what is X?"` merge?

- Default proposal: **Yes, MERGE.** Register doesn't change semantic content.
- Implementation: register-stripping is part of the normalization function (handles "yo," "WTF," "please," etc.).
- Edge case: profanity-laden questions can have semantic content carried by the profanity (`"why is this fucking broken"` carries frustration which might affect routing). For v1 we strip register; v2 might preserve a "tone" metadata field.

## 5. Versioning guidance

The canonical_id format is `v<N>:<hash>` where `<N>` is the equivalence-class version.

- **v1** is whatever we ship after this spec is signed off. It includes the §3.1, §3.2, and the §3.3 defaults that boss accepts.
- **v2** is whenever this spec changes. A v2 deployment requires: re-canonicalizing existing v1 data, OR keeping v1 data as v1-versioned and using a compatibility layer that computes v2 canonicals on demand.
- **The synonym dictionary has its own sub-version** (e.g., `v1.syn.3:<hash>`). Adding a synonym pair without breaking existing equivalences is a sub-version bump. Removing a synonym (which un-merges previously-merged questions) is a major version bump.

The version prefix is mandatory in v1. We never ship a canonical_id without it.

## 6. Test corpus implications

Phase 2 builds an evaluation corpus against this spec. The corpus structure:

```jsonl
{"q1": "...", "q2": "...", "label": "merge|separate", "category": "surface_form|negation|...", "version": "v1"}
```

Distribution targets:
- ~40% MERGE pairs (drawn from §3.1 categories + §3.3 categories where default is MERGE)
- ~40% SEPARATE pairs (drawn from §3.2 categories + §3.3 categories where default is SEPARATE)
- ~20% HARD NEGATIVES — questions that look similar by surface form or embedding cosine but should SEPARATE per this spec (negation pairs are the highest-value hard negatives)

Total target: 1000-2000 labeled pairs, with each §3 category represented by at least 50 pairs.

The corpus is itself versioned (`v1.corpus.0.jsonl`, `v1.corpus.1.jsonl`, ...) so that adding pairs over time doesn't invalidate prior scoring runs.

## 7. Open questions for v2 (deferred)

These don't block Phase 2; documented here so they're not lost.

- **Multi-question messages:** `"what is X? and how do I install it?"` — split or treat as one?
- **Implicit-question statements:** `"X is broken"` is implicitly asking `"why is X broken?"` — recognize as a question or not?
- **Code-bearing questions:** `"why does \`function foo() { ... }\` not work?"` — equivalence partly depends on the code, partly on the natural-language framing.
- **Self-reference:** `"what was the last question I asked?"` is a meta-question that doesn't fit the lattice's content model.

## 8. v1 sign-off (boss decisions, 2026-05-07)

All eight decisions resolved. Defaults accepted, with v2 architectural notes added for D1/D2/D7.

| Decision | Resolution |
|---|---|
| D1 — Cross-lingual | v1: English-only. v2: translate-to-English-first then canonicalize; all knowledge stays English internally. |
| D2 — Domain synonyms | v1: versioned synonym dictionary. v2: **lattice-mediated normalization** — the synonym knowledge becomes lattice content (meta-questions like "is X synonymous with Y?") rather than a separate artifact. |
| D3 — Granularity narrowing | SEPARATE. Specialized question is a distinct node; relationship to general question is captured via DAG decomposition (parent edge in CitationDAG). |
| D4 — Granularity broadening | SEPARATE. Same rationale as D3. |
| D5 — Implicit context | SEPARATE. Implicit-reference questions are flagged `unresolved` until context resolution rewrites them; only resolved questions enter the lattice. |
| D6 — Cosine threshold (θ) | 0.92 (precision-first). Tunable based on Phase 4 scoring. |
| D7 — Reformulation tolerance | v1: whatever falls out of θ + synonym dict. v2: **lattice-mediated** — reformulation handled by querying the lattice for "is this a reformulation of X?" |
| D8 — Register | MERGE. Strip register/casualness markers in normalization; preserve "tone" as out-of-band metadata for v2+. |

## 9. The lattice-as-normalizer (v2 commitment)

Boss raised the insight that the normalization function itself can be an inquiry the lattice answers. This is a v2 commitment — v1 ships with hand-maintained synonym dict, v2 graduates to lattice-mediated normalization.

**Architecture:**

```
Tier 0 (always): unicode NFKC → lowercase → strip punctuation → light tokenization
                 → produces "raw canonical" sufficient to find rough neighborhood

Tier 1 (when lattice has priors): query lattice meta-question index for
                                  "what's the canonical form of this?"
                                  Use lattice's canonical if high-confidence;
                                  fall back to tier 0 otherwise.

Re-canonicalization pass (BDD-reduction analog): periodically re-canonicalize
                                                  existing entries using current
                                                  best meta-knowledge.
```

**Implication for Phase 3 candidates:** the winning candidate must be straightforward to extend with lattice queries when v2 begins. Black-box closed-form normalizers are disfavored; pluggable function pipelines are preferred.

**Implication for the apprenticeship substrate:** the meta-questions ("is X synonymous with Y?", "what's the canonical form of Z?") flow through the same dual-output / study-turn / selection mechanisms as any other inquiry. The lattice learns its own equivalence rules through the same loop it learns everything else.

**Quantum-continuity property:** lattice-mediated normalization is structurally analogous to dynamic variable reordering in ROBDDs — the canonical form improves as the system learns more about the structure of what it's representing. The intellectual frame transfers to quantum circuit synthesis where canonical gate orderings depend on the function being compiled.

After this is signed off, Phase 2 (corpus assembly) becomes mechanical: I generate ~1500 pairs labeled per this spec, hand-curate hard negatives, and lock the corpus as `v1.corpus.0.jsonl`.
