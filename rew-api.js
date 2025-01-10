// creates funtions for api operation
const baseUrl = 'http://localhost:4735';
const speedDelay = 255;
const EQ_SETTINGS = {
  MANUFACTURER: "Generic",
  MODEL: "Generic"
};

// ERROR
function throwError(errorInput) {
  const errorMessage = Array.isArray(errorInput)
    ? errorInput.join('\n\n')
    : errorInput?.toString() || 'An unknown error occurred';

  clearCommands();
  updateAPI('inhibit-graph-updates', false);
  updateAPI('blocking', false);

  console.error(errorMessage);
  throw new Error(errorMessage);
}

// Cache the regex pattern
const VERSION_REGEX = /(\d+)\.(\d+)\sBeta\s(\d+)/;
const MAX_RETRIES = 5;
const MAX_RETRY_DELAY = 5; // seconds

async function checkTargetCurve() {
  let versionOK = false;
  let retryCount = 0;

  while (!versionOK && retryCount < MAX_RETRIES) {
    try {
      const tcResponse = await fetch(`${baseUrl}/eq/house-curve`);
      const target = tcResponse.ok ? await tcResponse.json() : null;
      const targetCurvePath = target?.message;
      const missingTargetCurve = !target || !targetCurvePath;

      if (missingTargetCurve) {
        // Implement exponential backoff
        const retryLeft = MAX_RETRIES - retryCount;
        const delay = Math.min(Math.pow(2, retryCount), MAX_RETRY_DELAY);
        console.warn(`Target curve not found. Please upload your preferred target curve under "REW/EQ/Target settings/House curve". Retrying in ${delay} seconds, left ${retryLeft}`);
        await new Promise(resolve => setTimeout(resolve, speedDelay));
        retryCount++;
      } else {
        console.info(`Using target curve : ${targetCurvePath}`);
        versionOK = true;
      }
      return targetCurvePath;

    } catch (error) {
      throwError(`Error checking target curve: ${error}`);
      retryCount++;

      if (retryCount === MAX_RETRIES) {
        throw new Error('Maximum retry attempts reached while checking target curve');
      }
    }
  }

  return versionOK;
}

async function checkVersion() {
  let versionOK = false;

  try {
    const rewVersionResponse = await fetch(`${baseUrl}/version`);

    if (!rewVersionResponse.ok) {
      throwError(`Error checking version: not ok`);
      return versionOK;
    }
    const rewData = await rewVersionResponse.json();
    let versionString = rewData.message;

    const versionMatch = VERSION_REGEX.exec(versionString);

    if (!versionMatch) {
      throw new Error(`Invalid version format: ${versionString}`);
    }

    const [, major, minor, beta] = versionMatch.map(v => parseInt(v, 10));

    console.info(`Using REW version: ${versionString}`);

    versionOK = major > 5 ||
      (major === 5 && minor > 40) ||
      (major === 5 && minor === 40 && beta >= 64);

    if (!versionOK) {
      throwError(
        `Installed REW version (${versionString}) is outdated and incompatible with A1 Evo! ` +
        `Please install the latest REW Beta from https://www.avnirvana.com/threads/rew-api-beta-releases.12981/.`
      );
    }


  } catch (error) {
    throwError(`Error checking version: ${error}`);

  }

  return versionOK;
}

async function resetREWSettings() {
  const defaultSettings = {
    manufacturer: EQ_SETTINGS.MANUFACTURER,
    model: EQ_SETTINGS.MODEL
  };

  try {
    await postSafe(
      `eq/default-equaliser`,
      defaultSettings,
      "Default equaliser changed"
    );
  } catch {
    throwError("Could not set the equalizer.");
  }

  clearCommands();
  resetAll();
}

async function resetAll() {
  try {
    const allResponses = await fetchREW();
    const nTotal = Object.keys(allResponses).length;

    const resetOperations = [
      { path: 'Smooth', data: { smoothing: "None" }, isNext: true },
      { path: 'ir-windows', data: { leftWindowType: "Rectangular", rightWindowType: "Rectangular", addFDW: false } },
      { path: 'target-settings', data: { shape: "None" } },
      { path: 'room-curve-settings', data: { addRoomCurve: false } },
      { path: 'equaliser', data: { manufacturer: "Generic", model: "Generic" } }
    ];

    for (let i = 1; i <= nTotal; i++) {
      console.info(`Resetting settings... ${((i / nTotal) * 100).toFixed(1)}%`);

      for (const operation of resetOperations) {
        try {
          if (operation.isNext) {
            await postNext(operation.path, i, operation.data);
          } else {
            if (operation.path === 'ir-windows' && allResponses[i].cumulativeIRShiftSeconds) {
              await postSafe(`measurements/${i}/${operation.path}`, operation.data, "Update processed");
            }
          }
          // Minimal delay to prevent overwhelming the server
          await new Promise(resolve => setTimeout(resolve, speedDelay / 10));
        } catch (error) {
          throw new Error(`Failed to reset ${JSON.stringify(operation)} for response ${i}: ${error}`);
        }
      }
    }

    console.info('Reset complete');
  } catch (error) {
    throwError(`Reset failed: ${error}`);
  }
}

