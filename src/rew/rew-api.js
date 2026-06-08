/**
 * REW Client Base
 * Classe de facade pour les clients de l'API REST de Room EQ Wizard.
 * Les responsabilites internes sont separees par module pour garder cette API
 * publique stable et lisible.
 */
import REWEQ from './rew-eq.js';
import REWImport from './rew-import.js';
import REWAlignmentTool from './rew-alignment-tool.js';
import REWMeasurements from './rew-measurements.js';
import { applicationMethods } from './rew-application.js';
import { codecStatics } from './rew-codec.js';
import { processMethods } from './rew-process.js';
import { responseStatics } from './rew-response.js';
import { subscriberStatics } from './rew-subscriber.js';
import { transportMethods, transportStatics } from './rew-transport.js';

class RewApi {
  static TIMEOUT_MS = 30000;
  static WAIT_BETWEEN_RETRIES_MS = 100;
  static MAX_POLLING_RETRY = Math.floor(
    RewApi.TIMEOUT_MS / RewApi.WAIT_BETWEEN_RETRIES_MS,
  );
  static SPEED_DELAY_INHIBIT_MS = 20;
  static SPEED_DELAY_NORMAL_MS = 500;
  static VERSION_REGEX = /^\s*(?:REW\s+)?v?(\d{1,3})\.(\d{1,3})\s+beta\s+(\d{1,4})\b/i;
  static MIN_REQUIRED_VERSION = 54071;
  static ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);
  static BODY_REQUIRED_METHODS = new Set(['POST', 'PUT', 'PATCH']);
  static WRITE_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
  static IMPORT_DATA_ENDPOINTS = new Set([
    '/import/frequency-response-data',
    '/import/impulse-response-data',
  ]);

  constructor(
    baseURL = 'http://localhost:4735',
    inhibitGraphUpdates = false,
    blocking = false,
  ) {
    this.setBaseURL(baseURL);
    this.blocking = blocking;
    this.inhibitGraphUpdates = inhibitGraphUpdates;
    this.importBlockingBypassCount = 0;
    this.importBlockingRestorePending = false;

    this.rewEq = new REWEQ(this);
    this.rewMeasurements = new REWMeasurements(this);
    this.rewImport = new REWImport(this);
    this.rewAlignmentTool = new REWAlignmentTool(this);
  }
}

Object.assign(RewApi, transportStatics, responseStatics, subscriberStatics, codecStatics);

Object.assign(RewApi.prototype, transportMethods, applicationMethods, processMethods);

export default RewApi;
