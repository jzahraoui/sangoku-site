import js from '@eslint/js';
import globals from 'globals';
import css from '@eslint/css';
import sonarjs from 'eslint-plugin-sonarjs';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  {
    // Hors périmètre : artefacts de build, couverture, notes de travail non
    // versionnées (même périmètre que sonar.exclusions / le clone CI).
    ignores: ['dist/**', 'coverage/**', 'work/**'],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    plugins: { js },
    extends: ['js/recommended'],
    languageOptions: { globals: globals.browser },
    rules: {
      // Convention : un paramètre préfixé « _ » est volontairement inutilisé
      // (signature imposée par l'interface mockée).
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  // Parité SonarQube Cloud en local : mêmes règles JS que le scanner
  // (plugin officiel SonarSource). Objectif : zéro issue découverte
  // après push — tout doit être vu au lint.
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...sonarjs.configs.recommended,
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    rules: {
      // Écarts assumés vis-à-vis du preset "recommended", alignés sur le
      // comportement effectif du profil SonarQube Cloud du projet :
      // - comparaisons flottantes exactes : voulues (parité bit-à-bit DSP,
      //   goldens) ; non remontées par le profil cloud.
      'sonarjs/no-floating-point-equality': 'off',
      // - tags de tâches en attente assumés (S1135 = INFO côté cloud,
      //   décisions métier à prendre par Jaoued).
      'sonarjs/todo-tag': 'off',
      // - security hotspots côté cloud (revue, pas issues) : API REW locale
      //   en http:// (LAN), IP de fixtures de tests, détection WSL via PATH.
      'sonarjs/no-clear-text-protocols': 'off',
      'sonarjs/no-hardcoded-ip': 'off',
      'sonarjs/no-os-command-from-path': 'off',
    },
  },
  {
    // Faux positifs S2187 : suites node:test / runners autonomes non
    // reconnues comme tests par l'analyseur — même exclusion que côté cloud
    // (sonar.issue.ignore.multicriteria dans sonar-project.properties).
    files: ['test/**/*.test.js'],
    rules: {
      'sonarjs/no-empty-test-file': 'off',
    },
  },
  {
    files: ['test/**/*.{js,mjs,cjs}', 'src/**/*.test.js'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.css'],
    plugins: { css },
    language: 'css/css',
    extends: ['css/recommended'],
  },
]);
