/**
 * Virtual subwoofer (ADR 003) — the combined response of the real subwoofers
 * of a listening position, owned by the application and projected into REW.
 *
 * [ORCHESTRATION] service. No Knockout, no DOM, no UI framework.
 *
 * Outputs — the virtual sub is the source of identity: `refresh()` recomputes
 * the sums client-side (same maths as the MultiSubOptimizer, covered by the
 * multi-sub goldens) and replaces the REW projections (delete + import):
 *  - `LFE predicted_P<position>`: complex sum of the subs' predicted responses;
 *  - `LFE Max Sum Theo_P<position>` (when enabled by align-sub): the ideal,
 *    zero-phase sum of the same responses — a read-only reference, recomputed
 *    at every refresh so it follows level/settings changes by recomputation.
 * The instance owns both uuids — nothing is looked up by title or tagged after
 * the fact. N = 1 is a normal case (the sum of one sub is that sub's predicted
 * response).
 *
 * Inputs (ADR 003 v2) — group commands: `addSPLOffset`, `addDelay`,
 * `setInverted`, `resetFilters`, `setFilters` and the generic `forEachSub`
 * fan the operation out to every real sub, then the projections are
 * recomputed once. Only group semantics belong here — per-sub settings
 * (optimizer results, MSO import) stay in their services.
 *
 * Recompute policy (ADR 003): record `change` events only mark the instance
 * dirty; `refresh({ force: true })` runs on user demand (preview-sub) and at
 * the end of alignment/equalisation/level actions.
 *
 * Construction dependencies:
 * - `session`: rew-session service (measurements list, removeMeasurement*,
 *   addMeasurementFromRewOperation, rewImport, rewMeasurements).
 * - `getSubsByPosition`: () => ({ [position]: [subs…] }) — real subwoofer
 *   measurements grouped by listening position.
 * - `operations`: (optional) createMeasurementOperations instance. When absent
 *   the measurement objects are driven through their own methods (Knockout
 *   entry); when provided the calls route to the operations functions over
 *   flat records (ADR 002), with `workingSettingsConfig`/`irWindowWidthsFor`
 *   providing the per-measurement context.
 */

import { synthesizeImpulseFromResponse } from '../dsp/impulse-synthesis.js';
import { predictedLfeTitle } from '../measurement/measurement-info.js';
import { calculateCombinedResponse } from '../optimizer/response.js';

export { DEFAULT_LFE_PREDICTED } from '../measurement/measurement-info.js';

const THEO_TITLE_PREFIX = 'LFE Max Sum Theo_P';

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const unwrap = value => (typeof value === 'function' ? value() : value);

function buildMeasurementApi({
  operations,
  session,
  workingSettingsConfig = () => undefined,
  irWindowWidthsFor = () => undefined,
}) {
  // Predicted (equalised) frequency response — read-only REW call, identical
  // for items and records: only the uuid is needed.
  const predictedFrequencyResponse = m =>
    session.rewMeasurements.getPredictedFrequencyResponse(m.uuid, {});

  if (!operations) {
    return {
      predictedFrequencyResponse,
      removeWorkingSettings: m => m.removeWorkingSettings(),
      applyWorkingSettings: m => m.applyWorkingSettings(),
      resetTargetSettings: m => m.resetTargetSettings(),
      setTitle: (m, title, notes) => m.setTitle(title, notes),
      addSPLOffsetDB: (m, amount) => m.addSPLOffsetDB(amount),
      addIROffsetSeconds: (m, seconds) => m.addIROffsetSeconds(seconds),
      setInverted: (m, inverted) => m.setInverted(inverted),
      resetFilters: m => m.resetFilters(),
      setFilters: (m, filters, overwrite) => m.setFilters(filters, overwrite),
    };
  }

  const rew = () => session.rewMeasurements;
  return {
    predictedFrequencyResponse,
    removeWorkingSettings: m =>
      operations.removeWorkingSettings(rew(), m, irWindowWidthsFor(m)),
    applyWorkingSettings: m =>
      operations.applyWorkingSettings(rew(), m, workingSettingsConfig()),
    resetTargetSettings: m => operations.resetTargetSettings(rew(), m),
    setTitle: (m, title, notes) => operations.setTitle(rew(), m, title, notes),
    addSPLOffsetDB: (m, amount) => operations.addSPLOffsetDB(rew(), m, amount),
    addIROffsetSeconds: (m, seconds) => operations.addIROffsetSeconds(rew(), m, seconds),
    setInverted: (m, inverted) => operations.setInverted(rew(), m, inverted),
    resetFilters: m =>
      operations.resetFilters(rew(), m),
    setFilters: (m, filters, overwrite) =>
      operations.setFilters(rew(), m, filters, {
        overwrite,
      }),
  };
}

