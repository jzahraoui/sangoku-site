

let allResponses;
let tagetCurve;

async function createOCAButton() {
  checkVersion();
  allResponses = await fetchREW();
  await createOCAFile(allResponses, tagetCurve);
}

async function createsAverages() {
  allResponses = await fetchREW();
  // group allresponse by matchedCodes attribute
  let groupedResponse = await groupResponseByChannel(allResponses);

  // creates array of uuid attributes for each code into groupedResponse
  await processGroupedResponses(groupedResponse);
  console.debug('done');
}


async function revertLfeFilter(deletePrevious = true) {

  const submitButton = document.getElementById('buttonrevertLfeFilter');

  // Initially disable the button
  submitButton.disabled = true;
  submitButton.style.opacity = '0.5'; // Optional: visual feedback

  try {
    allResponses = await fetchREW();

    const subResponses = Object.values(allResponses)
      .filter(response => response.title.startsWith("SW"));

    if (!subResponses || subResponses.length === 0) return null;

    // get selected value from combo box 
    const selectElement = document.getElementById('filterSelect');
    const freq = selectElement.value;
    const suffix = " w/o LPF"

    // use the fist measurement to creates the filter to ensure the same Frequency is used
    const measurementUuid = subResponses[0].uuid;

    await postSafe(`measurements/${measurementUuid}/filters`, {
      filters: [{
        index: 21, type: "Low pass", enabled: true, isAuto: false,
        frequency: freq, shape: "L-R", slopedBPerOctave: 24
      }]
    }, "Filters set");

    const lowPassFilter = await postNext('Generate filters measurement', measurementUuid);

    // remove filter from measurement to left it as it was
    await postSafe(`measurements/${measurementUuid}/filters`, {
      filters: [{
        index: 21, type: "None", enabled: true, isAuto: false
      }]
    }, "Filters set");

    // Update title, to get it into comments
    const lowPassFilterUuid = Object.values(lowPassFilter.results || {})[0]?.UUID;
    await fetchREW(lowPassFilterUuid, 'PUT', { title: "LFE filter" });

    for (const subResponse of subResponses) {
      // manage previous calculation results
      if (subResponse.title.includes(suffix)) {
        if (deletePrevious) {
          await postDelete(subResponse.uuid);
        }
        continue;
      }
      const division = await postNext(
        'Arithmetic',
        [subResponse.uuid, lowPassFilterUuid],
        {
          function: "A / B",
          "upperLimit": "1000"
        }
      );
      const divisionUuid = Object.values(division.results || {})[0]?.UUID;
      await fetchREW(divisionUuid, 'PUT', { title: subResponse.title + suffix });
    }
    // Delete filter
    console.debug(`filter deleting...`);
    await postDelete(lowPassFilterUuid);
  } catch (error) {
    console.error('Error processing revert LFE filter:', error);
    throw error;
  }

  // enable the button
  submitButton.disabled = false;
  submitButton.style.opacity = '1'; // Optional: visual feedback
}

// Process grouped responses and create UUID arrays
async function processGroupedResponses(groupedResponse) {
  try {
    // Input validation
    if (!groupedResponse || typeof groupedResponse !== 'object') {
      throw new Error('Invalid groupedResponse input');
    }

    // Process each code group sequentially
    const results = [];
    for (const code of Object.keys(groupedResponse)) {
      // Validate group exists and has items
      if (!groupedResponse[code]?.items) {
        console.warn(`Skipping empty group: ${code}`);
        continue;
      }

      if (code === "UNMATCHED") {
        console.warn(`Skipping invalid group: ${code}`);
        continue;
      }

      // Create array of UUIDs for the current code group
      const uuids = groupedResponse[code].items.map(item => item.uuid);

      // Process the collected indices
      if (uuids.length > 1) {
        // Cross correlation alignment
        console.debug(`${code}: ${uuids.length} measures cross corr align...`);
        await postNext('Cross corr align', uuids);

        // Vector average processing
        console.debug(`${code}: ${uuids.length} measures measurements average...`);
        const vectorAverage = await postNext('Vector average', uuids);

        // Update title
        const vectorKey = Object.values(vectorAverage.results || {})[0]?.UUID;
        if (vectorKey) {
          console.debug(`${code}: measurements average title renaming...`);
          await fetchREW(vectorKey, 'PUT', { title: code + "o" });
        } else {
          throw new Error(`${code}: can not rename the average...`);
        }

        // Delete measurements - sequential processing
        for (const uuid of uuids) {
          console.debug(`${code}: ${uuids.length} measures deleting...`);
          await postDelete(uuid);
        }
        results.push({ code, uuids });
      }
    }

    return results;

  } catch (error) {
    console.error('Error processing grouped responses:', error);
    throw error;
  }
}


