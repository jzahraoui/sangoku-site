import { chromium } from 'playwright';
import { BridgeMock } from './bridge-mock/index.js';
import { RewMock } from './rew-mock/index.js';
import {
  previewUrl,
  startPreviewServer,
  stopPreviewServer,
  waitForPreviewServer,
} from './server.js';

const PAGE_TIMEOUT_MS = 30000;

/**
 * Shared journey harness: preview server + Chromium + REW mock + bridge mock.
 *
 * Usage in a node --test file:
 *   const harness = await startHarness();
 *   ... harness.page / harness.rew / harness.bridge ...
 *   await stopHarness(harness);
 *
 * `options.bridge` is forwarded to the BridgeMock constructor (e.g.
 * `{ registered: false }` to start without a pre-registered AVR).
 */
async function startHarness(options = {}) {
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

    // The change-log page fetches the GitHub commits API at boot: stub it so
    // the journeys never depend on external network nor its rate limit (403).
    await page.route('**/api.github.com/**', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );

    const rew = new RewMock();
    await rew.attach(page);

    const bridge = new BridgeMock(options.bridge);
    await bridge.attach(page);

    await page.goto(previewUrl(), { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS });
    await page.waitForSelector('#appContent', { timeout: PAGE_TIMEOUT_MS });

    return { preview, browser, context, page, rew, bridge, pageErrors };
  } catch (error) {
    if (browser) await browser.close();
    await stopPreviewServer(preview);
    throw error;
  }
}

/**
 * Ensures the RCH Bridge (mock) is connected and its panel visible — the AVR
 * is pre-registered by default, so this turns the bridge/AVR chain links
 * green. A restored session auto-reconnects the bridge at boot (persistence),
 * so wait briefly for that before deciding to click: clicking the toggle on
 * an already-connected bridge would disconnect it.
 */
async function connectBridge(page) {
  const version = page.getByTestId('bridge-version');
  const autoConnected = await version.waitFor({ state: 'attached', timeout: 2000 }).then(
    () => true,
    () => false,
  );
  if (!autoConnected) {
    await page.getByTestId('bridge-connect').click();
    await version.filter({ hasText: '1.0.0' }).waitFor({ state: 'attached' });
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

/** Fails the test if a mock (REW or bridge) saw unknown routes or handler errors. */
function assertMockClean(...mocks) {
  for (const mock of mocks.filter(Boolean)) {
    const label = mock.constructor.name;
    if (mock.unknownRequests.length > 0) {
      throw new Error(
        `${label} received unimplemented routes:\n${[...new Set(mock.unknownRequests)].join('\n')}`,
      );
    }
    if (mock.errors.length > 0) {
      throw new Error(
        `${label} handlers raised errors:\n${mock.errors
          .map(e => `${e.method} ${e.path}: ${e.error}`)
          .join('\n')}`,
      );
    }
  }
}

export {
  assertMockClean,
  clickAndDownload,
  connectBridge,
  startHarness,
  stopHarness,
  waitForStatus,
};
