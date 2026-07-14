import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
// Absolute path to the locally-installed vite CLI. We spawn node itself
// (process.execPath, a fixed trusted path) with this script instead of
// resolving a command name such as "npx" through PATH — a PATH entry pointing
// at a writable directory could otherwise shadow the intended executable.
const VITE_BIN = path.join(
  path.dirname(require.resolve('vite/package.json')),
  'bin',
  'vite.js',
);

const PREVIEW_HOST = '127.0.0.1';
const PREVIEW_PORT = 4180; // distinct from the smoke tests (4173)
const STARTUP_TIMEOUT_MS = 30000;

/**
 * vite preview lifecycle for the e2e journeys (same pattern as
 * test/smoke/app-startup.browser.smoke.test.js). Requires `npm run build`
 * to have produced dist/ beforehand.
 */
function startPreviewServer() {
  const child = spawn(
    process.execPath,
    [VITE_BIN, 'preview', '--host', PREVIEW_HOST, '--port', String(PREVIEW_PORT)],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BROWSER: 'none' },
      detached: process.platform !== 'win32',
    },
  );

  let serverLogs = '';
  child.stdout.on('data', chunk => {
    serverLogs += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    serverLogs += chunk.toString();
  });

  return { child, getLogs: () => serverLogs };
}

async function stopPreviewServer(preview) {
  if (!preview?.child?.pid) return;

  try {
    if (process.platform === 'win32') {
      preview.child.kill('SIGTERM');
    } else {
      process.kill(-preview.child.pid, 'SIGTERM');
    }
  } catch {
    // Ignore cleanup races.
  }

  await delay(500);

  if (preview.child.exitCode === null) {
    try {
      if (process.platform === 'win32') {
        preview.child.kill('SIGKILL');
      } else {
        process.kill(-preview.child.pid, 'SIGKILL');
      }
    } catch {
      // Ignore cleanup races.
    }
  }
}

function previewUrl() {
  // E2E_TARGET selects the UI under test: 'knockout' (default) serves the
  // existing index.html; 'vue' will serve the Vue entry once it exists
  // (D-01: two Vite entries — the same journeys must pass on both).
  const target = process.env.E2E_TARGET ?? 'knockout';
  const base = `http://${PREVIEW_HOST}:${PREVIEW_PORT}`;
  return target === 'vue' ? `${base}/vue.html` : base;
}

async function waitForPreviewServer() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${PREVIEW_HOST}:${PREVIEW_PORT}`, {
        method: 'GET',
        headers: { Accept: 'text/html' },
      });
      if (response.ok) return;
    } catch {
      // Retry until timeout.
    }
    await delay(250);
  }

  throw new Error(`Timed out waiting for preview server on port ${PREVIEW_PORT}`);
}

export { previewUrl, startPreviewServer, stopPreviewServer, waitForPreviewServer };
