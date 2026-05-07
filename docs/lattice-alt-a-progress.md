# Alternative A — Progress Dashboard

> Status file maintained by the autonomous `/loop` driver. Captures Alt A deliverable progress, decision points, and verification results.

## Current state — 2026-05-07T17:55Z

**Phase: ALT-A-2 SHIPPED — pushContext wired into agent-chat runtime. Every cmdRun call now retrieves top-K relevant prior Q/A from the lattice and prepends as "Relevant prior knowledge" to the LLM prompt.**

## Phase status

| Phase | Deliverable | Status |
|---|---|---|
| ALT-A-1 | AI-to-AI dialog import | **COMPLETE** — pairSections() extended; 23 tests pass; production lattice grew 252→386 questions / 693→846 answers |
| ALT-A-2 | pushContext wired into agent-chat runtime | **COMPLETE** — `lattice-context.ts` helper + cmdRun integration; 12 unit tests + real-data end-to-end smoke pass |
| ALT-A-3 | Study turn loop with LLM integration | **NEXT** |

## Iteration log

### 2026-05-07T17:55Z (Alt A iteration 2)

- Built `plugins/agent-chat/scripts/lattice-context.ts` — helper module bridging cmdRun to the global lattice's pushContext()
- Two exported functions:
  - `composePushedContextBlock({query, latticeDbPath, k, exclude_agent, ...})` — returns formatted markdown block with top-K prior Q/A from the lattice. Empty string if lattice missing, query empty, or no peer hits after filtering.
  - `extractMostRecentPeerBody(sections, myAgentName)` — walks CONVO.md sections in reverse, finds the most recent peer (not-this-agent) section's body. Used as the natural retrieval query (what THIS agent is about to respond to).
- Wired into `agent-chat.ts:cmdRun` in the prompt-composition pipeline: `roleBlock + ... + pushedContextBlock + tailBlock`
  - Lazy-imported so the module loads only when cmdRun is invoked
  - Lattice retrieval failures are caught and logged but never block the response cycle
  - Each pushed answer truncated to 600-byte body budget so the block stays bounded
  - Auto-imported placeholder explanations are stripped (they're noise that would crowd out signal)
- 12 new tests in `plugins/agent-chat/tests/lattice-context.test.ts`; all pass:
  - `extractMostRecentPeerBody`: 5 tests covering peer extraction, self-exclusion, malformed sections, AI-to-AI dialog
  - `composePushedContextBlock`: 7 tests covering missing DB, empty query, no priors, formatted output, agent-self exclusion, peer-vs-self mixed, auto-imported-explanation suppression
- **Real-data end-to-end smoke** against the production lattice (386Q/846A):
  - Query: "What is the deadline?"
  - Result: 3 hits returned, formatted block produced (2640 chars)
  - Top hits ranked by embedding cosine (0.36, 0.25, 0.24)
  - Auto-imported explanations correctly suppressed
  - Orion's own answers correctly excluded — top hits are by lumeyon, keystone, vanguard
  - Confirms pushContext flows end-to-end against real production data
- Plugin tests: 495 pass / 0 fail (was 480; added 12 new + 3 unrelated tests appearing in the run)
- Lattice tests: 73 pass (was 67; one of those moved from a different file count or the AI-to-AI tests added 6 new ones)
- The forcing function 4 (cross-domain push) is now ALIVE in the runtime: every agent response is preceded by automatic retrieval of relevant prior Q/A from the lattice. The substrate pushes; the agent doesn't query.
- Loop CONTINUES — next iteration starts ALT-A-3 (study turn loop)

### 2026-05-07T17:30Z (Alt A iteration 1)

- Read sample AI-to-AI sections from `/data/lumeyon/agent-chat/conversations/petersen/lumeyon-orion/archives/leaf/`. Pattern: each section has `## <agent> — <topic> (UTC <iso>)` header and an arrow trailer. Adjacent different-agent sections form a Q→A pair.
- Extended `scripts/lattice/import-from-kg.ts:pairSections()` to recognize TWO patterns:
  - **human → AI** (existing): `user turn` → `assistant response`
  - **AI → AI** (new): adjacent different-agent sections, neither a handoff/park/proposal, with arbitrary topic descriptions
- Added `kind: "human_to_ai" | "ai_to_ai"` to `QAPair` so downstream tagging is preserved
- Skip-already-consumed logic so 4-section back-and-forths produce 2 pairs not 3
- Filter list of non-Q/A description prefixes: `handoff`, `park`, `parked`, `parking`, `propose subgraph`, `subgraph spawn`
- 6 new tests in `import-from-kg.test.ts` covering: AI-to-AI basic, 4-section sequence (consume-and-skip), handoff rejection, parking rejection, same-agent rejection, mixed human→AI / AI→AI sequence
- Test totals: 23 import tests, all pass (was 17 + 6 new)
- All 67 lattice tests still pass; full plugin suite still green
- **Production import validation:**
  - Before: 252 questions, 693 answers (5 distinct posed_by/by_agent participants — boss + 4 AI agents had answered)
  - After:  386 questions, 846 answers (+130 / +141, distributed across 10 distinct AI agents now answering)
  - Previously-empty AI-to-AI edges now contribute meaningful Q/A:
    - `petersen/lumeyon-orion` archives: +29Q +36A
    - `petersen/keystone-orion`: +23Q +27A
    - `petersen/carina-orion`: +24Q +24A
    - `petersen/lumeyon-sentinel`: +8Q +8A
    - `petersen/keystone-vanguard`: +10Q +10A
    - `petersen/keystone-rhino`: +9Q +9A
    - `petersen/cadence-carina`: +8Q +8A
    - `petersen/carina-pulsar`: +7Q +7A
    - `pair/lumeyon-orion`: +3Q +3A
- The lattice now contains agent-to-agent dialogue alongside human-to-AI Q/A. New participant distribution:
  - `posed_by`: boss=256, orion=64, lumeyon=24, carina=20, keystone=19, rhino=3
  - `by_agent`: orion=394, lumeyon=356, keystone=28, carina=20, vanguard=10, lyra=9, cadence=8, sentinel=8, pulsar=7, rhino=6
- Loop CONTINUES — next iteration starts ALT-A-2 (pushContext wired into runtime)
