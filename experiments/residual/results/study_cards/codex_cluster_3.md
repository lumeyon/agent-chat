# Study Card — codex cluster 3

## Failure Mode
**hedge-heavy uncertain** (n=21 / 99 high-residual rows = 21%)

## Residual Signature
Driving features (mean signed residual, in z-score units across high-residual rows):

- `n_hedge_words`: +2.42σ (mean abs 2.42)
- `response_len`: -0.65σ (mean abs 0.65)
- `n_latex`: -0.33σ (mean abs 0.52)
- `n_codeblocks`: -0.45σ (mean abs 0.48)

## Exemplars (top 5 most-extreme cluster members)

### 1. `recnjViFrqlZNL3fY` [Physics/Physics (general)] (residual ‖² = 13.98)

> Lyman-alpha is emitted/absorbed at rest wavelength \(1216\ \text{Å}\). For ground-based optical detection, it must be redshifted to roughly the optical cutoff, about \(3500\ \text{Å}\).

\[
1216(1+z)

### 2. `recYt8xx80OTyDsL0` [Biology/Molecular Biology] (residual ‖² = 12.52)

> Fluorescent Peyer patches indicate antigen exposure in gut-associated lymphoid tissue. The proliferating cells are likely activated B cells in germinal centers.

High variability specifically in the v

### 3. `rec9W28HgpEUeUN8k` [Physics/Quantum Mechanics] (residual ‖² = 12.06)

> For `phi = -pi/4`, the state is the odd cat state:

`|psi> ∝ |alpha> - |-alpha>`

Since `rho = |psi><psi|` is pure:

`Tr(rho ln rho) = 0`

So the non-Gaussianity is just the entropy of the reference G

### 4. `recD8oX1KevFbl7bL` [Biology/Genetics] (residual ‖² = 11.92)

> Reading from the start codon:

- Intact: `ATG TTT CTC GCT...`
- Mutant 2: `ATG TTC TAA GCT...`

Mutant 2 introduces `TAA`, a premature stop codon very early in the coding sequence. That is the most li

### 5. `recINGR1z01Fh1Z3A` [Physics/Physics (general)] (residual ‖² = 10.68)

> In LTE, the excitation populations follow the Boltzmann factor:

\[
n \propto e^{-\Delta E/kT}
\]

If star 1 has twice the excitation population of star 2:

\[
2 = \frac{e^{-\Delta E/kT_1}}{e^{-\Delta

## What to learn

Agent is hedging excessively. Indicates genuine uncertainty (good signal!) but the final answer may still be wrong. **Fix:** for hedge-heavy responses, automatically trigger a peer-review pass (Track C boundary scout).