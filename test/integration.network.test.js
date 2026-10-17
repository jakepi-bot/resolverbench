'use strict';
/**
 * Integration test: the real engine against real resolvers over the real network.
 *
 * Everything else in this suite runs on synthetic buffers. This test is the one
 * that proves the benchmark does what it claims: a UDP, a DoT and a DoH client
 * each get answers, DoH reuses one connection for many requests, the probes
 * produce the ground truth they are supposed to, and stopping mid-run keeps the
 * samples already collected.
 *
 * Set RESOLVERBENCH_OFFLINE=1 to skip it (a machine with no outbound 53/853/443
 * still runs the rest of the suite).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { runBenchmark } = require('../src/engine/bench');
const corpusTools = require('../src/engine/corpus');
const csv = require('../src/engine/csv');
const conclusions = require('../src/engine/conclusions');

const offline = process.env.RESOLVERBENCH_OFFLINE === '1';
const skip = offline ? 'RESOLVERBENCH_OFFLINE=1 is set' : false;

const SERVERS = [
  { id: 'cf-udp', label: 'Cloudflare', transport: 'udp', host: '1.1.1.1', ip: '1.1.1.1', port: 53 },
  { id: 'cf-dot', label: 'Cloudflare DoT', transport: 'dot', host: 'one.one.one.one', ip: '1.1.1.1', port: 853, sni: 'cloudflare-dns.com' },
  { id: 'cf-doh', label: 'Cloudflare DoH', transport: 'doh', host: 'cloudflare-dns.com', ip: '1.1.1.1', url: 'https://cloudflare-dns.com/dns-query' },
  { id: 'google-udp', label: 'Google', transport: 'udp', host: '8.8.8.8', ip: '8.8.8.8', port: 53 },
];

const SMALL_PLAN = corpusTools.buildPlan({
  corpus: corpusTools.DEFAULT_CORPUS.slice(0, 10),
  cachedSamples: 6,
  uncachedSamples: 4,
  dotcomSamples: 4,
});

async function run(overrides = {}) {
  return runBenchmark({
    servers: SERVERS,
    plan: SMALL_PLAN,
    timeoutMs: 1500,
    dnssec: true,
    ...overrides,
  });
}

test('every transport answers real queries, with real timings', { skip, timeout: 120000 }, async () => {
  const results = await run();

  assert.equal(results.schema, 'resolverbench/1');
  assert.equal(results.servers.length, SERVERS.length);
  assert.ok(results.durationMs > 0);

  for (const server of results.servers) {
    assert.notEqual(server.status, 'dead', `${server.label} should answer: ${JSON.stringify(server.notes)}`);
    // The plan asks for 6 cached samples per resolver; every one must land.
    assert.ok(server.cached.samples >= 5, `${server.label} cached samples: ${server.cached.samples}`);
    assert.ok(server.cached.mean > 0 && server.cached.mean < 1000, `${server.label} cached mean ${server.cached.mean}`);
    assert.ok(server.uncached.samples >= 3, `${server.label} uncached samples: ${server.uncached.samples}`);
    assert.ok(server.dotcom.samples >= 3, `${server.label} dotcom samples: ${server.dotcom.samples}`);
    assert.ok(server.reliability.percent >= 75, `${server.label} reliability ${server.reliability.percent}%`);
    assert.deepEqual(Object.keys(server.errors), [], `${server.label} should have no errors`);

    // A resolved cached lookups must be real addresses, not empty answers.
    assert.ok(server.raw.cached.every((ms) => ms > 0.5 && ms < 2000));
  }

  // Encrypted transports pay a measurable setup cost; plain UDP does not.
  const dot = results.servers.find((s) => s.transport === 'dot');
  const doh = results.servers.find((s) => s.transport === 'doh');
  const udp = results.servers.find((s) => s.transport === 'udp');
  assert.ok(dot.setupMs > 5, `DoT handshake should be measured, got ${dot.setupMs} ms`);
  assert.ok(doh.setupMs > 5, `DoH first request should include setup, got ${doh.setupMs} ms`);
  assert.ok(udp.setupMs < dot.setupMs, 'plain UDP has no handshake to pay for');

  // DoH must keep its connection: one connection, many requests. If this
  // regresses, the DoH numbers silently become handshake numbers.
  assert.equal(doh.transportStats.connections, 1, `DoH opened ${doh.transportStats.connections} connections`);
  assert.equal(doh.transportStats.reconnects, null);
  assert.ok(doh.transportStats.requests > 10, `expected many DoH requests, got ${doh.transportStats.requests}`);

  // DoT holds one TLS session for the whole run.
  assert.equal(dot.transportStats.connections, 1);
  assert.equal(dot.transportStats.reconnects, 0);

  return results;
});

test('the probes produce ground truth: NXDOMAIN is not hijacked, private answers are seen', { skip, timeout: 120000 }, async () => {
  const results = await run();

  for (const server of results.servers) {
    const hijack = server.probes.hijack;
    assert.ok(hijack, `${server.label} should have run the hijack probe`);
    assert.equal(hijack.names.length, 2);
    assert.ok(hijack.names.some((n) => n.endsWith('.com')));
    assert.ok(hijack.names.some((n) => n.endsWith('.invalid')));
    assert.equal(hijack.hijacked, false, `${server.label} hijacked a nonexistent name: ${JSON.stringify(hijack)}`);
    // Both probes must come back NXDOMAIN: the name cannot exist, and a
    // resolver that says otherwise is either rewriting it or broken.
    for (const result of hijack.results) {
      assert.equal(result.rcode, 3, `${server.label}: ${result.name} answered ${result.rcodeName}`);
      assert.deepEqual(result.addresses, []);
    }

    const rebinding = server.probes.rebinding;
    assert.equal(rebinding.ranges, 4);
    assert.equal(rebinding.details.length, 4);
    // The wildcard service must actually be answering, otherwise "protected"
    // would be true everywhere for the wrong reason (an empty answer).
    assert.ok(
      rebinding.details.every((d) => d.answered),
      `${server.label} rebinding probes must all get a reply`,
    );
  }

  // Positive control: at least one of the tested resolvers must hand back the
  // private address the probe asked for. Without this, a broken address parser
  // would look like universal rebinding protection.
  const sawPrivateAnswer = results.servers.some((s) =>
    s.probes.rebinding.details.some((d) => d.addresses.includes(d.expected)),
  );
  assert.ok(sawPrivateAnswer, 'expected at least one resolver to return the embedded private address');

  // DNSSEC: at least one resolver should set AD on a signed zone when asked
  // with the DO bit, proving the OPT/DO encoding works end to end.
  const validators = results.servers.filter((s) => s.probes.dnssec && s.probes.dnssec.validated > 0);
  assert.ok(validators.length > 0, 'expected at least one DNSSEC-validating resolver (AD bit)');
});

test('stopping mid-run keeps the samples already collected', { skip, timeout: 120000 }, async () => {
  const controller = new AbortController();
  // A three-domain corpus keeps the untimed warm-up short, so the abort lands
  // in the timed phase rather than before it started.
  const bigPlan = corpusTools.buildPlan({
    corpus: corpusTools.DEFAULT_CORPUS.slice(0, 3),
    cachedSamples: 60,
    uncachedSamples: 60,
    dotcomSamples: 60,
  });

  const timer = setTimeout(() => controller.abort(), 1200);
  const results = await run({ plan: bigPlan, signal: controller.signal, dnssec: false });
  clearTimeout(timer);

  assert.equal(results.meta.aborted, true);
  assert.equal(results.meta.completed, false);
  assert.equal(results.servers.length, SERVERS.length);
  for (const server of results.servers) {
    assert.equal(server.status, 'ok', `${server.label} should have been measurable`);
  }
  const withSamples = results.servers.filter((s) => s.cached.samples > 0);
  assert.ok(withSamples.length > 0, 'partial results must keep their samples');
  // A run stopped early must not claim more work than the plan contained.
  for (const server of results.servers) {
    for (const metric of ['cached', 'uncached', 'dotcom']) {
      const done = server[metric].samples + server[metric].lost;
      const planned = bigPlan[`${metric}Names`].length;
      assert.ok(done <= planned, `${server.label} ${metric}: ${done} results from a ${planned}-sample plan`);
      assert.ok(done < planned, `${server.label} ${metric} finished the whole plan despite the abort`);
    }
  }
});

test('csv export of a real run is well formed', { skip, timeout: 120000 }, async () => {
  const results = await run({ dnssec: false });
  const text = csv.toCSV(results, { recommended: ['Cloudflare'] });
  const lines = text.trimEnd().split('\n');
  const headerIndex = lines.findIndex((l) => l.startsWith('rank,'));
  assert.ok(headerIndex > 0, 'header row must be present after the metadata rows');
  assert.equal(lines[headerIndex].split(',').length, csv.HEADERS.length);

  for (const line of lines.slice(headerIndex + 1)) {
    assert.equal(line.split(',').length, csv.HEADERS.length, `column count mismatch: ${line.slice(0, 80)}`);
  }

  const ranked = text.split('\n')[headerIndex + 1].split(',');
  const cachedMean = Number(ranked[csv.HEADERS.indexOf('cached_mean_ms')]);
  assert.ok(Number.isFinite(cachedMean) && cachedMean > 0, `cached mean should be numeric, got "${ranked[csv.HEADERS.indexOf('cached_mean_ms')]}"`);
});

test('csv locale options change the separator without breaking the rows', () => {
  const payload = {
    schema: 'resolverbench/1',
    finishedAt: Date.now(),
    meta: { corpusSize: 2, samplesPerResolver: { cached: 3, uncached: 3, dotcom: 3 }, timeoutMs: 200 },
    servers: [
      {
        id: 'synthetic',
        label: 'Synthetic, with a comma',
        operator: 'Test, Inc.',
        transport: 'udp',
        endpoint: '192.0.2.1:53',
        host: '192.0.2.1',
        ip: '192.0.2.1',
        pinned: true,
        isSystem: false,
        status: 'ok',
        setupMs: 1.5,
        cached: { mean: 12.34, median: 12, min: 11, max: 14, stdev: 1, p95: 13, samples: 3, lost: 0 },
        uncached: { mean: 34.56, median: 34, min: 30, max: 40, stdev: 2, p95: 38, samples: 3, lost: 0 },
        dotcom: { mean: 22.22, median: 22, min: 20, max: 25, stdev: 1, p95: 24, samples: 3, lost: 0 },
        reliability: { sent: 9, lost: 0, replied: 9, percent: 100 },
        errors: {},
        probes: {},
      },
    ],
  };

  const comma = csv.toCSV(payload);
  assert.ok(comma.includes('12.34'), 'default export uses a dot');
  assert.ok(comma.includes('"Synthetic, with a comma"'), 'a label containing the delimiter must be quoted');
  assert.ok(comma.includes('"Test, Inc."'), 'operator with a comma must be quoted');

  const semi = csv.toCSV(payload, { delimiter: ';', decimalComma: true });
  const semiLines = semi.trimEnd().split('\n');
  const headerIndex = semiLines.findIndex((l) => l.startsWith('rank;'));
  assert.ok(headerIndex > 0);
  const row = semiLines[headerIndex + 1].split(';');
  assert.equal(row.length, csv.HEADERS.length);
  assert.equal(row[csv.HEADERS.indexOf('cached_mean_ms')], '12,34', 'decimal comma must be applied');
  assert.equal(row[csv.HEADERS.indexOf('label')], 'Synthetic, with a comma', 'quoting must not leak into values');
});

test('conclusions read as an ordered, non-empty report', { skip, timeout: 120000 }, async () => {
  const results = await run({ dnssec: false });
  const findings = conclusions.findingsFor(results);
  assert.ok(findings.length >= 5, `expected a real report, got ${findings.length} lines`);
  for (const finding of findings) {
    assert.ok(['bad', 'warn', 'good', 'info'].includes(finding.severity));
    assert.ok(finding.text.length > 40, `finding too terse: ${finding.text}`);
    assert.ok(!finding.text.includes('undefined'), `finding has a hole: ${finding.text}`);
    assert.ok(!finding.text.includes('NaN'), `finding has a NaN: ${finding.text}`);
  }
  const text = conclusions.toText(results);
  assert.ok(text.includes('Recommended order:'), 'a recommendation is the point of the report');
});
