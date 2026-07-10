# ADR 001 — Framework UI cible et décisions de cadrage de la migration

- **Statut** : accepté (validé par Jaoued le 2026-06-12, cadrage du run de migration).
  **Mise à jour 2026-07-10** : le premier portage Vue a été abandonné (régressions de
  parité) — son historique est conservé sur la branche `feat/vue-migration`. La décision
  de cible Vue 3 reste valable pour une future tentative, qui repartira de la base
  décontaminée actuelle (moteur + services agnostiques, ADR 002).
- **Date** : 2026-06-12
- **Contexte** : migration de la couche de présentation de Knockout vers un framework moderne,
  en préservant intégralement le moteur de calcul (cf. `CLAUDE.md`,
  `docs/reverse/00-classification.md`). Les décisions ouvertes D-01 à D-07 de CLAUDE.md
  doivent être fermées avant d'engager le travail pour que les lots de migration composent
  entre eux sans renégocier la frontière à chaque étape.

## Décision principale : Vue 3, Composition API, SFC `<script setup>`

Le framework cible est **Vue 3** (Composition API, Single-File Components `<script setup>`,
build Vite déjà en place).

**Justification** : le mapping depuis Knockout est quasi 1:1, ce qui minimise le risque de
portage par rapport à React ou Svelte :

| Knockout | Vue 3 |
|---|---|
| `ko.observable` | `ref` |
| `ko.observableArray` | `ref([])` |
| `ko.computed` / `pureComputed` | `computed` |
| `obs.subscribe` | `watch` |
| `data-bind` (text/value/foreach/if/visible/click…) | `{{ }}` / `v-model` / `v-for` / `v-if` / `v-show` / `@click` |
| `bindingHandlers` custom | composant wrapper ou directive `v-…` |

La table de correspondance complète (avec les nuances `value`→`v-model.lazy`,
`textInput`→`v-model`) est dans CLAUDE.md (Annexe portage) et dans
`work/prompts-claude-code-migration-rch.md` Annexe A.

**Alternatives écartées** :
- *React* : modèle mental différent (immutabilité, re-render), réécriture des patterns
  observables au lieu d'une transposition — risque et coût supérieurs sans bénéfice pour ce projet.
- *Big-bang rewrite* (quel que soit le framework) : détruirait la valeur des golden masters
  comme filet de comparaison incrémental ; interdit par CLAUDE.md.
- *Rester sous Knockout* : bibliothèque en fin de vie, objectif du projet.

## Fermeture des décisions ouvertes de CLAUDE.md

### D-01 — Coexistence Knockout / Vue : **deux entrées Vite** (option a)

`src/index.html` (Knockout) reste l'entrée par défaut ; une entrée Vue séparée
(`src/vue.html` ou équivalent) est ajoutée à la config Vite (`build.rollupOptions.input`).
Les deux UIs sont buildables et servables en parallèle pendant toute la migration.
Écarté : feature-flag de compilation (complexité de build inutile) et micro-frontend
KO-dans-Vue (infrastructure injustifiée pour une SPA mono-page).

### D-02 — État global Vue : **Pinia** pour l'état partagé transverse

Pinia pour l'état partagé entre composants distants (session de mesures, connexion REW,
préférences) ; composables (`composables/useXxx.js`) pour l'état local ou partagé entre
composants proches. Pas de singleton mutable global. Écarté : Vuex (déprécié au profit de
Pinia), Composition API seule (l'état de session est intrinsèquement transverse).

### D-03 — Interface de `MeasurementItem` post-décontamination : **différée**

Sera instruite et actée dans un ADR dédié (ADR 002) pendant la phase de décontamination,
APRÈS la cartographie membre par membre et AVANT les lots d'extraction, comme l'exige
CLAUDE.md. Options en lice : POJO + EventEmitter vs record immuable.

### D-04 — `BusinessTools.js` : **reclassé [MOTEUR] (service)** après stabilisation

Une fois l'interface de MeasurementItem stabilisée (D-03), BusinessTools devient un service
moteur (il n'a aucun import `ko` ; seul son contrat d'appel — getters observables — doit être
adapté). Écarté : dissolution dans des composables Vue (réimplémenterait de l'orchestration
métier dans la couche UI, contraire à la règle absolue de CLAUDE.md).

### D-05 — `frequency-range-slider` : **composant Vue natif**

La logique log₁₀ (mapping fréquence↔position) est extraite vers un module moteur agnostique ;
le widget devient un composant Vue (template + événements pointeur). Écarté : lib tierce
(noUiSlider, vue-slider-component) — dépendance supplémentaire pour un widget déjà écrit
dont seul le rendu doit être porté.

### D-06 — i18n : **composable maison alimenté par `translations.js`**

`src/translations.js` (POJO EN/FR) reste la source unique des chaînes ; un composable
`useI18n` le consomme côté Vue. Aucune duplication de chaînes. Écarté : migration vers
vue-i18n — acceptable plus tard si le besoin (pluralisation, lazy-loading de locales)
apparaît, mais inutile à parité fonctionnelle.

### D-07 — `PersistentStore.js` : **conservé tel quel**

Déjà agnostique. Les composants Vue l'utilisent directement ; un wrapper `useStorage`
pourra être introduit ultérieurement si un besoin de réactivité sur le storage émerge.

### D-08 — Smoke test `test:smoke:knockout` : inchangé (déjà planifié)

Maintenu jusqu'au retrait de Knockout (post-cutover, hors périmètre de ce run).

## Conséquences

- `vite.config.js` portera deux entrées ; CI et `test:smoke` doivent couvrir les deux builds.
- Le harnais e2e est bi-cible (flag pour rejouer la même suite contre KO ou Vue).
- Toute logique métier rencontrée pendant le portage qui n'existe pas encore dans un module
  agnostique déclenche une étape de décontamination préalable — jamais une réimplémentation
  côté Vue.
- L'ADR 002 (D-03) est un prérequis bloquant des lots d'extraction de MeasurementViewModel.
