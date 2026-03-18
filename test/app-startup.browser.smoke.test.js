import { spawn } from 'node:child_process';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const PREVIEW_HOST = '127.0.0.1';
const PREVIEW_PORT = 4173;
const PREVIEW_URL = `http://${PREVIEW_HOST}:${PREVIEW_PORT}`;
const STARTUP_TIMEOUT_MS = 30000;

function startPreviewServer() {
  const child = spawn(
    'npx',
    ['vite', 'preview', '--host', PREVIEW_HOST, '--port', String(PREVIEW_PORT)],
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
  if (!preview?.child?.pid) {
    return;
  }

  try {
    if (process.platform !== 'win32') {
      process.kill(-preview.child.pid, 'SIGTERM');
    } else {
      preview.child.kill('SIGTERM');
    }
  } catch {
    // Ignore cleanup races.
  }

  await delay(500);

  if (preview.child.exitCode === null) {
    try {
      if (process.platform !== 'win32') {
        process.kill(-preview.child.pid, 'SIGKILL');
      } else {
        preview.child.kill('SIGKILL');
      }
    } catch {
      // Ignore cleanup races.
    }
  }
}

async function waitForPreviewServer() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(PREVIEW_URL, {
        method: 'GET',
        headers: { Accept: 'text/html' },
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until timeout.
    }

    await delay(250);
  }

  throw new Error(`Timed out waiting for preview server at ${PREVIEW_URL}`);
}

function failIfRuntimeErrors(pageErrors, consoleErrors) {
  if (pageErrors.length === 0 && consoleErrors.length === 0) {
    return;
  }

  const details = [
    ...pageErrors.map(error => `pageerror: ${error}`),
    ...consoleErrors.map(error => `console: ${error}`),
  ].join('\n');

  throw new Error(`Application startup reported runtime errors:\n${details}`);
}

async function main() {
  const preview = startPreviewServer();
  let browser;

  try {
    await waitForPreviewServer();

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    const pageErrors = [];
    const consoleErrors = [];

    page.on('pageerror', error => {
      pageErrors.push(error?.stack ?? String(error));
    });

    page.on('console', message => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });

    await page.goto(PREVIEW_URL, {
      waitUntil: 'networkidle',
      timeout: STARTUP_TIMEOUT_MS,
    });
    await page.waitForSelector('#appContent', { timeout: STARTUP_TIMEOUT_MS });
    await delay(1000);

    failIfRuntimeErrors(pageErrors, consoleErrors);

    const title = await page.title();
    if (!title) {
      throw new Error('Expected the application page to have a title');
    }

    console.log('Browser smoke test passed');
  } finally {
    if (browser) {
      await browser.close();
    }
    await stopPreviewServer(preview);
  }
}

main().catch(error => {
  console.error('Browser smoke test failed');
  console.error(error?.stack ?? error);
  process.exit(1);
});
