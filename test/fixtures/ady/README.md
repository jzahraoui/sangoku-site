# Corpus de fixtures multi-positions (fichiers ADY réels)

Courbes de référence générées depuis des fichiers .ady d'utilisateurs par
`test/auto-eq/rew/generate-ady-fixtures.mjs` (REW 5.40 Beta 128, API 0.9.5).
Servent aux phases 0-3 du plan qualité audio (`work/docs/PLAN-QUALITE-AUDIO.md`).
Validées par `npm run test:ady-fixtures` (test data-driven sur les
`manifest.json` de chaque système).

## Systèmes

| Dossier | Source (fourni par) | AVR | Positions | Canaux | Particularité |
| --- | --- | --- | --- | --- | --- |
| `kef-3pos/` | Jaoued | Denon AVC-A1H | 3 | FL, C, SBR | KEF + 4 subs |
| `prociprince-8pos/` | prociprince | Denon AVC-X3700H | 8 | FL, C, SBR | corpus le plus dense en positions |
| `tony61-6pos/` | tony61 | Marantz AV8805 | 6 | FL, SLA | **enceintes à rolloff bas (583-811 Hz)**, pas de centrale |
| `barmatic-6pos/` | barmatic | Denon AVC-X3800H | 6 | FL, C | — |

Fichier « Nicobear34 … X3800H.ady » écarté : export de configuration OCA
(trims/xover/filtres), sans `responseData` — aucune mesure à extraire.

## Contenu par canal

| Fichier | Contenu |
| --- | --- |
| `<CH>_P01…P0n.txt` | Position individuelle, réponse brute 96 PPO sans lissage, après cross-corr align (import identique à l'app : 48 kHz, splOffset 80, sans calibration micro) |
| `<CH>_vector-avg_raw.txt` | Moyenne « Vector average », brute |
| `<CH>_rms-avg_raw.txt` | Moyenne « Magn plus phase average » (RMS + phase avg. dans l'UI), brute |
| `<CH>_db-avg_raw.txt` | Moyenne « dB plus phase average », brute |
| `<CH>_<slug>_mtw.txt` | Même moyenne avec fenêtrage « Optimized MTW » (mtwTimesms 9000/3000/450/120/30/7.7/2.6/0.9/0.4/0.15) |
| `manifest.json` | Source, modèle, version REW, canaux/positions/rolloff |

Format : REW txt (`* Freq(Hz)\tSPL(dB)`), lisible par `parseREWFile`.

## Faits mesurés sur le corpus (diagnostic de référentiel, 2026-07-12)

- **D(f) = brute − MTW** : ≤ 0.43 dB sous 300 Hz partout (fenêtres longues) ;
  sur 300-3000 Hz : **+1.3 à +2.4 dB sur les fronts large bande** (kef,
  prociprince, barmatic), ~+1.0 à +1.6 dB même sur les enceintes à rolloff bas
  (tony61), et seulement +0.22 sur la surround proche kef SBR (peu d'excès
  réverbéré). Des filtres dosés sur la MTW et appliqués à la brute dépassent la
  cible de D(f).
- **Vector − RMS average** : négatif partout, et **le biais croît avec le
  nombre de positions** : −1.2 à −2.2 dB à 3 positions (kef), −1.1 à −1.3 dB à
  6 positions (tony61), −3.7 à −4.1 dB (barmatic, 6 pos.), **−4.2 à −4.9 dB à
  8 positions (prociprince)** — biais large bande dès 40 Hz.
- **σ inter-positions** : 1-3 dB — matière de la pondération par cohérence
  (phase 3).

## Invariant

Données de référence figées (même règle que les golden masters, CLAUDE.md
invariant n°2) : toute modification exige une décision explicite tracée.
Régénération :

```bash
WINDOWS_HOST=... node test/auto-eq/rew/generate-ady-fixtures.mjs \
  <fichier.ady> test/fixtures/ady/<systeme> <CANAUX…>
```
