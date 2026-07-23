# ADR 004 — RCH Bridge (pilotage direct de l'ampli, RCH 2.0)

- **Statut** : accepté (décision Jaoued, 2026-07-22) — implémenté sur la branche
  `feat/rch-bridge-2.0` (client `src/bridge/`, services `bridge-session`,
  `avr-data-synthesis`, `bridge-measurement`, `filter-banks`,
  `calibration-transfer`, `session-file` ; parcours e2e `gating`, `measure`,
  `transfer`, `session-file`).
- **Contexte** : jusqu'à la 1.x, RCH s'arrêtait à la génération d'un fichier OCA
  et dépendait de programmes tiers pour tout ce qui touche l'ampli : odd.wtf ou
  A1 Evo Acoustica pour l'upload, un fichier `.avr` généré hors de l'application
  pour connaître la configuration du récepteur, l'app Audyssey pour mesurer. La
  configuration venait donc de fichiers figés au moment de leur génération —
  source récurrente d'écarts avec l'état réel de l'ampli (Amp Assign mismatch,
  EQType erroné) — et le navigateur ne pouvait pas parler lui-même aux amplis
  (protocole TCP propriétaire port 1256 / telnet 23, inaccessibles en fetch).
  Le RCH Bridge est un micro-serveur local (binaire lancé par l'utilisateur,
  `http://127.0.0.1:7735`, HTTP/JSON) qui parle ce protocole ; RCH 2.0
  l'intègre et supprime les fichiers `.avr`/OCA et les programmes externes du
  workflow.

## Décision : le bridge parle aux amplis, RCH reste une app web statique

- **Frontière** : tout ce qui touche le réseau de l'ampli (découverte SSDP,
  registre, telnet, sweeps Audyssey, transfert SET_COEFS) vit dans le binaire
  bridge (dépôt séparé). RCH reste une application web statique sans backend :
  elle consomme l'API HTTP locale du bridge comme elle consomme l'API REW. Le
  client est un module [MOTEUR] (`src/bridge/bridge-api.js` : enveloppe
  d'erreur typée `BridgeApiError`, `targetAddressSpace: 'loopback'` (Private
  Network Access), détection Safari/https non supporté, `MIN_BRIDGE_VERSION`,
  timeout) — zéro DOM, mockable en unitaire par `fetch` simulé.
- **Chaîne opérationnelle et blocage total** : l'application n'est utilisable
  que lorsque REW est connecté ∧ bridge connecté ∧ AVR enregistré (bandeau à
  trois voyants, computed `operationalChain`). Tant que la chaîne est
  incomplète, seuls les panneaux de connexion restent actifs (gating CSS
  `app-gated` + gardes logiques dans les services). Justification : chaque
  étape du parcours dépend de la configuration live de l'ampli — autoriser un
  workflow partiel reviendrait à retomber dans les états divergents que la 2.0
  supprime.
- **L'ampli connecté est LA source de la configuration** : `jsonAvrData` est
  synthétisé en direct depuis `GET /avr/info` + `GET /avr/status`
  (`src/services/avr-data-synthesis.js` : EQType → `enMultEQType`, ChSetup →
  `detectedChannels` avec normalisation SWMIX*→SW* et conservation du code fil,
  AssignBin, `AvrCaracteristics`). Les fichiers importés (`.ady`, `.mqx`,
  `.liveproject`) ne fournissent **que des mesures** ; un désaccord
  modèle/EQType fichier↔ampli produit un avertissement non bloquant, jamais un
  remplacement de configuration. **Règle d'identité anti-effacement** : à la
  (re)connexion, si la synthèse a la même identité (modèle + EQType + jeu de
  canaux) que la configuration restaurée, elle est rafraîchie **sans**
  `resetApplicationState()` — sinon chaque rechargement de page effacerait la
  session restaurée ; une identité différente déclenche le reset (nouvel ampli,
  nouveau projet).
