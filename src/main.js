import apo2camilla from './apo2camilla.js';
import { saveAs } from 'file-saver';
import jsyaml from 'js-yaml';
import lm from './logs.js';
import RewController from './rew-controler.js';

globalThis.rewController = new RewController();

const themeToggle = document.getElementById('themeToggle');
const themeStorageKey = 'theme';
const systemThemeQuery = globalThis.matchMedia('(prefers-color-scheme: dark)');

function isStoredTheme(value) {
  return value === 'dark' || value === 'light';
}

function getPreferredTheme() {
  const savedTheme = localStorage.getItem(themeStorageKey);
  if (isStoredTheme(savedTheme)) {
    return savedTheme;
  }
  return systemThemeQuery.matches ? 'dark' : 'light';
}

function applyTheme(theme) {
  const isDark = theme === 'dark';
  document.body.classList.toggle('dark-mode', isDark);
  if (themeToggle) {
    themeToggle.textContent = isDark ? '☀️' : '🌙';
    themeToggle.setAttribute('aria-pressed', String(isDark));
  }
}

applyTheme(getPreferredTheme());

const handleSystemThemeChange = event => {
  const savedTheme = localStorage.getItem(themeStorageKey);
  if (isStoredTheme(savedTheme)) {
    return;
  }
  applyTheme(event.matches ? 'dark' : 'light');
};

if (typeof systemThemeQuery.addEventListener === 'function') {
  systemThemeQuery.addEventListener('change', handleSystemThemeChange);
}

if (themeToggle) {
  themeToggle.addEventListener('click', () => {
    const nextTheme = document.body.classList.contains('dark-mode') ? 'light' : 'dark';
    applyTheme(nextTheme);
    localStorage.setItem(themeStorageKey, nextTheme);
  });
}

const columnToggleBtn = document.getElementById('columnToggleBtn');
const columnDropdown = document.getElementById('columnDropdown');

function setColumnDropdownExpanded(isExpanded) {
  if (!columnToggleBtn || !columnDropdown) {
    return;
  }

  columnToggleBtn.setAttribute('aria-expanded', String(isExpanded));
  columnDropdown.classList.toggle('show', isExpanded);
  columnDropdown.hidden = !isExpanded;
}

// Column visibility toggle
if (columnToggleBtn && columnDropdown) {
  columnToggleBtn.addEventListener('click', () => {
    const isExpanded = columnToggleBtn.getAttribute('aria-expanded') === 'true';
    setColumnDropdownExpanded(!isExpanded);
  });

  columnToggleBtn.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      setColumnDropdownExpanded(false);
      columnToggleBtn.focus();
    }
  });

  columnDropdown.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      setColumnDropdownExpanded(false);
      columnToggleBtn.focus();
    }
  });
}

// Close dropdown when clicking outside
globalThis.addEventListener('click', e => {
  if (!e.target.closest('.column-toggle-dropdown')) {
    setColumnDropdownExpanded(false);
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

// UI Setup
const dropzoneMso = document.getElementById('dropzoneMso');
const fileInputMso = document.getElementById('fileInputMso');
const results = document.getElementById('results');

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
      '<div class="status-message error">No files selected or invalid file input.</div>';
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
      results.innerHTML = `<div class="status-message error">Error initializing FilterConverter: ${error.message}</div>`;
      return;
    }

    const configs = filterConverter.createCamillaDspConfig();

    // Clear loading state
    results.innerHTML = '';

    // Show success message
    const successDiv = document.createElement('div');
    successDiv.className = 'status-message success';
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
    results.innerHTML = `<div class="status-message error">Error: ${error.message}</div>`;
  }
}
