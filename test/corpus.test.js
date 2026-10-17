'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const corpus = require('../src/engine/corpus');

test('the built-in corpus is fifty distinct, syntactically valid domains', () => {
  assert.equal(corpus.DEFAULT_CORPUS.length, 50);
  assert.equal(new Set(corpus.DEFAULT_CORPUS).size, 50, 'no duplicates');
  for (const domain of corpus.DEFAULT_CORPUS) {
    assert.match(domain, /^[a-z0-9.-]+\.[a-z]{2,}$/, `${domain} should look like a domain`);
    assert.ok(domain.length <= 253);
  }
});

test('default plan matches the fifty-lookups-per-resolver figure', () => {
  const plan = corpus.buildPlan();
  assert.equal(plan.cachedNames.length, 20);
  assert.equal(plan.uncachedNames.length, 15);
  assert.equal(plan.dotcomNames.length, 15);
  assert.equal(plan.totalTimed, 50);
  // cached names are corpus names, so a warm-up pass can prime the cache
  for (const name of plan.cachedNames) assert.ok(plan.corpus.includes(name));
  for (const name of plan.uncachedNames) {
    assert.ok(plan.corpus.some((d) => name.endsWith(`.${d}`)), `${name} should sit under a corpus domain`);
  }
  for (const name of plan.dotcomNames) assert.match(name, /\.com$/);
  assert.equal(new Set(plan.uncachedNames).size, plan.uncachedNames.length, 'uncached names must be unique');
});

test('random labels do not repeat across thousands of calls', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i += 1) seen.add(corpus.randomLabel());
  assert.equal(seen.size, 5000);
  for (const label of seen) assert.match(label, /^[0-9a-f]{8,}$/);
});

test('probe names have the shape the probes rely on', () => {
  const nonExistent = corpus.nonExistentNames();
  assert.equal(nonExistent.length, 2);
  assert.match(nonExistent[0], /^[0-9a-f]+\.com$/);
  assert.match(nonExistent[1], /^[0-9a-f]+\.invalid$/);
  assert.notEqual(nonExistent[0], nonExistent[1]);
  // The reserved example zones answer NOERROR/NODATA rather than NXDOMAIN, so
  // they must never be used as the hijack probe (see corpus.js).
  for (const name of nonExistent) assert.ok(!name.includes('example.'), `${name} would not prove anything`);
  assert.match(corpus.dotcomName(), /^[0-9a-f]+\.com$/);
  assert.match(corpus.uncachedName('google.com'), /^[0-9a-f]+\.google\.com$/);

  const rebind = corpus.rebindingNames();
  assert.equal(rebind.length, 4);
  assert.deepEqual(
    rebind.map((r) => r.range),
    ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8'],
  );
  assert.equal(rebind.find((r) => r.range === '10.0.0.0/8').expect, '10.0.0.1');
  for (const probe of rebind) {
    assert.ok(probe.name.endsWith(`.${corpus.REBIND_SUFFIX}`));
    assert.ok(
      probe.name.includes(`${probe.expect.split('.').join('-')}.`),
      `${probe.name} must encode ${probe.expect}`,
    );
  }

  const zones = corpus.dnssecNames();
  assert.ok(zones.length >= 2);
  for (const zone of zones) assert.equal(zone.name, zone.zone);
});

test('parseDomainList accepts comments, blanks and both separators', () => {
  const list = corpus.parseDomainList(`
    # a comment
    google.com
    Example.COM   ; trailing comment
    apple.com microsoft.com
    ; another comment
    netflix.com,spotify.com

  `);
  assert.deepEqual(list, [
    'google.com',
    'example.com',
    'apple.com',
    'microsoft.com',
    'netflix.com',
    'spotify.com',
  ]);
});

test('parseDomainList rejects things that are not domains', () => {
  assert.throws(() => corpus.parseDomainList('not a domain'), /not a valid domain/);
  assert.throws(() => corpus.parseDomainList('http://example.com'), /not a valid domain/);
  assert.throws(() => corpus.parseDomainList('-leading.example.com'), /not a valid domain/);
});

test('loadDomainList reads a file and refuses an empty one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolverbench-'));
  const good = path.join(dir, 'domains.txt');
  fs.writeFileSync(good, '# corpus\ngoogle.com\napple.com\n');
  assert.deepEqual(corpus.loadDomainList(good), ['google.com', 'apple.com']);

  const empty = path.join(dir, 'empty.txt');
  fs.writeFileSync(empty, '# nothing here\n');
  assert.throws(() => corpus.loadDomainList(empty), /no usable domains/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a custom corpus changes the plan', () => {
  const plan = corpus.buildPlan({
    corpus: ['a.example', 'b.example', 'c.example'],
    cachedSamples: 4,
    uncachedSamples: 2,
    dotcomSamples: 1,
  });
  assert.equal(plan.cachedNames.length, 4);
  assert.equal(plan.uncachedNames.length, 2);
  assert.equal(plan.dotcomNames.length, 1);
  assert.deepEqual(plan.cachedNames, ['a.example', 'b.example', 'c.example', 'a.example']);
});
