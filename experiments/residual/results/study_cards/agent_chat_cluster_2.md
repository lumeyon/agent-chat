# Study Card — agent_chat cluster 2

## Failure Mode
**asks-back questioning** (n=5 / 97 high-residual rows = 5%)

## Residual Signature
Driving features (mean signed residual, in z-score units across high-residual rows):

- `n_questions`: +4.68σ (mean abs 4.68)
- `n_hedge_words`: -0.87σ (mean abs 1.40)
- `n_self_correction`: -0.87σ (mean abs 1.27)
- `response_len`: -1.24σ (mean abs 1.24)

## Exemplars (top 5 most-extreme cluster members)

### 1. `recDDxpS9s8cwkqfq` [Chemistry/Organic Chemistry] (residual ‖² = 36.06)

> Reconsidering the critique:

**The key question: what does "emits" mean here?**

For a textile dye, the standard organic chemistry framing is:
- Dye absorbs certain wavelengths of visible light
- The

### 2. `recmkvk6EFAmqyMxR` [Physics/Relativistic Mechanics] (residual ‖² = 34.80)

> Looking at this problem again with the peer's endorsement.

The decay survival probability for ultra-relativistic particles traveling distance R is:
P = exp(-R/(γβcτ)) ≈ exp(-R/(γcτ))

At γ₁ = 20: P₁

### 3. `reczjcMtrB1YGS2fO` [Physics/Optics and Acoustics] (residual ‖² = 34.78)

> The peer reviewer confirms my calculation and reasoning. The caveat raises the possibility that "first two minima" could mean the first minima on each side of the central maximum (giving 2θ₁ = 1.220 λ

### 4. `recnTTKdBzfuoZ7w7` [Biology/Molecular Biology] (residual ‖² = 32.59)

> The peer is right that I was sloppy. Let me redo this with their corrections.

## Step 1: First filter — does each insert encode the specified P53 protein?

The peer flagged that B differs at residue

### 5. `recf6ayQmL1SxKbvW` [Biology/Molecular Biology] (residual ‖² = 26.09)

> The peer critique accepts my answer (B) but suggests refining the reasoning about D. Let me reconsider:

**Step 1: What does the question actually ask?**
The MOST crucial step BEFORE in silico docking

## What to learn

Agent is asking sub-questions instead of answering. The question may be ill-specified, OR the agent is dodging. **Fix:** detect via `n_questions > 2σ` and either re-prompt with clarification or escalate to a stronger model.