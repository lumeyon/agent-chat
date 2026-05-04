# Audit Rigor Frame

**Status:** project convention. Captured Round 14 (2026-05-04) from vanguard's design via keystone's Phase-3 audit slice.

When this skill conducts an audit of an external system (Ruflo audit Round 14, lossless-claw audit that produced Round 12, future similar work), every verdict must observe the rigor frame below. Without it, audits drift into vibes and adopted patterns survive integration friction unchallenged.

---

## Verdict types

### ADOPT — direct lift

A pattern from the audited system that we should copy approximately verbatim.

**Required fields:**
- **Receipt** — verbatim quote (≥3 lines context) with file:line.
- **Mechanism** — ≤3-sentence summary of how the pattern works.
- **Pain-point tie-in** — ≤2 sentences linking the adoption to an existing agent-chat issue this addresses.
- **Lands at** — `<file:section>` with named composition + named conflicts.
- **Downgrade trigger** — falsifiable condition under which this ADOPT becomes ADAPT or REJECT. Without the trigger, ADOPT becomes optimistic-by-default and survives integration friction through drift.

**Why the trigger matters:** any adoption can fail under integration. The trigger names what failure looks like in advance, so we know when to pull back.

### REJECT — explicit non-adoption

A pattern from the audited system that we deliberately will NOT adopt.

**Required fields (exactly one of):**
- (a) Citation to existing `ARCHITECTURE.md` invariant being preserved.
- (b) One-line proposed addition to `ARCHITECTURE.md` (queued for post-audit PR).
- (c) Explicit downgrade to `NOTE`.

**Why the principle matters:** a REJECT that can't pick from {a, b, c} is itself the audit's bug — it's a preference dressed as a principle. Surface it. Fix it.

### ADAPT — keep our shape, borrow their idea

A pattern that has a useful core but doesn't transplant cleanly.

**Required fields:**
- **Source mechanism** — ≤2 sentences describing the audited system's pattern.
- **Our adaptation** — what changes between their version and ours.
- **Why the adaptation** — which invariant or pain point forces the delta.
- **Load-bearing IDEA** — one sentence. The kernel that must survive intact through the adaptation. **If this line cannot be written, the import is a different feature wearing the source's name.** Downgrade to "REJECT-then-design-our-own."

### NOTE — observation only

Information that's interesting but not action-relevant. No required rigor; just one-line context.

### NOTE-MARKETING — presentation observation

Reserved for audits where the source has explicit marketing/positioning content (README narrative, GIFs, hosted demos, pitch lines). Distinct from `NOTE` so technical-architecture verdicts aren't crowded by viral-adoption observations. Deprioritized in integrated punch-lists unless the user surfaces a "viral adoption" goal explicitly.

### Confidence tagging

Every verdict carries a `Confidence: LOW | MEDIUM | HIGH` tag.

- **HIGH** — backed by verifiable receipts in the source code AND consistent with our existing invariants.
- **MEDIUM** — receipt exists but interpretation has unresolved questions, OR claim depends on documented behavior we haven't independently verified.
- **LOW** — claim rests on speculation OR on undocumented behavior we'd need to runtime-probe.

`LOW` verdicts get queued for empirical verification (runtime probe, real install, dual-runtime test) before any production decision rides on them.

---

## The pattern this guards against

Across rounds 12-14, the same anti-pattern recurred at three abstraction levels:

| Round | Level | Anti-pattern |
|---|---|---|
| 12 | Code | `bm25(archives, 2.0, 1.0, 1.5, 2.5)` — wrong number of weights aligned to wrong columns. Test passed for the wrong reason. |
| 13 | Code | `lockHeld = fs.existsSync()` — file presence ≠ liveness. `parseHeartbeat` accepts missing/unknown sidecar_version — string presence ≠ semantic validity. Test fixture `ts=x` short-circuited on `Date.parse` before reaching the labeled invariant. |
| 14 | Audit | Ruflo's autopilot-loop `SKILL.md` describes "markdown checkbox" task discovery; the actual implementation reads a JSON file. The doc lies; the code is truth. |

**Pattern statement:** load-bearing claim guarded by an under-specified primitive. Whether the primitive is a numeric tuple's length, a boolean's semantic meaning, a string's presence, a test fixture's fall-through, or a doc's accuracy, the failure mode is identical.

**Verify the primitive matches the load-bearing claim.** That's what the rigor frame enforces. Empty `Downgrade trigger` flags an unfalsified ADOPT; empty `Invariant cited` flags a REJECT that hasn't earned its principle; missing `Load-bearing IDEA` flags an ADAPT that's silently a different feature.

---

## Citation

Vanguard designed the rigor frame; keystone integrated it into the Round-14 audit at the slice-3 deliverable. When using this frame on future audit work, cite vanguard explicitly in the audit's process notes.
