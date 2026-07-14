/**
 * safe-path.mjs — validation des chemins passés en argument CLI aux scripts
 * de génération de goldens (source unique, partagée par generate-ady-fixtures
 * et generate-oca-golden).
 *
 * Deux contrats distincts :
 *   - safeInputFile : fichier LU uniquement. Le fichier de mesures (.ady) vit
 *     légitimement hors du dépôt (ex. /mnt/c/… en WSL) — on canonicalise
 *     (liens symboliques, « .. ») et on exige son existence, sans le confiner.
 *   - safeOutputDir : cible d'ÉCRITURE (mkdir/writeFile). Un argument
 *     malveillant (ex. via un agent LLM) ne doit pas pouvoir écrire hors du
 *     dépôt : canonicalisation puis confinement au répertoire de travail
 *     courant (doc Sonar S8707).
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';

export function safeInputFile(target) {
  try {
    return realpathSync(target); // résout liens symboliques et « .. »
  } catch {
    throw new Error(`input file '${target}' does not exist or is unreadable`);
  }
}

export function safeOutputDir(target) {
  const baseDir = realpathSync(process.cwd());
  let resolved;
  try {
    resolved = realpathSync(target); // résout liens symboliques et « .. »
  } catch {
    resolved = path.resolve(baseDir, target); // cible pas encore créée
  }
  if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) {
    throw new Error(`output path '${target}' is outside the allowed directory`);
  }
  return resolved;
}
