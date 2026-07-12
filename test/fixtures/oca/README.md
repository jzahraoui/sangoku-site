# Golden OCA — chemin d'export actuel (via REW)

Généré le 2026-07-12 par `test/auto-eq/rew/generate-oca-golden.mjs`
(REW 5.40 Beta 128) sur l'IR position 1 de FL et SW1 de l'ADY de référence
(`work/Denon AVC-A1H_kef.4sub.3pos.ady`), avec des banks de filtres
DÉTERMINISTES décrits dans `manifest.json` :
- FL : 5 filtres PK (62.5 Hz à 5883 Hz), crossover 80 Hz ;
- SW1 : 2 PK + **all-pass slot 20** (60 Hz, Q 0.7) — le cas critique de la
  future génération interne.

`kef-fl-sw1.oca.json` contient les tableaux `filter` (IR au format AVR :
16321 échantillons enceinte / 16055 sub, premier échantillon = gain
d'ajustement 10^-0.35 ≈ 0.4466836) produits par la chaîne actuelle
(generateFilterMeasurement → fenêtres rectangulaires → trim →
getImpulseResponse → transformIR).

## Rôle

Référence de non-régression du chantier « export OCA interne »
(la génération DSP de l'IR devra reproduire ces tableaux sur les mêmes banks).
Vérifié déterministe : deux exécutions successives produisent des valeurs
identiques.

## Invariant

Données de référence figées (règle des golden masters, CLAUDE.md
invariant n°2). Régénération :

```bash
WINDOWS_HOST=... node test/auto-eq/rew/generate-oca-golden.mjs \
  "work/Denon AVC-A1H_kef.4sub.3pos.ady" test/fixtures/oca
```
