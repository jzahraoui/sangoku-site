import translations from './translations.js';
import lm from './logs.js';

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
        lm.warn(`No translations found for language: ${this.currentLanguage}`);
        return;
      }

      // Use createNodeIterator for better performance with large DOMs
      const iterator = document.createNodeIterator(
        document.body,
        NodeFilter.SHOW_ELEMENT,
        {
          acceptNode: node =>
            node.dataset.i18n ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
        }
      );

      let element;
      while ((element = iterator.nextNode())) {
        const key = element.dataset.i18n;
        const translation = currentTranslations[key];

        if (!translation) {
          lm.warn(`Missing translation for key: ${this.currentLanguage} ${key}`);
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
      if (typeof globalThis.viewModel?.updateTranslations === 'function') {
        globalThis.viewModel.updateTranslations(this.currentLanguage);
      }

      // Dispatch event when translations are complete
      globalThis.dispatchEvent(
        new CustomEvent('translationsComplete', {
          detail: { language: this.currentLanguage },
        })
      );
    } catch (error) {
      lm.error('Translation error:', error);
    }
  }

  translate(key) {
    try {
      // Cache the current language translations to avoid repeated lookups
      const currentTranslations = translations[this.currentLanguage];

      if (!currentTranslations) {
        lm.warn(`No translations found for language: ${this.currentLanguage}`);
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
      lm.error(`Translation error for key "${this.currentLanguage} ${key}":`, error);
      return key;
    }
  }
}

export default LanguageManager;
