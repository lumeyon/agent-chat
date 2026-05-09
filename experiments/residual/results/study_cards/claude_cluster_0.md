# Study Card — claude cluster 0

## Failure Mode
**response_len dominant (+0.1σ)** (n=72 / 98 high-residual rows = 73%)

## Residual Signature
Driving features (mean signed residual, in z-score units across high-residual rows):

- `response_len`: +0.14σ (mean abs 0.62)
- `n_self_correction`: -0.40σ (mean abs 0.53)
- `n_questions`: -0.01σ (mean abs 0.52)
- `letter_unknown`: -0.19σ (mean abs 0.51)

## Exemplars (top 5 most-extreme cluster members)

### 1. `recVE8cUNHpHZIAvL` [Physics/Astrophysics] (residual ‖² = 54.72)

> Looking at this problem:

**Solar neutrino sources by branch:**
- pp-I: pp neutrinos (continuous, endpoint ~420 keV) — below both bands
- pp-II: ⁷Be neutrinos (lines at **861 keV** and 384 keV), pep a

### 2. `recD8oX1KevFbl7bL` [Biology/Genetics] (residual ‖² = 39.73)

> Looking at each mutant by translating the start of the coding sequence:

**Original:** ATG-TTT-CTC-GCT-GGT-ACT-TCT-GTG-GAT-GAA-CAT-ATT-TAT-TGT-CGT...
→ Met-Phe-Leu-Ala-Gly-Thr-Ser-Val-Asp-Glu-His-Ile-

### 3. `recnjViFrqlZNL3fY` [Physics/Physics (general)] (residual ‖² = 9.18)

> Looking at this problem:

Lyman alpha rest wavelength: 1216 Å

Ground-based optical telescopes are limited by atmospheric UV cutoff at roughly ~3500 Å (atmosphere blocks shorter wavelengths).

For Lyα

### 4. `recZdZxsN0AxDx0pB` [Biology/Molecular Biology] (residual ‖² = 7.12)

> Looking at this carefully:

**Check the slope/efficiency consistency:**
- Between each 10-fold dilution, Ct differences are ~3.3 cycles (e.g., 34.2 → 30.9 → 27.6 → 24.3 → 21.0). This is consistent wit

### 5. `rectlyG9pCAAuWhoB` [Chemistry/Organic Chemistry] (residual ‖² = 6.01)

> Looking at this problem:

**Diels-Alder reaction setup:** 5-fluorocyclopentadiene (the F is on the sp³ C5) reacts with maleic anhydride to give a norbornene-fused anhydride, where C5 of the diene beco

## What to learn

Cluster pattern: response_len dominant (+0.1σ). No predefined lesson — examine the exemplar responses above and characterize manually.