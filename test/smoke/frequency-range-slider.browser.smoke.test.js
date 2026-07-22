import { spawn } from 'node:child_process';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const PREVIEW_HOST = '127.0.0.1';
const PREVIEW_PORT = 4174;
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

async function waitForPreviewServer(getLogs) {
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

  throw new Error(
    `Timed out waiting for preview server at ${PREVIEW_URL}\n${getLogs()}`,
  );
}

function failIfRuntimeErrors(pageErrors, consoleErrors) {
  if (pageErrors.length === 0 && consoleErrors.length === 0) {
    return;
  }

  const details = [
    ...pageErrors.map(error => `pageerror: ${error}`),
    ...consoleErrors.map(error => `console: ${error}`),
  ].join('\n');

  throw new Error(`Frequency slider reported runtime errors:\n${details}`);
}

async function setFrequencyRange(page, lowerFrequency, upperFrequency) {
  await page.evaluate(
    ({ lowerFrequency, upperFrequency }) => {
      globalThis.viewModel.lowerFrequencyBound(lowerFrequency);
      globalThis.viewModel.upperFrequencyBound(upperFrequency);
    },
    { lowerFrequency, upperFrequency },
  );
  await page.waitForFunction(
    ({ lowerFrequency, upperFrequency }) =>
      globalThis.viewModel.lowerFrequencyBound() === lowerFrequency &&
      globalThis.viewModel.upperFrequencyBound() === upperFrequency,
    { lowerFrequency, upperFrequency },
  );
}

async function getSliderPoint(page) {
  const point = await page.evaluate(() => {
    const slider = document.querySelector('.dual-range-input');
    const minInput = document.querySelector('#min');
    const rect = slider.getBoundingClientRect();
    const minLog = Number(minInput.min);
    const maxLog = Number(minInput.max);
    // Source of truth is the KO observable, not the formatted input.value
    // (which can drift slightly through log10 round-trips).
    const logValue = Math.log10(globalThis.viewModel.lowerFrequencyBound());
    const ratio = (logValue - minLog) / (maxLog - minLog);

    return {
      x: rect.left + rect.width * ratio,
      y: rect.top + rect.height / 2,
      width: rect.width,
    };
  });

  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.width <= 0) {
    throw new Error(`Invalid slider geometry: ${JSON.stringify(point)}`);
  }

  return point;
}

async function dragFromOverlap(page, direction) {
  await setFrequencyRange(page, 1000, 1000);

  const point = await getSliderPoint(page);
  const deltaX = point.width * 0.12 * direction;

  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + deltaX, point.y, { steps: 8 });

  const duringDrag = await page.evaluate(() => ({
    lowerDragging: document.querySelector('#min').classList.contains('is-dragging'),
    upperDragging: document.querySelector('#max').classList.contains('is-dragging'),
  }));

  await page.mouse.up();

  const afterDrag = await page.evaluate(() => ({
    lowerFrequency: globalThis.viewModel.lowerFrequencyBound(),
    upperFrequency: globalThis.viewModel.upperFrequencyBound(),
    lowerDragging: document.querySelector('#min').classList.contains('is-dragging'),
    upperDragging: document.querySelector('#max').classList.contains('is-dragging'),
  }));

  return { duringDrag, afterDrag };
}

