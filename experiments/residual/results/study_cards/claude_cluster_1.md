# Study Card — claude cluster 1

## Failure Mode
**confidently asserts no answer (refusal-adjacent)** (n=15 / 98 high-residual rows = 15%)

## Residual Signature
Driving features (mean signed residual, in z-score units across high-residual rows):

- `n_certainty_words`: +2.69σ (mean abs 2.69)
- `letter_unknown`: +1.29σ (mean abs 1.29)
- `n_self_correction`: +1.05σ (mean abs 1.05)
- `letter_A`: -0.14σ (mean abs 0.90)

## Exemplars (top 5 most-extreme cluster members)

### 1. `rec6sE2CRtD4drtHg` [Physics/High-energy particle physics] (residual ‖² = 46.39)

> Looking at this problem, I need to identify the Coleman-Weinberg radiative correction to a pseudo-Goldstone boson mass.

The standard form is:
$$M^2 \sim \frac{1}{8\pi^2 f^2} \sum_i (\pm) M_i^4$$

whe

### 2. `recnTTKdBzfuoZ7w7` [Biology/Molecular Biology] (residual ‖² = 43.99)

> Looking at this question, I need to identify which DNA sequence will best produce human p53 in E. coli BL21 *quickly*. This is a codon optimization question — E. coli BL21 has rare codons that slow/st

### 3. `recYt8xx80OTyDsL0` [Biology/Molecular Biology] (residual ‖² = 23.93)

> API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). Try rephrasing the request or attempting a different appro

### 4. `rec4L69T0Y1AS4AFS` [Biology/Molecular Biology] (residual ‖² = 23.93)

> API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). Try rephrasing the request or attempting a different appro

### 5. `recTs7qzfJs6kfLUK` [Biology/Molecular Biology] (residual ‖² = 23.93)

> API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). Try rephrasing the request or attempting a different appro

## What to learn

The agent is hedging into ambiguity rather than committing. Watch for high `n_certainty_words` paired with `letter_unknown` — confident-sounding non-answers. **Fix:** require an explicit final letter even when uncertain; refusal-adjacent responses should be detected and re-prompted.