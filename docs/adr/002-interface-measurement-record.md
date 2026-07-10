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
