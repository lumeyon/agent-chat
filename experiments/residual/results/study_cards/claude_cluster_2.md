# Study Card — claude cluster 2

## Failure Mode
**math-notation-heavy (latex)** (n=10 / 98 high-residual rows = 10%)

## Residual Signature
Driving features (mean signed residual, in z-score units across high-residual rows):

- `n_latex`: +3.38σ (mean abs 3.38)
- `letter_D`: +0.65σ (mean abs 0.65)
- `response_len`: -0.29σ (mean abs 0.47)
- `n_self_correction`: -0.33σ (mean abs 0.41)

## Exemplars (top 5 most-extreme cluster members)

### 1. `recmkvk6EFAmqyMxR` [Physics/Relativistic Mechanics] (residual ‖² = 62.69)

> Looking at this problem, I need to find the Lorentz factor where 2/3 of particles reach the detector walls.

**Setting up the decay equation:**

The fraction of particles surviving to distance R is:
$

### 2. `recOYsaYs6RmtlTDy` [Physics/Quantum Mechanics] (residual ‖² = 24.60)

> Looking at this problem:

**Fundamental state**: v=0, J=0. Selection rules for rovibrational transitions: Δv=+1, ΔJ=±1. From J=0, only ΔJ=+1 is allowed, so the lowest-energy next state is (v=1, J=1).

### 3. `recatj4YXzbOaq3Ar` [Physics/Quantum Mechanics] (residual ‖² = 24.17)

> The operator $\vec{\sigma}\cdot\vec{n}$ has eigenvalues $\pm 1$ (since $(\vec{\sigma}\cdot\vec{n})^2 = I$ for a unit vector $\vec{n}$). Multiplying by $\varepsilon$ gives eigenvalues $\pm\varepsilon$.

### 4. `recN4DY9Q5V03glmQ` [Physics/Quantum Mechanics] (residual ‖² = 15.78)

> Looking at this problem, I need to find the imaginary part of the forward scattering amplitude using the partial wave expansion:

$$\text{Im } f(0) = \frac{1}{k}\sum_{l=0}^{4}(2l+1)\sin^2(\delta_l)$$

### 5. `rec2UlKqC6RFHdcro` [Physics/High-energy particle physics] (residual ‖² = 13.85)

> Looking at this problem, I need to find the threshold energy for γγ → e⁺e⁻ pair production.

**Threshold condition:**
For two photons with energies E_γ and E_CMB colliding head-on (most favorable case

## What to learn

Agent uses unusually heavy LaTeX. Often a signal of a hard quantitative question where typical reasoning isn't sufficient. **Fix:** these are good candidates for the residual-explore boundary scout to flag for human review.