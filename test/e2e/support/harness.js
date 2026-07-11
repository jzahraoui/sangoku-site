import { chromium } from 'playwright';
import { RewMock } from './rew-mock/index.js';
import {
  previewUrl,
  startPreviewServer,
  stopPreviewServer,
  waitForPreviewServer,
} from './server.js';

const PAGE_TIMEOUT_MS = 30000;

/**
 * Shared journey harness: preview server + Chromium + REW mock.
 *
 * Usage in a node --test file:
 *   const harness = await startHarness();
 *   ... harness.page / harness.rew ...
 *   await stopHarness(harness);
 */
async function startHarness() {
  const preview = startPreviewServer();
  let browser;
  try {
    await waitForPreviewServer();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);

    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error?.stack ?? String(error)));

    const rew = new RewMock();
    await rew.attach(page);

    await page.goto(previewUrl(), { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS });
    await page.waitForSelector('#appContent', { timeout: PAGE_TIMEOUT_MS });

    return { preview, browser, context, page, rew, pageErrors };
  } catch (error) {
    if (browser) await browser.close();
    await stopPreviewServer(preview);
    throw error;
  }
}

async function stopHarness(harness) {
  if (!harness) return;
  if (harness.browser) await harness.browser.close();
  await stopPreviewServer(harness.preview);
}

/** Waits for the status banner to display the given text. */
async function waitForStatus(page, text, timeout = 120000) {
  await page
    .getByTestId('status-message')
    .filter({ hasText: text })
    .waitFor({ state: 'attached', timeout });
}

/** Clicks an element and captures the resulting file download. */
async function clickAndDownload(page, testId, timeout = 180000) {
  const downloadPromise = page.waitForEvent('download', { timeout });
  await page.getByTestId(testId).click();
  const download = await downloadPromise;
  const path = await download.path();
  return { download, path, suggestedFilename: download.suggestedFilename() };
}

/** Fails the test if the REW mock saw unknown routes or handler errors. */
function assertMockClean(rew) {
  if (rew.unknownRequests.length > 0) {
    throw new Error(
      `REW mock received unimplemented routes:\n${[...new Set(rew.unknownRequests)].join('\n')}`,
    );
  }
  if (rew.errors.length > 0) {
    throw new Error(
      `REW mock handlers raised errors:\n${rew.errors
        .map(e => `${e.method} ${e.path}: ${e.error}`)
        .join('\n')}`,
    );
  }
}

export { assertMockClean, clickAndDownload, startHarness, stopHarness, waitForStatus };
