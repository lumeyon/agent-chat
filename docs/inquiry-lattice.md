# The Inquiry Lattice

> **Status:** strategic compositional layer (proposed 2026-05-07). Designed to sit on top of the [Apprenticeship Substrate](./apprenticeship-substrate.md) and replace the recursive-subgraph idea as the primary mechanism for how work decomposes across agents.

## What this is

The Inquiry Lattice is the compositional layer for the agent-chat system. Where the Apprenticeship Substrate handles HOW agents learn from each other (push-context, study turns, selection on explanations), the Inquiry Lattice handles HOW work decomposes across agents and HOW the system organizes its accumulated questions and answers into a canonical, mergeable, multi-dimensionally-queryable structure.

The defining property: **the lattice IS the inquiry space**, not a representation of it. Equivalent questions land at the same node regardless of who asked them or in what order. The structure self-organizes as inquiry accumulates, with O(log N) lookups via classical multi-dim indexing, and merges deterministically across installations.

## What problem it solves

The recursive-subgraph compositional model (an edge spawns a sub-team that lives in a directory under the parent edge) frames composition as an organizational problem: who's working on this, where do they live, how does the team form. That framing is appealing but mismatched to the actual shape of knowledge work. Knowledge work is **epistemic** — it's about what's being figured out, not about which team is figuring it out.

The Inquiry Lattice frames composition epistemically: the unit of work is a **question**, not an edge or a team. Questions decompose into sub-questions. Answers cite the sub-answers that compose into them. Agents are fluid — they pick up open questions from a queue based on capability profile, not because they're "members" of a particular subgraph.

Three properties this gets you that recursive subgraphs don't:

1. **Compositional reuse is automatic.** A sub-answer can be cited by many parent answers from completely different lines of inquiry. The DAG of answers naturally surfaces relevant prior work without anyone having to "remember" to query a specific subgraph.
2. **The graph is a real DAG, not a tree.** Multiple parent questions can share sub-questions. The same fact can support unrelated conclusions. This is how human knowledge actually composes.
3. **Sparse routing matches reality.** A typical question only needs 2-3 capable agents — those whose capability profile matches. The other 7 of 10 don't need to be present, dormant, or aware. Cost scales with inquiry complexity, not with declared topology size.

## Core abstractions

```
Question {
  id:                stable hash of normalized framing
  framing:           the question text itself
  embedding:         vector representation of the framing
  parents:           [Question.id]   — DAG, not tree
  status:            open | answered | closed | reopened
  best_answer_id:    pointer into the answer index
  posed_by:          agent or human
  posed_in_context:  reference to the conversation that spawned the question
  answers:           [Answer.id]
}

Answer {
  id:                stable hash of (question_id, body, by)
  question_id:       which question this answers
  body:              the answer content
  explanation:       (Apprenticeship Substrate's dual-output) why this answers it
  by:                agent who produced it
  cites:             [(question_id, answer_id)]   — sub-answers that compose into this one
  predictive_lift:   running score from peer study-turn grading
  status:            proposed | accepted | superseded | refuted
}
```

A question can have multiple parents (it's a sub-question of more than one bigger inquiry). An answer cites the sub-answers that compose into it. The dependency graph describes how knowledge BUILDS, not how teams ORGANIZE.

## How agents flow through it

Agents don't have teams. They have **capability profiles** — accumulated competencies derived from their successful prior answers, used by the lattice for routing. The work loop:

1. A question is posed (by user, by another agent, or auto-generated as a decomposition).
2. The lattice retrieves agents whose capability profile matches the question's embedding.
3. Those agents see the question on their queue.
4. One picks it up and attempts an answer.
5. If they can't answer directly, they **decompose**: post N sub-questions, return their parent answer by citing the sub-answers (which haven't been answered yet, so the parent stays `proposed`).
6. Sub-questions go through the same loop — possibly picked up by different agents.
7. When all sub-answers are accepted, the parent agent synthesizes them into the parent answer, marks `proposed`.
8. Peer study turns grade the answer. High predictive-lift answers are `accepted`; low-quality ones get `refuted` by competing answers.
9. When confidence is high enough, the question is `closed`. New evidence can `reopen` it later.

