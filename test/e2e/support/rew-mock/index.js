import { buildRoutes } from './handlers.js';
import { RewStore } from './store.js';

const REW_PORT = '4735';

/**
 * Stateful REW API test double attached to a Playwright page via
 * `page.route()`. Every request whose URL targets port 4735 is served
 * in-process; unknown routes answer 404 and are recorded so the journeys
 * can fail fast on unexpected traffic.
 *
 * Design notes: docs/reverse/02-rew-mock.md (§ 3 conception, § 5 arbitrages).
 */
class RewMock {
  constructor() {
    this.store = new RewStore();
    this.routes = buildRoutes(this.store);
    this.unknownRequests = [];
    this.errors = [];
    this.trace = []; // last exchanges, for journey debugging
    this.traceLimit = 200;
  }

  record(entry) {
    this.trace.push(entry);
    if (this.trace.length > this.traceLimit) this.trace.shift();
  }

  async attach(page) {
    await page.route(
      url => url.port === REW_PORT,
      async route => {
        const request = route.request();
        const url = new URL(request.url());
        const method = request.method();
        const body = parseBody(request.postData());

        let response;
        try {
          response = this.dispatch(method, url.pathname, url.searchParams, body);
        } catch (error) {
          this.errors.push({ method, path: url.pathname, error: error.message });
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ message: error.message }),
          });
          return;
        }

        if (response === undefined) {
          this.unknownRequests.push(`${method} ${url.pathname}`);
          await route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({
              message: `Not implemented in REW mock: ${method} ${url.pathname}`,
            }),
          });
          return;
        }

        const status = response?.__status ?? 200;
        if (response?.__status) delete response.__status;
        if (method !== 'GET' || !/^\/measurements$/.test(url.pathname)) {
          this.record({
            method,
            path: url.pathname,
            body: truncate(body),
            response: truncate(response),
          });
        }
        await route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify(response),
        });
      },
    );
  }

  dispatch(method, pathname, searchParams, body) {
    for (const { method: m, pattern, handler } of this.routes) {
      if (m !== method) continue;
      const match = pattern.exec(pathname);
      if (match) return handler(match, searchParams, body);
    }
    return undefined;
  }

  /** Titles currently in the store, in listing order. */
  titles() {
    return [...this.store.measurements.values()].map(record => record.title);
  }
}

function truncate(value) {
  const text = JSON.stringify(value);
  if (!text) return text;
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function parseBody(postData) {
  if (!postData) return undefined;
  try {
    return JSON.parse(postData);
  } catch {
    return postData;
  }
}

export { RewMock };
