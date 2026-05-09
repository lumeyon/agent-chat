# Study Card — agent_chat cluster 0

## Failure Mode
**soft-pushback / deferral** (n=48 / 97 high-residual rows = 49%)

## Residual Signature
Driving features (mean signed residual, in z-score units across high-residual rows):

- `n_self_correction`: +0.44σ (mean abs 0.90)
- `n_certainty_words`: -0.71σ (mean abs 0.73)
- `response_len`: +0.24σ (mean abs 0.66)
- `n_latex`: +0.12σ (mean abs 0.55)

## Exemplars (top 5 most-extreme cluster members)

### 1. `recLSzwBUS3olCjhl` [Chemistry/Chemistry (general)] (residual ‖² = 14.68)

> Looking at the NMR data again:

- **7.0 ppm (1H, d, J = 16.0 Hz)**: vinylic H on the carbon bonded to OAc (the peer's wording correction is fair — it's on C, not directly on O). The 16 Hz coupling is

### 2. `recPL4ZPpVYxgMu57` [Physics/High-energy particle physics] (residual ‖² = 14.45)

> The peer critique actually reinforces my original answer. Let me reconsider:

1. **Lorentz symmetry** ✓ — SMEFT is built as a relativistic QFT
2. **Poincaré symmetry** ✓ — includes translations, requi

### 3. `recWxGU8Q4YReJ1tb` [Chemistry/Organic Chemistry] (residual ‖² = 12.88)

> Looking at this critique, the peer raises legitimate concerns about rigor, but doesn't actually demonstrate that D is wrong. Let me reconsider the option-level distinctions more carefully.

**Re-exami

### 4. `recUOePh79cp4T2Bg` [Chemistry/Organic Chemistry] (residual ‖² = 11.42)

> Looking at this critique carefully, I'll work through both reactions again.

## Reaction A: Re-examining the Wittig pathway

Lumeyon is right that I should justify [1,2] vs [2,3] more rigorously. Let

### 5. `recUBgVlkKzcRPDdK` [Biology/Molecular Biology] (residual ‖² = 11.11)

> Reconsidering carefully:

**Peer's strongest point:** mRaspberry without a targeting sequence is indeed soluble/cytoplasmic, regardless of promoter. That's a true molecular-biology fact.

**But (D) ha

## What to learn

When `draft → revise` flips, require the agent to mark each substantive critique claim VALID or INVALID with one sentence of reasoning before accepting. The current revise prompt says 'don't change reflexively' but doesn't enforce the rebuttal discipline. **Fix:** append `For each substantive claim in the critique, state: VALID [why] or INVALID [counter-argument]. Then produce your final answer.` to the revise template.