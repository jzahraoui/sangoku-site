import RewApi from './rew-api.js';
import apo2camilla from './apo2camilla.js';
import MeasurementViewModel from './MeasurementViewModel.js';
import { translations } from './translations.js';

/**
 * LanguageManager is responsible for managing the language settings of the application.
 * It initializes the language based on the user's preference stored in localStorage,
 * provides methods to change the language, and translates the page content accordingly.
 */
class LanguageManager {
  constructor() {
    this.currentLanguage = localStorage.getItem('userLanguage') || 'en';
    this.i18nElements = document.querySelectorAll('[data-i18n]');
    this.init();
  }

  init() {
    const selector = document.getElementById('languageSelector');
    if (selector) {
      selector.value = this.currentLanguage;
      selector.addEventListener('change', e => {
        this.changeLanguage(e.target.value);
      });
    }
    this.translatePage();
  }

  changeLanguage(language) {
    this.currentLanguage = language;
    localStorage.setItem('userLanguage', language);
    this.translatePage();
    // Update HTML lang attribute
    document.documentElement.lang = language;
  }

  translatePage() {
    this.i18nElements.forEach(element => {
      const key = element.getAttribute('data-i18n');
      if (translations[this.currentLanguage] && translations[this.currentLanguage][key]) {
        if (element.tagName === 'INPUT' && element.hasAttribute('placeholder')) {
          element.placeholder = translations[this.currentLanguage][key];
        } else {
          element.textContent = translations[this.currentLanguage][key];
        }
      }
    });

    // Handle dynamic content in Knockout bindings
    if (window.viewModel) {
      window.viewModel.updateTranslations(this.currentLanguage);
    }
  }

  translate(key) {
    return translations[this.currentLanguage][key] || key;
  }
}

class RewController {
  constructor() {
    this.initializeEventListeners();
  }

  initializeEventListeners() {
    document.addEventListener('DOMContentLoaded', async () => {
      window.langManager = new LanguageManager();

      const rewApi = new RewApi();
      window.viewModel = new MeasurementViewModel(rewApi);

      // Apply Knockout bindings
      ko.applyBindings(window.viewModel);

      window.viewModel.restore();

      //window.addEventListener('beforeunload', () => viewModel.saveMeasurements());

      // Handle visibility change
      // document.addEventListener('visibilitychange', () => {
      //   if (document.visibilityState === 'hidden') {
      //     viewModel.saveMeasurements();
      //   }
      // });

      const popup = document.getElementById('descriptionPopup');
      const popupDescription = document.getElementById('popupDescription');
      const closeBtn = document.querySelector('.close-btn');

      // Add click event to all code links
      document.querySelectorAll('.code-link').forEach(link => {
        link.addEventListener('click', function (e) {
          e.preventDefault();
          const description = this.getAttribute('data-description');
          fetch(description)
            .then(response => response.text())
            .then(text => {
              popupDescription.innerHTML = text;
            })
            .catch(error => {
              console.error('Error fetching description:', error);
              popupDescription.textContent = 'Failed to load description.';
            });
          popup.style.display = 'block';
        });
      });

      // Close popup when clicking the close button
      closeBtn.addEventListener('click', function () {
        popup.style.display = 'none';
      });

      // Close popup when clicking outside
      popup.addEventListener('click', function (e) {
        if (e.target === popup) {
          popup.style.display = 'none';
        }
      });

      // thumnail mamangement
      const thumbnails = document.querySelectorAll('.thumbnail');
      const thumbnailPopup = document.getElementById('imagePopup');
      const fullImage = document.getElementById('fullImage');
      const thumbnailCloseBtn = document.querySelector('.close-btn');

      thumbnails.forEach(thumb => {
        thumb.addEventListener('click', function () {
          fullImage.src = this.dataset.full;
          thumbnailPopup.style.display = 'block';
        });
      });

      // Close thumbnailPopup when clicking the close button
      thumbnailCloseBtn.addEventListener('click', () => {
        thumbnailPopup.style.display = 'none';
      });

      // Close popup when clicking outside
      thumbnailPopup.addEventListener('click', e => {
        if (e.target === thumbnailPopup) {
          thumbnailPopup.style.display = 'none';
        }
      });

      // Close on escape key
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && thumbnailPopup.style.display === 'block') {
          thumbnailPopup.style.display = 'none';
        }
      });
    });
  }
}

window.rewController = new RewController();

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

function handleFiles(files) {
  if (!files || !files.length) {
    results.innerHTML =
      '<div class="error">No files selected or invalid file input.</div>';
    return;
  }

  const file = files[0];
  const reader = new FileReader();

  reader.onload = async e => {
    try {
      const content = e.target.result;
      let filterConverter;
      try {
        filterConverter = new apo2camilla(content);
      } catch (error) {
        console.error(`Error initializing FilterConverter: ${error.message}`, error);
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
      configs.forEach(({ config, channel }) => {
        const button = document.createElement('button');
        button.textContent = `Download ${channel} Configuration`;
        button.onclick = () => downloadConfig(config, channel);
        results.appendChild(button);
      });

      const REWconfigs = filterConverter.createREWConfiguration();
      await window.viewModel.importMsoConfigInRew(REWconfigs);
      // delete all predicted lfe
      for (const item of window.viewModel.allPredictedLfeMeasurement()) {
        await item.delete();
      }
    } catch (error) {
      console.error(error);
      results.innerHTML = `<div class="error">Error: ${error.message}</div>`;
    }
  };

  reader.onerror = () => {
    results.innerHTML = '<div class="error">Error reading file</div>';
  };

  reader.readAsText(file);
}