- **Sémantique BUSY** : pendant une mesure ou un transfert, le bridge répond
  `409 {error: "BUSY", reason}` sur les endpoints AVR. BUSY signifie
  « connecté-occupé » — la chaîne reste verte, la raison est affichée — et ne
  doit **jamais** être traité comme une panne ou une déconnexion. Le polling de
  santé est volontairement léger : `GET /health` + `GET /avr/current` toutes
  les 2 s ; **jamais `GET /avr/status` en continu** (chaque appel status est un
  aller-retour TCP vers l'ampli). L'état AVR complet n'est lu qu'aux moments
  qui le requièrent (enregistrement, démarrage de session de mesure,
  construction de l'archive).
- **Workflow deux banques Reference/Flat** : le format Audyssey ne porte
  qu'**un seul** jeu de délais/niveaux/distances/crossovers (SET_SETDAT
  unique) ; seules les deux courbes de coefficients (`filterRef`/`filterFlat`)
  diffèrent — l'ampli bascule entre elles à l'écoute. Le magasin
  (`src/services/filter-banks.js`) capture les FIR par banque avec une
  **empreinte des paramètres non-filtres** : l'enregistrement de la seconde
  banque est refusé si autre chose que la courbe cible a changé (différences
  listées), et l'empreinte est re-vérifiée à la construction de l'archive
  (avertissement « banque périmée »). `duplicateToOtherBank` couvre le cas
  mono-cible (mêmes filtres des deux côtés). Le transfert exige les deux
  banques ; `ampAssign`/`ampAssignBin` sont lus en live juste avant le build —
  le mismatch d'assignation du workflow OCA disparaît par construction.
- **Specs FIR par eqType côté archive, générateur intouché** : le bridge
  attend des IR à 48 kHz et fait lui-même la décimation multi-bande — MultEQ
  128/512 (recopie), XT **513/4141**, XT32 16321/16055.
  `src/bridge/archive-specs.js` porte ces longueurs et les injecte au
  générateur existant (`OCAFileGenerator.createsFilters`) via un
  `avrFileContent` cloné : `src/oca-file.js` (moteur, chemin FIR + BW12 baked
  du raccord LR24|LR24) n'est pas modifié.
- **Session sans données de signal** : le fichier de session (`.json`,
  `src/services/session-file.js`) et l'auto-save partagent le même payload —
  réglages, état de travail des mesures (sans impulsions ni réponses), banques
  de filtres. Les mesures vivent dans REW et se persistent en `.mdat`
  (invariant ADR 002 : jamais de signal sur les records). À la restauration,
  les mesures se rattachent par identifiant ; les introuvables sont signalées
  (titre + position) au lieu d'être supprimées en silence.
- **e2e sur mocks in-process** : les parcours Playwright interceptent le port
  7735 avec un `BridgeMock` (`test/e2e/support/bridge-mock/`, même patron que
  le RewMock : `page.route`, `unknownRequests`, progression de
  mesure/transfert scriptée) — aucun binaire bridge ni ampli requis en CI ; la
  validation contre le matériel réel reste un passage manuel.

## Alternatives écartées

- **Continuer avec les fichiers OCA + programmes tiers** : c'est le statu quo
  que la 2.0 remplace — configuration figée à la génération du fichier,
  divergences ampli/fichier détectées seulement à l'upload, trois programmes à
  installer et maintenir hors de l'application.
- **Parler aux amplis depuis le navigateur** : impossible — le protocole est
  du TCP brut (1256/telnet 23), hors de portée de `fetch`/WebSocket sans
  intermédiaire local.
- **Backend hébergé (proxy cloud vers l'ampli)** : l'ampli n'est joignable que
  depuis le LAN de l'utilisateur ; un service distant ne peut pas l'atteindre
  et ferait transiter des données locales par un tiers. Le binaire local est
  le seul point d'exécution qui voie l'ampli.
- **Dupliquer Ref=Flat systématiquement (comportement 1.x)** : gaspille la
  moitié du format — les deux banques sont le seul levier d'A/B à l'écoute
  côté ampli. Le workflow deux banques l'exploite, la duplication reste
  disponible comme raccourci.
- **Stocker les filtres/banques sur les mesures ou dans le fichier de
  session REW** : violerait l'ADR 002 (pas de signal sur les records) ; les
  banques vivent dans un service dédié, sérialisées avec la session.

## Conséquences

- L'import `.avr` et l'export OCA (bouton, formats odd/A1) sont retirés de
  l'UI et des services ; `oca-file.js` reste [MOTEUR] comme générateur FIR du
  chemin des banques. Les pages et binaires odd.wtf sont retirés du site
  (`resources.html` distribue les binaires du bridge).
- `src/bridge/` rejoint la liste des dossiers [MOTEUR] ; les services bridge
  (`bridge-session`, `bridge-measurement`, `avr-data-synthesis`,
  `filter-banks`, `calibration-transfer`, `session-file`) suivent le patron
  services existant mais n'ont **pas** le double chemin `operations` (ADR
  002) : ils ne réécrivent pas l'état des mesures, à l'exception de l'import
  d'IR de `bridge-measurement` qui réutilise `importImpulseResponse` du
  service d'import existant.
- La mesure Audyssey complète (détection position 1, positions suivantes par
  sous-ensemble de canaux, import des IR au fil de l'eau, sublevel SPL live)
  se fait sans quitter l'application ; la calibration micro est portée par le
  bridge (aucun fichier de calibration côté RCH). Les IR mesurées s'importent
  dans REW à la convention fichier du modèle (`AvrCaracteristics.splOffset`,
  105 dB Cirrus / 80 dB sinon — même domaine GET_RESPONSE que les
  `responseData` des `.ady`) ; le `levelReference.dbSplAtFullScale` du bridge
  est une ancre du domaine de capture brute ADC (ingrédient de la formule de
  trim) et ne s'applique pas à l'échelle numérique de l'IR déconvoluée —
  amendement du 2026-07-23, il n'est plus utilisé à l'import.
- **Subwoofers multiples** (amendement du 2026-07-23) : l'ampli expose ses
  subwoofers dans `ChSetup` et accepte des filtres/gains/délais **par sub
  dans tous les modes** — la synthèse live conserve donc SW1..SWn tels
  quels, sans repli lié au `SWMode`. Le mode Directional est un mode de
  **mesure** : il fournit les réponses individuelles des subs (hors
  Directional, le protocole officiel mutualise le sweep — un seul canal
  mesurable ; dans ce cas la calibration du sub mesuré est **dupliquée**
  vers chaque sub détecté au moment des banques et de l'archive — par
  linéarité, filtrer chaque sub revient à filtrer la somme mesurée).
  L'état final visé après transfert reste le mode Standard avec
  les réglages propres à chaque sub (lignée A1Evo) ; le `SET_SETDAT` du
  bridge échoit le `SWSetup` lu en direct sur l'ampli au moment du
  transfert.
- Toute évolution de l'API bridge se négocie par `MIN_BRIDGE_VERSION` côté
  client et par la version du binaire côté serveur ; les erreurs arrivent
  typées (enveloppe `{error, message?, reason?, details?}`) et jamais dans un
  200.
