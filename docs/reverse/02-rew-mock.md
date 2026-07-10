# Mock REW pour le harnais e2e — contrat, fixtures, conception

> Généré le 2026-06-11 (prompt 1.2). Lecture seule : aucun fichier source ni test n'a été modifié.
> Sources vérifiées : `src/rew/*.js` (11 modules, 2848 L), `test/unit/rew-api.test.js` (957 L),
> `test/auto-eq/test-config.js`, fixtures sous `test/auto-eq/` et `test/fixtures/`.
> Statut : **conception à valider avant le prompt 1.3**. Rien n'est implémenté.

---

## 1. Contrat REST REW réellement consommé [FAIT]

### 1.1 Conventions de transport (`rew-transport.js`, `rew-response.js`)

- Base URL par défaut : `http://localhost:4735` (modifiable dans l'UI, observable `apiBaseUrl` de MeasurementViewModel).
- Toutes les requêtes : `Accept: application/json` ; corps JSON avec `Content-Type: application/json` pour POST/PUT/PATCH (corps **obligatoire** pour ces méthodes, le client lève avant l'appel réseau sinon).
- Méthodes utilisées : GET, POST, PUT, DELETE (PATCH autorisé, non utilisé).
- Timeout client : **30 s** (`AbortController`). Après chaque écriture, le client attend `SPEED_DELAY` (500 ms, ou 20 ms si `inhibit-graph-updates`) — le mock n'a rien à faire, c'est côté client.
- Réponse `204` → traitée comme `{}`. Toute autre réponse doit être du **JSON valide**.
- **Contrat d'erreur** (important pour simuler des pannes) :
  - HTTP non-ok → le client lit le corps JSON et lève `[<status>] <message>` ; si le corps n'est pas du JSON, repli sur `statusText`.
  - Même en HTTP 200, si la réponse contient `results[0].Error`, le client lève cette erreur (`extractErrorMessage`).
  - Si `data.message` est une **chaîne JSON encodée**, elle est fusionnée dans l'objet réponse (`mergeParsedMessage`) — le mock peut donc renvoyer `{message: '{"...":...}'}` comme le fait REW.

### 1.2 Protocole de process asynchrone (`rew-process.js`) — cœur du mock

Toute écriture qui déclenche un traitement REW suit ce protocole, que le mock **doit** reproduire :

1. Le POST initial répond `{message: "<Nom du process> ID <n>"}` (l'ID peut aussi arriver via `processName`).
2. Le client polle alors en GET l'URL de résultat jusqu'à recevoir `{processName: "<Nom> ID <n>", message: "Completed", ...résultats}` (match **insensible à la casse, par sous-chaîne**). Max 300 tentatives espacées de 100 ms.
3. URL de résultat selon l'endpoint d'origine :
   - `/alignment-tool/*` → `GET /alignment-tool/result`
   - `/import/*` → **le même endpoint** en GET (la réponse doit contenir l'ID du process dans `message`/`processName`)
   - tout le reste → `GET /measurements/process-result`
   - sauf si le corps du POST contient `resultUrl` → cette URL est pollée à la place.
4. En mode `blocking=true` : pas de polling, un seul GET direct de l'URL de résultat.
5. Cas particulier imports : si `blocking=true` et POST vers `/import/frequency-response-data` ou `/import/impulse-response-data`, le client **désactive temporairement** le blocking (`POST /application/blocking false`) puis le restaure — le mock verra donc ces appels supplémentaires.
6. Si la réponse du POST ne contient **pas** d'`ID <n>`, elle est retournée telle quelle (pas de polling). → Le mock peut répondre de manière **synchrone** (résultat directement, sans ID) pour les opérations simples : c'est conforme au contrat et ça simplifie tout. Réserver le protocole ID+polling aux scénarios où on veut tester l'attente.

### 1.3 Routes par domaine

#### `/version` et `/application/*` (`rew-application.js`)

| Route | Méthodes | Réponse attendue |
|---|---|---|
| `/version` | GET | `{message: "5.40 beta 111"}` — doit matcher `VERSION_REGEX` et donner ≥ 54071 (5.40 beta 71). La fixture `FRavg.txt` mentionne « REW V5.40 beta 111 » : utiliser cette valeur. |
| `/application/blocking` | GET, POST | booléen |
| `/application/inhibit-graph-updates` | GET, POST | booléen |
| `/application/logging` | GET, POST | booléen |
| `/application/command` | POST `{command, parameters[]}` | utilisé au connect : `"Clear command in progress"` |
| `/application/commands`, `/application/last-error`, `/application/errors(+/subscribe…)`, `/application/warnings(…)` | GET/POST | wrappers existants, non critiques pour les parcours e2e |

**Séquence de connexion** (`initializeAPI` + `checkVersion`, déclenchée par le bouton Connect) :
`GET /application/inhibit-graph-updates` → (POST si différent) → `GET /application/blocking` → (POST si différent) → `POST /eq/default-equaliser` (corps = settings EQT par défaut de `REWEQ.defaulEqtSettings`) → `POST /application/command` (Clear) → `GET /version` → `GET /measurements` puis **polling `GET /measurements` toutes les 1 s** (`pollingInterval` du ViewModel). Le mock doit tenir ce polling permanent.

#### `/measurements` (collection) (`rew-measurements.js`)

| Route | Méthodes | Notes |
|---|---|---|
| `/measurements` | GET, DELETE | GET = source du polling ; objet/tableau de résumés. Champs consommés par `MeasurementItem` : `uuid` (clé d'identité), `title`, `notes`, `date`, `sampleRate`, `splOffsetdB`, `alignSPLOffsetdB`, `cumulativeIRShiftSeconds`, `timeOfIRStartSeconds`. |
| `/measurements/{id}` | GET, PUT, DELETE | `{id}` = UUID (règle du code : toujours UUID, jamais index) |
| `/measurements/selected`, `/measurements/selected-uuid` | GET, POST | sélection courante |
| `/measurements/max-measurements` | GET | capacité |
| `/measurements/process-measurements` | POST `{processName, measurementUUIDs|measurementIndices, parameters}` | **route centrale** : porte les process `Align SPL`, `Time align`, `Align IR start`, `Cross corr align`, `Smooth`, `Remove IR delays`, `Vector average`, `RMS average`, `dB average`, `dB plus phase average`, `Magn plus phase average`, `Vector sum`, `Arithmetic` |
| `/measurements/process-result` | GET | résultat du dernier process (cf. § 1.2) |
| `/measurements/process-commands`, `/measurements/commands`, `/measurements/command`, `/measurements/eq/commands`, `/measurements/arithmetic-functions` | GET/POST | introspection + commandes globales |
| `/measurements/frequency-response/units`, `…/smoothing-choices`, `/measurements/impulse-response/units`, `/measurements/distortion-units`, `…-ppo-choices`, `/measurements/spectrogram-*-choices` | GET | listes de choix statiques |

#### `/measurements/{id}/*` (par mesure)

| Route | Méthodes | Format réponse |
|---|---|---|
| `…/frequency-response?unit&smoothing&ppo` | GET | `{unit, startFreq, freqStep \| ppo, magnitude: <base64 float32>, phase?: <base64 float32>, …}` — le client reconstruit `freqs` à partir de `startFreq` + `freqStep` (linéaire) ou `ppo` (log) |
| `…/target-response?unit&ppo` | GET | idem (sans phase obligatoire) |
| `…/eq/frequency-response`, `…/eq/group-delay`, `…/eq/impulse-response` | GET | réponses **prédites** post-EQ, mêmes formats |
| `…/impulse-response?unit&windowed&normalised&samplerate` | GET | `{unit, startTime, sampleInterval, sampleRate, timingReference, timingRefTime, timingOffset, delay, data: <base64 float32>}` |
| `…/filters-impulse-response?length&samplerate` | GET | `{data: <base64 float32>, …}` |
| `…/group-delay`, `…/distortion`, `…/rt60?octaveFrac`, `…/rt60-settings` | GET | analyses |
| `…/equaliser` | GET, POST | équaliseur affecté (manufacturer/model…) |
| `…/filters` | GET, PUT, POST | tableau de filtres `{index, type, enabled, frequency, gain, q, …}` |
| `…/ir-windows` | GET, PUT, POST | fenêtres IR |
| `…/room-curve-settings` | GET, PUT, POST | settings courbe de salle |
| `…/target-level` | GET, POST | niveau cible (dB) |
| `…/target-settings` | GET, PUT, POST | settings cible |
| `…/command` | POST `{command, parameters, resultUrl?}` | commandes par mesure utilisées : `Save`, `Smooth`, `Mic in box correction`, `Merge cal data to IR`, `Generate waterfall`, `Generate spectrogram` (+ variantes equalised), `Estimate IR delay`, `Offset t=0`, `Add SPL offset`, `Invert`, `Invert phase`, `Trim IR to windows`, `Minimum phase version`, `Generate minimum phase` |
| `…/eq/command` | POST `{command, parameters?, resultUrl?}` | commandes EQ : `Calculate target level`, `Match target`, `Optimise gains`, `Optimise gains and Qs`, `Generate predicted measurement`, `Generate filters measurement`, `Generate target measurement` |
| `…/commands` | GET | liste des commandes disponibles |

#### `/eq/*` (`rew-eq.js`)

GET : `equalisers`, `manufacturers`, `target-shapes`, `crossover-types`, `slopes`, `commands`, `subscribers`.
GET/POST(/PUT/DELETE) : `default-equaliser`, `default-target-settings`, `default-target-level`, `default-room-curve-settings`, `house-curve` (POST = chemin de fichier, DELETE = retrait), `house-curve-log-interpolation`, `match-target-settings`, `command` (`Generate target measurement`).

#### `/import/*` (`rew-import.js`)

| Route | Méthodes | Corps |
|---|---|---|
| `/import/frequency-response-data` | POST, GET | `{identifier?, startFreq, freqStep \| ppo, magnitude: <base64>, phase: <base64>, …}` — **c'est par ici que l'app injecte dans REW les sommes/previews calculées par le moteur.** Encodage par `encodeFloat32ToBase64`. |
| `/import/impulse-response-data` | POST, GET | idem en IR |
| `/import/frequency-response`, `/import/impulse-response`, `/import/rta-file` (+`/progress`, `/save-options`), `/import/sweep-recordings/stimulus`, `…/response` | POST, GET | imports par chemin de fichier (côté machine REW) |
| `/import` , `/import/subscribers`, `/import/subscribe`, `/import/unsubscribe` | GET/POST | état du dernier import |

#### `/alignment-tool/*` (`rew-alignment-tool.js`)

- GET/POST par propriété : `mode` (+GET `modes`), `frequency`, `index-a`, `index-b`, `uuid-a`, `uuid-b`, `gain-a`, `gain-b`, `delay-b`, `invert-a`, `invert-b`, `max-positive-delay`, `max-negative-delay`, `remove-time-delay`.
- `POST /alignment-tool/command` avec `{command}` parmi : `Level phase`, `Undo level phase`, `Align phase slopes`, `Align phase`, `Filter IRs`, `Clear filter`, `Aligned copy of A`, `Aligned copy of B`, `Aligned sum`, `Reset all`.
- `GET /alignment-tool/result`, `GET /alignment-tool/filtered-impulse-response-a|b`.

### 1.4 Encodage binaire (`rew-codec.js`) — piège principal [FAIT]

Les tableaux numériques (`magnitude`, `phase`, `data`) transitent en **base64 de Float32 big-endian** (`isLittleEndian = false` par défaut dans `decodeBase64ToFloat32` / `encodeFloat32ToBase64`). Le mock **doit** encoder en big-endian, sinon les valeurs décodées seront du bruit. La bonne nouvelle : `encodeFloat32ToBase64` est exporté par `src/rew/rew-codec.js` (module [MOTEUR], zéro dépendance DOM) et **directement importable dans les handlers Playwright** (qui s'exécutent dans le process Node du test, pas dans le navigateur).

---

## 2. Fixtures existantes réutilisables et trous

### 2.1 Réutilisables [FAIT]

| Fixture | Contenu | Usage mock |
|---|---|---|
| `test/auto-eq/exemple{1..4}/` | `FRavg.txt` (mesure moyennée, magnitude+phase), `Target FRavg.txt` (cible), `EQ FRavg.txt` (EQ REW), `rew-auto-eq.txt` (filtres REW de référence) | corps de `…/frequency-response`, `…/target-response`, `…/filters` |
| `test/auto-eq/samples-48ppo/`, `samples-96ppo/`, `samples-96ppo-alt/` | mesures moyennées **par canal** : `Cavg`, `FLavg`, `FRavg`, `LFE`, `SBL/SBRavg`, `SLA/SRAavg`, `TFL/TFRavg`… | **seed idéal d'une session multi-canaux complète** (post-averaging) : un store de mesures par canal pour les parcours time align / align SPL / sub optimize / preview / export |
| `test/fixtures/frequency-response/` | `sw1.txt`, `sw1mp.txt`, `sw1mp-calculated.txt` (sub + versions minimum-phase) | réponses sub pour le parcours optimisation |
| `test/fixtures/multi-sub-optimizer/data*.test.js` | modules JS de configurations multi-sub | paramètres de scénario MSO |
| `work/Denon AVC-A1H_kef.4sub.3pos.ady` | session Audyssey réelle (4 subs, 3 positions) | fichier d'entrée du parcours « import .ady » — **hors dépôt de test** (répertoire `work/`), à copier dans `test/e2e/fixtures/` après validation (données personnelles ?) |

**Convertisseurs déjà écrits — le gros du travail est fait :**

- `parseREWFile(filePath)` et surtout **`parseREWFileAsAPI(filePath)`** dans `test/auto-eq/test-config.js` : parse un export texte REW (en-têtes `* Measurement:`, `* Start Frequency:`, `* Frequency Step:` ppo/linéaire, données `freq\tspl\tphase`) et retourne `{identifier, startFreq, ppo|freqStep, freqs, magnitude: Float32Array, phase: Float32Array}` — exactement la forme interne d'une réponse API.
- `encodeFloat32ToBase64` (`src/rew/rew-codec.js`) : transforme ces Float32Array en corps de réponse conforme.

→ **fixture .txt → réponse JSON API = `parseREWFileAsAPI` + `encodeFloat32ToBase64`**, deux fonctions existantes, zéro nouveau parseur.

### 2.2 Trous identifiés [FAIT — vérifié par recherche exhaustive]

| Trou | Impact parcours | Complément proposé (à valider) |
|---|---|---|
| **Aucune capture JSON de l'API** (pas un seul `.json` sous `test/`) : métadonnées de `/measurements` (uuid, title, date…) à inventer | tous | Générer les résumés synthétiquement dans le store du mock (uuid déterministes `e2e-0001…`, titres = noms de canaux des fixtures). Optionnel : capturer une vraie réponse `/measurements` sur une instance REW live pour valider la forme (one-shot, documenté ici). |
| **Pas de mesures multi-positions brutes** (`FR_P01…P03` citées dans l'en-tête de `FRavg.txt` mais absentes) | averaging | Synthétiser P01–P03 = `FRavg` ± offsets déterministes (±0,5 dB), et faire produire par le mock la fixture `FRavg` comme résultat du process `RMS average` / `Vector average`. La sortie est alors exactement la moyenne de référence. |
| **Aucune fixture de réponse impulsionnelle** (`…/impulse-response`, `…/filters-impulse-response`) | time align, sub optimize | Synthétiser des IR minimales (impulsion + délai connu par canal, `sampleRate` 48000) : le but du filet e2e est la parité UI, pas la précision acoustique des IR. Les délais injectés doivent être choisis pour produire des résultats d'alignement stables et vérifiables. |
| **Formes exactes non capturées** : `…/target-settings`, `…/room-curve-settings`, `…/equaliser`, `…/ir-windows`, `/eq/default-*` | align SPL, preview | Déduire les champs des écritures de l'app elle-même (le mock écho-mémorise ce que l'app POST/PUT, et sert des valeurs par défaut plausibles en GET initial). Marquer [SUPPOSÉ] jusqu'à vérification contre REW live. |
| `house-curve` POST = **chemin de fichier côté REW** | align SPL (target curve) | Le mock accepte n'importe quel chemin et marque la house curve « chargée » ; la cible servie ensuite vient de `Target FRavg.txt`. |
| `…/distortion`, `…/rt60` | aucun parcours README | Hors périmètre du filet : répondre 404 ou objet vide, à acter. |

---

## 3. Conception de la couche d'interception Playwright

### 3.1 Principe [proposition]

**Pas de serveur supplémentaire.** Les handlers `page.route()` s'exécutent dans le process **Node** du test Playwright : ils peuvent importer `parseREWFileAsAPI`, `encodeFloat32ToBase64` et lire les fixtures avec `readFileSync`. Le « mock REW » est une classe pure JS instanciée par test :

```js
// test/e2e/support/rew-mock/index.js (conception — non implémenté)
const rew = new RewMock();                      // store en mémoire
rew.seedScenario('samples-96ppo');              // mesures par canal depuis les fixtures
await rew.attach(page, 'http://localhost:4735'); // page.route('http://localhost:4735/**', dispatch)
```

Arborescence proposée :

```
test/e2e/support/rew-mock/
  index.js        # RewMock : attach(page), seedScenario(name), assertions d'inspection
  router.js       # table (méthode, pattern de path) → handler ; 404 JSON par défaut sur route inconnue (fail-fast)
  store.js        # état : Map uuid→measurement, props application/alignment-tool, file de process
  handlers/       # un module par domaine : application, measurements, measurement-detail, eq, import, alignment-tool
  fixtures.js     # chargement+cache : parseREWFileAsAPI(txt) → encodeFloat32ToBase64 → corps JSON
  scenarios/      # seeds nommés : samples-96ppo (session complète), averaging (P01-P03 synthétiques), subs (sw1*)
```

`fixtures.js` réutilise `test/auto-eq/test-config.js` par import direct (aucune copie). Si le couplage e2e→test/auto-eq gêne, extraire `parseREWFileAsAPI` vers un helper partagé `test/support/` — décision mineure à prendre à l'implémentation.

### 3.2 Comportement du mock — stateful minimal

Le mock est **avec état**, c'est indispensable : l'UI polle `GET /measurements` toutes les secondes et réagit aux apparitions/disparitions (`mergeMeasurements`). Règles :

1. **Store** : `Map<uuid, {summary, frequencyResponse, impulseResponse, filters, equaliser, targetSettings, …}>` ; UUID déterministes (`e2e-0001`, …) ; compteur de process IDs séquentiel.
2. **Process** (`process-measurements`, commandes, alignment) : par défaut **réponse synchrone** (résultat direct sans `ID <n>`, conforme § 1.2.6) et mutation immédiate du store — l'UI voit la nouvelle mesure au tick de polling suivant. Un mode optionnel `async: true` rejoue le protocole ID+polling pour tester les états « en cours » de l'UI.
3. **Mutations matérialisées** (ce que chaque process crée dans le store) :
   - `RMS/Vector average` sur P01…P03 → nouvelle mesure servie depuis la fixture `*avg` correspondante ;
   - `Cross corr align` / `Time align` → met à jour `cumulativeIRShiftSeconds` des mesures visées (valeurs dérivées des délais injectés dans les IR synthétiques) ;
   - `Align SPL` → met à jour `alignSPLOffsetdB`/`splOffsetdB` ;
   - `POST /import/frequency-response-data` → **décode le base64 reçu** et crée une mesure dont la FR re-servie est exactement ce que le moteur a envoyé (round-trip fidèle, clé pour les previews et sommes de subs) ;
   - `Aligned sum` (alignment-tool) → nouvelle mesure somme (fixture précalculée type `sw1mp-calculated.txt` ou somme réelle recalculée — à trancher à l'implémentation).
4. **Propriétés simples** (application/*, alignment-tool/*, target-level…) : écho-mémoire — GET sert la dernière valeur POSTée, défauts plausibles sinon.
5. **Routes non couvertes** : 404 JSON + log — un parcours qui touche une route imprévue doit **échouer bruyamment**, pas silencieusement.
6. **Simulation d'erreurs** : helpers `rew.failNext(route, {status, body})` pour tester les messages d'erreur UI (contrat § 1.1 : corps JSON avec `message`, ou `results[0].Error` en 200).

### 3.3 Couverture des workflows du README

| Workflow | Routes exercées | Fixtures | État |
|---|---|---|---|
| Connexion REW | `/application/*`, `/eq/default-equaliser`, `/version`, polling `/measurements` | aucune (synthétique) | ✅ couvert |
| Import .ady / load AVR | aucune (local au navigateur) | `.ady` de `work/` | ✅ hors mock |
| Averaging multi-positions | `process-measurements` (`RMS/Vector average`), polling | P01–P03 synthétiques → `*avg` | ⚠️ positions à synthétiser |
| Time Align | `process-measurements` (`Cross corr align`, `Time align`), `…/impulse-response`, `…/command` (`Offset t=0`, `Estimate IR delay`) | IR synthétiques | ⚠️ IR à synthétiser |
| Align SPL + target | `/eq/house-curve`, `…/target-settings`, `…/target-level`, `process-measurements` (`Align SPL`) | `Target FRavg.txt` | ✅ couvert (formes settings [SUPPOSÉ]) |
| Sub optimize | `…/frequency-response`, `/import/frequency-response-data` (round-trip), `/alignment-tool/*`, `…/filters` | `sw1*.txt`, samples LFE | ✅ couvert via round-trip |
| Preview | `/import/frequency-response-data`, `…/eq/frequency-response`, `…/eq/command` (`Generate predicted measurement`) | round-trip + fixtures | ✅ couvert |
| Export .oca / MSO / Equalizer APO | génération locale ; lectures `…/filters`, FR | store | ✅ couvert |
| Bascule EN/FR | aucune | — | ✅ hors mock |

### 3.4 Déterminisme

- UUIDs et process IDs séquentiels ; champ `date` des mesures figé (constante du scénario).
- Réponses servies sans délai (le `SPEED_DELAY` de 500 ms est côté client et reste actif — en tenir compte dans les timeouts e2e).
- Aucune dépendance réseau : toute requête sortante vers `:4735` est interceptée ; prévoir un `page.route` catch-all qui fait échouer le test si une URL externe non prévue est appelée.
- Le non-déterminisme restant (algo génétique du moteur, cf. `01-couverture.md` § sources de non-déterminisme) est **hors mock** — à traiter dans le prompt 1.3 (seed ou tolérances sur le .oca).

---

## 4. Compléments nécessitant validation avant 1.3

1. **Synthèse des positions P01–P03** (averaging) : OK pour des copies décalées de `FRavg` ? Alternative : exporter 3 vraies positions depuis REW une fois pour toutes (capture one-shot, tracée ici).
2. **Synthèse d'IR minimales** (time align) : impulsions à délais connus, suffisant pour la parité UI ? Alternative : capture one-shot d'IR réelles.
3. **Formes [SUPPOSÉ]** (`target-settings`, `room-curve-settings`, `equaliser`, `ir-windows`, `/eq/default-*`) : valider par une session de capture unique contre REW live (WSL : `WINDOWS_HOST` géré comme dans `test/unit/rew-api.test.js`), ou accepter l'écho-mémoire en l'état.
4. **Fichier `.ady` d'exemple** : copie de `work/Denon AVC-A1H_kef.4sub.3pos.ady` vers `test/e2e/fixtures/` — contient-il des données personnelles à anonymiser ?
5. **Partage de `parseREWFileAsAPI`** : import direct depuis `test/auto-eq/test-config.js` ou extraction vers `test/support/` ?
6. **`Aligned sum`** : fixture précalculée ou somme recalculée par le mock ?

Aucun de ces points ne bloque la conception ; ils déterminent le niveau de fidélité du mock. Après arbitrage, le prompt 1.3 peut implémenter `test/e2e/support/rew-mock/` puis les parcours.
