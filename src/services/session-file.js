/**
 * Session file export/import (RCH 2.0, LOT 6).
 *
 * [ORCHESTRATION] service: serialises the whole working session to a user
 * file and restores it later. No Knockout, no DOM — the viewmodel handles
 * the Blob download and the file input.
 *
 * Product contract: the measurements themselves live in REW (the user saves
 * a `.mdat` there) — the RCH session carries everything else: persisted
 * settings, signal-less measurement state (ADR 002), the stripped AVR
 * context and the Reference/Flat filter banks. On import, measurements are
 * re-attached to REW by uuid by the existing sync (services/rew-session.js),
 * which reports the ones not found.
 *
 * File shape:
 *   { rchVersion, schemaVersion: 1, savedAt: ISO string, payload }
 * where `payload` is exactly the shared session payload of
 * services/persistence.js (`buildSessionPayload`).
 *
 * `rchVersion` is informative only (logged when different); `schemaVersion`
 * gates the import: a file newer than the supported schema is refused.
 */

const SESSION_FILE_SCHEMA_VERSION = 1;

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/**
 * Import validation error. `code` is a translation key resolved by the UI
 * layer (src/translations.js); `message` stays an English fallback.
 */
class SessionFileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SessionFileError';
    this.code = code;
  }
}

const INVALID_FORMAT_CODE = 'session_import_invalid_format';

const pad2 = value => String(value).padStart(2, '0');

/** Suggested file name: rch-session-YYYY-MM-DD-HHmm.json (local time). */
function sessionFileName(date) {
  const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  const time = `${pad2(date.getHours())}${pad2(date.getMinutes())}`;
  return `rch-session-${day}-${time}.json`;
}

/** Parses and validates the raw text of a session file (throws SessionFileError). */
function parseSessionFileText(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new SessionFileError(
      'session_import_invalid_json',
      `Invalid session file: not valid JSON (${error.message})`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SessionFileError(
      INVALID_FORMAT_CODE,
      'Invalid session file: expected a JSON object',
    );
  }
  if (!Number.isInteger(parsed.schemaVersion) || parsed.schemaVersion < 1) {
    throw new SessionFileError(
      INVALID_FORMAT_CODE,
      'Invalid session file: missing or invalid schemaVersion',
    );
  }
  if (parsed.schemaVersion > SESSION_FILE_SCHEMA_VERSION) {
    throw new SessionFileError(
      'session_import_unsupported_schema',
      `Unsupported session file: schemaVersion ${parsed.schemaVersion} is newer ` +
        `than the supported version ${SESSION_FILE_SCHEMA_VERSION} — update RCH`,
    );
  }
  if (!parsed.payload || typeof parsed.payload !== 'object' || Array.isArray(parsed.payload)) {
    throw new SessionFileError(
      INVALID_FORMAT_CODE,
      'Invalid session file: missing session payload',
    );
  }
  return parsed;
}

/**
 * Factory. Dependencies:
 * - `persistence`: the persistence service (buildSessionPayload /
 *   persistPayload / applySessionPayload).
 * - `appVersion`: current RCH version, written to exported files.
 * - `now`: clock injection (tests).
 */
function createSessionFile({ persistence, appVersion = '', log = noopLog, now = () => new Date() }) {
  /** Builds the export: file object, pretty JSON text and suggested name. */
  function exportSessionFile() {
    const savedAt = now();
    const file = {
      rchVersion: appVersion,
      schemaVersion: SESSION_FILE_SCHEMA_VERSION,
      savedAt: savedAt.toISOString(),
      payload: persistence.buildSessionPayload(),
    };
    return {
      file,
      json: JSON.stringify(file, null, 2),
      filename: sessionFileName(savedAt),
    };
  }

  /**
   * Validates and applies a session file. The imported session becomes the
   * current one: it is written to the persistent store (so a page reload
   * restores it) before being applied to the running application.
   */
  function importSessionFile(jsonText) {
    const file = parseSessionFileText(jsonText);
    if (file.rchVersion && file.rchVersion !== appVersion) {
      log.info(
        `Session file written by RCH ${file.rchVersion} (current version ${appVersion})`,
      );
    }
    persistence.persistPayload(file.payload);
    persistence.applySessionPayload(file.payload);
    log.info(`Session imported (saved at ${file.savedAt ?? 'unknown date'})`);
    return file;
  }

  return { exportSessionFile, importSessionFile };
}

export {
  SESSION_FILE_SCHEMA_VERSION,
  SessionFileError,
  createSessionFile,
  parseSessionFileText,
  sessionFileName,
};
