# AutoEQ — Pipeline et contrat de configuration

> **Module** : `src/autoeq/` + `src/optimization/`
> **Point d'entrée public** : `AutoEQCalculator` (`src/autoeq/AutoEQCalculator.js`)
> **Construction depuis l'UI** : `createPhaseMatchCalculator`
> (`src/autoeq/phase-match-calculator.js`)
> **Mise à jour** : 2026-07-14

Documentation technique du calculateur AutoEQ (mode RCH) : ordre des phases,
sémantique réelle de chaque paramètre, et rapport de run. Destinée aux
développeurs qui interviennent sur le moteur ou sur le panneau de réglages.

Principe directeur : **l'égaliseur est un outil**. Le moteur est un contrat
entrées → filtres piloté par des paramètres explicites ; le workflow, la
persistance et l'activation appartiennent aux services et à l'UI.

---

## Table des matières

1. [Le pipeline, phase par phase](#1-le-pipeline-phase-par-phase)
2. [Contrat de configuration](#2-contrat-de-configuration)
3. [Sémantique des mécanismes clés](#3-sémantique-des-mécanismes-clés)
4. [Rapport de run et verdicts](#4-rapport-de-run-et-verdicts)
5. [Pièges et points d'attention](#5-pièges-et-points-dattention)
6. [Tests](#6-tests)

---

## 1. Le pipeline, phase par phase

`AutoEQCalculator.calculate()` enchaîne les étapes suivantes.

| # | Étape | Module |
| --- | --- | --- |
| 0 | **Préparation de la grille** : découpe sur `[matchRangeStart, matchRangeEnd]`, rééchantillonnage de la cible sur la grille mesurée (plus proche voisin), estimation du PPO | `GridCalculationContext.fromResponses` |
| 1 | **Métriques initiales** : `SpanAnalyzer` (spans hors notches à t=0), `FastMSE` → `initialMSE` | `initialMetrics.js` |
| 2 | **Phase 1 — placement itératif** : boucle sur `numFilters` slots (résiduel → recherche de span → filtre candidat → `optimizeGainAndQ`), puis `ensureHFCoverage` | `placementPipeline.js`, `hfCoverage.js` |
| 3 | **Phases 2 & 4 — nettoyage + réoptimisation** : boucle `numOptimizationPasses`, élagage des filtres contre-productifs, réduction des overshoots | `finalOptimizationStages.js` |
| 4 | **Challenger de placement** (si `enableCandidatePlacement`) : rejoue les étapes 2+3 en mode multi-candidats, remplace si meilleur | `candidatePlacementChallenger.js` |
| 4b | **Challenger modal** (si `enableModalSeeding`) : rejoue le placement avec les seeds LPC (voir §3.7), remplace si meilleur | `candidatePlacementChallenger.js`, `math/modalAnalyzer.js` |
| 5 | **Phase 6 — Beat REW** (si `enableBeatRewOptimization`) : reduce/repair → raffinement par bandes → régularisation | `beatRewEnhancements.js` |
| 6 | **Raffinement final** (si `enableRefinement`) : `optimizeAllParameters` sur grille pleine, `refinementIterations` itérations | `AutoEQCalculator.js` |
| 7 | **Nettoyage final** : `removeFinalDeadFilters` (plancher fixe 0.1 dB) | `filterCleanup.js` |
| 8 | **Résultat** : `finalMSE`, évaluation qualité, `buildRunReport`, écriture dans le `FilterSet` | `runReport.js`, `resultSummary.js` |

Toutes les optimisations sauf l'étape 6 travaillent sur une **grille décimée**
(deux fois moins de points). Chaque appel d'optimisation n'applique son résultat
que si le MSE s'améliore (`FilterParameterOptimizer._runOptimize`) — la garde est
interne à l'optimiseur, pas propre au raffinement.

---

## 2. Contrat de configuration

Validation : `createAutoEQConfig` (`src/autoeq/AutoEQConfig.js`). `validateNumber`
**lève une `RangeError`** hors plage — il ne clampe pas.

### Paramètres exposés à l'utilisateur

| Paramètre | Plage | Défaut moteur | Défaut UI | Rôle |
| --- | --- | ---: | ---: | --- |
| `numFilters` | 1-30 | 20 | 20 | Nombre de slots de placement |
| `maxCutDb` | 0-30 | 25 | 25 | Atténuation maximale par filtre |
| `flatnessTarget` | 0.1-6 | 1 | 0.3 | Seuil de significativité (voir §3.1) |
| `numOptimizationPasses` | 1-20 | 10 | 20 | Passes de la boucle nettoyage + réoptimisation |
| `gainSignLockThreshold` | 0.1-2 | 0.5 | 0.5 | \|gain\| au-delà duquel le signe est verrouillé |
| `notchExclusionThreshold` | 2-15 | 6 | 6 | Profondeur sous la cible qui déclare un notch |
| `minFilterGain` | 0.1-2 | 0.4 | 0.4 | Seuil d'écriture des filtres (**hors moteur**, voir §5.2) |
| `refinementIterations` | 10-500 | 100 | 100 | Itérations du raffinement final |
| `maxBoostFreq` | 0-500 | 0 | 50 | Zone cut-only sous cette fréquence (FR-032) |
| `overshootPenaltyWeight` | 0-10 | 0.3 | 0.3 | Poids de la pénalité douce d'overshoot |
| `maxAllowedOvershoot` | 0.1-6 | 1.5 | 1.5 | Seuil de la réduction post-hoc + seuil WARN |
| `lowBandMaxQ` | 0-8 | 0 (off) | 0 (off) | Plafond de Q sous 200 Hz |
| `highBandMaxQ` | 0-8 | 0 (off) | 0 (off) | Plafond de Q dans la bande haute |
| `highBandStartFreq` | 200-20000 | 3000 | 3000 | Début de la bande haute (UI plafonnée à 16000) |
| `enableBeatRewOptimization` | booléen | false | false | Verrou maître de la phase 6 (voir §5.1) |
| `enableCandidatePlacement` | booléen | false | true | Challenger multi-candidats |
| `enableModalSeeding` | booléen | false | false | Challenger modal LPC (voir §3.7) |
| `enableReduceRepair` | booléen | true | true | Reduce/repair — **gated par Beat REW** |
| `enableCriticalBandRefinement` | booléen | true | true | Raffinement par bandes — **gated par Beat REW** |
| `enableRefinement` | booléen | false | false | Passe finale sur grille pleine |
| `varyQAbove200Hz` | booléen | false | false | REW `varyqabovemodal` |
| `allowNarrowFiltersBelow200Hz` | booléen | true | true | REW `usemodaleq` |
| `allowBoosts` | booléen | true | true | Filtre les spans sous la cible (voir §5.3) |

Les bornes de gain et la plage de fréquence viennent d'ailleurs :
`individualMaxBoostDb` / `overallMaxBoostDb` (0-30 moteur, **bridés 0-6 dans
l'UI**, défauts UI 6 et 3) et `matchRangeStart` / `matchRangeEnd` (le curseur de
plage de l'UI, 20 Hz-16 kHz par défaut).

Les défauts UI vivent dans `DEFAULT_AUTOEQ_CONFIG` (`src/MeasurementViewModel.js`)
et sont la seule chose que l'utilisateur voit : l'UI envoie toujours une valeur
explicite. Les défauts moteur ne s'appliquent qu'aux appels hors UI et aux
configs anciennes (`phase-match-calculator.js` passe `undefined` pour les clés
absentes, via `optionalNum`).

### Paramètres moteur non exposés

`placementCandidateCount` (3), `placementCandidateIterations` (60),
`placementCandidatePriorityRatio` (0.6), `challengerOptimizationIterations` (220),
`reduceRepairPasses` (2), `reduceRepairCandidateLimit` (7),
`reduceRepairOptimizationLimit` (2), `criticalBandStart`/`criticalBandEnd`
(≈40/3000), `maxFullRmsRegression` (0.03), `maxMidRmsRegression` (0.02),
`maxOvershootRegression` (0.2), `qRiskPenaltyWeight` (0.08),
`filterCountPenalty` (0.025), `equalizerFreqStep`/`GainStep`/`QStep`.

---

## 3. Sémantique des mécanismes clés

### 3.1 `flatnessTarget` n'est pas un seuil d'arrêt

C'est un seuil de **significativité**, consommé à trois endroits :

- **suivi des notches** : un creux n'est prolongé que s'il descend sous
  `-flatnessTarget` (`SpanAnalyzer._shouldTrackNotchValue`) ;
- **spans candidats** : `SpanCandidateFinder._isSpanSignificant` —
  `peakVal > 2 × flatness && |sumDelta| > 10`, ou
  `|peak| > flatness && ratio > 1.08 && |sumDelta| > 10` ;
- **purge des filtres faibles** : le seuil de `removeWeakFilters` vaut
  `max(equalizerGainStep ?? 0.5, flatnessTarget × 0.5)`.

L'effet « arrêt » est indirect : quand plus aucun span ne passe, le placement
s'interrompt et les slots restants ne sont jamais créés.

### 3.2 Notches et spans

Une zone est déclarée **notch** si le résiduel corrigé y descend à plus de
`notchExclusionThreshold` dB **sous la cible** (`_pushNotchIfDeepEnough`). Les
notches sont exclus du MSE : les spans traités sont leur complément. C'est ce qui
empêche le moteur de gaspiller du boost dans des annulations acoustiques.

### 3.3 Bornes de Q

`getOptimizedQBounds` (`src/optimization/filterParameterBounds.js`) reproduit les
lois REW pilotées par deux préférences, puis applique les plafonds utilisateur :

```
!usemodaleq            → cuts [1, min(maxQ, 5)]
usemodaleq, fc ≥ 200   → hi = varyqabovemodal ? 3+7·(1−log(fc/200)/log(50)) : 5
usemodaleq, fc < 200   → hi = min(maxQ, fc/2) ; lo = min(2, hi−0.1)   (cuts modaux)
boost (toujours)       → hi = min(maxQ, varyqabovemodal ? 3+4.5·loi log : min(fc/6.22, 7.5))
puis (opt-in)          → hi = min(hi, fc < 200 ? lowBandMaxQ : fc ≥ highBandStartFreq ? highBandMaxQ : ∞)
```

Les plafonds utilisateur ne peuvent que **resserrer** : un plafond supérieur à la
loi REW est sans effet, et `0` désactive. Plage 0-8 : au-delà de Q≈8 un filtre
correctif sonne (ringing audible), et c'est là que démarrent les seuils WARN des
verdicts.

### 3.4 Verrou de signe et zone cut-only

`optimizationState._buildGainBounds`, dans cet ordre de priorité :

```js
if (fc < maxBoostFreq)              gainUpperBounds = 0;  // cut-only, prioritaire
else if (gain < -signLockThreshold) gainUpperBounds = 0;  // verrouillé cut
else if (gain >  signLockThreshold) gainLowerBounds = 0;  // verrouillé boost
```

`maxBoostFreq` porte sur la **fréquence centrale** du filtre : un filtre large
placé au-dessus du seuil peut encore booster sous celui-ci.

### 3.5 Overshoot — deux mécanismes distincts

Un « overshoot » est ici un dépassement de **la cible** (`corrected − target`),
à ne pas confondre avec le dépassement du plafond de boost.

- **Pénalité douce** (`overshootPenaltyWeight`) dans le noyau MSE :
  `if (targetOver > 1) f3 += (targetOver − 1) × weight × overshootPenaltyWeight`.
  Le seuil de 1 dB est **codé en dur**. Actif uniquement dans
  `optimizeAllParameters`, pas au placement ni dans `FastMSE`.
- **Réduction post-hoc** (`maxAllowedOvershoot`, `targetOvershoot.js`) : tant
  qu'un point dépasse le seuil, le filtre de boost le plus influent voit son gain
  réduit de `min(overshoot × 0.6, gain × 0.4)`. S'arrête si l'influence est
  ≤ 0.3 dB ou la réduction ≤ 0.1 dB.

La pénalité **dure** est un troisième mécanisme, sur le gain cumulé :
`if (fdb − boostPenaltyThresholdDb > 0) f3 += 10 × boostOvershoot`, où
`boostPenaltyThresholdDb = overallMaxBoostDb`.

### 3.6 Le challenger modal ne peut pas régresser

`enableModalSeeding` (§3.7) n'injecte **pas** ses seeds dans le pipeline
standard : il rejoue le placement dans un challenger séparé et le résultat
n'est adopté que s'il passe `acceptCandidate` (gardes fullRms/criticalRms/
maxOvershoot **plus** `positiveRegression: 0.01` — l'énergie au-dessus de la
cible prime, SC-008). Verdict visible dans les logs moteur :
`Challenger modal (LPC) accepté/rejeté`.

### 3.7 Seeds modaux (LPC)

Quand `enableModalSeeding` est actif, une analyse all-pole du résiduel
initial (Levinson-Durbin, bande 20-400 Hz, constantes moteur dans
`MODAL_SEEDING_DEFAULTS`) détecte les modes ; au placement du challenger
modal, un span dont le pic coïncide (±1/6 d'octave) avec un mode voit son
`fc` posé sur la fréquence modale (précision sub-bin) et son Q initial
dérivé de la **largeur du pic au niveau G/√2.5** (casuistique des pics
noyés : miroir de demi-largeur, repli creux-à-creux). Le gain reste
entièrement optimisé ; les bornes de Q (§3.3) s'appliquent inchangées.
Décision de conception et chiffres : banc du 2026-07-16 (notes de travail).

### 3.8 Suppression des filtres

Cinq mécanismes cumulés, dont un seul hors moteur :

1. arrêt du placement si aucun span valide (le slot n'est jamais créé) ;
2. `removeWeakFilters` à chaque passe (seuil dérivé de `flatnessTarget`) ;
3. `pruneCounterproductiveFilters` : retrait glouton tant que neutraliser un
   filtre **baisse** le MSE ;
4. `removeFinalDeadFilters` : `|gain| < 0.1` ou boost en bord haut de bande ;
5. **hors moteur** : filtrage `minFilterGain` à l'écriture (§5.2).

---

## 4. Rapport de run et verdicts

`buildRunReport` (`src/autoeq/runReport.js`) attache `result.report` :

```js
{
  verdict: 'PASS'|'WARN'|'FAIL',
  warnings: string[],
  improvementPct: number,
  before: { fullRms, criticalRms, positiveRms, maxOvershoot },
  after:  { fullRms, criticalRms, positiveRms, maxOvershoot },
  maxCombinedBoostDb: number,
  filters: [{ fc, Q, gain, verdict, warnings[] }]
}
```

### Verdicts par filtre

`FilterQualityEvaluator.buildFilterVerdicts` :

| Condition | Verdict |
| --- | --- |
| `fc < 300 Hz` et `Q > 10` | FAIL (plafond de sécurité) |
| `fc < 300 Hz` et `Q > 8` | WARN (risque de ringing) |
| `fc ≥ 300 Hz` et `Q > 12` | FAIL (plafond de sécurité) |
| `fc ≥ 300 Hz` et `Q > 10` | WARN (risque de ringing) |
| `gain > 0` et `fc > 3000 Hz` | WARN (dépendant de la position) |

### Verdict global

**FAIL** si un filtre est en FAIL, ou si la correction dégrade le RMS global.
**WARN** (seulement si encore PASS) si un filtre est en WARN, si l'overshoot
résiduel dépasse `maxAllowedOvershoot`, si `improvementPct < 10 %`, ou si le
boost combiné dépasse `overallMaxBoostDb + 0.05`. **PASS** sinon.

`improvementPct` est calculé sur le RMS d'erreur pleine bande — il diffère de
`result.improvement`, basé sur le MSE restreint aux spans hors notches.

### Affichage

Le seul affichage utilisateur réel est `logPhaseMatchReport`
(`src/services/measurement-operations.js`) : une ligne
`[createPhaseMatchFilter] rapport: <VERDICT> — <warnings>` plus jusqu'à quatre
filtres signalés, en `log.warn` si FAIL sinon `log.info`. Voir §5.4 pour le sort
de `logRunReport`.

---

## 5. Pièges et points d'attention

### 5.1 Reduce/repair et critical band sont gated par Beat REW

`enableReduceRepair` et `enableCriticalBandRefinement` valent `true` par défaut
mais ne font **rien** tant que `enableBeatRewOptimization` est `false` (défaut
UI) : ils ne sont lus qu'à l'intérieur de `runBeatRewEnhancements`. L'UI
matérialise cette dépendance : les deux cases sont indentées sous Beat-REW et
désactivées (`enable:` Knockout) tant que le mode est décoché. Tout réglage
hors UI doit en tenir compte.

### 5.2 `minFilterGain` n'est pas un paramètre du moteur

Il est validé par `createAutoEQConfig` et transmis, mais **aucun module d'AutoEQ
ne le lit**. Il est appliqué en aval, à l'écriture des filtres
(`measurement-operations.js`, `sub-optimization.js`) :
`filter(f => Math.abs(f.gain) >= minFilterGain)`. Fonctionnellement le résultat
est le même (le filtre n'atteint pas REW), mais le moteur, lui, élague avec un
plancher fixe de 0.1 dB.

### 5.3 `allowBoosts` ne borne pas l'optimiseur

Dans le moteur, `allowBoosts: false` empêche seulement un span sous la cible de
devenir candidat au placement (`SpanCandidateFinder`). Rien dans
`_buildGainBounds` ne le consulte : un filtre placé sur un span de cut peut
repasser en gain positif. L'interdiction effective vient de l'UI : les valeurs
transmises au moteur passent par les computed `effectiveIndividualMaxBoost` /
`effectiveOverallBoost` (`MeasurementViewModel`), qui valent 0 quand
`allowBoosts` est décoché — les réglages de l'utilisateur sont conservés et
restaurés au re-cochage. Un appel hors UI avec `allowBoosts: false` et
`individualMaxBoostDb > 0` **produira des boosts**.

### 5.4 Les logs internes du moteur ne sortent nulle part

Aucun des trois points de construction (`services/filters.js`,
`MeasurementItem.js`, `services/sub-optimization.js`) ne fournit `onLog` ;
`createPhaseMatchCalculator` a `onLog = () => {}` par défaut. Tous les logs
internes (phases, slots, MSE, `logRunReport`) sont donc jetés en production. Le
rapport reste disponible sur `result.report`, et `logPhaseMatchReport` en publie
un résumé.

### 5.5 Le double chemin des services

Les services portent deux chemins (ADR 002) : sans `operations` (méthodes de
`MeasurementItem`, chemin de production actuel) et avec `operations` injecté
(`MeasurementRecord` plats). Ne retirer aucun des deux.

### 5.6 Jamais de signal stocké

Les impulsions et réponses ne sont jamais stockées sur le record ni sur l'item :
l'IR courante se lit à la demande au moment du calcul (amendement ADR 002).

---

## 6. Tests

| Commande | Portée |
| --- | --- |
| `npm test` | Suite rapide Vitest (dont contrats rew-codec, phase-match-calculator) |
| `npm run test:all` | Golden masters AutoEQ (4 exemples, deux configs : golden et UI production) — assertions SC-008 (overshoots ≤ 2× REW) et SC-010 (RMS ≤ 1.5× REW) |
| `npm run test:quality` | `test:all` + analyse des overshoots |
| `npm run test:filter-parameter-bounds` | Bornes de Q (lois REW + plafonds utilisateur) |
| `npm run test:optimization-state` | Bornes de gain, verrou de signe, zone cut-only |
| `npm run test:optimizer-decoding` | Décodeur du vecteur d'optimisation |
| `npm run test:optimizer-config` | Mapping config AutoEQ → optimiseur |
| `npm run test:characterization` | Caractérisation du pipeline |
| `npm run test:rew-parity-strict` | Parité REW (REW réel requis) |

Les répertoires `test/auto-eq/exemple*` et `test/auto-eq/samples-*` sont des
**golden masters** : toute modification exige une décision explicite tracée dans
le message de commit. Ne jamais les éditer pour faire passer un test.