## The Shannon-decomposition insight

The architectural backbone is borrowed from Reduced Ordered Binary Decision Diagrams (ROBDDs): **the tree IS the function, not a representation of it**. Equivalent boolean functions reduce to identical BDDs. The tree compresses to size proportional to the function's intrinsic complexity, not to 2^N.

Applied to inquiry: the lattice's structure should BE the system's understanding of the inquiry space. Two agents independently asking semantically-equivalent questions land at the same node. The path from root to a question IS that question's "decomposition" through concept-space — analogous to reading off variable assignments along a BDD path.

Three concrete properties this produces:

**Canonical placement.** Two installations of the system, given the same set of questions, converge to the same lattice. The placement of any question is a deterministic function of (its embedding, the existing tree state).

**Compressed structure.** The lattice's size is proportional to the intrinsic complexity of what's been asked, not to the universe of askable questions. Repetitive or near-duplicate questions merge cleanly via canonical-id matching.

**Mergeability.** Two independently-grown lattices can be merged deterministically: equivalent questions unify; disjoint sub-trees splice in by cluster centroid. This is the property that lets multiple installations pool their accumulated inquiry without conflicts. Collective intelligence across teams compounds without manual reconciliation.

## The multi-dimensional structure

The lattice is layered: a primary semantic structure indexed by question embedding, plus several secondary structures indexed by metadata. Each structure is O(log N) for its own dimension; multi-axis queries combine them via index intersection.

```
SemanticTree    — cover tree variant (or HNSW with deterministic insertion) on
                  question embeddings. The Shannon-style canonical placement happens
                  here. Internal nodes carry auto-derived concept labels (LLM-summarized
                  centroids, cached per node). The path from root to a question is the
                  question's decomposition through concept-space.

TemporalIndex   — B-tree on (timestamp, question_id). Used for "what was asked
                  recently" queries.

AgentIndex      — hash table: agent → [question_ids they've successfully answered].
                  Drives capability-profile routing and "show me what lumeyon knows"
                  queries.

StatusIndex     — partition: questions split by {open, answered, closed, reopened}.
                  Drives queue-pickup for available work.

DepthIndex      — partition: questions by composition depth (root-of-tree, sub,
                  sub-sub). Useful for filtering "show me high-level questions" vs
                  "show me leaf inquiries".

CitationDAG     — directed edges between answer_ids. Maintained in topological order.
                  Drives "what does this answer build on" / "what builds on this answer"
                  queries.
```

A typical multi-axis query — "questions about quantum algorithms asked in the last month, currently closed, answered by lumeyon" — intersects four indices, each O(log N) for its dimension, giving sub-linear total cost. This is standard multi-dim indexing, well-understood, doesn't require new theory.

### Curse-of-dimensionality consideration

Embedding ambient dimension is high (384 for our `Xenova/all-MiniLM-L6-v2`), but **language embeddings have low intrinsic dimensionality** — typically 30-50 for natural-language text. Cover trees and HNSW exploit intrinsic dimensionality, giving O(log N) typical performance for our use case. Pure k-d trees would collapse to O(N) above ~20 dimensions and are the wrong choice here.

## Format-uniform artifacts (architectural commitment 2026-05-07)

Every artifact the lattice produces has the SAME shape whether read by a future agent for context or exported as a downstream dataset. The export pipeline is first-class infrastructure, not an afterthought.

Specific architectural constraints baked in from this commitment forward:

