import MeasurementViewModel from './MeasurementViewModel.js';
import ko from 'knockout';
import JSZip from 'jszip';
import DualRangeInput from '@stanko/dual-range-input';
import LanguageManager from './language-manager.js';
import lm from './logs.js';

class RewController {
  constructor() {
    this.initializeEventListeners();
  }

  // Extract version tag from commit message if exists
  extractVersionTag(message) {
    const versionMatch = message.match(/(\d+\.\d+\.\d+)/);
    return versionMatch ? versionMatch[0] : null;
  }

  initializeEventListeners() {
    document.addEventListener('DOMContentLoaded', async () => {
      globalThis.langManager = new LanguageManager();

      globalThis.viewModel = new MeasurementViewModel();

      // Apply Knockout bindings
      ko.applyBindings(globalThis.viewModel);

      globalThis.viewModel.restore();

      // Dual Range Input Setup
      const $min = document.querySelector('#min');
      const $max = document.querySelector('#max');
      globalThis.DualRangeInput = new DualRangeInput($min, $max, 2);

      globalThis.addEventListener('beforeunload', () =>
        globalThis.viewModel.saveMeasurements()
      );

      // Handle visibility change
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          globalThis.viewModel.saveMeasurements();
        }
      });

      const appContent = document.getElementById('appContent');
      const documentationContent = document.getElementById('documentationContent');
      const resourcesContent = document.getElementById('resourcesContent');
      const changeLogContent = document.getElementById('changeLogContent');

      // Load resources content
      await fetch('/resources.html')
        .then(response => response.text())
        .then(data => {
          resourcesContent.innerHTML = data;
        });

      // Load documentation content
      await fetch('/documentation.html')
        .then(response => response.text())
        .then(data => {
          documentationContent.innerHTML = data;
        });

      // Load change log content
      await fetch('/change-log.html')
        .then(response => response.text())
        .then(data => {
          changeLogContent.innerHTML = data;
        });

      const popup = document.getElementById('descriptionPopup');
      const popupDescription = document.getElementById('popupDescription');
      const closeBtn = document.querySelector('#descriptionPopup .close-btn'); // More specific selector

      // Add click event to all code links
      for (const link of document.querySelectorAll('.code-link')) {
        link.addEventListener('click', function (e) {
          e.preventDefault();
          const description = this.dataset.description;
          fetch(description)
            .then(response => response.text())
            .then(text => {
              popupDescription.innerHTML = text;
            })
            .catch(error => {
              lm.error('Error fetching description:', error);
              popupDescription.textContent = 'Failed to load description.';
            });
          if (popup) popup.style.display = 'block';
        });
      }

      // Close popup when clicking the close button
      if (closeBtn) {
        closeBtn.addEventListener('click', function () {
          if (popup) popup.style.display = 'none';
        });
      }

      // Close popup when clicking outside
      if (popup) {
        popup.addEventListener('click', function (e) {
          if (e.target === this) {
            popup.style.display = 'none';
          }
        });
      }

      // thumnail mamangement
      const thumbnails = document.querySelectorAll('.thumbnail');
      const thumbnailPopup = document.getElementById('imagePopup');
      const fullImage = document.getElementById('fullImage');
      // Use a more specific selector for the close button inside the image popup
      const thumbnailCloseBtn = thumbnailPopup
        ? thumbnailPopup.querySelector('.close-btn')
        : null;

      // Function to handle popup visibility - DRY principle
      const togglePopup = show => {
        if (thumbnailPopup) thumbnailPopup.style.display = show ? 'block' : 'none';
      };
      for (const thumb of thumbnails) {
        thumb.addEventListener('click', function () {
          if (!thumbnailPopup || !fullImage) return;
          // Preload image before showing popup
          const img = new Image();
          img.onload = () => {
            fullImage.src = this.dataset.full;
            togglePopup(true);
          };
          img.src = this.dataset.full;
          thumbnailPopup.style.display = 'block';
        });
      }

      // Close thumbnailPopup when clicking the close button
      if (thumbnailCloseBtn && thumbnailPopup) {
        thumbnailCloseBtn.addEventListener('click', () => {
          thumbnailPopup.style.display = 'none';
        });
      }

      // Close popup when clicking outside
      if (thumbnailPopup) {
        thumbnailPopup.addEventListener('click', e => {
          if (e.target === thumbnailPopup) {
            thumbnailPopup.style.display = 'none';
          }
        });
        thumbnailPopup.addEventListener(
          'touchstart',
          e => {
            if (e.target === thumbnailPopup) {
              thumbnailPopup.style.display = 'none';
            }
          },
          { passive: true }
        );
      }

      // Close on escape key
      document.addEventListener('keydown', e => {
        if (
          thumbnailPopup &&
          e.key === 'Escape' &&
          thumbnailPopup.style.display === 'block'
        ) {
          thumbnailPopup.style.display = 'none';
        }
      });

      // Handle navigation with buttons
      for (const button of document.querySelectorAll('.nav-button')) {
        button.addEventListener('click', e => {
          const page = e.target.closest('.nav-button').dataset.page;
          navigateToPage(page);
        });
      }

      // Handle navigation
      function navigateToPage(page) {
        if (
          !appContent ||
          !documentationContent ||
          !resourcesContent ||
          !changeLogContent
        )
          return;
        appContent.style.display = 'none';
        documentationContent.style.display = 'none';
        resourcesContent.style.display = 'none';
        changeLogContent.style.display = 'none';
        if (page === 'documentation') {
          documentationContent.style.display = 'block';
        } else if (page === 'resources') {
          resourcesContent.style.display = 'block';
        } else if (page === 'changelog') {
          changeLogContent.style.display = 'block';
        } else if (page === 'application') {
          appContent.style.display = 'block';
        } else {
          lm.error('Unknown page:', page);
          appContent.style.display = 'block'; // Default to application page
          page = 'application';
        }
        // Update URL without refresh
        history.pushState({ page }, '', `#${page}`);

        // Update active state of buttons
        for (const btn of document.querySelectorAll('.nav-button')) {
          btn.classList.toggle('active', btn.dataset.page === page);
        }
      }

