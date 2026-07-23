import { beforeEach, describe, expect, it, vi } from 'vitest';
import PersistentStore from '../../src/PersistentStore.js';

// Browser globals absent from the node environment: `Node` for the DOM
// filter, `localStorage` for save/load.
beforeEach(() => {
  vi.stubGlobal(
    'Node',
    class Node {},
  );
  const backing = new Map();
  vi.stubGlobal('localStorage', {
    getItem: key => backing.get(key) ?? null,
    setItem: (key, value) => backing.set(key, String(value)),
    removeItem: key => backing.delete(key),
  });
});

describe('PersistentStore.removeCircularReferences', () => {
  it('keeps legitimate shared references intact', () => {
    // Cas reel : les clones de sub mutualise partagent le tableau de filtre
    // du sub mesure — un anti-cycle par ensemble global les droppait.
    const store = new PersistentStore('test');
    const filter = [0.1, 0.2, 0.3];
    const payload = {
      banks: {
        reference: {
          channels: [
            { commandId: 'SW1', filter },
            { commandId: 'SW2', filter },
            { commandId: 'SW3', filter },
          ],
        },
      },
    };

    const parsed = JSON.parse(store.removeCircularReferences(payload));
    for (const channel of parsed.banks.reference.channels) {
      expect(channel.filter).toEqual([0.1, 0.2, 0.3]);
    }
  });

  it('keeps a shared object referenced from two branches', () => {
    const store = new PersistentStore('test');
    const shared = { value: 42 };
    const parsed = JSON.parse(
      store.removeCircularReferences({ left: shared, right: shared }),
    );
    expect(parsed.left).toEqual({ value: 42 });
    expect(parsed.right).toEqual({ value: 42 });
  });

  it('drops true circular references only', () => {
    const store = new PersistentStore('test');
    const node = { name: 'root' };
    node.self = node;
    node.child = { parent: node, name: 'child' };

    const parsed = JSON.parse(store.removeCircularReferences(node));
    expect(parsed.name).toBe('root');
    expect(parsed.self).toBeUndefined();
    expect(parsed.child.name).toBe('child');
    expect(parsed.child.parent).toBeUndefined();
  });

  it('round-trips through save and load', () => {
    const store = new PersistentStore('test');
    const filter = [1, 2];
    expect(
      store.save({ channels: [{ filter }, { filter }] }),
    ).toBe(true);
    expect(store.load()).toEqual({ channels: [{ filter: [1, 2] }, { filter: [1, 2] }] });
  });
});