async function main() {
  const preview = startPreviewServer();
  let browser;

  try {
    await waitForPreviewServer(preview.getLogs);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

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

    await page.goto(`${PREVIEW_URL}/#application`, {
      waitUntil: 'networkidle',
      timeout: STARTUP_TIMEOUT_MS,
    });
    await page.waitForSelector('.dual-range-input', { timeout: STARTUP_TIMEOUT_MS });
    await page.waitForFunction(
      () => globalThis.viewModel && globalThis.frequencyRangeSlider,
      { timeout: STARTUP_TIMEOUT_MS },
    );
    // The operational-chain gating (REW + bridge + AVR) makes the slider's
    // control-group inert on a bare boot; this smoke exercises the slider
    // component itself, so unlock the chain flags directly.
    await page.evaluate(() => {
      globalThis.viewModel.isPolling(true);
      globalThis.viewModel.bridgeConnected(true);
      globalThis.viewModel.avrRegistered(true);
    });
    await page.locator('.dual-range-input').first().scrollIntoViewIfNeeded();

    failIfRuntimeErrors(pageErrors, consoleErrors);

    await page.evaluate(() => {
      globalThis.viewModel.upperFrequencyBound(20000);
    });
    const maxLimit = await page.evaluate(() => {
      const maxInput = document.querySelector('#max');
      return {
        observable: globalThis.viewModel.upperFrequencyBound(),
        aria: maxInput.getAttribute('aria-valuetext'),
      };
    });
    if (maxLimit.observable !== 20000 || maxLimit.aria !== '20000 Hz') {
      throw new Error(`Expected 20 kHz aria text, got ${JSON.stringify(maxLimit)}`);
    }

    await setFrequencyRange(page, 1000, 1000);
    const point = await getSliderPoint(page);
    await page.mouse.click(point.x, point.y);
    const afterThumbClick = await page.evaluate(() => ({
      lowerFrequency: globalThis.viewModel.lowerFrequencyBound(),
      upperFrequency: globalThis.viewModel.upperFrequencyBound(),
    }));
    if (
      afterThumbClick.lowerFrequency !== 1000 ||
      afterThumbClick.upperFrequency !== 1000
    ) {
      throw new Error(
        `Clicking an overlapped thumb without dragging should not move it: ${JSON.stringify(
          afterThumbClick,
        )}`,
      );
    }

    const leftDrag = await dragFromOverlap(page, -1);
    if (
      !leftDrag.duringDrag.lowerDragging ||
      leftDrag.duringDrag.upperDragging ||
      leftDrag.afterDrag.lowerFrequency >= 1000 ||
      leftDrag.afterDrag.upperFrequency !== 1000 ||
      leftDrag.afterDrag.lowerDragging ||
      leftDrag.afterDrag.upperDragging
    ) {
      throw new Error(`Expected left overlap drag to move lower only: ${JSON.stringify(leftDrag)}`);
    }

    const rightDrag = await dragFromOverlap(page, 1);
    if (
      rightDrag.duringDrag.lowerDragging ||
      !rightDrag.duringDrag.upperDragging ||
      rightDrag.afterDrag.lowerFrequency !== 1000 ||
      rightDrag.afterDrag.upperFrequency <= 1000 ||
      rightDrag.afterDrag.lowerDragging ||
      rightDrag.afterDrag.upperDragging
    ) {
      throw new Error(
        `Expected right overlap drag to move upper only: ${JSON.stringify(rightDrag)}`,
      );
    }

    // Hover should illuminate only the closest thumb, not both at once.
    await setFrequencyRange(page, 200, 5000);
    const lowerPoint = await page.evaluate(() => {
      const slider = document.querySelector('.dual-range-input');
      const minInput = document.querySelector('#min');
      const rect = slider.getBoundingClientRect();
      const ratio =
        (Math.log10(globalThis.viewModel.lowerFrequencyBound()) -
          Number(minInput.min)) /
        (Number(minInput.max) - Number(minInput.min));
      return { x: rect.left + rect.width * ratio, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(lowerPoint.x, lowerPoint.y);
    const hoverNearLower = await page.evaluate(() => ({
      lowerHovered: document.querySelector('#min').classList.contains('is-hovered'),
      upperHovered: document.querySelector('#max').classList.contains('is-hovered'),
    }));
    if (!hoverNearLower.lowerHovered || hoverNearLower.upperHovered) {
      throw new Error(
        `Hovering near the lower thumb should mark only it as hovered: ${JSON.stringify(
          hoverNearLower,
        )}`,
      );
    }

    const upperPoint = await page.evaluate(() => {
      const slider = document.querySelector('.dual-range-input');
      const maxInput = document.querySelector('#max');
      const rect = slider.getBoundingClientRect();
      const ratio =
        (Math.log10(globalThis.viewModel.upperFrequencyBound()) -
          Number(maxInput.min)) /
        (Number(maxInput.max) - Number(maxInput.min));
      return { x: rect.left + rect.width * ratio, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(upperPoint.x, upperPoint.y);
    const hoverNearUpper = await page.evaluate(() => ({
      lowerHovered: document.querySelector('#min').classList.contains('is-hovered'),
      upperHovered: document.querySelector('#max').classList.contains('is-hovered'),
    }));
    if (hoverNearUpper.lowerHovered || !hoverNearUpper.upperHovered) {
      throw new Error(
        `Hovering near the upper thumb should mark only it as hovered: ${JSON.stringify(
          hoverNearUpper,
        )}`,
      );
    }

    // Moving the pointer outside the slider must clear hover state from both.
    await page.mouse.move(0, 0);
    const hoverAfterLeave = await page.evaluate(() => ({
      lowerHovered: document.querySelector('#min').classList.contains('is-hovered'),
      upperHovered: document.querySelector('#max').classList.contains('is-hovered'),
    }));
    if (hoverAfterLeave.lowerHovered || hoverAfterLeave.upperHovered) {
      throw new Error(
        `Pointer leaving the slider should clear hover state: ${JSON.stringify(
          hoverAfterLeave,
        )}`,
      );
    }

    console.log('Frequency range slider browser smoke test passed');
  } finally {
    if (browser) {
      await browser.close();
    }
    await stopPreviewServer(preview);
  }
}

try {
  await main();
} catch (error) {
  console.error('Frequency range slider browser smoke test failed');
  console.error(error?.stack ?? error);
  process.exit(1);
}
