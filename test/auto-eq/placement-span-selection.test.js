import assert from 'node:assert/strict';
import { test } from 'node:test';

import { selectActivePlacementSpans } from '../../src/autoeq/placementSpanSelection.js';

test('returns all spans when candidate placement is disabled', () => {
  const spans = [{ priority: 10 }, { priority: 1 }];

  const out = selectActivePlacementSpans(spans, {
    useCandidatePlacement: false,
    priorityRatio: 0.5,
  });

  assert.equal(out, spans);
});

test('filters spans below priority ratio', () => {
  const spans = [{ priority: 10 }, { priority: 7 }, { priority: 4 }];

  const out = selectActivePlacementSpans(spans, {
    useCandidatePlacement: true,
    priorityRatio: 0.6,
  });

  assert.deepEqual(out, [{ priority: 10 }, { priority: 7 }]);
});

test('keeps all spans when top priority is non-positive', () => {
  const spans = [{ priority: 0 }, { priority: -1 }];

  const out = selectActivePlacementSpans(spans, {
    useCandidatePlacement: true,
    priorityRatio: 0.6,
  });

  assert.equal(out, spans);
});