/**
 * Groups responses by their matched channel codes
 * @param {Array} responses - Array of response objects
 * @returns {Object} Grouped responses by channel code
 */
function groupResponseByChannel(responses) {

  // Group responses by matched codes
  const groupedResponse = Object.values(responses).reduce((groups, item) => {
    const matchedCodes = CHANNEL_TYPES.getBestMatchCode(item.title);
    const code = matchedCodes || 'UNMATCHED';

    // Initialize or update group
    if (!groups[code]) {
      groups[code] = {
        items: [],
        count: 0
      };
    }

    // Add item to group
    groups[code].items.push(item);
    groups[code].count++;

    return groups;
  }, {});

  // Sort items within each group by title
  Object.keys(groupedResponse).forEach(code => {
    groupedResponse[code].items.sort((a, b) =>
      a.title.localeCompare(b.title)
    );
  });

  return groupedResponse;
}


async function checkREWButton() {
  checkVersion();
  tagetCurve = checkTargetCurve();
}

/**
 * Search through JSON objects by attribute values
 * @param {Object} jsonData - Array of JSON objects to search through
 * @param {Object} searchCriteria - Object containing attribute-value pairs to search for
 * @param {Object} options - Search options (optional)
 * @returns {Array} Matching JSON objects
 */
function filterResponses(jsonData, searchCriteria, options = {}) {
  const {
    caseSensitive = false,
    matchAll = true,
    partialMatch = true
  } = options;

  if (!jsonData || typeof jsonData !== 'object' || !searchCriteria || typeof searchCriteria !== 'object') {
    return [];
  }

  // Convert the object to an array of its values
  const dataArray = Object.values(jsonData);

  return dataArray.filter(item => {
    // Handle each search criteria
    const matches = Object.entries(searchCriteria).map(([key, value]) => {
      // Skip if search value is null or undefined
      if (value == null) return true;

      // Get nested property value using key path (e.g., 'attributes.color')
      const itemValue = key.split('.').reduce((obj, k) => obj?.[k], item);

      // If item doesn't have the property, no match
      if (itemValue == null) return false;

      // Convert values to strings for comparison
      const searchStr = String(value);
      const itemStr = String(itemValue);

      if (partialMatch) {
        return caseSensitive
          ? itemStr.includes(searchStr)
          : itemStr.toLowerCase().includes(searchStr.toLowerCase());
      } else {
        return caseSensitive
          ? itemStr === searchStr
          : itemStr.toLowerCase() === searchStr.toLowerCase();
      }
    });

    // Return true if all criteria match (AND) or any criteria matches (OR)
    return matchAll
      ? matches.every(match => match)
      : matches.some(match => match);
  });
}



function downloadConfig(config, channel) {
  const yamlContent = jsyaml.dump(config);
  const blob = new Blob([yamlContent], { type: 'text/yaml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `config_${channel}.yml`;
  a.click();
  URL.revokeObjectURL(url);

}

// UI Setup
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const results = document.getElementById('results');

dropzone.addEventListener('click', () => fileInput.click());

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragover');
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  handleFiles(e.dataTransfer.files);
});

fileInput.addEventListener('change', (e) => {
  handleFiles(e.target.files);
});

function handleFiles(files) {
  if (files.length === 0) return;

  const file = files[0];
  const reader = new FileReader();

  reader.onload = (e) => {
    try {
      const content = e.target.result;
      const filters = parseEqualizerApo(content);
      const configs = createCamillaDspConfig(filters);

      results.innerHTML = '';
      const successDiv = document.createElement('div');
      successDiv.className = 'success';
      successDiv.textContent = 'Conversion successful! Click buttons below to download configurations:';
      results.appendChild(successDiv);

      configs.forEach(({ config, channel }) => {
        const button = document.createElement('button');
        button.textContent = `Download ${channel} Configuration`;
        button.onclick = () => downloadConfig(config, channel);
        results.appendChild(button);
      });

      importFilterInREW(filters);
    } catch (error) {
      results.innerHTML = `<div class="error">Error: ${error.message}</div>`;
    }
  };

  reader.onerror = () => {
    results.innerHTML = '<div class="error">Error reading file</div>';
  };

  reader.readAsText(file);
}