| Concern | Constraint |
|---|---|
| Schema | Internal storage and external export use the same fields. No translation layer. |
| Provenance | Every Question, Answer, and Explanation record includes creation timestamp, agent_id, predictive_lift score, validator_id (if any), and citation parents. |
| Quality tiers | Explicit `quality_tier ∈ {1,2,3,4,5}` field on every Answer. Tier 1 = human-verified gold; tier 5 = raw lattice contribution. |
| Mergeability | Canonical-form lattice merging works across installations and across exported subsets without conflicts. |
| Export pipeline | `lattice → JSONL` is a first-class operation, not an afterthought. Format is documented and stable. |
| Multimodal | CLIP-based image indexing is a v2 commitment. Diagrams, charts, equations are training-relevant content; the lattice indexes them alongside text. |

## Lattice-as-normalizer (v2 architectural commitment)

> **Status:** v2 design, committed 2026-05-07. v1 of the lattice ships with a hand-maintained versioned synonym dictionary + tier-0 string normalization. v2 graduates to lattice-mediated normalization.

The normalization function isn't a fixed primitive sitting outside the lattice. It is itself an inquiry the lattice answers. **"What is the canonical form of this question?"** is a meta-question. **"Is X synonymous with Y in this domain?"** is a meta-question. As the lattice accumulates answered meta-questions, its normalization power grows organically — without anyone hand-maintaining a synonym dictionary or paraphrase rule set.

### Two-tier bootstrap (solving the chicken-and-egg)

The lattice needs canonical_ids to function, and canonical_ids depend on normalization. Without a starting point, neither bootstraps. Resolved with two tiers:

```
Tier 0 — minimal deterministic normalization (always available):
  unicode NFKC → lowercase → strip punctuation → light tokenization
  Produces a "raw canonical" sufficient to find a question's rough
  neighborhood in the lattice.

Tier 1 — lattice-mediated normalization (kicks in when the lattice
has accumulated meta-question answers):
  1. Compute tier-0 canonical for the input question.
  2. Query the lattice's meta-question index: "what's the canonical
     form of <tier-0 canonical>?"
  3. If a high-confidence answer exists (predictive_lift above a
     threshold, multiple confirming citations), use the lattice's
     canonical.
  4. Otherwise fall back to tier-0.

Periodic re-canonicalization (BDD-reduction analog):
  As the lattice's meta-knowledge grows, old entries get re-canonicalized
  using the current best understanding. Equivalence classes refine over
  time. This is structurally analogous to ROBDD variable reordering:
  the canonical form improves as the system learns more about the
  structure of what it's representing.
```

### Connection to the Apprenticeship Substrate

The meta-questions flow through the same forcing functions as any other inquiry:

- **Dual-output:** every meta-answer carries an explanation ("X is synonymous with Y because..."). The explanation is what makes future re-canonicalization passes traceable.
- **Study turns:** peers grade meta-answers. Bad equivalence judgments get caught and refuted.
- **Selection pressure:** competing canonicalization proposals fight for `accepted` status. The system's normalization rules become the rules with the highest predictive_lift.
- **Cross-domain push:** when a new question arrives, the lattice retrieves similar prior meta-questions automatically. Canonicalization is itself a learning process.

This means the lattice doesn't just store knowledge about its domain — it stores knowledge about ITSELF, including how to canonicalize, how to detect equivalence, how to decompose. The system's foundation is not above the protocol; it's inside it.

### Quantum-continuity property

Dynamic normalization that improves with use is structurally analogous to dynamic variable reordering in ROBDDs. Both share the property: "the canonical form improves as you learn more about the structure of what you're representing." The intellectual frame transfers cleanly to quantum circuit synthesis where canonical gate orderings depend on the specific function being compiled — a lattice-mediated normalization function is a step toward a system that does its own algorithmic optimization.

### Implications for the Phase 3 candidates

When implementing candidate normalization functions for v1, the winning candidate must be **pluggable** — straightforward to extend with lattice queries when v2 begins. Closed-form black-box functions are disfavored. The candidate that wins on Phase 4 scoring should also be the one that exposes a clean extension point where Tier 1 lattice queries can hook in.

## Canonical placement rule

