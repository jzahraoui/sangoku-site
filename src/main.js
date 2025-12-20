import apo2camilla from './apo2camilla.js';
import { saveAs } from 'file-saver';
import jsyaml from 'js-yaml';
import lm from './logs.js';
import RewController from './rew-controler.js';

globalThis.rewController = new RewController();

const themeToggle = document.getElementById('themeToggle');
const savedTheme = localStorage.getItem('theme');

if (savedTheme === 'dark') {
  document.body.classList.add('dark-mode');
  themeToggle.textContent = '☀️';
}

themeToggle.addEventListener('click', () => {
  document.body.classList.toggle('dark-mode');
  const isDark = document.body.classList.contains('dark-mode');
  themeToggle.textContent = isDark ? '☀️' : '🌙';
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
});

// Close dropdown when clicking outside
globalThis.addEventListener('click', e => {
  if (!e.target.closest('.column-toggle-dropdown')) {
    document.getElementById('columnDropdown')?.classList.remove('show');
  }
});

async function downloadConfig(config, channel) {
  try {
    // Convert config to YAML
    const yamlContent = jsyaml.dump(config);

    // Create blob with YAML content
    const blob = new Blob([yamlContent], { type: 'text/yaml' });

    // Save file using FileSaver
    await saveAs(blob, `config_${channel}.yml`);
  } catch (error) {
    throw new Error('Error downloading config:', error);
  }
}

const dropzoneAvr = document.getElementById('dropzoneAvr');
const fileInputAvr = document.getElementById('fileInputAvr');

dropzoneAvr.addEventListener('click', () => {
  fileInputAvr.click();
});

// UI Setup
const dropzoneMso = document.getElementById('dropzoneMso');
const fileInputMso = document.getElementById('fileInputMso');
const results = document.getElementById('results');

dropzoneMso.addEventListener('click', () => fileInputMso.click());

dropzoneMso.addEventListener('dragover', e => {
  e.preventDefault();
  dropzoneMso.classList.add('dragover');
});

dropzoneMso.addEventListener('dragleave', () => {
  dropzoneMso.classList.remove('dragover');
});

dropzoneMso.addEventListener('drop', e => {
  e.preventDefault();
  dropzoneMso.classList.remove('dragover');
  handleFiles(e.dataTransfer.files);
});

fileInputMso.addEventListener('change', e => {
  handleFiles(e.target.files);
});

async function handleFiles(files) {
  if (!files?.length) {
    results.innerHTML =
      '<div class="error">No files selected or invalid file input.</div>';
    return;
  }

  const file = files[0];

  try {
    const content = await file.text();
    let filterConverter;
    try {
      filterConverter = new apo2camilla(content);
    } catch (error) {
      lm.error(`Error initializing FilterConverter: ${error.message}`, error);
      results.innerHTML = `<div class="error">Error initializing FilterConverter: ${error.message}</div>`;
      return;
    }

    const configs = filterConverter.createCamillaDspConfig();

    // Clear loading state
    results.innerHTML = '';

    // Show success message
    const successDiv = document.createElement('div');
    successDiv.className = 'success';
    successDiv.textContent =
      'Conversion successful! Click buttons below to download configurations:';
    results.appendChild(successDiv);

    // Create download buttons
    for (const { config, channel } of configs) {
      const button = document.createElement('button');
      button.textContent = `Download ${channel} Configuration`;
      button.onclick = () => downloadConfig(config, channel);
      results.appendChild(button);
    }

    const REWconfigs = filterConverter.createREWConfiguration();
    await globalThis.viewModel.importMsoConfigInRew(REWconfigs);
    // delete all predicted lfe
    for (const item of globalThis.viewModel.allPredictedLfeMeasurement()) {
      await item.delete();
    }
  } catch (error) {
    lm.error(error);
    results.innerHTML = `<div class="error">Error: ${error.message}</div>`;
  }
}