/** One virtual subwoofer per listening position. */
class VirtualSubwoofer {
  constructor({ position, session, mops, log }) {
    this.position = position;
    this.projectionUuid = null;
    this.theoUuid = null;
    this.withTheo = false;
    this.dirty = true;
    this.session = session;
    this.mops = mops;
    this.log = log;
    this.unsubscribes = new Map();
  }

  get title() {
    return predictedLfeTitle(this.position);
  }

  get theoTitle() {
    return `${THEO_TITLE_PREFIX}${this.position}`;
  }

  markDirty() {
    this.dirty = true;
  }

  /**
   * Declare the projection consistent with the real subs. Reserved for callers
   * that applied the SAME delta to every sub AND to the projection in place
   * (produceAligned: shared offset + inversion — the sum of shifted subs is the
   * shifted sum, so re-projecting would be a no-op). Any later change to a sub
   * marks the instance dirty again through watch().
   */
  markConsistent() {
    this.dirty = false;
  }

  /** Watch the real subs' records: any API delta marks the instance dirty. */
  watch(subs) {
    const seen = new Set();
    for (const sub of subs) {
      const record = sub.record ?? (typeof sub.on === 'function' ? sub : null);
      if (!record) continue;
      seen.add(record);
      if (!this.unsubscribes.has(record)) {
        this.unsubscribes.set(record, record.on('change', () => this.markDirty()));
      }
    }
    for (const [record, unsubscribe] of this.unsubscribes) {
      if (!seen.has(record)) {
        unsubscribe();
        this.unsubscribes.delete(record);
      }
    }
  }

  /** Full-range predicted response of each real sub, working settings restored. */
  async captureResponses(subs) {
    const responses = [];
    for (const sub of subs) {
      await this.mops.removeWorkingSettings(sub);
      await this.mops.resetTargetSettings(sub);
      const frequencyResponse = await this.mops.predictedFrequencyResponse(sub);
      await this.mops.applyWorkingSettings(sub);
      responses.push(frequencyResponse);
    }
    return responses;
  }

  /** Combined predicted response of the real subs, computed client-side. */
  async response(subs) {
    return calculateCombinedResponse(await this.captureResponses(subs));
  }

  /**
   * Re-establish ownership over projections restored from a previous session
   * (persistence or REW-side survivors): adopt the same-title measurements so
   * they are replaced — not duplicated — by the next refresh. An adopted Theo
   * re-enables its recomputation.
   */
  adoptExistingProjection() {
    const byTitle = title =>
      this.session.measurements.get().find(item => unwrap(item.title) === title);
    if (!this.projectionUuid) {
      const existing = byTitle(this.title);
      if (existing) {
        this.projectionUuid = existing.uuid;
        this.dirty = true;
      }
    }
    if (!this.theoUuid) {
      const existingTheo = byTitle(this.theoTitle);
      if (existingTheo) {
        this.theoUuid = existingTheo.uuid;
        this.withTheo = true;
        this.dirty = true;
      }
    }
  }

  /** Remove an owned projection uuid, tolerating an already-gone measurement. */
  async removeOwned(uuid) {
    if (!uuid) return;
    if (this.session.findMeasurementByUuid(uuid)) {
      await this.session.removeMeasurementUuid(uuid);
    }
  }

  /** Remove the current projections and any legacy same-title measurement. */
  async removeProjection() {
    await this.removeOwned(this.projectionUuid);
    this.projectionUuid = null;
    await this.removeOwned(this.theoUuid);
    this.theoUuid = null;
    const titles = new Set([this.title, this.theoTitle]);
    const legacy = this.session.measurements
      .get()
      .filter(item => titles.has(unwrap(item.title)));
    await this.session.removeMeasurements(legacy);
  }

  /**
   * Import a computed sum into REW, title it and post-process it.
   *
   * The sum is imported as an IMPULSE response (client-side inverse FFT):
   * REW exposes no impulse data for frequency-response imports, which breaks
   * every IR consumer (Find Sub Alignment, previews, peak measurements).
   *
   * The impulse is centered in the buffer and imported with the matching
   * NEGATIVE startTime: every sample keeps its physical time (the peak
   * arithmetic of produceAligned still holds — verified on a live REW) and
   * the content before t = 0 is preserved. Without this, zero-phase sums
   * (Theo) and negatively-delayed sums wrap their anticausal half to the end
   * of the buffer and REW discards it: truncated responses.
   */
  async project(sum, title, notes, sampleRate) {
    const impulse = synthesizeImpulseFromResponse(sum, { sampleRate, center: true });
    const options = {
      identifier: title.slice(0, 24),
      startTime: impulse.startTimeSeconds,
      sampleRate: impulse.sampleRate,
      splOffset: 0,
      applyCal: false,
      data: impulse.data,
    };
    const projection = await this.session.addMeasurementFromRewOperation(
      () => this.session.rewImport.importImpulseResponseData(options),
      { expectedTitle: options.identifier, operationLabel: title },
    );
    if (!projection) {
      throw new Error(`Error creating ${title}`);
    }

    await this.mops.setTitle(projection, title, notes);
    await this.mops.applyWorkingSettings(projection);
    // Transition (ADR 003): downstream consumers still identify derived sub
    // curves through this flag; it is removed with the paths it serves.
    projection.isSubOperationResult = true;
    return projection;
  }

