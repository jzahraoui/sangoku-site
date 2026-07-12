import { describe, expect, it, vi } from 'vitest';
import { LogService } from '../../src/logs.js';

describe('LogService (agnostic)', () => {
  it('records entries with a lowercased level and notifies listeners', () => {
    const service = new LogService();
    const listener = vi.fn();
    service.subscribe(listener);

    service.info('hello');
    service.error('boom');

    expect(service.getEntries()).toHaveLength(2);
    expect(service.getEntries()[0]).toMatchObject({ level: 'info', message: 'hello' });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1][0]).toMatchObject({ type: 'log' });
  });

  it('filters entries at or above the current level', () => {
    const service = new LogService();
    service.info('i');
    service.debug('d');
    service.error('e');

    service.setLevel('WARN'); // ERROR, WARN only
    expect(service.getFilteredEntries().map(l => l.message)).toEqual(['e']);
    service.setLevel('DEBUG'); // everything
    expect(service.getFilteredEntries()).toHaveLength(3);
  });

  it('drops the oldest entry past the cap (ring buffer)', () => {
    const service = new LogService();
    service.maxLogs = 2;
    service.info('a');
    service.info('b');
    service.info('c');
    expect(service.getEntries().map(l => l.message)).toEqual(['b', 'c']);
  });

  it('emits clear / level / autoScroll events and unsubscribes', () => {
    const service = new LogService();
    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);

    service.clearLogs();
    service.setLevel('DEBUG');
    service.setAutoScroll(false);
    expect(listener.mock.calls.map(c => c[0].type)).toEqual(['clear', 'level', 'autoScroll']);
    // idempotent setters do not re-emit
    service.setAutoScroll(false);
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    service.info('x');
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('formats a plain-text dump', () => {
    const service = new LogService();
    service.success('done');
    expect(service.formatLogsText()).toMatch(/\] \[SUCCESS\] done$/);
  });

  it('detached log methods stay bound to the instance', () => {
    // Régression : `const f = log.info; f(msg)` plantait en production
    // (« Cannot read properties of undefined (reading 'addLog') ») quand une
    // méthode était sélectionnée conditionnellement puis appelée détachée.
    const service = new LogService();
    const { info, warn, error, debug, success, log } = service;
    info('a');
    warn('b');
    error('c');
    debug('d');
    success('e');
    log('f');
    expect(service.getEntries().map(entry => entry.level)).toEqual([
      'info',
      'warn',
      'error',
      'debug',
      'success',
      'info',
    ]);
  });
});
