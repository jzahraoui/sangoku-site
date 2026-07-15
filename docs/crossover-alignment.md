# Find Best Crossover — Documentation Technique

> **Date de rédaction** : 2026-07-13
> **Modules** : `src/services/alignment.js`, `src/services/business-tools.js`,
> `src/dsp/ir-align.js`, `src/MeasurementViewModel.js`, `src/MeasurementItem.js`
> **Points d'entrée UI** : bouton par groupe (`buttonFindBestCrossover`) et bouton
> global d'en-tête (`buttonFindBestCrossoverAll`)

Automatise le choix de la fréquence de coupure d'un groupe d'enceintes : on teste
tous les crossovers candidats, on mesure le *required shift* à chacun (la même
métrique que le bouton ⟳ `checkAlignment`) et on retient celui qui raccorde le
mieux. Les règles métier du domaine (scénario de référence, alignement temporel,
polarité/inversions) priment sur toute déduction du code.

---

## Table des matières

1. [Le problème et le critère](#1-le-probleme-et-le-critere)
2. [La fenêtre de recherche partagée (±T/4)](#2-la-fenetre-de-recherche-partagee-t4)
3. [Le sweep par enceinte (moteur)](#3-le-sweep-par-enceinte-moteur)
4. [findBestCrossover : agrégation de groupe + garde-fous](#4-findbestcrossover--agregation-de-groupe--garde-fous)
5. [Orchestration UI](#5-orchestration-ui)
6. [Décisions de conception](#6-decisions-de-conception)
7. [Tests](#7-tests)

---

## 1. Le problème et le critère

Le crossover est une propriété de **groupe** (FL/FR partagent une valeur, stockée
dans `_crossoverMap[groupName]`). Le *required shift* d'une enceinte à un crossover
donné est le décalage temporel nécessaire pour aligner son IR predicted **brute**
avec la « somme vraie » des subs, mesuré dans la bande du candidat (passe-bande
zéro-phase interne de l'aligneur) — exactement ce que calcule `checkAlignment`.

**Critère retenu : la moyenne des `|required shift|`** des membres du groupe
(valeur absolue prise *avant* la moyenne — deux shifts opposés ne s'annulent pas),
argmin sur les candidats.

Pourquoi le shift **absolu** et non un désaccord entre enceintes : les enceintes
sont déjà alignées temporellement entre elles (figées après le Time align) et le
bloc des subs est aligné à **une** enceinte de référence puis figé — il ne suit
pas chaque groupe. Le required shift face au sub (fixe) est donc un résidu réel et
non corrigeable qu'on minimise. Comme les enceintes d'une paire sont pré-alignées,
leurs shifts sont proches à un crossover donné (un écart type serait ≈ 0 partout,
non discriminant).

---

## 2. La fenêtre de recherche partagée (±T/4)

`crossoverAlignmentWindowMs(frequency, { forward })` — `src/dsp/ir-align.js`.
**Source unique** de la fenêtre de recherche, dérivée de la période `T = 1/fc` :

- **centrée** `[−T/4, +T/4]` (± 250/fc ms) — `checkAlignment` et le sweep ;
- **avant** `[0, T/2]` (500/fc ms) — `produceAligned` (Find Sub Alignment), qui
  pré-positionne le sub sur le pic de l'enceinte puis cherche le délai à appliquer,
  forcément vers l'avant.

**Pourquoi ±T/4 et pas un cycle entier.** Les lobes de la corrélation (carré signé,
`alignImpulseResponses`) se répètent tous les **T/2** ; le lobe à T/2 est
l'alignement **inversé** (180° au raccord). Une fenêtre centrée d'un cycle entier
(±T/2) ré-inclurait ce lobe inversé au bord → sauts de cycle. ±T/4 isole un seul
lobe → pic unique ; combiné au drapeau d'inversion, il représente déjà tous les
alignements possibles (décalage minimal, éventuellement inversé).

Le `±1 ms` fixe historique de `checkAlignment` ne valait ±T/4 qu'à 250 Hz (trop
étroit dans le grave). `produceAligned` conserve son arrondi 0.01 ms au point
d'appel → parité golden `test:align-sub-parity` inchangée.

---

## 3. Le sweep par enceinte (moteur)

`crossoverRequiredShiftSweep(speaker, lfe, subs, candidateFrequencies)` —
`src/services/business-tools.js`. Pour **une** enceinte :

1. Lit **une seule fois** les IR predicted brutes : l'enceinte
   (`getPredictedImpulseResponseInfo`) et la « somme vraie » pondérée `splOffsetdB`
   des subs de la position (`combineImpulseResponses`), ou la projection LFE
   predicted en repli.
2. Pour chaque candidat `fc` :
   `alignImpulseResponses(subRaw, speakerRaw, { frequency, fenêtre ±T/4 })` —
   les courbes sont alignées **brutes** (doctrine « mesures sur courbes
   brutes », 2026-07-15) : aucun filtre de raccord n'est appliqué, la
   sélectivité au candidat vient du passe-bande 1/3 d'octave à phase nulle
   interne de l'aligneur. Ces mesures restent valides pour le système réel
   car l'export OCA ajoute un BW12 électrique côté enceinte : le bass
   management devient LR24|LR24, une paire en phase à toutes les fréquences
   qui n'introduit aucune phase relative. Pas de régénération de filtres ni
   d'aller-retour REW par crossover.

Renvoie par candidat `{ frequency, requiredDelayMs, delayMs, withinBounds, invertB }`.
**Aucune écriture REW, aucune mutation** (ni inversion, ni filtres).

Le classement se fait sur le **`delayMs` borné** (= la valeur que `checkAlignment`
/ l'UI affiche), **pas** sur `requiredDelayMs` (pic libre non borné, sujet aux
sauts de cycle — regles-metier §2). `requiredDelayMs` n'est conservé qu'à titre
indicatif.

---

## 4. findBestCrossover : agrégation de groupe + garde-fous

`findBestCrossover(groupSpeakerItems, candidateFrequencies)` —
`src/services/alignment.js`. **Fonction pure** (ne mute rien) : elle appelle le
sweep par membre puis agrège par candidat.

- `shiftMs = withinBounds ? delayMs : Infinity` (un membre hors bornes =
  « Delay too large » de `checkAlignment` → écarté).
- `mean = moyenne(|shiftMs|)` si tous finis, sinon `Infinity`.
- **Garde-fou d'inversion (regles-metier §6)** : si les membres du groupe ne
  partagent pas la même inversion (`invertB`) à ce candidat, le candidat est
  **rejeté** (`mean = Infinity`, `inversionConsistent = false`). Le crossover
  retenu garantit alors une inversion cohérente sur toute la paire.
- `bestFrequency = argmin` des `mean` finis, ou `null` si aucun candidat
  exploitable (échec).

Retour : `{ bestFrequency, table: [{ fc, perMember: [{ uuid, id, shiftMs, delayMs,
requiredDelayMs, withinBounds, invertB }], mean, inversionConsistent }] }`.

---

## 5. Orchestration UI

`src/MeasurementViewModel.js` — l'**application** (écritures) vit ici, pas dans le
service pur (principe « l'égaliseur est un outil »).

- `runFindBestCrossoverForGroup(groupName)` : cœur partagé. Préconditions (filtres
  générés + somme des subs / LFE disponible, sinon lève), appel du service, logs
  d'audit par candidat (avec marqueur `(inv)` et `[rejeté: inversion incohérente]`),
  puis en cas de succès : écrit le crossover du groupe (sélection auto dans la
  liste), le `shiftDelay` par membre, **et applique l'inversion** décidée
  (`member.toggleInversion()` si `invertB`) — exactement comme `checkAlignment`.
- `buttonFindBestCrossover(item)` : traite le groupe de l'enceinte cliquée.
- `buttonFindBestCrossoverAll()` : boucle sur tous les groupes d'enceintes ; un
  groupe en échec (précondition, aucun candidat) est logué et sauté.
- `MeasurementItem.isFirstOfGroup` (`pureComputed`) : le bouton par ligne n'est
  affiché que sur le représentant du groupe → un seul bouton par groupe.
- `invalidateSpeakerAlignments()` : remet le `shiftDelay` des enceintes à `Infinity`
  quand la somme des subs change (sum subs, EQ subs, multi-sub optimizer). Le
  déplacement temporel d'une enceinte est déjà couvert par
  `MeasurementItem.cumulativeIRShiftSeconds` (→ `shiftDelay(Infinity)`).

Changer le crossover périme l'aval (filtres, Find Sub Alignment, previews) : un log
le rappelle, sans recalcul automatique (perception utilisateur, regles-metier §10).

---

## 6. Décisions de conception

- **Shift absolu, pas désaccord** (§1) : le sub est figé sur une enceinte de
  référence, le résidu est réel. Le désaccord entre membres est ≈ 0 (enceintes
  pré-alignées) donc non discriminant.
- **`delayMs` borné, pas `requiredDelayMs` libre** : le pic libre saute de cycle
  (observé : −4 ms ≈ −T/2 à 120 Hz alors que le vrai raccord est à ~0). Le borné
  reproduit `checkAlignment` bit à bit.
- **Fenêtre ±T/4 partagée** : évite qu'un ajustement de la fenêtre côté bouton et
  côté auto ne divergent (source unique).
- **Application de l'inversion dans le handler** : le service reste pur ; l'inversion
  décidée est appliquée à la sélection (le garde-fou §6 la rend cohérente).
- **Hors périmètre** : le shaping « cible × BU12(fc) » (remède d'amplitude du
  raccord, regles-metier §3) n'entre pas ici — il corrige l'amplitude, pas le
  temps, et ne changerait pas l'argmin. `LPF for LFE` n'est pas touché par cette
  fonction : Find Sub Alignment pose une valeur heuristique
  (`max(120, crossover)`), et le bouton dédié « Find Best LFE Low-Pass » la
  remplace par une recherche mesurée
  ([`docs/lfe-lowpass-selection.md`](lfe-lowpass-selection.md)).

---

## 7. Tests

- `test/unit/ir-align.test.js` — `crossoverAlignmentWindowMs` (centrée ±T/4,
  avant = formule legacy de `produceAligned`, = ±1 ms à 250 Hz, rejet fc ≤ 0).
- `test/unit/business-tools.test.js` — le sweep lit les IR une seule fois, renvoie
  `invertB`, repli LFE, garde d'entrée.
- `test/unit/alignment.test.js` — `findBestCrossover` : classement sur le `delayMs`
  borné (pas le pic libre), moyenne des valeurs absolues, garde-fou d'inversion
  (rejet du membre unique inversé, acceptation des deux inversés), `bestFrequency`
  null quand tout est non fini.
- Parité golden inchangée : `test:align-sub-parity`, `test:ir-align-parity`.
