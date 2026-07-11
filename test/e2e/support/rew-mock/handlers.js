import { encodeFloat32ToBase64 } from '../../../../src/rew/rew-codec.js';
import { resampleToPpo } from './dsp.js';

/**
 * Route table of the REW mock. Each entry: [method, regex, handler].
 * Handlers receive (store, match, query, body) and return the JSON body
 * to serve (or { __status, ...body } to override the HTTP status).
 *
 * Conventions (cf. docs/reverse/02-rew-mock.md):
 * - processes answer synchronously, without `ID <n>` (no client polling);
 * - process responses that create a measurement return {results:[{UUID}]};
 * - property endpoints are echo-memory;
 * - anything not listed here 404s (fail-fast, asserted by the journeys).
 */

const ok = { message: 'Completed' };

function frequencyResponseBody(store, record, query) {
  const linear = store.linearResponse(record);
  const ppo = query.get('ppo');
  const grid = ppo ? resampleToPpo(linear, Number(ppo)) : linear;
  const body = {
    unit: query.get('unit') ?? 'SPL',
    smoothing: record.smoothing,
    startFreq: grid.startFreq,
    magnitude: encodeFloat32ToBase64(grid.magnitude),
    phase: encodeFloat32ToBase64(grid.phase),
  };
  if (grid.ppo) body.ppo = grid.ppo;
  else body.freqStep = grid.freqStep;
  return body;
}

function targetResponseBody(record, query) {
  // Flat target at the measurement target level — UI-parity approximation.
  const ppo = Number(query.get('ppo')) || 96;
  const freqs = [];
  for (let f = 10; f <= 24000; f *= Math.pow(2, 1 / ppo)) freqs.push(f);
  const magnitude = new Float32Array(freqs.length).fill(record.targetLevel);
  return {
    unit: query.get('unit') ?? 'SPL',
    startFreq: 10,
    ppo,
    magnitude: encodeFloat32ToBase64(magnitude),
  };
}

function applyOffsetTZero(record, parameters) {
  const offset = Number(parameters?.offset) || 0;
  record.cumulativeIRShiftSeconds = roundFloat(
    record.cumulativeIRShiftSeconds + offset,
    10,
  );
  record.timeOfIRPeakSeconds = roundFloat(record.timeOfIRPeakSeconds - offset, 10);
  record.timeOfIRStartSeconds = roundFloat(record.timeOfIRStartSeconds - offset, 10);
  return ok;
}

function roundFloat(value, decimals) {
  return Number(value.toFixed(decimals));
}

function cloneAsResult(store, record, title) {
  const clone = store.createRecord({
    title,
    sampleRate: record.sampleRate,
    splOffsetdB: record.splOffsetdB,
    timeOfIRStartSeconds: record.timeOfIRStartSeconds,
    timeOfIRPeakSeconds: record.timeOfIRPeakSeconds,
    ir: record.ir,
    fr: record.fr,
  });
  clone.targetLevel = record.targetLevel;
  return { results: [{ UUID: clone.uuid }] };
}

function sumIRs(store, records, gains = null, delays = null, inverts = null) {
  const sampleRate = records[0].sampleRate;
  const length = Math.min(...records.map(r => r.ir.length));
  const out = new Float32Array(length);
  for (let idx = 0; idx < records.length; idx++) {
    const ir = records[idx].ir;
    const gain = Math.pow(10, (gains?.[idx] ?? 0) / 20) * (inverts?.[idx] ? -1 : 1);
    const delaySamples = Math.round((delays?.[idx] ?? 0) * sampleRate);
    for (let i = 0; i < length; i++) {
      const j = i - delaySamples;
      if (j >= 0 && j < length) out[i] += ir[j] * gain;
    }
  }
  return out;
}