  /**
   * Recompute the sums and replace the REW projections (predicted, plus the
   * zero-phase Theo reference when enabled). No-op when the instance is clean
   * and already projected, unless `force` is set. Returns the predicted
   * projection, or null when the position has no sub.
   */
  async refresh(subs, { force = false, theoResponse = null } = {}) {
    if (!subs?.length) {
      await this.removeProjection();
      return null;
    }
    this.adoptExistingProjection();
    if (!force && !this.dirty && this.projectionUuid) {
      const existing = this.session.findMeasurementByUuid(this.projectionUuid);
      const theoOk = !this.withTheo || this.session.findMeasurementByUuid(this.theoUuid);
      if (existing && theoOk) return existing;
    }

    this.watch(subs);
    const titles = subs.map(sub => unwrap(sub.title));
    this.log.info(`Using: ${titles.join(', ')} to create subwoofer sum`);

    const responses = await this.captureResponses(subs);
    const sum = calculateCombinedResponse(responses);
    const sampleRate = Number(unwrap(subs[0].sampleRate)) || undefined;
    await this.removeProjection();

    const projection = await this.project(
      sum,
      this.title,
      `sum from:\n${titles.join('\n')}`,
      sampleRate,
    );
    this.projectionUuid = projection.uuid;

    if (this.withTheo) {
      // Reference ceiling: the caller-provided raw response when available
      // (align-sub passes the pre-optimization sum — no EQ, no gain trims —
      // so the Theo is invariant to the applied settings), otherwise the
      // zero-phase sum of the current predicted responses.
      const theoSum = theoResponse ?? calculateCombinedResponse(responses, true);
      const theo = await this.project(
        theoSum,
        this.theoTitle,
        `theoretical (zero-phase) sum from:\n${titles.join('\n')}`,
        sampleRate,
      );
      this.theoUuid = theo.uuid;
    }

    this.dirty = false;
    this.log.info(`Subwoofer sum created successfully: ${this.title}`);
    return projection;
  }

  // --- Group commands (ADR 003 v2): fan-out over the real subs --------------

  /** Apply `fn(mops, sub)` to every real sub, then mark the instance dirty. */
  async forEachSub(subs, fn) {
    for (const sub of subs) {
      await fn(this.mops, sub);
    }
    this.markDirty();
  }

  async addSPLOffset(subs, amountdB) {
    return this.forEachSub(subs, (mops, sub) => mops.addSPLOffsetDB(sub, amountdB));
  }

  async addDelay(subs, seconds) {
    return this.forEachSub(subs, (mops, sub) => mops.addIROffsetSeconds(sub, seconds));
  }

  async setInverted(subs, inverted) {
    return this.forEachSub(subs, (mops, sub) => mops.setInverted(sub, inverted));
  }

  async resetFilters(subs) {
    return this.forEachSub(subs, (mops, sub) => mops.resetFilters(sub));
  }

  /** Distribute one filter set to every sub (all-pass slot preserved by default). */
  async setFilters(subs, filters, { overwrite = false } = {}) {
    return this.forEachSub(subs, (mops, sub) => mops.setFilters(sub, filters, overwrite));
  }

  dispose() {
    for (const unsubscribe of this.unsubscribes.values()) {
      unsubscribe();
    }
    this.unsubscribes.clear();
  }
}

/**
 * Registry of the per-position virtual subwoofers, with multi-position
 * variants of the group commands.
 */