// REW API
async function updateAPI(endpoint, bodyValue) {
  const url = `${baseUrl}/application/${endpoint}`;
  return await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyValue)
  });
}

async function clearCommands() {
  const body = { command: 'Clear command in progress' };
  return await updateAPI('command', body);
}

async function fetchREW(indice = null, method = 'GET', body = null) {
  const requestUrl = `${baseUrl}/measurements${indice !== null ? `/${indice}` : ''}`;
  const requestOptions = {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(method === 'PUT' && body && { body: JSON.stringify(body) })
  };
  return await fetchWithRetry(requestUrl, requestOptions, 3);
}

async function fetchSafe(requestUrl, indice = null, parameters = null) {
  const url = `${baseUrl}/measurements${indice ? `/${indice}` : ''}/${requestUrl}`;
  const options = {
    method: parameters ? 'POST' : 'GET',
    ...(parameters && {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parameters)
    })
  };

  return await fetchWithRetry(url, options);

}

async function fetchAlign(requestUrl) {
  const url = `${baseUrl}/alignment-tool/${requestUrl}`;
  const options = {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' }
  };

  return await fetchWithRetry(url, options);

}

// Helper function to make HTTP requests with consistent error handling
async function fetchWithRetry(url, options, retries = 3,
  expectedMessage = null,
  expectedHTTPCode = null) {
  if (!url || !options) {
    throw new Error('Missing parameters');
  }
  try {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.message || `HTTP error! status: ${response.status}`);
    } else if (response.status > 400) {
      throw new Error(data.message || `HTTP error! status: ${response.status}`);
    } else if (expectedMessage && !data.message.includes(expectedMessage)) {
      throw new Error(data.message || `HTTP error! status: ${response.status}`);
    } else if (expectedHTTPCode && response.status > expectedHTTPCode) {
      throw new Error(data.message || `HTTP error! status: ${response.status}`);
    } else {
      return data;
    }
  } catch (error) {
    if (retries > 0) {
      console.debug(`${error.message}\nRetrying ${url}... ${retries - 1} attempts left`);
      // gives more time for process to complete
      await new Promise(resolve => setTimeout(resolve, speedDelay * 2));
      return await fetchWithRetry(url, options, retries = retries - 1, expectedMessage, expectedHTTPCode);
    } else {
      throw new Error(`Max retries reached: ${error.message}`);
    }
  }
}


/**
 * Executes a process for measurements with retry capability
 * @param {string} processName - Name of the process to execute
 * @param {string|string[]} uuids - Single UUID or array of measurement UUIDs
 * @param {Object} [parameters=null] - Optional parameters for the process
 * @returns {Promise<Object>} Process result
 */
async function postNext(processName, uuids, parameters = null, retries = 0) {
  if (!processName || !uuids) {
    throw new Error('Process name and UUIDs are required');
  }
  const isProcessMeasurements = Array.isArray(uuids);
  // Determine the type of command based on parameters
  const commandType = parameters === null
    ? 'eq/command'
    : 'command';
  // Build the appropriate endpoint based on measurement type
  const endpoint = isProcessMeasurements
    ? 'process-measurements'
    : `${uuids}/${commandType}`;
  // Set response code based on command type
  const returnCode = 202;
  const url = `${baseUrl}/measurements/${endpoint}`;
  const body = {
    ...(isProcessMeasurements ? { processName, measurementUUIDs: uuids } : { command: processName }),
    ...(parameters && { parameters })
  };
  try {
    await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, retries, null, returnCode);
    // wait for command to be done
    await new Promise(resolve => setTimeout(resolve, speedDelay));

    // Next...
    return await fetchWithRetry(
      `${baseUrl}/measurements/process-result`,
      { method: 'GET' },
      9,
      'ompleted'
    );

  } catch (error) {
    throw new Error(`Process execution failed: ${error.message}`);
  }
}

async function postSafe(requestUrl, parameters, expectedMessage, retries = 3) {
  const fetchOptions = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parameters)
  };

  try {
    return await fetchWithRetry(
      `${baseUrl}/${requestUrl}`,
      fetchOptions,
      retries,
      expectedMessage);
  } catch (error) {
    throwError(error);
  }
}


