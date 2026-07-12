# ADR 002 — Interface de MeasurementItem post-décontamination (D-03)

- **Statut** : accepté (décision auto-tracée du run de migration, 2026-06-12,
  prérequis des extractions de services)
- **Contexte** : `MeasurementItem` mêle aujourd'hui trois rôles : miroir de l'état REW
  (observables `title`, `splOffsetdB`, `cumulativeIRShiftSeconds`…), dérivations métier
  (computeds canal/distance/SPL) et orchestration REW (60+ méthodes async). CLAUDE.md
  exige de trancher la forme cible avant d'attaquer MeasurementViewModel, sinon chaque
  lot renégocie la frontière. Options en lice : POJO + événements vs record immuable.

## Décision : **record mutable à champs plats + émetteur d'événements minimal**

```js
// src/measurement/measurement-record.js (module [MOTEUR], zéro dépendance)
class MeasurementRecord {
  // identité & état REW (plats, pas d'observables)
  uuid; title; notes; date; sampleRate;
  inverted; splOffsetdB; alignSPLOffsetdB; initialSplOffsetdB;
  cumulativeIRShiftSeconds; clockAdjustmentPPM;
  timeOfIRStartSeconds; timeOfIRPeakSeconds; haveImpulseResponse;
  // état applicatif non-REW
  associatedFilterUuid; IRPeakValue; revertLfeFrequency; isSubOperationResult; …

  update(partial)            // applique un delta API → émet 'change' (champs modifiés)
  on(event, fn) / off(…)     // émetteur maison (~20 lignes), pas de dépendance Node
  toJSON()
}
```

- **Les dérivations ne vivent PAS sur le record** : `channelName`, `distanceInMeters`,
  `splForAvr`… sont des fonctions pures de `measurement-info.js` /
  `measurement-calculations.js` prenant `(record, contexte AVR, liste)` en paramètres.
- **L'orchestration ne vit PAS sur le record** : `src/services/measurement-operations.js`
  expose des fonctions `(rewServices, record, params)` qui appellent REW puis
  `record.update(...)`.
- **Adaptateurs UI** : côté Knockout (transition), `MeasurementItem` devient une coquille
  qui possède un record, relaie `change` vers ses observables et délègue ses méthodes —
  l'API publique du VM ne bouge pas pendant la migration. Côté Vue, un composable
  `useMeasurement(record)` projette `change` vers des `shallowRef`.

## Alternatives écartées

- **Record immuable (copy-on-write)** : sémantique attrayante mais incompatible à coût
  raisonnable avec le code existant — les flux (`mergeMeasurements`,
  `addMeasurementFromRewOperation`, BusinessTools) conservent des références d'items
  pendant des séquences longues ; l'immutabilité forcerait à re-propager l'identité dans
  toutes les listes à chaque écriture REW (des dizaines par workflow), pour un bénéfice
  nul tant que les écritures restent sérialisées (verrou `setProcessing`).
- **Plain-object sans événements** : laisserait le polling REW (1 s) comme seul moyen de
  rafraîchir l'UI, dégradant la réactivité actuelle (les observables KO se mettent à jour
  immédiatement après chaque opération).
- **EventEmitter de Node / EventTarget DOM** : dépendance d'environnement dans un module
  moteur ; un émetteur maison de 20 lignes est testable partout.

## Conséquences

- `BusinessTools` peut être reclassé [MOTEUR] (D-04) une fois ses paramètres convertis de
  getters observables (`item.title()`) aux champs plats (`record.title`) — adaptation à
  faire dans les lots I3/I4.
- Les tests des lots portent sur record + fonctions pures + services (REW mocké),
  remplaçant progressivement le mock de `measurement-view-model.test.js`.
- Pendant la transition, double écriture record→observables via l'adaptateur ; le retrait
  des observables se fait au portage Vue de chaque écran.

---

**Amendement (2026-07-12)** : le champ `associatedFilterUuid` a été retiré du
contrat. Il portait le cache du « filtre associé » (mesure REW représentant le
bank d'un canal), hérité d'un mode predicted-par-convolution abandonné puis du
chemin d'export OCA historique. L'export OCA calcule désormais l'IR des filtres
en interne (`src/dsp/impulseResponse.js` + `src/measurement/rew-filter-bank.js`)
en lisant le bank REW à chaque export : plus de cache, plus d'invalidation
(`invalidateAssociatedFilter` retiré de `setFilters`/`setSingleFilter` et de
tous les services). Les sauvegardes anciennes portant ce champ sont ignorées.

---

**Amendement (2026-07-12) — accès aux données de signal (impulsions)** :

- **Le record ne stocke jamais de données de signal** (impulsions,
  réponses en fréquence) — uniquement l'identité, l'état REW scalaire et
  l'état applicatif. Deux raisons mesurées : la fraîcheur n'est pas
  garantissable (les opérations RCH — Offset t=0, inversion, SPL — et les
  actions faites directement dans l'interface REW transforment l'impulsion
  après l'import ; une copie stockée serait silencieusement fausse), et la
  persistance `localStorage` n'a pas le quota (≈15 Mo d'impulsions pour un
  système 8 positions).
- **Contrat : l'impulsion courante s'obtient en la demandant** —
  `operations.getImpulseResponseInfo(rew, record)` renvoie
  `{ data, sampleRate, startTime }` frais au moment du calcul. C'est le
  pattern de tous les calculs internes (export OCA, alignement du moyennage,
  Time align) : lire au moment de l'opération, jamais d'état intermédiaire.
- **Tout cache futur, s'il devient nécessaire, vit dans la couche
  operations** (point de passage unique des écritures, seul endroit où
  l'invalidation est garantissable — `addIROffsetSeconds`, `setInverted`,
  `setFilters`, `addSPLOffsetDB`… touchent l'uuid → l'entrée saute), jamais
  dans le record ni l'adaptateur. Décision du 2026-07-12 : pas de cache tant
  qu'aucun profil ne montre de relectures répétées dans une même opération ;
  pour tout calcul audio-critique, on relit.