function createVirtualSubwooferService({
  session,
  getSubsByPosition,
  operations = null,
  workingSettingsConfig,
  irWindowWidthsFor,
  log = noopLog,
}) {
  if (!session) throw new Error('session is required');
  if (typeof getSubsByPosition !== 'function') {
    throw new TypeError('getSubsByPosition provider is required');
  }

  const mops = buildMeasurementApi({
    operations,
    session,
    workingSettingsConfig,
    irWindowWidthsFor,
  });
  const byPosition = new Map();

  function subwooferFor(position) {
    // Group keys come either from Object.entries (strings) or from the
    // measurements' position field (numbers): normalise to one instance.
    const key = String(position);
    if (!byPosition.has(key)) {
      byPosition.set(
        key,
        new VirtualSubwoofer({ position: key, session, mops, log }),
      );
    }
    return byPosition.get(key);
  }

  function markDirty() {
    for (const virtualSub of byPosition.values()) {
      virtualSub.markDirty();
    }
  }

  /** Position-level markConsistent — see VirtualSubwoofer.markConsistent. */
  function markConsistent(position) {
    subwooferFor(position).markConsistent();
  }

  /** Groups targeted by a command: one position, or every non-empty group. */
  function targetGroups(position) {
    const groups = getSubsByPosition();
    if (position != null) {
      const subs = groups[position] ?? [];
      return subs.length ? [[String(position), subs]] : [];
    }
    return Object.entries(groups).filter(([, subs]) => subs.length);
  }

  /**
   * Refresh one position; subs default to the current group of the position.
   * `withTheo: true` (align-sub) enables the zero-phase Theo reference — it
   * then stays enabled and is recomputed by every subsequent refresh.
   * `theoResponse` (optional) supplies the reference to project instead of
   * the zero-phase sum of the current predicted responses: align-sub passes
   * the RAW ceiling (no EQ filters, no gain trims) so the Theo stays
   * invariant whatever settings the optimizer applied.
   */
  async function refresh(position, { force = false, withTheo, theoResponse } = {}) {
    const virtualSub = subwooferFor(position);
    if (withTheo === true) virtualSub.withTheo = true;
    const subs = getSubsByPosition()[position] ?? [];
    return virtualSub.refresh(subs, { force, theoResponse });
  }

  /**
   * Refresh every position that currently has subs; positions whose subs are
   * gone see their projections removed and their instance dropped.
   */
  async function refreshAll({ force = false } = {}) {
    const groups = getSubsByPosition();
    const projections = [];
    for (const [position, subs] of Object.entries(groups)) {
      if (!subs.length) continue;
      projections.push(await subwooferFor(position).refresh(subs, { force }));
    }
    for (const [position, virtualSub] of byPosition) {
      if (groups[position]?.length) continue;
      await virtualSub.refresh([], {});
      virtualSub.dispose();
      byPosition.delete(position);
    }
    return projections;
  }

  /**
   * Refresh only the positions that already carry a projection (owned or
   * adopted from a restored session) — used after group commands on the real
   * subs so existing predicted curves follow without creating new ones.
   */
  async function refreshProjected({ force = false, position } = {}) {
    const projections = [];
    for (const [key, subs] of targetGroups(position)) {
      const virtualSub = subwooferFor(key);
      virtualSub.adoptExistingProjection();
      if (!virtualSub.projectionUuid) continue;
      projections.push(await virtualSub.refresh(subs, { force }));
    }
    return projections;
  }

  /** Run an instance command on the targeted groups, then recompute once. */
  async function applyCommand(run, { position } = {}) {
    for (const [key, subs] of targetGroups(position)) {
      await run(subwooferFor(key), subs);
    }
    return refreshProjected({ force: true, position });
  }

  const addSPLOffset = (amountdB, options) =>
    applyCommand((virtualSub, subs) => virtualSub.addSPLOffset(subs, amountdB), options);
  const addDelay = (seconds, options) =>
    applyCommand((virtualSub, subs) => virtualSub.addDelay(subs, seconds), options);
  const setInverted = (inverted, options) =>
    applyCommand((virtualSub, subs) => virtualSub.setInverted(subs, inverted), options);
  const resetFilters = options =>
    applyCommand((virtualSub, subs) => virtualSub.resetFilters(subs), options);
  const setFilters = (filters, options = {}) =>
    applyCommand(
      (virtualSub, subs) =>
        virtualSub.setFilters(subs, filters, { overwrite: options.overwrite }),
      options,
    );
  const forEachSub = (fn, options) =>
    applyCommand((virtualSub, subs) => virtualSub.forEachSub(subs, fn), options);

  function dispose() {
    for (const virtualSub of byPosition.values()) {
      virtualSub.dispose();
    }
    byPosition.clear();
  }

  return {
    subwooferFor,
    markDirty,
    markConsistent,
    refresh,
    refreshAll,
    refreshProjected,
    addSPLOffset,
    addDelay,
    setInverted,
    resetFilters,
    setFilters,
    forEachSub,
    dispose,
  };
}

export { THEO_TITLE_PREFIX, VirtualSubwoofer, createVirtualSubwooferService };
