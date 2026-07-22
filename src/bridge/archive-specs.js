/**
 * Specs de filtres pour la CalibrationArchive du bridge (FR-062).
 *
 * Longueurs d'ENTREE attendues par POST /transfer, par eqType : ce sont des
 * IR REW a 48 kHz pour XT/XT32 (le bridge fait lui-meme la decimation
 * multi-bande Mrate3), et le format final AVR pour MultEQ (recopie telle
 * quelle, FR-066) — d'ou les specs BASIC identiques a celles de l'app.
 * Seul XT differe des specs historiques (512@6k) : le bridge attend
 * 513/4141 taps a 48 kHz.
 *
 * [MOTEUR] : consommees en clonant l'avrFileContent passe au generateur OCA
 * (`avr.multEQSpecs` remplace) — zero modification de oca-file.js.
 */

const BRIDGE_FILTER_SPECS = Object.freeze({
  // MultEQ (0) : recopie directe par le bridge — format final AVR.
  0: Object.freeze({
    subFilter: Object.freeze({ samples: 512, taps: 512, frequency: 48000 }),
    speakerFilter: Object.freeze({ samples: 128, taps: 128, frequency: 6000 }),
  }),
  // MultEQ XT (1) : IR 48 kHz, decimation MBP cote bridge.
  1: Object.freeze({
    subFilter: Object.freeze({ samples: 4141, taps: 4141, frequency: 48000 }),
    speakerFilter: Object.freeze({ samples: 513, taps: 513, frequency: 48000 }),
  }),
  // MultEQ XT32 (2) : identiques aux specs historiques de l'app.
  2: Object.freeze({
    subFilter: Object.freeze({ samples: 16055, taps: 704, frequency: 48000 }),
    speakerFilter: Object.freeze({ samples: 16321, taps: 1024, frequency: 48000 }),
  }),
});

// Domaine des crossovers accepte par le transfert : jetons officiels FR-129
// + 70 Hz (firmwares recents — le bridge est corrige cote rch-bridge pour
// l'accepter ; MIN_BRIDGE_VERSION suivra cette version). Toute autre valeur
// est refusee AVANT l'envoi, jamais arrondie (RCH = autorite acoustique).
const TRANSFER_CROSSOVER_DOMAIN = Object.freeze([
  40, 60, 70, 80, 90, 100, 110, 120, 150, 180, 200, 250,
]);

/**
 * Clone l'avrFileContent avec les specs de filtres du bridge : le generateur
 * OCA (createsFilters) produira directement des FIR aux longueurs FR-062.
 */
function cloneAvrDataWithBridgeSpecs(avrData) {
  const specs = BRIDGE_FILTER_SPECS[avrData?.enMultEQType];
  if (!specs) {
    throw new Error(`Unsupported MultEQ type for transfer: ${avrData?.enMultEQType}`);
  }
  return {
    ...avrData,
    avr: { ...avrData.avr, multEQSpecs: specs },
  };
}

export { BRIDGE_FILTER_SPECS, TRANSFER_CROSSOVER_DOMAIN, cloneAvrDataWithBridgeSpecs };