function handleProcessMeasurements(store, body) {
  const { processName, measurementUUIDs = [], parameters = {} } = body;
  const records = measurementUUIDs.map(uuid => {
    const record = store.get(uuid);
    if (!record) throw new Error(`Unknown measurement UUID: ${uuid}`);
    return record;
  });

  switch (processName) {
    case 'Align SPL': {
      const frequencyHz = Number(parameters.frequencyHz) || 1000;
      const spanOctaves = Number(parameters.spanOctaves) || 0;
      const levels = records.map(record =>
        store.levelAround(record, frequencyHz, spanOctaves),
      );
      const target =
        parameters.targetdB === 'average' || Number.isNaN(Number(parameters.targetdB))
          ? levels.reduce((a, b) => a + b, 0) / levels.length
          : Number(parameters.targetdB);
      const results = records.map((record, i) => {
        const offset = roundFloat(target - levels[i], 4);
        record.alignSPLOffsetdB = roundFloat(record.alignSPLOffsetdB + offset, 4);
        record.splOffsetdB = roundFloat(record.splOffsetdB + offset, 4);
        return { UUID: record.uuid, alignSPLOffsetdB: record.alignSPLOffsetdB };
      });
      return { message: 'Completed', results };
    }
    case 'Smooth': {
      for (const record of records) record.smoothing = parameters.smoothing ?? 'None';
      return ok;
    }
    case 'Cross corr align': {
      const reference = records[0];
      for (const record of records.slice(1)) {
        const shift = roundFloat(
          record.timeOfIRPeakSeconds - reference.timeOfIRPeakSeconds,
          10,
        );
        applyOffsetTZero(record, { offset: shift });
      }
      return ok;
    }
    case 'Time align':
    case 'Align IR start':
    case 'Remove IR delays':
      return ok;
    case 'Vector average':
    case 'RMS average':
    case 'dB average':
    case 'dB plus phase average':
    case 'Magn plus phase average': {
      const average = store.createAverage(measurementUUIDs, processName);
      return { message: 'Completed', results: [{ UUID: average.uuid }] };
    }
    case 'Vector sum': {
      const sum = store.createRecord({
        title: `Vector sum ${store.uuidCounter + 1}`,
        sampleRate: records[0].sampleRate,
        splOffsetdB: records[0].splOffsetdB,
        ir: sumIRs(store, records),
      });
      return { message: 'Completed', results: [{ UUID: sum.uuid }] };
    }
    case 'Arithmetic': {
      // Only A + B is needed by the journeys; extend on demand.
      const fn = parameters.function ?? 'A + B';
      if (fn !== 'A + B') {
        throw new Error(`Arithmetic function not implemented in mock: ${fn}`);
      }
      const sum = store.createRecord({
        title: `Arithmetic ${store.uuidCounter + 1}`,
        sampleRate: records[0].sampleRate,
        splOffsetdB: records[0].splOffsetdB,
        ir: sumIRs(store, records),
      });
      return { message: 'Completed', results: [{ UUID: sum.uuid }] };
    }
    default:
      throw new Error(`Process not implemented in mock: ${processName}`);
  }
}

function handleMeasurementCommand(store, record, body) {
  const { command, parameters = {} } = body;
  switch (command) {
    case 'Offset t=0':
      return applyOffsetTZero(record, parameters);
    case 'Add SPL offset':
      record.splOffsetdB = roundFloat(
        record.splOffsetdB + (Number(parameters.offset) || 0),
        4,
      );
      return ok;
    case 'Invert':
    case 'Invert phase':
      record.inverted = !record.inverted;
      return ok;
    case 'Save':
    case 'Smooth':
    case 'Estimate IR delay':
      return ok;
    case 'Trim IR to windows': {
      // REW creates a new, trimmed measurement; the app reads its UUID
      // from the result (analyseApiResponse).
      if (!record.ir) throw new Error('Trim IR to windows requires an IR');
      const sampleRate = record.sampleRate;
      const windowMs =
        Number(record.irWindows?.rightWindowWidthms) || (record.ir.length / sampleRate) * 1000;
      const t0Index = Math.max(Math.round(-record.timeOfIRStartSeconds * sampleRate), 0);
      // REW's trimmed IR spans the window inclusively and zero-pads past
      // the available data: length = window × fs + 1.
      const length = Math.round((windowMs / 1000) * sampleRate) + 1;
      const ir = new Float32Array(length);
      ir.set(record.ir.subarray(t0Index, Math.min(t0Index + length, record.ir.length)));
      const trimmed = store.createRecord({
        title: `${record.title} trimmed`,
        sampleRate,
        splOffsetdB: record.splOffsetdB,
        timeOfIRStartSeconds: 0,
        timeOfIRPeakSeconds: 0,
        ir,
      });
      return { results: [{ UUID: trimmed.uuid }] };
    }
    case 'Minimum phase version':
    case 'Generate minimum phase':
      return cloneAsResult(store, record, `${record.title} (min phase)`);
    case 'Excess phase version':
      return cloneAsResult(store, record, `${record.title} (excess phase)`);
    case 'Response copy':
      return cloneAsResult(store, record, `${record.title} copy`);
    default:
      throw new Error(`Measurement command not implemented in mock: ${command}`);
  }
}

