# The Apprenticeship Substrate

> **Status:** strategic architectural direction (confirmed 2026-05-07). Not yet implemented. The compositional layer that sits on top of this substrate (how work decomposes across agents) is still under design.

## What this is

The Apprenticeship Substrate is the target architecture for the agent-chat plugin: a multi-agent system in which **knowledge is transmitted, not stored**, and **learning is structurally inseparable from working**. Every action an agent takes produces a teaching artifact; every agent is forced, on a regular cadence, to study peer artifacts; the system's accumulated wisdom is what survives selection pressure on those artifacts.

It replaces the prior framing — "tree-of-knowledge built from per-edge KGs" — as the strategic goal. The per-edge KG / archive / Stop-hook infrastructure already in this repo becomes the storage layer underneath; the substrate adds the forcing functions on top.

## What problem it solves

Tree-of-knowledge gives you a STRUCTURE for accumulated experience but bets the intelligence on **agent discipline**: remembering to query KGs, integrating retrieved context, writing lessons, citing prior subgraphs. If discipline lapses — and it will, because forgetting is cheap and remembering is costly — the structure fills with orphaned knowledge that no future agent benefits from.

The Apprenticeship Substrate makes the discipline a **protocol invariant**. An agent can't skip reflection or learning without breaking the protocol; the substrate handles retrieval automatically. The intelligence isn't hoped-for; it's structurally pressured to emerge.

## The shift

| Tree-of-knowledge | Apprenticeship Substrate |
|---|---|
| Knowledge is stored | Knowledge is transmitted |
| Querying is opt-in | Context is pushed at every turn |
| Learning happens off-path (post-hoc reflection) | Learning is on-path (mandatory study turns) |
| All knowledge persists | Only useful knowledge survives selection |
| Cross-agent visibility = manual | Cross-agent visibility = automatic via embedding similarity |
| Capability = "this agent knows things" | Capability = "the system knows things, any agent can access" |

The defining property: an agent who joined the system yesterday can act with the accumulated wisdom of every agent who has ever worked in it, because explanations are ranked, retrieved on demand, and pushed before action.

## The five forcing functions

### 1. Dual-output every turn

Every agent response is a tuple `(response, explanation)` — not optional. The response is what the peer sees and reacts to. The explanation is short, written for a hypothetical novice peer who wasn't in the conversation, and answers: *what did I just decide, why, and what would help someone unfamiliar with this domain understand?*

The explanation is captured at the moment of action — the only moment reflection is really tractable, because the agent's reasoning is fresh. After-the-fact reflection is a different (and weaker) cognitive operation.

Implementation note: the explanation is a separate field, not embedded in the response prose. It's stored in a parallel index keyed by the same `(speaker, turn-sha256)` as the response itself. Token cost: roughly 1.5–2× per turn vs response-only.

### 2. Mandatory study turns

Every Nth turn (proposed default: N=10), an agent's next turn is a **study turn** instead of a work turn. The protocol:

1. Retrieves the top-K explanations from peers that are relevant to the agent's recent activity (semantic similarity over recent edges' content).
2. Hides the corresponding *responses* and shows only the *prompts* that led to those explanations.
3. Asks the agent to predict what the original agent would have responded.
4. Reveals the actual response and grades the prediction.
5. High prediction error triggers a clarifying question back to the original agent via the standard edge protocol; that agent's reply refines the explanation, raising its quality score.

The study turn is the only place the system enforces learning-as-distinct-from-doing. Without it, agents act forever without ever consolidating peer experience.

### 3. Selection pressure on explanations

Explanations don't all survive. They compete on three signals:

- **Predictive lift** — when other agents have read this explanation as pushed context, do their subsequent actions improve (measured by reduced prediction error on later study turns)? This is the strongest signal but the most expensive to compute.
- **Citation count** — how often does this explanation get retrieved as relevant to other turns?
- **Concision** — short explanations that perform equally well beat long ones. There's a length penalty term in the score.

High-scoring explanations get promoted to **patterns** — short, durable, callable as tools. The pattern registry IS the system's accumulated capability, queryable by any agent. Low-scoring explanations are pruned (deleted, or demoted to long-tail storage that doesn't get pushed).

The system has a memory budget. Survival is competitive. This is the only mechanism that prevents the substrate from filling with useless content over time.

### 4. Cross-domain push

Every agent action is preceded by automatic retrieval of the top-K most-relevant explanations across the **entire** system — not just the agent's own KG, not just the current edge, not just the current subgraph. The substrate pushes; the agent doesn't query.

The retrieval is keyed by the current input (the user's prompt or peer's last message). The K explanations are prepended to the agent's context window as "relevant prior knowledge." The agent reads them as part of natural prompt processing — no special "query the KG" affordance is needed.

This is the mechanism by which a novice agent inherits the accumulated wisdom of every other agent. It's also the mechanism by which cross-domain transfer happens: a similar pattern in an unrelated domain surfaces because the embedding similarity finds it.

### 5. Every artifact is training-data-shaped