async function postAlign(processName, frequency = null) {
  try {
    await fetchWithRetry(`${baseUrl}/alignment-tool/command`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: processName,
          ...(frequency !== null && { frequency })
        })
      },
      3,
      null,
      202
    );
    // wait for command to be done
    await new Promise(resolve => setTimeout(resolve, speedDelay));
    // Next...
    const result = await fetchWithRetry(
      `${baseUrl}/alignment-tool/result`,
      { method: 'GET' },
      7,
      'ompleted'
    );
    const errorIntoMessage = result.message.results?.[0]?.Error;
    if (errorIntoMessage) {
      const delayMatch = errorIntoMessage.match(/delay required to align the responses.*(-?[\d.]+) ms/);
      if (delayMatch) {
        return {
          message: 'Delay too large',
          error: errorIntoMessage,
          delay: parseFloat(delayMatch[1])
        };
      }
    }
    return result;
  } catch (error) {
    throwError(error);
  }
}
async function postDelete(indice) {
  const expectedMessage = ` deleted`;
  const url = `${baseUrl}/measurements/${indice}`;
  const options = {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' }
  };

  try {
    return await fetchWithRetry(url, options, 3, expectedMessage);
  } catch (error) {
    throw new Error(`Delete failed: ${error.message}`);
  }

}


const sOs = 343.00;
const minDistAccuracy = 3.0 / 100 / sOs / 2;
const modelDelayLimit = 6.0 / sOs * 1000;

async function syncPeaks(indices, name = null) {
  if (!indices?.length) {
    throw new Error('No indices provided for synchronization');
  }
  // Get reference measurement
  await postNext('Cross corr align', indices);
  await new Promise(r => setTimeout(r, speedDelay));
  const reference = await fetchREW(indices[0]);
  const referenceStart = reference.timeOfIRStartSeconds;

  // Process remaining measurements
  for (let i = 1; i < indices.length; i++) {
    const current = await fetchREW(indices[i]);
    const timeDiff = Math.abs(current.timeOfIRStartSeconds - referenceStart);

    if (timeDiff <= minDistAccuracy) continue;

    // Try to align measurement
    const aligned = await magicAlign(indices[0], indices[i]);
    if (!aligned) continue;

    // Check alignment result
    const recheck = await fetchREW(indices[i]);
    if (Math.abs(recheck.timeOfIRStartSeconds - referenceStart) <= minDistAccuracy) continue;

    // Log warning if still misaligned
    const warningMessage = name
      ? `${name}${i} required several additional attempts to be properly aligned to MLP due to strong HF reflection content in its IR!`
      : (await fetchREW(i + 1)).title + ' required several additional attempts to be properly aligned to MLP due to strong HF reflection content in its IR!';

    console.warn(warningMessage);
    await new Promise(r => setTimeout(r, speedDelay));
  }
}


async function magicAlign(index0, index1) {
  try {
    const magicShift = await getDivisionPeakTime(index0, index1);

    if (Math.abs(magicShift) <= minDistAccuracy) {
      return false;
    }

    await postNext('Offset t=0', index1, {
      offset: magicShift,
      unit: 'seconds'
    });
    return true;

  } catch (error) {
    console.error('Error in magicAlign:', error);
    return false;
  }
}

async function getDivisionPeakTime(i0, i1) {
  let key;
  try {
    // Get division results
    const division = await postNext('Arithmetic', [i1, i0], {
      function: "A / B"
    });

    // Wait for processing
    await Promise.race([
      new Promise(r => setTimeout(r, speedDelay)),
      new Promise((_, r) => setTimeout(() => r(new Error('Timeout')), 5000))
    ]);

    // Get and validate key
    key = parseInt(Object.keys(division?.results ?? {})[0]);
    if (isNaN(key)) throw new Error('Invalid key');

    // Get and return peak
    return await findTruePeak(key);

  } catch (error) {
    console.error('Error:', error);
    throw error;
  } finally {
    // Cleanup
    if (key) await postDelete(key).catch(() => { });
  }
}