function handleMeasurementEqCommand(store, record, body) {
  const { command } = body;
  switch (command) {
    case 'Calculate target level': {
      record.targetLevel = roundFloat(store.levelAround(record, 1000, 3), 2);
      return ok;
    }
    case 'Match target':
      // The mock does not compute EQ; REW-mode parity is asserted on
      // workflow outputs, not on filter values.
      record.filters = record.filters.length
        ? record.filters
        : [
            {
              index: 1,
              type: 'PK',
              enabled: true,
              frequency: 100,
              gain: -3,
              q: 4,
            },
          ];
      return ok;
    case 'Generate predicted measurement':
      return cloneAsResult(store, record, `${record.title} predicted`);
    case 'Generate filters measurement': {
      // REW serves the EQ filter's own impulse response. The mock does not
      // model EQ, so the filter is an identity impulse (UI-parity stub).
      const length = 4096;
      const ir = new Float32Array(length);
      ir[0] = 1;
      const filter = store.createRecord({
        title: `${record.title} filters`,
        sampleRate: record.sampleRate,
        splOffsetdB: 0,
        timeOfIRStartSeconds: 0,
        timeOfIRPeakSeconds: 0,
        ir,
      });
      return { results: [{ UUID: filter.uuid }] };
    }
    case 'Generate target measurement':
      return generateTargetMeasurement(store, record);
    default:
      throw new Error(`EQ command not implemented in mock: ${command}`);
  }
}

function generateTargetMeasurement(store, referenceRecord) {
  const level = referenceRecord?.targetLevel ?? store.eq['default-target-level'];
  const sampleRate = 48000;
  const n = 4096;
  // Flat target as an FR-only measurement (no impulse response fields).
  const bins = n / 2;
  const freqStep = sampleRate / n;
  const magnitude = new Float32Array(bins).fill(level);
  const phase = new Float32Array(bins);
  const record = store.createRecord({
    title: 'Target',
    splOffsetdB: 0,
    fr: { startFreq: freqStep, freqStep, magnitude, phase },
  });
  record.targetLevel = level;
  return { results: [{ UUID: record.uuid }] };
}

function echoProperty(container, key) {
  return [
    ['GET', () => (container[key] === null ? {} : container[key])],
    [
      'POST',
      body => {
        container[key] = body;
        return ok;
      },
    ],
    [
      'PUT',
      body => {
        container[key] = body;
        return ok;
      },
    ],
    [
      'DELETE',
      () => {
        container[key] = null;
        return ok;
      },
    ],
  ];
}

