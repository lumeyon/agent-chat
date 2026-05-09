# Study Card — agent_chat cluster 1

## Failure Mode
**n_certainty_words dominant (+1.3σ)** (n=40 / 97 high-residual rows = 41%)

## Residual Signature
Driving features (mean signed residual, in z-score units across high-residual rows):

- `n_certainty_words`: +1.31σ (mean abs 1.33)
- `letter_unknown`: +0.34σ (mean abs 0.69)
- `n_hedge_words`: +0.02σ (mean abs 0.60)
- `n_self_correction`: -0.30σ (mean abs 0.54)

## Exemplars (top 5 most-extreme cluster members)

### 1. `rec47oNPXudlTIk4y` [Chemistry/Chemistry (general)] (residual ‖² = 27.32)

> Looking at this problem again with the peer's endorsement:

The question asks about a dual catalyst system to make branched PE from ethylene alone. The essential additional reaction step is selective

### 2. `recD8oX1KevFbl7bL` [Biology/Genetics] (residual ‖² = 26.85)

> Looking at this question carefully:

**Intact:** ATG-TTT-CTC-GCT-GGT-ACT-TCT-GTG-GAT...

**Mutant 1:** ATG-TTC-TAC-GCT-GGT-ACT-TCT-GTG-GAT... → missense changes (Phe→Phe silent, Leu→Tyr); protein stil

### 3. `recZbxrocrxh9YENH` [Chemistry/Chemistry (general)] (residual ‖² = 22.04)

> Looking at this again with the peer's critique in mind:

**My calculation gives: ΔHf = 1900 kJ/mol** (the arithmetic is confirmed correct by the peer).

**Evaluating the options:**
- (A) 67.4 kJ/mol —

### 4. `rec06pnAkLOr2t2mp` [Physics/Physics (general)] (residual ‖² = 14.35)

> The draft answer and the critique agree, and the reasoning is correct.

Using ΔE ≈ ℏ/τ:
- τ₁ = 10⁻⁹ s → ΔE₁ ≈ 6.6×10⁻⁷ eV
- τ₂ = 10⁻⁸ s → ΔE₂ ≈ 6.6×10⁻⁸ eV

To clearly resolve the two levels, the ener

### 5. `rec4L69T0Y1AS4AFS` [Biology/Molecular Biology] (residual ‖² = 11.29)

> API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). Try rephrasing the request or attempting a different appro

## What to learn

Cluster pattern: n_certainty_words dominant (+1.3σ). No predefined lesson — examine the exemplar responses above and characterize manually.