async function findTruePeak(key) {
  // Get excess phase data
  const ep = await postNext('Excess phase version', key, {
    "include cal": true,
    "append lf tail": false,
    "append hf tail": false,
    "frequency warping": false,
    "replicate data": false
  });

  await new Promise(r => setTimeout(r, speedDelay));

  // Get normalized impulse response
  const keyEP = parseInt(Object.keys(ep.results)[0]);
  const response = await fetchSafe('impulse-response?normalised=true', keyEP);
  await postDelete(keyEP);

  // Process data
  const bytes = Uint8Array.from(atob(response.data), c => c.charCodeAt(0));
  const dataView = new DataView(bytes.buffer);
  const totalSamples = bytes.length / 4;

  let maxPeak = 0;
  let maxPosition = 0;

  // Find peaks and interpolate
  for (let i = 1; i < totalSamples - 1; i++) {
    const [prev, curr, next] = [
      dataView.getFloat32((i - 1) * 4, false),
      dataView.getFloat32(i * 4, false),
      dataView.getFloat32((i + 1) * 4, false)
    ];

    if ((curr > prev && curr > next) || (curr < prev && curr < next)) {
      for (let j = 0; j < 16; j++) {
        const position = i + j / 16;
        const center = Math.floor(position);
        let value = 0;

        // Interpolate using sinc window
        for (let k = center - 8; k <= center + 8; k++) {
          if (k >= 0 && k < totalSamples) {
            const x = position - k;
            const sample = dataView.getFloat32(k * 4, false);

            if (x === 0) {
              value += sample;
            } else if (Math.abs(x) <= 8) {
              const px = Math.PI * x;
              value += sample * (Math.sin(px) / px) * (0.5 * (1 - Math.cos(2 * Math.PI * (x / 16))));
            }
          }
        }

        if (Math.abs(value) > Math.abs(maxPeak)) {
          maxPeak = value;
          maxPosition = position;
        }
      }
    }
  }

  return response.startTime + maxPosition / response.sampleRate;
}
const powerFactor = 1.61803398874989; //Adjusts number of speaker averages for IDW - increase for more averages

async function getSpatial(indices, name) {
  // Handle single index case
  if (indices.length === 1) {
    const index = indices[0];
    await postSafe(`${index}/command`, { command: 'Response copy' }, 'Completed');

    const responses = await fetchREW();
    const totalResponses = Object.keys(responses).length;

    await fetchREW(totalResponses, 'PUT', { title: `${name}o` });
    return;
  }

  if (name.startsWith("SW")) {
    try {
      const vectorAverage = await postNext('Vector average', indices);
      await new Promise(resolve => setTimeout(resolve, speedDelay));
      const key = parseInt(Object.keys(vectorAverage.results)[0], 10);

      await fetchREW(key, 'PUT', { title: `${name}o` });

      console.info(`Total measurements averaged to optimize speaker ${name} steady state response: ${indices.length}`);
    } catch (error) {
      console.error(`Error processing speaker ${name}:`, error);
    }
    return;
  }

  analyzeSpeaker(indices, name);
}

async function analyzeSpeaker(indices, name) {
  console.info(`Analysing speaker ${name} measurements...`);

  // Get distances from MLP
  const distances = await Promise.all(
    indices.map(async i => {
      const { cumulativeIRShiftSeconds } = await fetchREW(i);
      return Math.abs(parseFloat(cumulativeIRShiftSeconds) - (await fetchREW(indices[0])).cumulativeIRShiftSeconds);
    })
  );

  const maxDistance = Math.max(...distances);
  const distanceCm = maxDistance * 34300;

  // Handle small deviations (<1cm)
  if (distanceCm < 1) {
    const avgDistance = math.mean(distances);
    await Promise.all(indices.map(i =>
      postNext('Offset t=0', i, { offset: -avgDistance, unit: 'seconds' })
    ));
    await saveAverage(indices, name);
    return;
  }

  // Handle larger deviations with weighted averaging
  const weights = distances.map((d, i) => i === 0
    ? maxCopies
    : Math.max(1, Math.round(maxCopies * Math.pow(1 - d / maxDistance, powerFactor)))
  );

  // Create copies and average
  const startIndex = Object.keys(await fetchREW()).length;
  const copies = [];

  for (let i = 0; i < indices.length; i++) {
    for (let j = 0; j < weights[i]; j++) {
      await postSafe(`${indices[i]}/command`, { command: "Response copy" }, "Completed");
      copies.push(startIndex + copies.length + 1);
    }
  }

  // Log results
  console.info(`Max distance: ${distanceCm.toFixed(2)}cm, power: ${powerFactor.toFixed(2)}`);
  indices.forEach((idx, i) =>
    console.info(`  Pos ${idx - indices[0]}${idx === indices[0] ? ' (MLP)' : ''}: ` +
      `${weights[i]} ${weights[i] > 1 ? 'copies' : 'copy'} (${(distances[i] * 34300).toFixed(2)}cm)`)
  );

  await Promise.all(copies.map(postDelete));
}