The (question, answer, explanation, predictive_lift score, provenance trail) tuple is the SAME shape whether read by a future agent for retrieval or exported as downstream data. The export pipeline is first-class infrastructure, not an afterthought.

Implications baked into every subsequent design decision:

- **Format consistency.** Internal storage shape == external export shape. The lattice's Q&A records and any exported JSONL use the same schema, same metadata fields, same field names. No translation layer.
- **Provenance is mandatory.** Every artifact carries: who created it, when, in what context, who validated it, what the predictive_lift score was. Same traceability serves agents (auditable retrieval context) and downstream consumers (verifiable provenance).
- **Quality tiers are explicit.** Not all lattice data is equal. The system defines quality 1 (human-verified gold) through quality 5 (raw, unvalidated). Same scores serve agent retrieval (filter for quality ≥ 3 when answering high-stakes questions) and downstream curation.
- **Mergeability is universal.** Canonical-form lattice merging works the same way for multi-installation team aggregation and for clean dataset merges across exported subsets. The Inquiry Lattice's canonical_id property is the structural enabler.
- **Multimodal becomes load-bearing.** Diagrams, charts, screenshots, equations rendered as images are content-relevant for any technical domain. Multimodal indexing (CLIP) is a v2 commitment.

The forcing question for any future design decision: **does this preserve format-uniformity, provenance, mergeability, and quality-tier semantics?** If any of those break, the design is incomplete.

## What this DOES guarantee

- **Reflection happens** — because dual-output is required.
- **Learning happens** — because study turns are required.
- **Useful patterns survive** — because selection is structural.
- **Cross-pollination happens** — because retrieval is automatic.
- **Every artifact is exportable** — because format consistency is required.

## What this does NOT guarantee

- That the patterns the system learns are CORRECT in some absolute sense.
- That the system's worldview converges rather than fragments.
- That mediocre explanations don't dominate by being plausible-sounding (selection signals can be wrong).
- That the agents can actually USE the pushed context — model capability remains the ceiling.

No filesystem architecture solves the open AI research problem of guaranteed emergent intelligence. The Apprenticeship Substrate is a stronger forcing function than tree-of-knowledge, not a magic bullet.

## Tradeoffs to be honest about

- **Token cost ~2× per turn** (response + explanation). Real money.
- **Throughput penalty from study turns** — every Nth turn isn't doing work. Roughly 10% overhead at N=10.
- **Selection pressure scoring is hard.** Predictive lift is the right signal but expensive; it requires pairing study turns with outcome telemetry. The ranking can be wrong, demoting useful explanations.
- **Novice-vs-master gating is hard to calibrate.** Forcing too much study on a master is wasteful; not enough on a novice means they act without context.
- **Cold start is brutal.** With no explanations in the system, the first turns are just normal work without push-context. Bootstrap requires seed explanations from a human or transferred from another system.

## Compatibility with existing infrastructure

The infrastructure already in this repo continues to work and provides the storage primitives:

- `<edge_root>/CONVO.md` is still where conversations land, but each turn now carries an explanation field alongside the response.
- The KG built by `kg.ts` continues to embed sections, but explanations get their own sub-index — they're retrieved with different ranking signals than raw conversation text.
- Archives still seal old content; explanations are archived too, but the pattern registry (promoted explanations) lives outside any single edge so it's globally accessible.
- Stop hooks still capture turns; the capture now includes the explanation field.
- Autowatch still drives codex agents; study turns are scheduled by the same watcher.

## Open design questions

These aren't blockers, but they need answers before implementation begins:

1. **Where does the explanation live in the section format?** Inline as a sub-section, or as a sidecar file `<turn-sha256>.explanation.md`?
2. **Who runs the prediction-grading loop in study turns?** A separate "judge" agent? The peer agent the explanation belongs to? An automated semantic-similarity grader?
3. **What's the retrieval scope for cross-domain push?** Whole-system explanation index? Topology-scoped? Last-N-days only? This is a relevance/cost tradeoff.
4. **How are patterns (promoted explanations) addressed?** Stable IDs? Content-hashed? Slugs?
5. **How is the pattern registry stored and synced?** One file per pattern, or a single bun-sqlite database? Per-agent visibility, or global?
6. **What's the right N for study-turn cadence?** Probably context-dependent — novices study more, masters less. Need a per-agent state for this.

## The compositional layer that sits on top

The substrate handles HOW knowledge accumulates and HOW agents learn. It does NOT prescribe HOW work decomposes across agents. The compositional layer — what shape "the team" takes, how problems get broken down, how parallel agents coordinate — is a separate design concern.

The current proposed compositional layer is the [Inquiry Lattice](./inquiry-lattice.md) — a canonical multi-dimensional question/answer DAG inspired by Shannon decomposition / ROBDDs, with O(log N) lookups via cover-tree / HNSW semantic indexing plus B-tree secondary indices. The lattice frames composition epistemically (decomposition by inquiry) rather than organizationally (decomposition by team), and produces canonical, mergeable structure across installations.

The two layers interlock: the Apprenticeship Substrate is the LEARNING engine, the Inquiry Lattice is the WORK engine. Together they form the target architecture for the agent-chat plugin.