```
canonical_id(question) := sha256(normalize(question.framing))
   where normalize() = stem, lowercase, dedupe whitespace, strip punctuation,
                       and apply a small list of synonyms via a versioned dictionary.

equivalence(q1, q2) := canonical_id(q1) == canonical_id(q2)
                       OR cosine(embedding(q1), embedding(q2)) > θ_merge
                       (θ_merge ≈ 0.92, tunable)

placement(question, tree):
   1. Compute embedding e := embedding(question).
   2. Navigate from root: at each internal node, choose the child whose centroid
      is closer to e. Deterministic tiebreak: lex on canonical_id.
   3. At a leaf cluster:
        if cluster contains a question with equivalence(q, existing) → MERGE
        else → ADD; if cluster size now exceeds K, split deterministically via
        2-means seeded by the two questions with maximum pairwise cosine distance.
   4. Update centroids on the path back to root. Recompute concept labels for
      affected internal nodes (LLM call, debounced).
```

The hardest design call is the `normalize` function. Getting it right means "what is X?" and "What's X" merge but "what is X?" and "what causes X?" do not. This is worth prototyping in isolation against a corpus of paraphrased questions before committing to a production version.

## How it composes with the Apprenticeship Substrate

The two layers interlock:

| Substrate (HOW agents learn) | Lattice (HOW work decomposes) |
|---|---|
| Dual-output: every response = (response, explanation) | Every Answer carries an explanation field |
| Mandatory study turns | Study turns pick K questions from the lattice via semantic neighborhood and ask for predicted answers |
| Selection pressure on explanations | Selection runs on Answers via predictive_lift; competing answers to the same question fight for `accepted` status |
| Cross-domain push (relevant explanations prepended automatically) | Push-context queries the SemanticTree for the K nearest prior questions+answers; prepends their explanations to the agent's prompt |

The substrate is the LEARNING engine. The lattice is the WORK engine. Together: agents learn by teaching (substrate), work by answering (lattice), and patterns emerge through selection across both.

## Quantum connection (forward-looking)

For a system running on agents and files, classical multi-dim search wins. Quantum doesn't beat O(log N) typical for nearest-neighbor by enough to matter at our scale.

That said, there are real intellectual bridges worth holding in reserve:

- **BDDs are the foundation of quantum circuit synthesis.** A canonical-form lattice that compiles "what's been asked" into a compressed structure has the same flavor as compiling boolean functions to gate sequences via BDD traversal.
- **Grover-style search** gives O(√N) for predicate searches over the whole lattice when no index for that predicate exists. Relevant if any future runtime targets quantum hardware.
- **Quantum walks** give quadratic speedup on traversing the CitationDAG.
- **Variational quantum eigensolvers** on the lattice's adjacency matrix give a natural-cluster-boundary detection mechanism, faster than classical spectral clustering for certain matrix sparsity patterns.

The lattice infrastructure translates: the canonical-tree idea, applied to quantum circuit synthesis, gate optimization, or hybrid quantum-classical algorithms, is the same shape. The inquiry-lattice work is a continuity bridge for any future quantum-domain product layer, not a discard.

## Implementation path

Three layers, each independently shippable:

### Layer 1 — semantic substrate (~1 week)

- Adapt the vendored HNSW for deterministic canonical insertion (lex tiebreaks on canonical_id).
- Implement canonical_id via normalized framing → sha256.
- Add equivalence-merging at leaf level (cosine threshold).
- Auto-label internal nodes via LLM-summarized centroids; cache per node, invalidate on cluster split.

### Layer 2 — multi-dim coordination (~3-5 days)

- bun:sqlite tables for TemporalIndex, AgentIndex, StatusIndex, DepthIndex.
- Implement multi-axis intersection queries.
- CitationDAG as a separate sqlite table with explicit FK to answer_ids; topological-order maintenance.

### Layer 3 — apprenticeship integration (~1-2 weeks)