      // Handle initial load
      const hash = globalThis.location.hash.slice(1);
      navigateToPage(hash || 'application');

      // Handle collapsible sections
      const collapsibles = document.querySelectorAll('.collapsible');

      for (const collapsible of collapsibles) {
        collapsible.addEventListener('click', function () {
          this.classList.toggle('active');
          const content = this.nextElementSibling;

          if (content.style.maxHeight) {
            content.style.maxHeight = null;
          } else {
            content.style.maxHeight = content.scrollHeight + 'px';
          }
        });
      }

      // Handle ZIP downloads with real implementation using JSZip
      const downloadAllButtons = document.querySelectorAll('.download-all-button');

      for (const button of downloadAllButtons) {
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
              lm.error('Unknown button ID');
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
            const fetchPromises = Array.from(links).map(async link => {
              const url = link.getAttribute('href');
              const filename = url.split('/').pop();
              const response = await fetch(url);
              if (!response.ok) throw new Error(`Failed to fetch ${filename}`);
              const blob = await response.blob();
              zip.file(filename, blob);
              return filename;
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
            downloadLink.remove();

            // Update status
            statusDiv.innerHTML = '<i class="fas fa-check"></i> Download complete!';
            statusDiv.style.color = '#28a745';

            // Remove status after a delay
            setTimeout(() => {
              if (statusDiv.parentNode) {
                statusDiv.remove();
              }
            }, 3000);
          } catch (error) {
            lm.error('Error creating ZIP file:', error);
            statusDiv.innerHTML = `<i class="fas fa-exclamation-triangle"></i> Error: ${error.message}`;
            statusDiv.style.color = '#dc3545';
          }
        });
      }

      const commitList = document.getElementById('commitList');
      const loading = document.getElementById('loading');
      const error = document.getElementById('error');
      const searchInput = document.getElementById('searchCommits');
      const authorFilter = document.getElementById('filterByAuthor');

      let allCommits = [];
      const authors = new Set();

      // Filter commits based on search and author filter
      const filterCommits = () => {
        if (!commitList || !searchInput || !authorFilter) return;
        const searchTerm = searchInput.value.toLowerCase();
        const selectedAuthor = authorFilter.value;

        commitList.innerHTML = '';

        const filteredCommits = allCommits.filter(commit => {
          const matchesSearch = commit.commit.message.toLowerCase().includes(searchTerm);
          const matchesAuthor =
            !selectedAuthor || commit.commit.author.name === selectedAuthor;
          return matchesSearch && matchesAuthor;
        });

        if (filteredCommits.length === 0) {
          const noResults = document.createElement('div');
          noResults.className = 'loading';
          noResults.innerHTML = '<p>No commits match your filters</p>';
          commitList.appendChild(noResults);
          return;
        }

        // Group commits by version tag
        const commitsByVersion = {};
        let versionTag;

        for (const commit of filteredCommits) {
          const versionTagRead = this.extractVersionTag(commit.commit.message);
          // If a version tag is found, update the versionTag variable
          if (versionTagRead) {
            versionTag = versionTagRead;
          }
          commit.versionTag = versionTag;

          if (!commit.commit.message.startsWith('feat:')) continue;

          // Group by version tag
          if (!commitsByVersion[versionTag]) {
            commitsByVersion[versionTag] = [];
          }
          commitsByVersion[versionTag].push(commit);
        }

        // Render commits grouped by version
        for (const [version, commits] of Object.entries(commitsByVersion)) {
          const fragment = document.createDocumentFragment();
          const commitEl = document.createElement('li');
          commitEl.className = 'commit';

          commitEl.innerHTML = `<div class="commit-header"><h3 class="commit-title">Version ${version}</h3></div>`;

          const messagesContainer = document.createElement('div');
          messagesContainer.className = 'commit-messages';

          for (const commit of commits) {
            const message = document.createElement('div');
            message.className = 'commit-message';
            message.innerHTML = `- ${commit.commit.message.split('\n').join('<br>')}`;
            messagesContainer.appendChild(message);
          }

          commitEl.appendChild(messagesContainer);
          fragment.appendChild(commitEl);
          commitList.appendChild(fragment);
        }
      };

      // Fetch commits from GitHub API
      async function fetchCommits() {
        if (!commitList || !loading || !error || !searchInput || !authorFilter) return;
        try {
          const response = await fetch(
            'https://api.github.com/repos/jzahraoui/sangoku-site/commits'
          );

          if (!response.ok) {
            throw new Error('Failed to fetch commits');
          }

          allCommits = await response.json();

          // Populate author filter
          for (const commit of allCommits) {
            if (commit.commit?.author?.name) {
              authors.add(commit.commit.author.name);
            }
          }

          for (const author of authors) {
            const option = document.createElement('option');
            option.value = author;
            option.textContent = author;
            authorFilter.appendChild(option);
          }

          // Display commits
          loading.style.display = 'none';
          filterCommits();

          // Set up event listeners for filters
          searchInput.addEventListener('input', filterCommits);
          authorFilter.addEventListener('change', filterCommits);
        } catch (err) {
          lm.error(`Error fetching commits: ${err.message}`, err);
          if (loading) loading.style.display = 'none';
          if (error) error.style.display = 'block';
        }
      }

      // Initialize
      fetchCommits();
    });
  }
}

export default RewController;
