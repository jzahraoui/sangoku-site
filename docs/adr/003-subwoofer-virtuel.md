# ADR 003 — Subwoofer virtuel (agrégat des subs réels, projection `LFE predicted`)

- **Statut** : accepté (décision Jaoued, 2026-07-10) — implémenté le 2026-07-10
  (`src/services/virtual-subwoofer.js` ; preview-sub, align-sub, equalize-sub,
  trim gain ±, revert LFE branchés ; parcours e2e sub-preview/sub-align/sub-trim).
  **Étendu le 2026-07-11 (v2, décision Jaoued)** : le sub virtuel devient
  bidirectionnel — il **calcule aussi la référence Theo** (somme idéale, phase = 0)
  et **accepte des commandes de groupe en entrée** (offset SPL, délai, filtres…)
  qu'il applique à chaque sub réel avant de recalculer ses projections.
  Les chemins historiques (`produceSubSums`, `createsSum`, `LFE Max Sum` sans
  bridge) restent la surface de mock des tests unitaires.
- **Contexte** : la « réponse combinée des subwoofers » n'existe pas comme entité de
  l'application. Elle est matérialisée par des mesures REW créées puis étiquetées a
  posteriori (`LFE predicted_Px` par preview-sub, `LFE Max Sum`/`Theo` par align-sub,
  flag volatil `isSubOperationResult`), retrouvées ensuite par titre ou par flag. Quatre
  chemins de code convergent vers cette même notion sans la partager :
  `produceSubSums`/`createsSum` (somme via arithmétique REW), `alignSub` (somme calculée
  par `MultiSubOptimizer` puis importée), le trim gain ± (itération sur
  `subsLikeMeasurements`), et le garde-fou mono-sub (« Only one subwoofer found, please
  use single sub optimizer button »). Conséquences constatées : duplication mono/multi,
  et une classe de bugs d'identité — le flag `isSubOperationResult` ne vit que côté
  application (mémoire + localStorage) ; toute rupture de session (UUID REW changés,
  localStorage différent) le perd silencieusement, et les courbes dérivées cessent de
  suivre les opérations de niveau (bug confirmé le 2026-07-10).

## Décision : **une classe `VirtualSubwoofer` par position, projetée dans REW**

```js
// src/services/virtual-subwoofer.js (module [MOTEUR], zéro dépendance UI)
class VirtualSubwoofer {
  position;                 // clé de groupe (P01, …) — une instance par position
  realSubs;                 // MeasurementRecords des subs réels (N ≥ 1)
  projectionUuid;           // uuid REW courant de la mesure `LFE predicted_Px`
  theoUuid;                 // uuid REW de la référence `LFE Max Sum Theo_Px` (v2)
  withTheo;                 // Theo activée par align-sub, recalculée ensuite (v2)

  markDirty(changedFields)  // notifié par les événements 'change' des records (ADR 002)
  async refresh()           // recalcule somme (+ Theo si activée), met à jour les projections
  response()                // somme client (freqs/magnitude/phase), sans passer par REW

  // — entrées (v2) : commandes de groupe, fan-out sur les subs réels
  async addSPLOffset(dB)    // trim ± ; Theo suit par recalcul, pas par décalage
  async addDelay(seconds)   // décale le groupe dans le temps
  async setInverted(inverted)
  async resetFilters()
  async setFilters(filters) // distribution d'un jeu de filtres (equalize)
  async forEachSub(fn)      // échappatoire générique : batch + refresh unique
  dispose()
}
```

Le service par position expose les mêmes commandes en version multi-positions
(fan-out sur chaque groupe, puis `refreshProjected` — un seul recalcul par
projection existante).

