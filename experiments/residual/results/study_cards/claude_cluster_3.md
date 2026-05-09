# Study Card — claude cluster 3

## Failure Mode
**code-block-heavy reasoning** (n=1 / 98 high-residual rows = 1%)

## Residual Signature
Driving features (mean signed residual, in z-score units across high-residual rows):

- `n_codeblocks`: +11.32σ (mean abs 11.32)
- `letter_D`: -2.43σ (mean abs 2.43)
- `n_certainty_words`: -2.30σ (mean abs 2.30)
- `response_len`: -2.06σ (mean abs 2.06)

## Exemplars (top 1 most-extreme cluster members)

### 1. `recnGEpF1srQpaqWq` [Chemistry/Organic Chemistry] (residual ‖² = 151.45)

> Looking at this problem, I need to recognize that heating a 1,5-diene triggers a **Cope rearrangement** ([3,3]-sigmatropic shift).

## Step 1: Draw 5-butylnona-2,6-diene

```
CH₃-CH=CH-CH₂-CH(C₄H₉)-CH

## What to learn

Agent uses code blocks where prose would suffice. Often correlates with over-formalization on questions that don't require code. **Fix:** for non-code domains (Chemistry, Physics, Biology), require justification-in-prose with code blocks reserved for actual computation.