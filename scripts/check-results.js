#!/usr/bin/env node
'use strict';
/**
 * Validate a results file produced by the engine (or by the packaged app).
 *
 * CI uses this after every headless run, on both Linux and the Apple silicon
 * runner. A green build that produced no measurements is the failure mode this
 * exists to catch: a resolver list that silently went dead, a transport that
 * stopped answering, or an app that launched but never measured anything all
 * look like success otherwise.
 *
 *   node scripts/check-results.js results.json [--min-answered=2] [--min-samples=3]
 *
 * Exits 0 only when the file is a well-formed payload with real latency data.
 */

const fs = require('node:fs');

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  process.stderr.write('usage: node scripts/check-results.js <results.json> [--min-answered=N] [--min-samples=N]\n');
  process.exit(2);
}
const minAnswered = Number((args.find((a) => a.startsWith('--min-answered=')) || '').split('=')[1] || 2);
const minSamples = Number((args.find((a) => a.startsWith('--min-samples=')) || '').split('=')[1] || 3);

if (!fs.existsSync(file)) fail(`${file} does not exist`);
const results = JSON.parse(fs.readFileSync(file, 'utf8'));

if (results.schema !== 'resolverbench/1') fail(`unexpected schema: ${results.schema}`);
if (!Array.isArray(results.servers) || results.servers.length === 0) fail('no resolvers in the payload');
if (!results.meta || !results.meta.samplesPerResolver) fail('payload has no meta.samplesPerResolver');

const answered = results.servers.filter((s) => s.status !== 'dead');
if (answered.length < minAnswered) {
  fail(`${answered.length} resolver(s) answered, wanted at least ${minAnswered}: ${JSON.stringify(results.servers.map((s) => [s.label, s.status, s.notes]))}`);
}

const problems = [];
for (const server of answered) {
  for (const metric of ['cached', 'uncached', 'dotcom']) {
    const stat = server[metric];
    if (!stat) {
      problems.push(`${server.label}: no ${metric} section`);
      continue;
    }
    if (stat.samples < minSamples) {
      problems.push(`${server.label}: only ${stat.samples} ${metric} samples (wanted ${minSamples})`);
    }
    if (!(stat.median > 0) || stat.median > 5000) {
      problems.push(`${server.label}: implausible ${metric} median ${stat.median}`);
    }
  }
  if (!(server.reliability?.percent >= 50)) {
    problems.push(`${server.label}: reliability ${server.reliability?.percent}%`);
  }
}

if (problems.length > 0) fail(`measurement problems:\n  - ${problems.join('\n  - ')}`);

// Encrypted transports must show a connection cost and connection reuse, or the
// numbers are not what they claim to be.
const encrypted = answered.filter((s) => s.transport === 'dot' || s.transport === 'doh');
for (const server of encrypted) {
  if (!(server.setupMs > 0)) problems.push(`${server.label}: ${server.transport} setup time not measured`);
  if (!server.transportStats || !(server.transportStats.connections >= 1)) {
    problems.push(`${server.label}: no ${server.transport} connections recorded`);
  }
}

const fastest = answered
  .filter((s) => s.cached?.median)
  .sort((a, b) => a.cached.median - b.cached.median)[0];

process.stdout.write(
  `OK: ${answered.length}/${results.servers.length} resolvers answered, ` +
    `${results.meta.samplesPerResolver.cached}/${results.meta.samplesPerResolver.uncached}/${results.meta.samplesPerResolver.dotcom} ` +
    `cached/uncached/dot-com samples each, ${(results.durationMs / 1000).toFixed(1)}s` +
    (fastest ? `, fastest cached ${fastest.cached.median} ms (${fastest.label})` : '') +
    `\n`,
);

const transports = new Set(answered.map((s) => s.transport));
process.stdout.write(`transports exercised: ${[...transports].sort().join(', ')}\n`);
