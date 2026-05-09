# Study Card — agent_chat cluster 3

## Failure Mode
**math-notation-heavy (latex)** (n=4 / 97 high-residual rows = 4%)

## Residual Signature
Driving features (mean signed residual, in z-score units across high-residual rows):

- `n_latex`: +4.86σ (mean abs 4.86)
- `letter_A`: +1.86σ (mean abs 1.86)
- `letter_D`: -1.30σ (mean abs 1.30)
- `n_self_correction`: +0.15σ (mean abs 1.13)

## Exemplars (top 4 most-extreme cluster members)

### 1. `recyPffUDqC2k7ZZO` [Physics/Quantum Mechanics] (residual ‖² = 48.19)

> The peer's critique confirms my reasoning. Let me verify once more:

State: $(-1/2, 1/\sqrt{2}, -1/2)$ in the $P_z$ eigenbasis.

Normalization check: $1/4 + 1/2 + 1/4 = 1$ ✓

Probabilities:
- $P(\hbar

### 2. `recywRj5a8EEjj2Ib` [Physics/Physics (general)] (residual ‖² = 32.96)

> The peer critique confirms my reasoning. Let me verify once more:

**Energy conservation:** At turning point (x=A, v=0), total energy is rest energy plus potential:
$$E = mc^2 + \tfrac{1}{2}kA^2$$

At

### 3. `rec0VuKUjt1SZ7NYv` [Physics/Relativistic Mechanics] (residual ‖² = 30.14)

> The metric is $ds^2 = \frac{32}{4-x^2-y^2}(dx^2 + dy^2)$ on the disk $x^2+y^2 < 4$.

**Area element:** $dA = \frac{32}{4-x^2-y^2}\, dx\, dy$

**In polar coordinates:**
$$A = 2\pi \int_0^2 \frac{32\rho

### 4. `recyrk6XBVwugG5u8` [Physics/Astrophysics] (residual ‖² = 27.55)

> The peer's critique confirms my answer and adds a minor refinement: the grazing condition should technically be $b_2 \leq 1 + R_{p,2}/R_\star$ rather than $b_2 \leq 1$. I noted this correction in my d

## What to learn

Agent uses unusually heavy LaTeX. Often a signal of a hard quantitative question where typical reasoning isn't sufficient. **Fix:** these are good candidates for the residual-explore boundary scout to flag for human review.