function buildRoutes(store) {
  const routes = [];
  const add = (method, pattern, handler) => routes.push({ method, pattern, handler });

  // ---- application ----
  add('GET', /^\/version$/, () => ({ message: '5.40 beta 111' }));
  for (const key of ['blocking', 'inhibit-graph-updates', 'logging']) {
    add('GET', new RegExp(`^/application/${key}$`), () => store.application[key]);
    add('POST', new RegExp(`^/application/${key}$`), (m, q, body) => {
      store.application[key] = body === true || body === 'true';
      return ok;
    });
  }
  add('POST', /^\/application\/command$/, () => ok);
  add('GET', /^\/application\/last-error$/, () => ({ message: '' }));

  // ---- eq globals ----
  for (const key of Object.keys(store.eq)) {
    for (const [method, fn] of echoProperty(store.eq, key)) {
      add(method, new RegExp(`^/eq/${key}$`), (m, q, body) => fn(body));
    }
  }
  add('POST', /^\/eq\/command$/, (m, q, body) => {
    if (body.command === 'Generate target measurement') {
      return generateTargetMeasurement(store, null);
    }
    throw new Error(`Global EQ command not implemented in mock: ${body.command}`);
  });

  // ---- measurements collection ----
  add('GET', /^\/measurements$/, () => store.list());
  add('DELETE', /^\/measurements$/, () => {
    store.measurements.clear();
    return ok;
  });
  add('GET', /^\/measurements\/max-measurements$/, () => 199);
  add('POST', /^\/measurements\/process-measurements$/, (m, q, body) =>
    handleProcessMeasurements(store, body),
  );
  add('GET', /^\/measurements\/process-result$/, () => store.lastProcessResult ?? ok);

  // ---- per measurement ----
  const id = '([^/]+)';
  const measurement = handler => (match, query, body) => {
    const record = store.get(decodeURIComponent(match[1]));
    if (!record) return { __status: 404, message: `No measurement ${match[1]}` };
    return handler(record, query, body);
  };

  add('GET', new RegExp(`^/measurements/${id}$`), measurement(r => store.summary(r)));
  add(
    'PUT',
    new RegExp(`^/measurements/${id}$`),
    measurement((r, q, body) => {
      if (body.title !== undefined) r.title = body.title;
      if (body.notes !== undefined) r.notes = body.notes;
      return ok;
    }),
  );
  add(
    'DELETE',
    new RegExp(`^/measurements/${id}$`),
    measurement(r => {
      store.delete(r.uuid);
      return ok;
    }),
  );
  add(
    'GET',
    new RegExp(`^/measurements/${id}/frequency-response$`),
    measurement((r, q) => frequencyResponseBody(store, r, q)),
  );
  add(
    'GET',
    new RegExp(`^/measurements/${id}/eq/frequency-response$`),
    measurement((r, q) => frequencyResponseBody(store, r, q)),
  );
  add(
    'GET',
    new RegExp(`^/measurements/${id}/target-response$`),
    measurement((r, q) => targetResponseBody(r, q)),
  );
  add(
    'GET',
    new RegExp(`^/measurements/${id}/impulse-response$`),
    measurement((r, q) => {
      if (!r.ir) return { __status: 404, message: 'No impulse response' };
      const targetRate = Number(q.get('samplerate')) || r.sampleRate;
      let data = r.ir;
      if (targetRate !== r.sampleRate) {
        // Linear-interpolation resample — UI-parity approximation.
        const ratio = r.sampleRate / targetRate;
        const length = Math.max(Math.floor(r.ir.length / ratio), 1);
        const resampled = new Float32Array(length);
        for (let i = 0; i < length; i++) {
          const pos = i * ratio;
          const lo = Math.min(Math.floor(pos), r.ir.length - 1);
          const hi = Math.min(lo + 1, r.ir.length - 1);
          const t = pos - lo;
          resampled[i] = r.ir[lo] * (1 - t) + r.ir[hi] * t;
        }
        data = resampled;
      }
      if (q.get('normalised') === 'true') {
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v));
        if (peak > 0) {
          const normalised = new Float32Array(data.length);
          for (let i = 0; i < data.length; i++) normalised[i] = data[i] / peak;
          data = normalised;
        }
      }
      return {
        unit: q.get('unit') ?? 'percent',
        startTime: r.timeOfIRStartSeconds,
        sampleInterval: 1 / targetRate,
        sampleRate: targetRate,
        timingReference: 'None',
        timingRefTime: 0,
        timingOffset: 0,
        delay: 0,
        data: encodeFloat32ToBase64(data),
      };
    }),
  );
  add(
    'GET',
    new RegExp(`^/measurements/${id}/filters-impulse-response$`),
    measurement((r, q) => {
      const length = Number(q.get('length')) || 4096;
      const data = new Float32Array(length);
      data[0] = 1; // identity filter — the mock does not model EQ
      return {
        sampleRate: Number(q.get('samplerate')) || r.sampleRate,
        startTime: 0,
        data: encodeFloat32ToBase64(data),
      };
    }),
  );
  add(
    'GET',
    new RegExp(`^/measurements/${id}/target-level$`),
    measurement(r => r.targetLevel),
  );
  add(
    'POST',
    new RegExp(`^/measurements/${id}/target-level$`),
    measurement((r, q, body) => {
      r.targetLevel = Number(body);
      return ok;
    }),
  );
  for (const [key, prop] of [
    ['target-settings', 'targetSettings'],
    ['ir-windows', 'irWindows'],
    ['room-curve-settings', 'roomCurveSettings'],
    ['equaliser', 'equaliser'],
  ]) {
    add(
      'GET',
      new RegExp(`^/measurements/${id}/${key}$`),
      measurement(r => r[prop]),
    );
    for (const method of ['POST', 'PUT']) {
      add(
        method,
        new RegExp(`^/measurements/${id}/${key}$`),
        measurement((r, q, body) => {
          r[prop] = { ...r[prop], ...body };
          return ok;
        }),
      );
    }
    add(
      'DELETE',
      new RegExp(`^/measurements/${id}/${key}$`),
      measurement(r => {
        r[prop] = {};
        return ok;
      }),
    );
  }
  add(
    'GET',
    new RegExp(`^/measurements/${id}/filters$`),
    measurement(r => r.filters),
  );
  for (const method of ['POST', 'PUT']) {
    add(
      method,
      new RegExp(`^/measurements/${id}/filters$`),
      measurement((r, q, body) => {
        // REW merges by slot index. Bodies seen from the app:
        // {filters: [...]} (POST), a single filter object or an array (PUT).
        const incoming = Array.isArray(body) ? body : (body.filters ?? [body]);
        for (const filter of incoming) {
          const slot = r.filters.findIndex(f => f.index === filter.index);
          if (slot >= 0) r.filters[slot] = { ...r.filters[slot], ...filter };
        }
        return ok;
      }),
    );
  }
  add(
    'POST',
    new RegExp(`^/measurements/${id}/command$`),
    measurement((r, q, body) => handleMeasurementCommand(store, r, body)),
  );
  add(
    'POST',
    new RegExp(`^/measurements/${id}/eq/command$`),
    measurement((r, q, body) => handleMeasurementEqCommand(store, r, body)),
  );

  // ---- import ----
  add('POST', /^\/import\/impulse-response-data$/, (m, q, body) => {
    const record = store.createFromImpulseImport(body);
    store.lastImport = { message: `Imported ${record.title}` };
    return store.lastImport;
  });
  add('GET', /^\/import\/impulse-response-data$/, () => store.lastImport ?? {});
  add('POST', /^\/import\/frequency-response-data$/, (m, q, body) => {
    const record = store.createFromFrequencyImport(body);
    store.lastImport = { message: `Imported ${record.title}` };
    return store.lastImport;
  });
  add('GET', /^\/import\/frequency-response-data$/, () => store.lastImport ?? {});

  // ---- alignment tool ----
  for (const key of Object.keys(store.alignmentTool)) {
    add('GET', new RegExp(`^/alignment-tool/${key}$`), () => store.alignmentTool[key]);
    add('POST', new RegExp(`^/alignment-tool/${key}$`), (m, q, body) => {
      store.alignmentTool[key] = body;
      return ok;
    });
  }
  add('GET', /^\/alignment-tool\/modes$/, () => ['Impulse', 'Frequency']);
  add('POST', /^\/alignment-tool\/command$/, (m, q, body) => {
    const tool = store.alignmentTool;
    switch (body.command) {
      case 'Reset all': {
        tool['gain-a'] = 0;
        tool['gain-b'] = 0;
        tool['delay-b'] = 0;
        tool['invert-a'] = false;
        tool['invert-b'] = false;
        store.lastAlignmentResult = ok;
        return ok;
      }
      case 'Align IRs':
      case 'Cross corr align': {
        // Deterministic outcome: B is declared aligned with zero extra delay.
        store.lastAlignmentResult = {
          message: 'Completed',
          results: [{ Delay: 0, 'Delay B ms': 0, Invert: false }],
        };
        return store.lastAlignmentResult;
      }
      case 'Aligned sum': {
        const a = store.get(tool['uuid-a']);
        const b = store.get(tool['uuid-b']);
        if (!a?.ir || !b?.ir) {
          throw new Error('Aligned sum needs two measurements with IR data');
        }
        const ir = sumIRs(
          store,
          [a, b],
          [Number(tool['gain-a']) || 0, Number(tool['gain-b']) || 0],
          [0, Number(tool['delay-b']) / 1000 || 0],
          [Boolean(tool['invert-a']), Boolean(tool['invert-b'])],
        );
        const sum = store.createRecord({
          title: `Aligned sum ${store.uuidCounter + 1}`,
          sampleRate: a.sampleRate,
          splOffsetdB: a.splOffsetdB,
          ir,
        });
        store.lastAlignmentResult = { message: 'Completed', results: [{ UUID: sum.uuid }] };
        return store.lastAlignmentResult;
      }
      default:
        throw new Error(`Alignment command not implemented in mock: ${body.command}`);
    }
  });
  add('GET', /^\/alignment-tool\/result$/, () => store.lastAlignmentResult ?? ok);

  return routes;
}

export { buildRoutes };