async function importFilterInREW(msofilters) {
  const REWconfigs = createREWConfiguration(msofilters);
  // First fetch all responses
  allResponses = await fetchREW();
  if (!allResponses) {
    throw new Error(`Cannot retreive REW measurements`);
  }

  const generatedPredicted = [];

  // Process each REW configuration sequentially
  for (const { filters, channel, invert, gain, delay } of REWconfigs) {
    try {
      // Find item in allResponses that has title beginning with channel
      const foundItem = Object.values(allResponses).find(item =>
        item?.title?.toLowerCase().startsWith(channel.toLowerCase())
      );

      if (!foundItem) {
        throw new Error(`Cannot find measurement name matching ${channel}`);
      }
      // Apply filters
      await postSafe(
        `measurements/${foundItem.uuid}/filters`,
        { filters },
        "Filters set"
      );
      // invert
      if ((invert === -1 && !foundItem.inverted) || (invert === 1 && foundItem.inverted)) {
        await postSafe(
          `measurements/${foundItem.uuid}/command`,
          { command: 'Invert' },
          'Invert completed'
        );
      }
      // reverse delay if previous iteration change it          
      if (foundItem.cumulativeIRShiftSeconds !== 0) {
        await postNext(
          'Offset t=0',
          foundItem.uuid,
          {
            offset: -foundItem.cumulativeIRShiftSeconds,
            unit: "seconds"
          },
          0);
      }
      // apply specified delay
      const offset = delay / 1000;
      await postNext(
        'Offset t=0',
        foundItem.uuid,
        {
          offset: -offset,
          unit: "seconds"
        },
        0);
      const rollResponse = await postNext(
        'Generate predicted measurement',
        foundItem.uuid
      );
      const rollResponseUuid = Object.values(rollResponse.results || {})[0]?.UUID;
      const roundedGain = roundGain(gain)
      await postNext(
        'Add SPL offset',
        rollResponseUuid,
        { offset: roundedGain }
        , 0);
      console.log(`${rollResponse.title} applied 'relative' volume adjustment: ${roundedGain} dB`);

      generatedPredicted.push(rollResponseUuid);
    } catch (error) {
      console.error(`Error processing channel ${channel}:`, error);
      throw error;
    }
  }

  await createsSum(generatedPredicted);
  // cleanup
  for (const uuid of generatedPredicted) {
    await postDelete(uuid);
  }
}

async function createsSum(uuids) {
  if (!Array.isArray(uuids)) {
    throw new Error("Parameter must be an array")
  }
  if (uuids.length < 2) {
    throw new Error("Parameter must contains at least 2 elements")
  }
  const limitRange = 1;
  await postSafe(`alignment-tool/mode`, "Impulse", "Mode set");
  await postSafe(`alignment-tool/remove-time-delay`, false, "Value set");
  await postAlign('Reset all');
  await postSafe(`alignment-tool/max-negative-delay`, -limitRange, "Maximum negative delay set");
  await postSafe(`alignment-tool/max-positive-delay`, limitRange, "Maximum positive delay set");

  // initialisation  with first two UUIDs
  await postSafe("alignment-tool/uuid-a", uuids[0], "selected as measurement A");
  await postSafe("alignment-tool/uuid-b", uuids[1], "selected as measurement B");
  const lastAlignedSumInit = await postAlign('Aligned sum');
  let lastAlignedSumUuid = Object.values(lastAlignedSumInit.results || {})[0]?.UUID;

  // Loop through each UUID and process
  for (let i = 2; i < uuids.length; i++) {
    await postSafe("alignment-tool/uuid-a", uuids[i], "selected as measurement A");
    await postSafe("alignment-tool/uuid-b", lastAlignedSumUuid, "selected as measurement B");
    const lastAlignedSum = await postAlign('Aligned sum');
    await postDelete(lastAlignedSumUuid);
    lastAlignedSumUuid = Object.values(lastAlignedSum.results || {})[0]?.UUID;
  }

}

// thumnail mamangement
document.addEventListener('DOMContentLoaded', function () {
  const thumbnails = document.querySelectorAll('.thumbnail');
  const popup = document.getElementById('imagePopup');
  const fullImage = document.getElementById('fullImage');
  const closeBtn = document.querySelector('.close-btn');

  thumbnails.forEach(thumb => {
    thumb.addEventListener('click', function () {
      fullImage.src = this.dataset.full;
      popup.style.display = 'block';
    });
  });

  // Close popup when clicking X or outside the image
  closeBtn.addEventListener('click', () => {
    popup.style.display = 'none';
  });

  popup.addEventListener('click', (e) => {
    if (e.target === popup) {
      popup.style.display = 'none';
    }
  });

  // Close on escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && popup.style.display === 'block') {
      popup.style.display = 'none';
    }
  });
});