- Tie Answer records to questions by canonical_id.
- Push-context retrieval: top-K from SemanticTree, filtered by status/recency from secondary indices.
- Study turns: sample K random questions whose embeddings are within range of the agent's recent activity, hide answers, ask for prediction, grade.

### Open implementation questions

- **Where do Question and Answer records live on disk?** One sqlite database per topology root? Per-agent-home? Globally shared at `/data/lumeyon/agent-chat/lattice.db`?
- **How are concept labels for internal nodes generated and cached?** LLM call per split is expensive; need batching or a distilled labeling model.
- **What's the right cluster size K before splitting?** Probably 8-16, but worth empirically tuning against query latency.
- **How does Layer 1 bootstrap?** With zero questions, the SemanticTree is empty — first insertion just becomes root. No special handling needed, but worth confirming.
- **Cycle prevention on the parent-DAG.** Decomposition must refuse to create cycles. Standard topological-order check on each new parent edge.

## Tradeoffs to be honest about

- **Bigger architectural shift than recursive subgraphs.** This isn't a directory layout change; it's a different primary abstraction. More implementation work and more risk of getting design details wrong before they're locked in.
- **Question-quality matters a lot.** Bad framings mislead the inquiry. The system needs to be able to REFRAME questions when an answer reveals the framing was wrong (a "supersede" mechanism on Question records).
- **Synthesis is hard.** Composing sub-answers into a parent answer is real cognitive work, not just concatenation. The Apprenticeship Substrate's pattern registry helps (synthesis patterns become tools), but cold-start synthesis is awkward.
- **Cycle prevention.** The DAG must stay acyclic; we need to refuse decompositions that would create cycles.
- **Cold-start.** Empty lattice means no priors to push, no patterns to apply. Bootstrap requires either a seed corpus or human-posed initial questions.
- **The normalize() function is load-bearing.** Get it wrong and either too many questions merge (losing distinctions) or too few merge (losing canonical-form benefit). Versioning the normalizer is essential — each version produces a different equivalence class, and old data has to be compatible.

## What this DOES guarantee

- **Compositional reuse** — sub-answers naturally cited by multiple parent inquiries.
- **Sparse routing** — only capable agents see relevant questions.
- **Canonical structure** — equivalent inquiries unify; the lattice grows by intrinsic complexity, not by submission volume.
- **Mergeability** — two independently-grown lattices combine deterministically.
- **Sub-linear queries** — O(log N) typical for each axis, intersection scales with smallest result set.

## What this does NOT guarantee

- That the questions agents pose are GOOD. Bad questions still produce bad inquiry trees.
- That synthesis is correct. Composing sub-answers into a parent answer is judgment, and judgment can be wrong.
- That the equivalence threshold is tuned right. Set too aggressively, distinct questions merge incorrectly. Set too conservatively, near-duplicates accumulate.
- That capability profiles route to the right agent. Routing quality depends on the profiles being accurate, which depends on prior answers being graded accurately.

The lattice is a forcing function for STRUCTURE. The intelligence still has to come from the agents, the substrate's selection pressure, and the quality of the human seed corpus.

## Relationship to existing infrastructure

The CONVO.md / edge / archive infrastructure already in this repo continues to work and provides the conversation log layer. Conversations are still durable per-edge. What changes:

- **The KG is no longer the primary cognitive store.** It becomes the secondary log of what was discussed. The primary cognitive store is the Question + Answer records in the lattice database.
- **Agents don't navigate to "the right edge" to do work.** They pull from the lattice's question queue, filtered by their capability profile. The edge structure becomes a record of their conversational interactions, not a routing mechanism.
- **Recursive subgraphs become unnecessary.** Composition happens via Question DAGs, not via spawned teams. An edge directory may still exist for two-party direct conversation, but problem decomposition no longer requires spawning sub-edges.

When the lattice is fully built, the per-edge KG / archive / Stop-hook infrastructure remains as the conversation-capture mechanism — but the system's accumulated wisdom lives in the lattice, not in any individual edge's KG.
