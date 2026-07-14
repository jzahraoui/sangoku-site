# Find Best LFE Low-Pass — Documentation Technique

> **Date de rédaction** : 2026-07-14
> **Modules** : `src/services/business-tools.js` (`lfeLowPassSummationSweep`),
> `src/services/alignment.js` (`findBestLfeLowPass`), `src/dsp/spectrum.js`,
> `src/dsp/biquadResponse.js` (`getCascadeComplexResponse`),
> `src/MeasurementViewModel.js`
> **Point d'entrée UI** : bouton `buttonFindBestLfeLowPass` (zone Finalization,
> à côté du champ LPF for LFE)

Choisit automatiquement la fréquence du filtre passe-bas du canal LFE
(« LPF for LFE » de l'AVR) : on teste toutes les valeurs disponibles pour
l'AVR sélectionné et on retient celle dont la sommation LFE + enceintes
frontales LCR est la plus constructive sur la bande utile du LFE.

---

## 1. Le problème et le critère

Le passe-bas LFE ne change pas seulement le niveau : il impose un retard de
groupe au signal LFE (LR24 : ≈ √2/(π·fc), soit 3.75 ms à 120 Hz, 1.8 ms à
250 Hz). Find Sub Alignment pose une heuristique `max(120, crossover de
l'enceinte de référence)` : elle n'est exacte que lorsque le passe-bas égale
ce crossover (mêmes filtres → même phase). Dès que le `max` s'active
(crossover < 120, le cas courant), la valeur est un pari — et les candidats
≥ 120 (120/150/200/250), qui préservent tous le contenu, diffèrent par leur
retard de groupe. La recherche mesure au lieu de supposer.

**Critère par candidat** : perte de sommation moyenne (dB) sur une grille
log 20–120 Hz (16 points/octave),

```
loss(f) = 20·log10(|F(f)| + |L(f)|) − 20·log10(|F(f) + L_fc(f)|)
```

où `F` est la voie du **canal front complet** tel que le bass management le
fait entendre (décision 2026-07-15, simulation REW Vector sum à l'appui) :

```
F = enceinte_predicted × HP BW12(crossover) + L × LR24(crossover)
```

(le grave redirigé du canal sort des mêmes subs que le LFE ; une enceinte
Large joue sa réponse complète, sans redirection), `L` la voie LFE non
filtrée (« somme vraie » des subs pondérée `splOffsetdB`, ou projection LFE
predicted en repli) et `L_fc = L × LR24(fc)`. Dans le grave profond, `F` se
réduit au grave redirigé : un candidat égal au crossover y est **en phase à
l'identique** (même filtre, mêmes subs) — l'intuition « le passe-bas confirme
le crossover » est portée par le modèle et arbitrée contre la préservation du
contenu. La référence — sommation parfaitement
cohérente ET contenu intégralement préservé — fait qu'un candidat bas paie sa
perte de contenu sous 120 Hz exactement comme une annulation : le compromis
contenu/addition tient dans un seul nombre. Agrégation : moyenne des pertes
sur les fronts LCR présents, argmin sur les candidats.

La borne 120 Hz est celle de la **bande d'évaluation** (le contenu LFE des
pistes de films s'arrête à 120 Hz) — il n'y a **aucune borne sur les
candidats** : toutes les valeurs de `AvrCaracteristics.getLfeFrequencies`
(liste dépendante du modèle) sont jugées.

## 2. Réalisation — tout en fréquentiel

`lfeLowPassSummationSweep(speaker, lfe, subs, candidateFrequencies)` —
`src/services/business-tools.js`. Pour UNE enceinte front :

1. Lit **une seule fois** les IR predicted brutes (enceinte + somme vraie des
   subs), comme `crossoverRequiredShiftSweep` (lecture partagée
   `predictedSubSumIr`). **Chaque voie est remise à son niveau affiché**
   (`splOffsetdB` — les exports d'IR REW n'intègrent pas le niveau) :
   l'enceinte comme les subs, et la projection LFE du repli. Sans cette
   repondération, le poids relatif enceinte/LFE serait arbitraire et le
   critère dégénérerait en atténuation du LR24 seul, identique pour tous les
   canaux (observé lors du premier test grandeur nature, 2026-07-14 : perte
   « worst » exactement égale à l'atténuation LR24 à 120 Hz pour chaque
   candidat). L'alignement (xcorr), lui, est invariant d'échelle — c'est
   pourquoi le défaut ne touchait que ce critère.
2. Évalue leurs **spectres complexes** sur la grille d'évaluation
   (`complexSpectrumAt`, `src/dsp/spectrum.js`) : DFT au point, phase
   intégrant le `startTime` absolu — les deux voies sont donc directement
   sommables dans le référentiel temporel de REW.
3. Applique les filtres du bass management (HP BW12 enceinte + LR24 du grave
   redirigé) et le LR24 candidat **analytiquement**
   (`getCascadeComplexResponse` sur les biquads de `buildCrossoverCascade` —
   les mêmes que le chemin IR) : pas de filtrage temporel ni de DFT par
   candidat.

Aucune écriture REW, aucune mutation. Renvoie par candidat
`{ frequency, summationLossDb, worstLossDb, groupDelayMs }` ;
`groupDelayMs` (retard de groupe passe-bande du LR24, 2 × √2/ω₀) est le
« décalage pris en compte », purement informatif.

## 3. findBestLfeLowPass : agrégation + orchestration UI

`findBestLfeLowPass(frontItems, candidateFrequencies)` —
`src/services/alignment.js`. **Fonction pure** : sweep par front, moyenne des
`summationLossDb` par candidat (un membre non fini → candidat écarté),
`bestFrequency = argmin`, ou `null` si aucun candidat exploitable. Pas de
garde-fou d'inversion ici : rien n'est muté, aucune décision d'inversion.

`buttonFindBestLfeLowPass` (`src/MeasurementViewModel.js`) : fronts =
FL/C/FR sélectionnés ; préconditions identiques au find best crossover
(filtres générés + somme des subs / LFE) ; logs d'audit par candidat (perte
moyenne, pire creux, délai) ; en cas de succès écrit `lpfForLFE` et logue la
fréquence choisie, le décalage pris en compte, la justification (somme la
plus favorable) et la comparaison avec la valeur précédente (gain en dB, ou
« confirmée » si identique). **Seul le réglage lpfForLFE est modifié** — ni
délai des subs, ni inversions, ni crossovers.

## 4. Décisions de conception

- **Candidats = liste AVR complète, pénalité par le score** : la limitation
  des candidats à ≤ 120 Hz d'une première rédaction du besoin était une
  erreur ; 120 Hz borne la bande d'évaluation, pas la recherche.
- **LR24 pour le passe-bas LFE** : même topologie que le LP sub du bass
  management (décision 2026-07-14).
- **Canal front complet, pas enceinte seule** (décision 2026-07-15) : la
  première version sommait le LFE avec la seule voie haut-parleur (HP BW12) ;
  la simulation REW de contrôle (Vector sum du LFE filtré et de la predicted
  pleine bande, plateau ≈ +5 dB) a montré que le grave du canal front devait
  être présent dans la comparaison. Le modèle retenu inclut le grave redirigé
  `L × LR24(crossover)` — physiquement fidèle pour une enceinte Small, et il
  porte l'intuition « fc = crossover ⇒ phase identique dans le grave ».
- **Analytique plutôt que temporel** : la réponse complexe des biquads est
  exacte (mêmes coefficients que le chemin IR) — 2 DFT par front au lieu
  d'un filtrage + DFT par candidat.
- **Décalage informatif** : le délai du bloc des subs reste figé (posé par
  Find Sub Alignment) ; le retard du LR24 est affiché, pas compensé.
- **Bouton dédié, pas d'automatisme** : lancé après Find Sub Alignment, il
  remplace la valeur heuristique ; si le crossover de référence est ≥ 120 et
  ressort gagnant, il la confirme.

## 5. Tests

- `test/unit/spectrum.test.js` — grille log (bornes exactes), spectre d'un
  Dirac décalé (module + phase, startTime), équivalence filtrage temporel
  (`processThroughCascade`) ↔ réponse analytique de cascade.
- `test/unit/business-tools.test.js` — le sweep lit les IR une seule fois,
  perte décroissante quand fc monte (IR identiques, enceinte Large), repli
  LFE, gardes d'entrée, `groupDelayMs = √2/(π·fc)`.
- `test/unit/alignment.test.js` — `findBestLfeLowPass` : argmin de la
  moyenne, membre non fini → candidat écarté, `bestFrequency` null quand
  tout est non fini, gardes d'entrée.
