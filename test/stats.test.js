'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const stats = require('../src/engine/stats');

const ramp = (n, start = 10, step = 1) => Array.from({ length: n }, (_, i) => start + i * step);

test('mean, median and percentile', () => {
  assert.equal(stats.mean([1, 2, 3, 4]), 2.5);
  assert.equal(stats.median([3, 1, 2]), 2);
  assert.equal(stats.median([4, 1, 3, 2]), 2.5);
  assert.equal(stats.percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(stats.percentile([1, 2, 3, 4, 5], 0), 1);
  assert.equal(stats.percentile([1, 2, 3, 4, 5], 1), 5);
  assert.equal(stats.percentile([], 0.5), null);
});

test('stdev is the sample standard deviation', () => {
  assert.equal(stats.stdev([5]), 0);
  // sd of 2,4,4,4,5,5,7,9 is 2.13809...
  assert.equal(Math.round(stats.stdev([2, 4, 4, 4, 5, 5, 7, 9]) * 1000) / 1000, 2.138);
});

test('summarize reports every field and counts lost replies separately', () => {
  const s = stats.summarize([10, 12, 14], 2);
  assert.equal(s.samples, 3);
  assert.equal(s.lost, 2);
  assert.equal(s.sent, 5);
  assert.equal(s.mean, 12);
  assert.equal(s.median, 12);
  assert.equal(s.min, 10);
  assert.equal(s.max, 14);
  assert.equal(s.stdev, 2);

  const empty = stats.summarize([], 4);
  assert.equal(empty.samples, 0);
  assert.equal(empty.mean, null);
  assert.equal(empty.lost, 4);
});

test('welch calls clearly separated distributions significantly different', () => {
  const a = ramp(20, 10, 0.5);
  const b = ramp(20, 40, 0.5);
  const result = stats.welch(a, b);
  assert.equal(result.applicable, true);
  assert.ok(result.p < 0.0001, `expected tiny p, got ${result.p}`);
  assert.equal(result.significant, true);
  assert.ok(
    (result.ci[0] > 0 && result.ci[1] > 0) || (result.ci[0] < 0 && result.ci[1] < 0),
    `confidence interval must exclude zero, got ${JSON.stringify(result.ci)}`,
  );
});

test('welch calls overlapping distributions a tie', () => {
  const a = [12, 13, 11, 14, 12.5, 13.5, 11.5, 12.8, 13.2, 12.1];
  const b = [12.4, 12.9, 11.8, 13.8, 12.2, 13.1, 11.9, 12.6, 13.4, 12.3];
  const result = stats.welch(a, b);
  assert.equal(result.applicable, true);
  assert.equal(result.significant, false);
  assert.ok(result.ci[0] < 0 && result.ci[1] > 0, 'interval must straddle zero');
});

test('welch survives tiny and identical samples', () => {
  assert.equal(stats.welch([1], [2]).applicable, false);
  const identical = stats.welch([5, 5, 5, 5], [5, 5, 5, 5]);
  assert.equal(identical.applicable, true);
  assert.equal(identical.diff, 0);
  assert.equal(identical.significant, false);
  assert.equal(identical.p, 1);

  const a = stats.welch([5, 5, 5, 5], [9, 9, 9, 9]);
  assert.equal(a.se, 0);
  assert.equal(a.significant, true);
});

test('t distribution helpers behave', () => {
  assert.ok(Math.abs(stats.tTail(0, 10) - 1) < 1e-9);
  assert.ok(stats.tTail(2.228, 10) > 0.04 && stats.tTail(2.228, 10) < 0.06);
  assert.ok(stats.tCritical95(5) > stats.tCritical95(60));
  assert.equal(stats.tCritical95(0), Number.POSITIVE_INFINITY);
});

test('overlapPercent explains how much of one distribution is worse than another', () => {
  assert.equal(stats.overlapPercent([1, 2, 3, 4, 5], [10, 11]), 0);
  assert.equal(stats.overlapPercent([10, 11, 12], [11]), 33.3);
  assert.equal(stats.overlapPercent([10, 11, 12], [9, 10]), 100);
  assert.equal(stats.overlapPercent([], [1]), null);
});
