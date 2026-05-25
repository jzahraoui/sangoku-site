/**
 * public-entrypoints.test.js
 *
 * Vérifie que les points d'entrée publics officiels exportent
 * les symboles attendus.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AutoEQCalculator,
  BiquadFilter,
  FilterSet,
  FilterParameterOptimizer,
  optimizeWithNewtonBfgs,
} from '../../src/index.js';

import * as dsp from '../../src/dsp/index.js';
import * as optimization from '../../src/optimization/index.js';

test('main public entrypoint exports expected API', () => {
  assert.equal(typeof AutoEQCalculator, 'function');
  assert.equal(typeof BiquadFilter, 'function');
  assert.equal(typeof FilterSet, 'function');
  assert.equal(typeof FilterParameterOptimizer, 'function');
  assert.equal(typeof optimizeWithNewtonBfgs, 'function');
});

test('domain public entrypoints export expected API', () => {
  assert.equal(typeof dsp.BiquadFilter, 'function');
  assert.equal(typeof dsp.FilterSet, 'function');
  assert.equal(typeof optimization.FilterParameterOptimizer, 'function');
  assert.equal(typeof optimization.optimizeWithNewtonBfgs, 'function');
});
