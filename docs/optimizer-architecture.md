# Multi-Sub Optimizer — Documentation Technique

> **Date de rédaction** : 2026-07-04
> **Module** : `src/optimizer/` (22 fichiers)
> **Point d'entrée public** : `MultiSubOptimizer` (`src/multi-sub-optimizer.js`)

Cette documentation synthétise les enseignements acquis lors de plusieurs
sessions d'investigation et de correction du module d'optimisation multi-sub.
Elle est destinée aux développeurs qui interviendront sur cet algorithme lors
de futures investigations.

---

## Table des matières

1. [Architecture du module](#1-architecture-du-module)
2. [Principes audio fondamentaux](#2-principes-audio-fondamentaux)
3. [Le maximum théorique — choix critique](#3-le-maximum-théorique--choix-critique)
4. [Le scoring psychoacoustique](#4-le-scoring-psychoacoustique)
5. [Le flux d'optimisation](#5-le-flux-doptimisation)
6. [Le raffinement global (coordinate descent)](#6-le-raffinement-global-coordinate-descent)
7. [Le local search](#7-le-local-search)
8. [Comparaison avec MSO](#8-comparaison-avec-mso)
9. [Pièges et décisions de conception](#9-pièges-et-décisions-de-conception)
10. [Tests](#10-tests)
11. [Journal des corrections](#11-journal-des-corrections)
12. [Budget de délai — fenêtre de distances AVR](#12-budget-de-délai--fenêtre-de-distances-avr)

---

## 1. Architecture du module

```
src/optimizer/
├── multi-sub-optimizer.js   # Classe publique (constructeur, static API)
├── facade-methods.js        # Wrappers minces vers les modules focalisés
├── config.js                # DEFAULT_CONFIG, normalizeConfig, validateOptimizerConfig
├── params.js                # Génération de combinaisons, coarseDiversityKey
├── measurements.js          # Préparation des mesures (filtrage bande, grille)
├── response.js              # Calcul de réponse combinée, all-pass, getFinalSubSum
├── scoring.js               # Scorer : poids fréquentiels, efficiency, pénalités
├── evaluation.js            # evaluateParameters, calculateOptimizationScoreDetails
├── cache.js                 # Cache LRU + hash (WeakMap pour contextes de réponse)
├── coarse-search.js         # runClassicOptimization, findTopCoarseParams
├── genetic-algorithm.js     # GA : population, sélection, mutation, crossover
├── genetic-search.js        # runGeneticOptimization, runSingleGeneticRun
├── differential-evolution.js # DE/rand/1/bin : solveur générique (flux joint)
├── local-search.js          # Hill climbing multi-échelle avec quantification
├── sub-search.js            # optimizeSingleSub, chooseBestSolution (seuil all-pass)
├── flow.js                  # findOptimalParameters (orchestration séquentielle)
├── joint-flow.js            # Flux joint (target-match) : tous les subs ensemble
├── result.js                # refineOptimizedSubsGlobally, scoreOptimizedSubSum
├── report.js                # buildOptimizationReport, buildAllPassReport
├── report-metrics.js        # calculateReportMetrics, calculateImplementationCost
├── audio-selection.js       # Guardrails, sélection du meilleur candidat
└── output.js                # Logging, checkDelayBoundaries
```

### Pattern architectural

- **Facade** : `MultiSubOptimizer` étend `OptimizerFacadeMethods`. Toutes les
  méthodes publiques sont des wrappers minces qui délèguent aux modules
  focalisés. La logique métier ne vit pas dans la facade.
- **Modules focalisés** : chaque fichier a une responsabilité unique. Les
  modules ne se référencent pas directement entre eux ; ils sont appelés par
  la facade ou par `flow.js`.
- **Cache** : `createEvaluationCache()` crée un cache LRU avec `WeakMap` pour
  les contextes de réponse (évite les fuites mémoire).

---

## 2. Principes audio fondamentaux

### Somme cohérente des subs

La réponse combinée est une **somme vectorielle complexe** (pas une somme de
magnitudes) :

```
real(ƒ)      = Σ |H_i(ƒ)| · cos(φ_i(ƒ))
imaginary(ƒ) = Σ |H_i(ƒ)| · sin(φ_i(ƒ))
|H_combined(ƒ)| = √(real² + imaginary²)
```

où `|H_i(ƒ)|` est le gain linéaire (10^(dB/20)) et `φ_i(ƒ)` est la phase en
radians du sub _i_ à la fréquence _ƒ_.

**Fichier** : `response.js` → `calculateCombinedResponse()`

### Application des paramètres

Chaque sub reçoit 4 paramètres :

| Paramètre                  | Effet sur la phase         | Effet sur la magnitude |
| -------------------------- | -------------------------- | ---------------------- |
| **delay** (τ, en secondes) | +2π·ƒ·τ radians            | Aucun                  |
| **polarity** (±1)          | +π radians si -1           | Aucun                  |
| **gain** (dB)              | Aucun                      | × 10^(gain/20)         |
| **all-pass** (ƒ₀, Q)       | -2·atan2((ω₀·ω)/Q, ω₀²-ω²) | Aucun                  |

**Fichier** : `response.js` → `calculateResponseWithParams()`

### All-pass du second ordre

La formule de phase d'un biquad all-pass est :

```
φ(ω) = -2 · atan2((ω₀·ω)/Q, ω₀² - ω²)
```

où `ω₀ = 2π·ƒ₀` et `ω = 2π·ƒ`. La phase passe de 0 → -π (à ƒ₀) → -2π.

**Fichier** : `response.js` → `calculateAllPassResponse()`

---

## 3. Le maximum théorique — choix critique

### Définitions

| Type                     | Calcul                                         | Propriétés                                                                                                                                              |
| ------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Max absolu** (phase=0) | `calculateCombinedResponse(subs, true, false)` | Toutes les phases mises à 0 → somme cohérente des magnitudes. **Invariant temporellement** : ne change pas quand on applique des delays.                |
| **Minimum phase**        | `calculateCombinedResponse(subs, false, true)` | Phase recalculée via transformée de Hilbert (cepstre). Dépend du contenu spectral. **Change quand les magnitudes changent** (mais pas avec les delays). |

### Décision finale : max absolu (phase=0)

> **Le max absolu est la seule référence correcte pour le scoring.**

**Raisonnement** :

1. Le minimum phase représente le meilleur alignement de phase **sans
   delay**. Or l'optimiseur applique des delays. Quand un delay est appliqué,
   la phase réelle s'éloigne du minimum phase, et l'efficacité
   (actual/theoretical) baisse artificiellement.

2. Plus l'optimiseur utilise de delay, plus l'efficacité baisse — c'est
   contradictoire avec l'objectif d'optimisation. L'optimiseur est pénalisé
   pour utiliser l'outil même qu'il est censé exploiter.

3. Le max absolu (phase=0) est **invariant temporellement** : il ne change pas
   quand on applique des delays ou des inversions de polarité. L'efficacité
   par rapport au max absolu récompense l'alignement des phases sans pénaliser
   l'usage de delays.

**Implémentation** :

- `flow.js` : `globalTheoreticalMax = calculateCombinedResponse(preparedSubs, true, false)`
  pour le raffinement, le report et les métriques ; pendant la boucle
  séquentielle, un **theo d'étape** (`options.stepTheoreticalMax`, phase=0 des
  subs présents dans la somme partielle) sert de référence de scoring — voir §5.
- `sub-search.js` : utilise `options.stepTheoreticalMax` (passé depuis `flow.js`)
- `result.js` : utilise `globalTheoreticalMax` pour le raffinement et le garde-fou

### Historique (à éviter)

Le minimum phase (`false, true`) a été utilisé initialement. Il a causé une
baisse d'efficacité pendant l'optimisation (52.85% → 44.76% sur `data.test`
sans all-pass). Le passage au max absolu a corrigé ce problème.

---

## 4. Le scoring psychoacoustique

### Les trois objectifs

| Objectif              | Score                                                        | Usage                                                                 |
| --------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------- |
| `balanced`            | `qualityScore` (ci-dessous)                                  | Historique ; réponse « belle » en soi                                  |
| `max-theoretical`     | `quality×(1−w) + cappedEff×w`                                | Priorité au niveau ; sert aussi d'heuristique de placement (w=0.6)     |
| **`pre-eq`** (prod)   | `eff×2 − dipsVsTheo×3 − nulls×3 − excèsGD×2`                 | La somme sera égalisée ensuite vers la cible                           |

**`pre-eq`** est l'objectif de production (`createOptimizerConfig`) : la somme
des subs passe ensuite dans l'auto-EQ vers la courbe cible, donc l'optimiseur
maximise ce que l'EQ ne peut pas corriger et ignore ce qu'elle corrige
gratuitement :

- **Pas de pénalité peaks/smoothness** : un cut d'EQ est gratuit et, pour une
  résonance minimum-phase, réduit aussi la traîne temporelle.
- **`dipsVsTheo`** : creux *localisés* sous l'enveloppe théorique (écart à la
  médiane pondérée du shortfall, franchise 3 dB, pow 1.8). La part uniforme du
  shortfall est déjà comptée par l'efficiency.
- **Garde temporelle (`excèsGD`)** : group delay dérivé de la phase déroulée,
  facturé au-delà de 1 période d'excès vs la médiane de bande (rampe
  quadratique, cap 9/bin contre les artefacts de déroulage et le bord de bande
  10-16 Hz). Empêche de « payer en traînage » un gain de réponse en fréquence
  (all-pass notamment).
- Les médianes pondérées sont sous-échantillonnées (192 pts) : temps
  d'exécution identique à `balanced`.

> ⚠️ Un objectif dominé par l'efficiency (dont `pre-eq` et `max-theoretical`
> w≥0.9) **égare la phase séquentielle greedy en mode all-pass** (effondrement
> mesuré à ~66 % d'efficiency) : les pénalités de forme servaient de
> régularisateur au placement. C'est pourquoi la phase séquentielle score
> toujours avec l'heuristique w=0.6 (voir §5), quel que soit l'objectif
> `balanced`/`pre-eq` configuré — l'objectif configuré pilote le raffinement
> et la sélection.

### Formule du qualityScore (objectif `balanced`)

```
qualityScore = efficiency × 2
             - dipPenalty × 3
             - nullPenalty × 3
             - peakPenalty × 0.5
             - smoothnessPenalty
```

**Fichier** : `scoring.js` → `calculateQualityScore()`

### Poids des composantes

| Composante       | Poids  | Justification                                                                                                                                                                                                                            |
| ---------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Efficiency**   | **2×** | Proximité au max théorique. Poids doublé pour empêcher l'optimiseur de sacrifier le niveau global pour réduire les dips. Sans ce poids, l'efficacité baisse pendant l'optimisation (le delay réduit les dips mais crée des annulations). |
| **Dip penalty**  | 3×     | Les dips (annulations) ne sont pas corrigeables par EQ sans boost massif. Pénalité asymétrique : dips > pics.                                                                                                                            |
| **Null penalty** | 3×     | Les nulls étroits (annulations de phase ponctuelles) sont particulièrement problématiques. Détectés via largeur à mi-profondeur + facteur Q.                                                                                             |
| **Peak penalty** | 0.5×   | Les pics sont facilement corrigeables par EQ (cut). Pénalité faible.                                                                                                                                                                     |
| **Smoothness**   | 1×     | Pente spectrale > 12 dB/oct. Ramp quadratique avec cap par bin.                                                                                                                                                                          |

### Pourquoi efficiency × 2 ?

Sans all-pass ni gain, le delay est le seul outil pour corriger la phase. Le
delay agit linéairement avec la fréquence (2π·f·τ) : un delay qui corrige à
30Hz désaligne à 60Hz. L'optimiseur peut réduire les dips à certaines
fréquences mais créer des annulations à d'autres, baissant l'efficacité.

Avec `efficiency × 1`, l'optimiseur acceptait ce trade-off (perte de niveau
pour gain de smoothness). Avec `efficiency × 2`, l'optimiseur ne sacrifie plus
le niveau global.

### Pondération fréquentielle

Les poids fréquentiels (`computeFrequencyWeight`) suivent une courbe
psychoacoustique :

- Pic à 55 Hz (zone modale principale)
- Secondaire à 100 Hz (région de crossover)
- Rolloff < 25 Hz (sensibilité réduite)
- Rolloff > 150 Hz (moins critique pour les subs)

### Reference level

Le `referenceLevel` est calculé dans le domaine **linéaire de puissance**
(moyenne RMS pondérée), pas en dB. L moyennage en dB sous-pondère les pics et
biaise les pénalités dip/peak.

---

## 5. Le flux d'optimisation

### Vue d'ensemble

```
optimizeSubwoofers()
  │
  ├─ 1. Préparer les mesures (filtrage bande, validation grille)
  ├─ 2. Calculer globalTheoreticalMax (max absolu, phase=0)
  ├─ 3. Calculer baselineMetrics
  ├─ 4. Choisir la méthode : classic (< 1000 params) ou genetic (> 1000)
  │
  ├─ 5. BOUCLE SÉQUENTIELLE (pour chaque sub 1..N-1) :
  │   ├─ optimizeSingleSub(sub, previousValidSum, options)
  │   │   ├─ Calculer theo = options.stepTheoreticalMax
  │   │   ├─ runGeneticOptimization OU runClassicOptimization
  │   │   ├─ chooseBestSolution (seuil all-pass)
  │   │   └─ Retourner finalResponse
  │   ├─ previousValidSum = finalResponse
  │   └─ subToOptimize.param = finalResponse.param
  │
  ├─ 6. Calculer preRefinementMetrics
  ├─ 7. refineOptimizedSubsGlobally (si activé)
  ├─ 8. buildOptimizationReport
  └─ 9. Retourner { optimizedSubs, bestSum, optimizationReport, ... }
```

**Fichier** : `flow.js` → `findOptimalParameters()`

### Le sub de référence (sub 0)

Le sub 0 est l'**ancre temporelle** : tous les delays sont relatifs à lui.
Son `param` reste `EMPTY_CONFIG` (delay=0, gain=0, polarity=1, all-pass
désactivé). Optimiser son delay déplacerait l'ensemble sans changer les
alignements relatifs — le résultat acoustique serait identique.

**MSO fonctionne de la même manière** : le sub de référence reste fixe.

### Optimisation séquentielle (greedy)

Chaque sub est optimisé **un par un** contre la somme précédente
(`previousValidSum`). C'est une approche greedy qui peut conduire à des
minimums locaux : le sub 2 est optimisé pour le sub 1, mais quand le sub 3
est ajouté, les paramètres du sub 2 ne sont plus optimaux.

Le raffinement global (section 6) compense partiellement cette limitation.

### Theo d'étape (`stepTheoreticalMax`) et heuristique de placement

Pendant la boucle séquentielle, chaque étape est scorée contre le **max
théorique (phase=0) des subs réellement présents dans la somme partielle**
(référence + subs déjà optimisés + sub en cours). Comme le max global, il ne
dépend que des magnitudes — jamais des delays/polarités/all-pass appliqués —
donc il est **stable à l'intérieur d'une étape**. Contrairement au max global
des N subs, il garde le terme efficiency sur une échelle 0-100 % significative
pour les premiers subs : contre le max global, une somme partielle de 2 subs
sur 4 plafonne à ~50 % d'efficiency et les pénalités dip/null dominent le
score, orientant les premiers subs vers la smoothness au détriment du niveau
(mesuré : data.test passait de 55.4 % à 74.0 % d'efficiency finale avec ce
seul changement).

> **Piège (toujours valable)** : un `theo` per-sub **minimum phase**
> (`[sub + previousSum]`, `false, true`) crée une cible mouvante qui dépend
> des params appliqués et pénalise l'usage de delays. Le theo d'étape est
> phase=0, indépendant des params : il n'a pas ce défaut.

De plus, quand l'objectif configuré est `balanced`, la phase séquentielle
score avec une **heuristique de placement** `max-theoretical` (w=0.6,
`SEQUENTIAL_HEURISTIC_WEIGHT` dans `flow.js`) : le paysage `balanced` piège
la recherche greedy dans des optima locaux à faible efficacité que le
raffinement global (coordinate descent, mouvements gardés par l'objectif
réel) ne peut pas quitter. L'objectif configuré est restauré avant le
raffinement, et `bestSum` est rescoré sur l'échelle configurée. Mesuré :
data.bis avec all-pass 78.2 % → 85.6 % d'efficiency, avec un score `balanced`
final lui aussi supérieur (133.7 → 148.7). w=0.75 dégrade le score `balanced`
sur certains datasets ; w=0.9 est instable.

---

## 6. Le raffinement global (coordinate descent)

### Principe

Après l'optimisation séquentielle, le raffinement global re-optimise chaque
sub en coordinate descent : il optimise un sub à la fois en gardant les autres
fixes, puis passe au suivant. Plusieurs passes sont effectuées.

**Fichier** : `result.js` → `refineOptimizedSubsGlobally()`

### Configuration de production

La config posée par `createOptimizerConfig` (`src/services/sub-optimization.js`,
objectif `pre-eq`) active le raffinement global :

```javascript
globalRefinement: {
  enabled: true,
  passes: 4,        // 4 passes de coordinate descent
  maxIterations: 30, // 30 itérations de local search par sub par passe
}
```

Le `DEFAULT_CONFIG` du **module** (`src/optimizer/config.js`) est plus
conservateur — `objective: 'balanced'`, `globalRefinement: { enabled: false,
passes: 1, maxIterations: 20 }` : c'est la couche services qui l'ajuste pour la
production.

### Ordre de visite

- **Passe 0** : ordre naturel (1, 2, ..., N-1) pour le déterminisme
- **Passes suivantes** : ordre aléatoire (Fisher-Yates) pour éviter les
  minimums locaux liés à la séquence de visite

Le sub 0 (référence) n'est **jamais** raffiné.

### Garde-fou global

Chaque amélioration locale est validée contre le **score global** :

1. Le local search trouve un meilleur score (par rapport à
   `globalTheoreticalMax`)
2. On applique tentativement le nouveau paramètre
3. On calcule le score global (`scoreOptimizedSubSum`)
4. Si le score global ne s'améliore pas → **rejet** (revert)

Ce garde-fou est essentiel : sans lui, le coordinate descent peut diverger
quand une amélioration locale (un sub mieux aligné contre sa `otherSum`)
dégrade l'ensemble.

### `tryRefineSub`

La fonction `tryRefineSub` encapsule cette logique :

- Utilise `globalTheoreticalMax` comme référence pour le local search
- Vérifie le score global avant d'accepter
- Retourne `{ accepted: true, newGlobalScore }` ou `{ accepted: false }`

---

## 7. Le local search

### Principe

Hill climbing multi-échelle avec quantification sur grille. Teste des
perturbations dans 5 échelles décroissantes : `[4, 2, 1, 0.5, 0.25]` × step.

**Fichier** : `local-search.js` → `localSearch()`

### Perturbations testées

| Paramètre    | Perturbations               |
| ------------ | --------------------------- |
| delay        | ±delta                      |
| gain         | ±delta                      |
| **polarity** | flip (1 ↔ -1)               |
| allPassFreq  | ±delta (si all-pass activé) |
| allPassQ     | ±delta (si all-pass activé) |

> **Important** : la polarity est testée par le local search. Sans cela, une
> mauvaise polarity choisie par le coarse/GA ne pourrait jamais être corrigée
> par le raffinement. La polarity a l'impact le plus important sur la réponse
> combinée (rotation de 180°).

### Quantification

Les valeurs sont quantifiées sur la grille de step pour :

- Améliorer la réutilisation du cache
- Produire des valeurs DSP-réalisables

Aux échelles ≥ 1 : `quantum = step` (snap à la grille coarse).
Aux échelles < 1 : `quantum = step × multiplier` (pour ne pas effacer la
perturbation).

---

## 8. Comparaison avec MSO

### MSO (Multi-Sub Optimizer)

MSO optimise **tous les subs simultanément** en minimisant la variation de la
réponse combinée par rapport à une cible. Il utilise des gains variables et
des delays, avec une optimisation globale (Nelder-Mead ou similaire).

### Différences clés

| Aspect                | Cet optimiseur                           | MSO                              |
| --------------------- | ---------------------------------------- | -------------------------------- |
| **Stratégie**         | Séquentielle (greedy) + raffinement      | Simultanée (globale)             |
| **Gain**              | Fixé à 0                                 | Variable                         |
| **Sub de référence**  | Fixe (delay=0)                           | Fixe (delay=0)                   |
| **Maximum théorique** | Max absolu (phase=0)                     | Cible utilisateur                |
| **All-pass**          | Optionnel                                | Non disponible                   |
| **Scoring**           | Efficiency + pénalités psychoacoustiques | Variation par rapport à la cible |

### Pourquoi le gain reste à 0

L'efficacité est calculée comme `actual / theoretical` (en linéaire). Si on
autorise un gain positif, l'efficacité dépasse 100% sans amélioration
acoustique réelle — l'optimiseur "triche" en boostant le niveau au lieu
d'améliorer l'alignement. MSO utilise aussi des gains à 0 pour les mêmes
raisons.

### Limitation structurelle

L'approche séquentielle ne peut pas égaler MSO sur l'optimisation simultanée.
Le raffinement global compense partiellement, mais une refonte vers une
optimisation simultanée serait nécessaire pour égaler MSO.

---

## 9. Pièges et décisions de conception

### ⚠️ Ne pas utiliser le minimum phase comme max théorique

Le minimum phase représente le meilleur alignement **sans delay**. Comme
l'optimiseur applique des delays, le minimum phase est une cible mouvante qui
pénalise l'usage de delays. **Toujours utiliser le max absolu (phase=0).**

### ⚠️ Ne pas optimiser le sub de référence

Le sub 0 est l'ancre temporelle. Optimiser son delay déplace l'ensemble sans
changer les alignements relatifs. Le résultat acoustique est identique, mais
les delays absolus changent (confus pour l'utilisateur).

### ⚠️ Ne pas autoriser le gain variable

Le gain positif fait dépasser l'efficacité à 100% artificiellement. Le gain
doit rester à 0.

### ⚠️ Ne pas calculer de theo per-sub en minimum phase

Un `theo` minimum phase calculé comme `[sub + previousSum]` change avec les
params appliqués (cible mouvante qui pénalise les delays). Le **theo d'étape
phase=0** (`stepTheoreticalMax`, subs de la somme partielle) est la référence
correcte pour la phase séquentielle ; le `globalTheoreticalMax` (phase=0, N
subs) reste la référence du raffinement, du report et des métriques.

### ⚠️ Le garde-fou global du raffinement est obligatoire

Sans le garde-fou (`scoreOptimizedSubSum`), le coordinate descent peut
diverger : une amélioration locale (un sub mieux aligné contre sa `otherSum`)
peut dégrader l'ensemble.

### ⚠️ La polarity doit être testée par le local search

Sans le flip de polarity dans `buildLocalSearchPerturbations`, une mauvaise
polarity choisie par le coarse/GA ne peut jamais être corrigée par le
raffinement.

### ⚠️ Le cache LRU utilise une `WeakMap` pour les contextes

La `WeakMap` (`responseContexts`) permet de hasher les réponses sans fuite
mémoire. Ne pas remplacer par une `Map` ordinaire.

### ⚠️ `getFinalSubSum` doit utiliser `preparedSubs`

Utiliser `subMeasurements` (non filtré) inclut des fréquences hors-bande et
produit un score incohérent avec l'optimisation. Toujours utiliser
`preparedSubs` (filtré sur la bande d'optimisation).

### ⚠️ Le report cappe l'efficiencyRatio à 100%

`calculateReportMetrics` cappe l'efficiencyRatio à [0, 100] pour le report
public. `calculateEfficiencyRatio` (scoring) reste non cappé pour préserver
la valeur brute utilisée par le scoring.

---

## 10. Tests

### Commandes

```bash
# Tests d'intégration (15 tests : 9 synthétiques + 6 mesures réelles)
npm run test:multi-sub-optimizer-all

# Tests unitaires (56 tests)
npx vitest run test/unit/scorer.test.js \
  test/unit/multi-sub-optimizer-general.test.js \
  test/unit/audio-selection.test.js \
  test/unit/genetic-algorithm.test.js
```

### Fixtures de mesures réelles

| Fixture            | Subs | Bande     | Smoothing | Scénario                          |
| ------------------ | ---- | --------- | --------- | --------------------------------- |
| `data.test.js`     | 4    | 10–305 Hz | None      | Configuration multi-sub typique   |
| `data.bug.test.js` | 4    | 12–269 Hz | 1/48      | Cas de régression (bug précédent) |
| `data.bis.test.js` | 4    | 11–244 Hz | None      | Configuration alternative         |

Chaque fixture est testée **avec et sans all-pass** (6 tests au total).

### Tests synthétiques

| Test                         | Ce qu'il valide                                                         |
| ---------------------------- | ----------------------------------------------------------------------- |
| `testBasicOptimization`      | L'optimisation améliore le score + delay non-trivial                    |
| `testGeneticVsClassic`       | GA atteint ≥ 98% du score classic                                       |
| `testCacheEffectiveness`     | Hit rate > 5%                                                           |
| `testDeterministicResults`   | Seed → résultats reproductibles (3 runs)                                |
| `testPhaseAlignmentScenario` | Détection d'annulation de phase (polarity inversée) + delay proche de 0 |
| `testLocalSearchImprovement` | Hill climbing améliore ou maintient le score                            |
| `testGlobalRefinement`       | Le raffinement ne dégrade pas la qualité                                |
| `testOptimizationReport`     | Structure du report, efficiency ≤ 100%, guardrails                      |
| `testErrorCases`             | 8 cas d'erreur (sub unique, config invalide, etc.)                      |

### Données synthétiques seedées

`generateSyntheticSubMeasurement` utilise un PRNG mulberry32 seedé
(constante `20260704`) pour la reproductibilité. Ne pas remplacer par
`Math.random()`.

### `runClassicComparison`

Le test de comparaison classic calcule un **score global**
(`calculateOptimizationScore(previousSum2, globalTheo2)`) pour une comparaison
équitable avec `result.bestSum.score` (aussi un score global). Ne pas
comparer des scores per-sub avec des scores globaux.

---

## 11. Journal des corrections

### Session 1 — Revue de code (bugs)

1. **`getFinalSubSum`** (`response.js`) : utilisait `subMeasurements` (non
   filtré) → corrigé pour utiliser `preparedSubs` (bande filtrée).
2. **`calculateReportMetrics`** (`report-metrics.js`) : `efficiencyRatio`
   pouvait dépasser 100% → cappé à [0, 100] dans le report.
3. **Message d'erreur** (`sub-search.js`) : "coarseParams" → "testParamsList".
4. **Documentation** (`result.js`, `sub-search.js`) : inconsistances du
   `theoreticalMax` documentées.

### Session 2 — Amélioration des tests

1. Seed du générateur synthétique (mulberry32).
2. Correction de `testDeterministicResults` (seed avant l'optimisation).
3. Assertions sur les paramètres physiques (delay, polarity).
4. Ajout de `testGlobalRefinement`, `testOptimizationReport`, `testErrorCases`.
5. Tolérance GA vs Classic : 95% → 98%.
6. Clone de `optimizerConfig` pour éviter les mutations.
7. Remplacement de `process.exit(1)` par `throw new Error()`.

### Session 3 — Écart de performance vs MSO

**Corrigé puis reverté** (sur validation utilisateur) :

- Optimisation du sub 0 → reverté (le sub de référence reste fixe)
- Gain variable → reverté (gain reste à 0)
- Poids efficiency 1.5× → reverté puis réajusté à 2×

**Corrigé et conservé** :

- Polarity dans le local search (`buildLocalSearchPerturbations`)
- Passes de raffinement 4×30 (au lieu de 2×20)
- Garde-fou global du raffinement (`tryRefineSub`)

### Session 4 — Maximum théorique et scoring

1. **Max absolu (phase=0)** remplaçant le minimum phase comme `theoreticalMax`
   dans `flow.js`, `sub-search.js`, `result.js`.
2. **`globalTheoreticalMax` partagé** via `options` au lieu d'un `theo`
   per-sub qui changeait à chaque étape.
3. **Poids efficiency × 2** dans `scoring.js` pour empêcher l'optimiseur de
   sacrifier le niveau pour la smoothness.
4. **Garde-fou du raffinement** utilisant `globalTheoreticalMax` pour le
   local search et le score global.
5. **`runClassicComparison`** corrigé pour comparer des scores globaux.

### Session 5 — Theo d'étape et heuristique de placement (2026-07-11)

1. **Theo d'étape** (`stepTheoreticalMax`) : la phase séquentielle score
   contre le max phase=0 des subs de la somme partielle au lieu du max global
   des N subs (qui écrasait le terme efficiency des premiers subs).
2. **Heuristique de placement** : phase séquentielle scorée en
   `max-theoretical` w=0.6 quand l'objectif est `balanced` ; objectif restauré
   avant le raffinement, `bestSum` rescoré sur l'échelle configurée.
3. **Écarté après mesure (aucun gain)** : doubler le budget de raffinement
   (4×30 → 8×60) ; grossir le GA en mode all-pass (pop 70, gen 48,
   stepFactor 5 : +60-150 % de temps pour ±0.03 pt) ; Qmax all-pass 2.0
   (gains faibles, temps ×1.6-1.9) ; w=0.75 (dégrade data.bug) ; w=0.9
   (instable).

### Session 6 — Objectif pre-eq et garde temporelle (2026-07-11)

1. **Mesure préalable** : les solutions optimisées ne traînent pas plus que la
   baseline (excès moyen de group delay en baisse partout) — l'efficiency et
   la compacité temporelle sont alliées (le max phase=0 est la version la plus
   compacte de la somme).
2. **Objectif `pre-eq`** (voir §4) adopté par la prod : efficiency + creux
   non-corrigeables + garde de group delay ; peaks/smoothness laissés à l'EQ
   aval. Mesuré vs `balanced` : efficiency égale ou supérieure partout
   (AP : +1.3 à +1.6 pt), data.bug AP passe de 54.8 % à 46.8 % de bins au-delà
   d'1 cycle d'excès de GD, temps identiques.
3. **Piège découvert** : `pre-eq` appliqué à la phase séquentielle s'effondre
   en mode all-pass (~66 %) — l'heuristique de placement w=0.6 est conservée
   pour tous les objectifs.

### Session 7 — Process joint target-match (Lots 0-2, 2026-07-11)

Refonte MSO-like validée par prototype puis implémentée dans le moteur : un
process unique optimise **simultanément** delay/polarité/gain **et des
biquads peaking par sub** contre la **courbe cible** (le matériel supporte
les filtres par sub ; l'EQ commune recopiée ne peut pas modifier la
structure d'interférence).

- **Lot 0 (go/no-go, scratchpad)** : DE joint + 3 biquads/sub vs chaîne
  actuelle, même EQ commune finale — RMS vs cible 3.32→1.23 / 2.17→0.98 /
  2.27→0.84 dB. La valeur vient des filtres par sub (le DE joint sans
  filtres ≈ chaîne actuelle).
- **Lot 1** : `param.filters` (peaking, via `src/dsp`) dans le contrat +
  `calculateResponseWithParams` ; objectif `target-match` (écart asymétrique
  ×4 sous-cible + garde GD, base 100, `optimization.targetCurve`
  rééchantillonnée log-f) ; régularisateur d'effort (|gain|, boost ×2).
- **Lot 2** : `optimizeSubwoofersJoint()` — DE/rand/1/bin générique
  (`differential-evolution.js`, async, onProgress, annulation coopérative),
  flow deux phases (`joint-flow.js`) : alignement seul puis espace complet
  seedé par le vainqueur. Coût partagé avec le chemin d'évaluation standard.
  Tables trig par grille (WeakMap) + `getComplexResponseWithTrig` (dsp).
  Banc fixtures : RMS 2.93/1.65/1.81 dB en 120/65/94 s (gardes actives).
- **Pièges notés** : pas de raffinement legacy dans le flow joint (le
  `config.gain` prod {0,0} clamperait les gains DE) ; une cible plate
  au-delà de la bande utile fait garer des boosts en bord de bande (la cible
  produit doit refléter le rolloff) ; les scores de phase incluent les
  pénalités delay/effort, `final.score` non.

- **Lot 3 (intégration produit)** : le bouton Align Sub route vers le
  solveur joint quand le toggle « Optimisation jointe » est coché
  (`useJointSubOptimization`). Préambule partagé avec le chemin legacy
  (`prepareMultiSubOptimization`). Cible = `target-response` REW du premier
  sub après `setTargetLevel(mainTargetLevel)` (même ancrage
  qu'equalize-sub). Filtres PK par sub écrits en slots 1..N **non-auto**
  (survivent aux écritures `overwrite=false`, convention du slot 20
  all-pass) ; le sub de référence fait partie du résultat (il porte ses
  filtres). Budget surchargeable via `config.jointOptimizerBudget` (hook
  test/e2e). Progression : callback UI (phase + %) + logs. Parcours e2e
  `sub-align-joint` (27 au total).

- **Corrections post-test sur REW réel** : le champ de gain des filtres REW
  est **`gaindB`** (une clé `gain` est ignorée silencieusement → filtres à
  0 dB) ; le Theo projeté est la somme phase=0 des réponses **brutes**
  (subs propres, avant gains/filtres) passée via `refresh({theoResponse})` —
  invariante aux réglages appliqués ; la purge filtres/inversions se fait en
  tête de préambule (avant la mesure des réserves d'alignement) ;
  `joint.gain` vaut {0,0} par défaut (le trim SPL n'est pas réinitialisable
  au run suivant et déplace le Theo) ; les projections d'impulsions sont
  centrées et importées avec un `startTime` négatif (temps physiques
  préservés, contenu pré-t=0 conservé — sinon REW tronque la partie
  acausale).

- **Anti-boost (constat utilisateur : « l'algo booste les modes au lieu
  d'utiliser les autres subs »)** : tarification superlinéaire des boosts
  (rampe quadratique au-delà de 2 dB) + cap souple sur le boost cumulé par
  sub (`joint.overallBoostCapDb`, câblé sur `maxBoostOverallValue` de l'app ;
  `maxBoostIndividualValue` borne chaque filtre) + **phase 3 « realign »**
  (alignement re-optimisé avec les filtres gelés au vainqueur). Résultat :
  solutions dominées par des cuts aux fréquences modales, boosts résiduels
  ≤ cap, et sur data.test un RMS meilleur (2.93 → 2.67 dB) avec des délais
  courts et des polarités normales.

- **Cible plafonnée au max théorique** (constat utilisateur : la cible,
  calibrée pour la somme, est trop haute pour un sub seul) : là où peu de
  subs portent le signal, la cible est structurellement inatteignable et
  l'asymétrie sous-cible aspirait du boost sans fin — la cible effective est
  écrêtée bin par bin au plafond (somme cohérente des magnitudes brutes,
  `clampTargetToTheoreticalCeiling`). ⚠️ Piège DE découvert dans la foulée :
  quand l'alignement seul approche l'optimum, une population initiale
  aléatoire fait décrocher DE/rand/1 (les gènes de filtres parasites des
  membres aléatoires masquent les petits raffinements — zéro amélioration en
  400×80 essais). La moitié de la population de phase 2 démarre en
  perturbations focalisées (±5 % des bornes) du vainqueur. Banc : RMS 1.58 /
  1.63 / 1.78 dB, realign +1.2 à +3.6 points.

- **Base saine et gains en atténuation seule** : le préambule re-normalise
  les niveaux des subs à la référence align-SPL (`adjustSubwooferSPLLevels`,
  cible@40 Hz − 20·log₁₀(N)) en plus des filtres/inversions/délais — les
  vestiges du run précédent sont effacés par reconstruction, pas par
  soustraction. Ceci rend la dimension gain réactivable sans comptabilité :
  `joint.gain` [−12, 0] (atténuation seule — un trim positif tricherait
  au-dessus du plafond théorique du clamp), coût d'effort 0.05 pt/dB. Banc :
  RMS 1.44/1.76/1.48 dB, trims parcimonieux (−0.3 à −2 dB). Pas de type
  « Gain » dans l'égaliseur REW Generic (testé sur REW réel : 400) — le trim
  passe par les offsets SPL.

- **All-pass par sub dans le génome (expérimental, 2026-07-12)** :
  `joint.allPassPerSub` ajoute `[enable, log₁₀ fc, log₁₀ Q]` au bloc
  alignement de chaque sub non-référence (fc [10, 120] Hz, Q [0.2, 2],
  activation si `enable > 0` — le génome neutre reste sans all-pass, un
  all-pass n'étant jamais neutre en bande). Coût d'activation fixe 0.1 pt
  (gé par le flag joint — scoring GA legacy intact) ; le coût temporel réel
  est la garde de GD. Seul levier qui tourne la phase LOCALEMENT sans
  toucher la magnitude : un cut mute le contributeur destructif, l'all-pass
  peut le recruter. **Banc (3 seeds, budget prod, RMS médian vs cible
  atteignable)** : data.bug 1.541 → **1.166 dB** (gain net, les 3 seeds) ;
  data.bis 1.595 → 1.543 (neutre) ; data.test 1.472 → 1.592 (légère
  régression — la phase alignement est MEILLEURE avec AP, mais la phase
  filtres converge moins bien dans l'espace élargi, 45 vs 36 dims sur
  4 subs). Verdict : utile quand la structure d'interférence résiduelle
  résiste au trio delay/polarité/cuts (data.bug), coût de recherche sinon —
  **désactivé par défaut** côté moteur, exposé dans l'app par le checkbox
  all-pass (ré-activé en mode joint : il pilote `joint.allPassPerSub`, la
  recherche all-pass du GA legacy restant off sur ce chemin). L'all-pass
  trouvé est appliqué au slot 20 non-auto (convention historique, couverte
  par la réservation de l'EQ partagée).

Reste : Lot 4 (objectif multi-positions).

### Session 8 — Accélération du solveur joint (2026-07-15)

Le run joint de production durait ~120 s de calcul pur (JS mono-thread,
94 % du temps du bouton) sur une machine rapide — plusieurs minutes sur
laptop. Chantier en 7 commits, mesuré sur un banc dédié :

- **Banc** : `npm run bench:joint` (`test/bench/joint-solver.bench.js`) —
  runner Node autonome sur les 3 fixtures réelles, seed fixe, cible plate
  ancrée au plafond théorique pondéré. `--json` produit une empreinte
  déterministe (scores, générations, params sérialisés — timings exclus) ;
  `--compare <ref> --mode strict|quality` pour les non-régressions ;
  `--seed` pour les études de variance. `timeMs` par phase ajouté au
  rapport (`optimizationReport.phases`).
- **Early-stop utile** (`patienceEpsilon`, watermark) : la patience du DE
  n'est réarmée que si l'amélioration **cumulée** depuis le dernier
  réarmement dépasse 1e-4 point. ⚠️ Deux pièges mesurés : (a) un epsilon
  par amélioration *unitaire* coupe du vrai travail — la progression DE est
  un flux de gains individuellement sous-epsilon qui s'accumulent (−2,3
  points mesurés sur data.bug avec la première variante, rejetée) ; (b) tout
  early-stop change `phase1.best` de quelques ULP → la phase 2 diverge
  chaotiquement → **la qualité d'un levier à trajectoire modifiée ne se juge
  qu'en multi-seeds** (la variance seed-à-seed du solveur est de ±0,2-0,4 dB
  de targetRms, bien au-dessus de tout seuil mono-seed raisonnable).
  Critère adopté : Δ targetRms moyen sur ≥ 9 cellules (3 seeds × 3 fixtures)
  ≤ +0,05 dB et aucune fixture dégradée sur tous les seeds. Yield
  `setTimeout(0)` gaté sur 50 ms écoulées ; `shouldCancel` câblé depuis le
  service.
- **Biquad sans allocation** (bit-strict) : `normalizeBiquadCoefficients`
  (divisions par a0 hoistées hors de la boucle par bin) +
  `getComplexResponseFromNormalizedInto` (écrit dans un objet fourni — la
  variante historique allouait un objet par filtre × bin × candidat) ;
  table trig par grille en struct-of-arrays.
- **Évaluateur fusionné lin/rad** (`joint-evaluator.js`) — le plus gros
  levier (~22 % du run partait en conversions dB↔linéaire pures, profil
  `--cpu-prof`) : contexte créé une fois par run (invariants de mesure
  précalculés : magnitude linéaire, phase radians, 2π·f ; buffers
  réutilisés), somme vectorielle complexe en une passe sans jamais
  matérialiser les réponses par sub en dB/degrés ; `decodeGenomeInto`
  (décodage en place). Le chemin classique reste la référence : baseline,
  `bestSum` final, rapports et tous ses autres consommateurs. Écart
  numérique : la quantification Float32 dB intermédiaire disparaît →
  trajectoires DE différentes à seed égal, qualité validée multi-seeds.
- **Scoring sans allocation** (bit-strict) : somme des poids précalculée au
  constructeur du Scorer (même ordre d'accumulation), scratch pour le
  group delay et les indices de la médiane pondérée (l'accumulation de la
  médiane reste dans l'ordre trié — ordre de sommation flottante).
- **Realign gelé** (bit-strict) : en phase 3 les dimensions filtres sont
  bornées au vainqueur → contribution de chaque filtre précalculée par bin
  et appliquée dans l'ordre de la cascade ; plus aucun biquad évalué.
- **Budgets d'alignement** : `joint.alignmentPopulationSize: 40` et
  `joint.alignmentPatience: 200` pour les phases 1/3 (9 dims libres sur
  4 subs vs 45 au total), appliqués en `min()` avec le budget principal
  (un budget de test réduit n'est jamais gonflé).
- **Grille décimée locale au solveur** : `joint.solverGridStride: 2`
  (~96 → 48 ppo pour la fonction de coût seulement) — subs, cible et poids
  décimés par les mêmes indices, scorer dédié ; baseline/bestSum/rapport/
  targetRms restent pleine grille (métriques commensurables, et un null
  étroit invisible de la grille décimée y serait détecté).

**Résultats** (budget prod, seed 42, targetRms pleine grille) :
data.test 151,8 → 32,7 s, data.bug 82,6 → 18,9 s, data.bis 118,2 → 26,8 s
(**−77 à −78 %**) ; qualité multi-seeds : Δ targetRms moyen **−0,152 dB**
(amélioration), aucune dégradation systématique. Le parcours e2e
`sub-align-joint` a été re-seedé (2 → 3, le génome neutre gagnait sur les
subs jouets après changement de trajectoire — comportement documenté du
seed).

**Non fait (décision ultérieure)** : Web Workers — imposerait un DE
générationnel (le steady-state actuel remplace `population[i]`
immédiatement), un fallback synchrone Node et un re-seed e2e ; à
réévaluer seulement si le temps laptop reste insuffisant.

### Résultats finaux (efficiency ratio)

| Fixture       | Baseline | Final (sans all-pass) | Final (avec all-pass) |
| ------------- | -------- | --------------------- | --------------------- |
| data.test     | 48.36%   | **79.35%** (+31)      | **80.64%** (+32)      |
| data.bug.test | 56.55%   | **69.62%** (+13)      | **73.56%** (+17)      |
| data.bis.test | 48.90%   | **78.78%** (+30)      | **85.56%** (+37)      |

L'efficacité **augmente** pendant l'optimisation sur tous les datasets.
Temps : 542/913/214/266/457/710 ms (budgets 1200/2500 ms).

## 12. Budget de délai — fenêtre de distances AVR

Le paramètre `delay {min, max}` de la configuration (construit par
`createOptimizerConfig`, `src/services/sub-optimization.js`) n'est pas
symétrique : il modélise la **fenêtre de distances de l'AVR** — chaque canal
doit rester entre le canal le plus proche (l'« ancre ») et l'ancre + 6 m
(7,35 m avec le hack). Les délais relatifs cherchés ici consomment le même
budget que l'**alignement de groupe** sub ↔ enceinte frontale qui suit
(`produceAligned`) :

- **Borne négative** = marge d'ancre : un sub avancé ne doit pas descendre
  sous le canal le plus proche, sinon l'ancre glisse et tous les canaux
  perdent de la marge. Calculée en `cumulativeIRShiftSeconds` purs (le shift
  global s'annule dans la différence).
- **Borne positive** = headroom (`distanceLeftBeforeError`) **moins la réserve
  d'alignement**. Source préférée : l'écart **mesuré comme `produceAligned` le
  mesurera** — la projection `LFE predicted` (délais égalisés, filtres purgés)
  contre chaque frontale LCR, les deux versions prédites **filtrées au
  crossover** (`alignmentGapSeconds`, BusinessTools) : le retard de groupe des
  filtres est donc inclus. Repli : l'écart de pics d'impulsion bruts (sub de
  référence vs frontales), approximation biaisée de ce retard de groupe.
  Pire cas parmi les LCR, signé : un groupe **en retard** (cas typique : le
  signal des subs est traité avec un délai, on doit les déclarer plus loin)
  réserve le côté positif ; un groupe **en avance** réserve le côté ancre.
  La réserve reste une valeur de planification : `produceAligned` fait seul le
  calcul précis des délais, et garde son clamp vivant sur la marge restante en
  dernier recours.

Sans les providers de listes (`uniqueMeasurements`,
`frontSpeakersMeasurements`), les bornes restent symétriques à ±headroom
(surface de test historique). Si les deux bornes tombent à 0, l'optimizer ne
cherche que polarité/all-pass (warning loggé).
