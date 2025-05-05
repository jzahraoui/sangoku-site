import RewApi from './rew-api.js';
import apo2camilla from './apo2camilla.js';
import MeasurementViewModel from './MeasurementViewModel.js';
import translations from './translations.js';

/**
 * LanguageManager is responsible for managing the language settings of the application.
 * It initializes the language based on the user's preference stored in localStorage,
 * provides methods to change the language, and translates the page content accordingly.
 */
class LanguageManager {
  constructor() {
    this.currentLanguage = localStorage.getItem('userLanguage') || 'en';
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
    try {
      // Cache the current language translations
      const currentTranslations = translations[this.currentLanguage];
      if (!currentTranslations) {
        console.warn(`No translations found for language: ${this.currentLanguage}`);
        return;
      }

      // Use createNodeIterator for better performance with large DOMs
      const iterator = document.createNodeIterator(
        document.body,
        NodeFilter.SHOW_ELEMENT,
        {
          acceptNode: node =>
            node.hasAttribute('data-i18n')
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_REJECT,
        }
      );

      let element;
      while ((element = iterator.nextNode())) {
        const key = element.getAttribute('data-i18n');
        const translation = currentTranslations[key];

        if (!translation) {
          console.warn(`Missing translation for key: ${this.currentLanguage} ${key}`);
          continue;
        }

        // Handle different element types
        switch (element.tagName) {
          case 'INPUT':
            if (element.hasAttribute('placeholder')) {
              element.placeholder = translation;
            }
            break;
          case 'IMG':
            if (element.hasAttribute('alt')) {
              element.alt = translation;
            }
            break;
          default:
            element.textContent = translation;
        }
      }

      // Handle Knockout bindings if available
      if (typeof window.viewModel?.updateTranslations === 'function') {
        window.viewModel.updateTranslations(this.currentLanguage);
      }

      // Dispatch event when translations are complete
      window.dispatchEvent(
        new CustomEvent('translationsComplete', {
          detail: { language: this.currentLanguage },
        })
      );
    } catch (error) {
      console.error('Translation error:', error);
    }
  }

