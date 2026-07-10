/**
 * MSO Equalizer-APO import into REW (lot MSO-B). Decontaminated equivalent of
 * BusinessTools.importFilterInREW (D-04, ADR 002): applies the parsed REW
 * configurations (filters, inversion, delay, gain) to the matching subwoofer
 * records through the operations service.
 *
 * [ORCHESTRATION] service — no Knockout, no DOM.
 *
 * Dependencies: `operations` (createMeasurementOperations instance) and
 * `session` (RewSession: rewMeasurements, findMeasurementByUuid,
 * removeMeasurementUuid).
 */

const unwrap = value => (typeof value === 'function' ? value() : value);

function createMsoImporter({ operations, session }) {
  const rew = () => session.rewMeasurements;

  // Same associated-filter invalidation the KO item wired into setFilters.
  const invalidateAssociatedFilter = measurement => async () => {
    if (measurement.associatedFilter == null) return;
    if (session.findMeasurementByUuid(measurement.associatedFilter)) {
      await session.removeMeasurementUuid(measurement.associatedFilter);
      measurement.associatedFilter = null;
    }
  };

  async function importFilterInREW(REWconfigs, subResponses) {
    for (const { filters, channel, invert, gain, delay } of REWconfigs) {
      const foundItem = Object.values(subResponses).find(item =>
        unwrap(item.title)?.toLowerCase().startsWith(channel.toLowerCase()),
      );
      if (!foundItem) {
        throw new Error(`Cannot find measurement name matching ${channel}`);
      }

      await operations.setFilters(rew(), foundItem, filters, {
        invalidateAssociatedFilter: invalidateAssociatedFilter(foundItem),
      });

      if (invert === -1) {
        await operations.setInverted(rew(), foundItem, true);
      } else if (invert === 1) {
        await operations.setInverted(rew(), foundItem, false);
      } else {
        throw new Error(`Invalid invert value for ${channel}`);
      }

      // reverse the MSO delay (ms → s) and apply the gain
      await operations.setcumulativeIRShiftSeconds(rew(), foundItem, -delay / 1000);
      await operations.setSPLOffsetDB(rew(), foundItem, gain);
    }
  }

  return { importFilterInREW };
}

export { createMsoImporter };