- **Le virtuel est la source d'identité, la mesure REW n'est qu'une projection.**
  `refresh()` supprime l'ancienne projection et importe la nouvelle
  (nouvel uuid, mémorisé dans `projectionUuid`). **Import impulsionnel (v2.1,
  2026-07-11)** : REW n'expose aucune donnée d'impulsion pour un import de
  réponse en fréquence (vérifié sur REW réel), ce qui casse tous les
  consommateurs d'IR (Find Sub Alignment, previews, mesure d'écart de pics).
  La somme est donc convertie en réponse impulsionnelle côté client (IFFT du
  spectre complexe, `src/dsp/impulse-synthesis.js`) et importée via
  `importImpulseResponseData` avec `splOffset 0` : la phase porte les retards
  absolus (pic à l'instant physique correct) et REW restitue exactement la
  magnitude encodée (validé par sonde sur REW réel : pic à 10,0 ms pour un
  retard encodé de 10 ms, niveau 75 dB restitué à ±0,8 dB). Cas particulier de
  **Theo** (v2.2) : sa somme est à phase nulle, donc son impulsion est acausale —
  importée brute, la moitié anticausale s'enroule en fin de buffer et REW la
  jette (**≈ −6 dB constatés par sonde**, la predicted pouvait alors « dépasser »
  la référence). Elle est donc synthétisée **centrée dans le buffer** (phase
  linéaire ajoutée) : niveau restitué exact (75,0 dB à la sonde), fenêtres IR
  référencées au pic symétriques.
  Plus rien n'est « retrouvé » par titre ni marqué par flag : l'application possède
  l'uuid courant. La synchronisation REW (`mergeMeasurements`) ne doit jamais adopter
  la projection comme mesure ordinaire — elle est reconnue par `projectionUuid`.
- **Somme calculée côté client**, en réutilisant les maths de réponse du
  `MultiSubOptimizer` (délais, polarité, all-pass — `getFinalSubSum`), déjà validées
  par les goldens multi-sub. L'arithmétique REW (`A + B`) est reléguée au rôle d'outil
  de contrôle (parité avec le commentaire DEBUG existant d'`alignSub`).
- **Déclenchement du recalcul** (remarque Jaoued, 2026-07-10) : pas de recalcul au fil
  des événements. Les événements `change` des records ne font que **marquer dirty** ;
  `refresh()` est exécuté :
  1. **à la demande de l'utilisateur** — bouton preview-sub ;
  2. **automatiquement à la fin d'une action d'alignement ou d'égalisation** des subs
     (align-sub, equalize-sub, single-sub EQ, trim gain ±, revert LFE, et — v2 —
     align SPL et time align, qui recalculent les projections possédées au lieu de
     les laisser supprimées), au point de sortie d'opération existant
     (`setProcessing(false)` / `onProcessingEnded`, déjà utilisé par la persistance)
     — une action = au plus un recalcul, quel que soit le nombre d'écritures REW
     qu'elle contient.
- **N = 1 est un cas normal, pas un cas spécial** : avec un seul sub réel, la somme est
  un passe-plat. Les chemins mono-sub et multi-sub deviennent identiques ; le garde-fou
  et le bouton séparé « single sub optimizer » disparaissent à terme.
- **Devenir de `LFE Max Sum`** : une fois les réglages optimisés appliqués aux subs
  réels par align-sub, la projection recalculée *est* la somme maximisée — `Max Sum`
  disparaît comme entité séparée.
- **Theo calculée par le sub virtuel (v2, décision Jaoued 2026-07-11)** : la référence
  théorique est elle aussi une somme des subs — la somme **idéale, à phase nulle**
  (`calculateCombinedResponse(responses, theoreticalResponse = true)`), toujours en
  lecture seule. Elle devient la **seconde projection** de l'instance : activée par
  align-sub (`withTheo`), possédée (`theoUuid`), titrée `LFE Max Sum Theo_P<position>`
  et **recalculée à chaque refresh** — elle suit donc les trims et changements de
  réglages par recalcul, jamais par décalage. `alignSub` n'importe plus
  `optimizer.theoreticalMaxResponse` sur le chemin bridge : Theo sort de la même
  capture de réponses prédites que la projection.
- **Entrées : commandes de groupe (v2)** : le sub virtuel accepte des commandes qui
  s'appliquent à chaque sub réel (fan-out) puis déclenchent **un** recalcul des
  projections. Périmètre : la sémantique de **groupe** uniquement (offset SPL commun,
  délai commun, purge/distribution de filtres, inversion) — les réglages **par sub**
  (résultats de l'optimizer, import MSO) restent dans leurs services : ils sont
  individuels par nature et ne passent pas par cette façade. Cas limite tranché :
  `adjustSubwooferSPLLevels` (align SPL) n'est **pas** absorbé — sa cible
  `−20·log₁₀(N)` est bien une sémantique de groupe, mais chaque sub y est aligné sur
  sa propre fréquence centrale/étendue (analyse de bande passante individuelle) ;
  align SPL déclenche simplement le recalcul des projections possédées.
- **Le flag `isSubOperationResult` devient obsolète** : les opérations de niveau
  (trim gain ±) passent par `addSPLOffset` qui ne touche que les subs réels ; les
  projections (predicted + Theo) suivent par recalcul. Le flag est conservé pendant
  la transition puis retiré avec les chemins qu'il servait.

## Alternatives écartées

- **Corriger le flag sans changer l'architecture** (inclusion par titre dans
  `subsLikeMeasurements`, ou persistance du flag dans les notes REW) : pansement
  acceptable à court terme, mais l'identité resterait déclarative et à reconstruire à
  chaque rupture de session ; la duplication mono/multi demeure.
- **Somme via l'arithmétique REW comme source de vérité** : dépend d'un aller-retour
  REW par recalcul, non testable en unitaire, non couvert par le mock e2e
  (`arithmeticADividedByB` non implémenté), et divergerait des maths de l'optimizer
  utilisées par align-sub.
- **Recalcul immédiat sur chaque événement `change`** : une action comme align-sub
  écrit des dizaines de champs → rafales d'imports REW inutiles. Le couple
  dirty-marking + flush en fin d'opération donne le même résultat pour un coût borné.
- **Faire porter l'agrégat par un `MeasurementRecord` spécial** : le record (ADR 002)
  est le miroir d'une mesure REW ; l'agrégat est une entité de calcul avec un cycle de
  vie propre (projection jetable, uuid volatile). Les confondre recréerait le problème
  d'identité que cette décision supprime.

## Conséquences

- La classe de bugs « courbe dérivée orpheline » (flag perdu, courbes non suivies par
  les opérations de niveau) disparaît par construction.
- `sub-optimization.js` et `business-tools.js` se simplifient : `produceSubSums`,
  `createsSum` (chemin somme) et la création de `Max Sum` convergent vers
  `VirtualSubwoofer.refresh()`. Attention : ces fichiers alimentent les goldens
  multi-sub — le remplacement se fait chemin par chemin, suites `npm test` et
  `npm run test:all` vertes à chaque lot (invariants CLAUDE.md).
- Tests : la classe est testable en unitaire pur (fixtures de records + ops mockées) ;
  les goldens optimizer sont inchangés (les maths de somme ne bougent pas) ; le mock
  e2e n'a plus besoin d'implémenter l'arithmétique REW pour couvrir preview-sub.
- La classe est un module moteur piloté par événements, sans UI : elle constitue un
  joint de découpe propre pour la future migration Vue (ADR 001).