  translate(key) {
    try {
      // Cache the current language translations to avoid repeated lookups
      const currentTranslations = translations[this.currentLanguage];

      if (!currentTranslations) {
        console.warn(`No translations found for language: ${this.currentLanguage}`);
        return key;
      }

      // Support nested keys using dot notation (e.g., 'menu.items.title')
      const keyParts = key.split('.');
      let translation = currentTranslations;

      for (const part of keyParts) {
        translation = translation[part];
        if (translation === undefined) break;
      }

      return translation || key;
    } catch (error) {
      console.error(`Translation error for key "${this.currentLanguage} ${key}":`, error);
      return key;
    }
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

      // Function to handle popup visibility - DRY principle
      const togglePopup = show => {
        thumbnailPopup.style.display = show ? 'block' : 'none';
      };
      thumbnails.forEach(thumb => {
        thumb.addEventListener('click', function () {
          // Preload image before showing popup
          const img = new Image();
          img.onload = () => {
            fullImage.src = this.dataset.full;
            togglePopup(true);
          };
          img.src = this.dataset.full;
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
      thumbnailPopup.addEventListener(
        'touchstart',
        e => {
          if (e.target === thumbnailPopup) {
            closePopup();
          }
        },
        { passive: true }
      );

      // Close on escape key
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && thumbnailPopup.style.display === 'block') {
          thumbnailPopup.style.display = 'none';
        }
      });

      const appContent = document.getElementById('appContent');
      const documentationContent = document.getElementById('documentationContent');
      const ressourceContent = document.getElementById('resourcesContent');

      // Handle navigation with buttons
      document.querySelectorAll('.nav-button').forEach(button => {
        button.addEventListener('click', e => {
          const page = e.target.closest('.nav-button').dataset.page;
          navigateToPage(page);
        });
      });

      // Handle navigation
      function navigateToPage(page) {
        if (page === 'documentation') {
          appContent.style.display = 'none';
          documentationContent.style.display = 'block';
          ressourceContent.style.display = 'none';
        } else if (page === 'resources') {
          appContent.style.display = 'none';
          documentationContent.style.display = 'none';
          ressourceContent.style.display = 'block';
        } else {
          appContent.style.display = 'block';
          documentationContent.style.display = 'none';
          ressourceContent.style.display = 'none';
        }
        // Update URL without refresh
        history.pushState({ page }, '', `#${page}`);

        // Update active state of buttons
        document.querySelectorAll('.nav-button').forEach(btn => {
          btn.classList.toggle('active', btn.dataset.page === page);
        });
      }

      // Handle initial load
      const hash = window.location.hash.slice(1);
      navigateToPage(hash || '');

      // Handle collapsible sections
      const collapsibles = document.querySelectorAll('.collapsible');

      collapsibles.forEach(collapsible => {
        collapsible.addEventListener('click', function () {
          this.classList.toggle('active');
          const content = this.nextElementSibling;

          if (content.style.maxHeight) {
            content.style.maxHeight = null;
          } else {
            content.style.maxHeight = content.scrollHeight + 'px';
          }
        });
      });

      // Handle ZIP downloads with real implementation using JSZip
      const downloadAllButtons = document.querySelectorAll('.download-all-button');

      downloadAllButtons.forEach(button => {
        button.addEventListener('click', async function (e) {
          e.preventDefault();

          const buttonId = this.id;
          let folderPath = '';
          let zipFilename = '';
          let fileExtension = '';

          // Set parameters based on which button was clicked
          switch (buttonId) {
            case 'downloadAllLossless':
              folderPath = 'ressources/lossless/';
              zipFilename = 'lossless_audio_files';
              fileExtension = '.mlp';
              break;
            case 'downloadAllLossy':
              folderPath = 'ressources/lossy/';
              zipFilename = 'lossy_audio_files';
              fileExtension = '.mp4';
              break;
            case 'downloadAllTargetCurves':
              folderPath = 'ressources/target_curves/';
              zipFilename = 'target_curves';
              fileExtension = '.txt';
              break;
            default:
              console.error('Unknown button ID');
              return;
          }

          // Create status message
          const statusDiv = document.createElement('div');
          statusDiv.className = 'download-status';
          statusDiv.textContent = 'Preparing files for download...';
          this.parentNode.appendChild(statusDiv);

          try {
            // Create a new JSZip instance
            const zip = new JSZip();

            // Get all links with the specified file extension from the relevant section
            const section = this.closest('section');
            const links = section.querySelectorAll(
              `a[href^="${folderPath}"][href$="${fileExtension}"]`
            );

            if (links.length === 0) {
              throw new Error('No files found to download');
            }

            // Add loading animation
            statusDiv.innerHTML =
              '<i class="fas fa-spinner fa-spin"></i> Creating ZIP file...';

            // Add files to the zip
            const fetchPromises = Array.from(links).map(link => {
              const url = link.getAttribute('href');
              const filename = url.split('/').pop();

              return fetch(url)
                .then(response => {
                  if (!response.ok) throw new Error(`Failed to fetch ${filename}`);
                  return response.blob();
                })
                .then(blob => {
                  zip.file(filename, blob);
                  return filename;
                });
            });

            // Wait for all files to be fetched and added to the zip
            await Promise.all(fetchPromises);

            // Generate the zip file
            statusDiv.innerHTML =
              '<i class="fas fa-spinner fa-spin"></i> Generating ZIP file...';
            const zipBlob = await zip.generateAsync({ type: 'blob' });

            // Create download link and trigger download
            const downloadLink = document.createElement('a');
            downloadLink.href = URL.createObjectURL(zipBlob);
            downloadLink.download = `${zipFilename}.zip`;
            document.body.appendChild(downloadLink);
            downloadLink.click();
            document.body.removeChild(downloadLink);

            // Update status
            statusDiv.innerHTML = '<i class="fas fa-check"></i> Download complete!';
            statusDiv.style.color = '#28a745';

            // Remove status after a delay
            setTimeout(() => {
              if (statusDiv.parentNode) {
                statusDiv.parentNode.removeChild(statusDiv);
              }
            }, 3000);
          } catch (error) {
            console.error('Error creating ZIP file:', error);
            statusDiv.innerHTML = `<i class="fas fa-exclamation-triangle"></i> Error: ${error.message}`;
            statusDiv.style.color = '#dc3545';
          }
        });
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
