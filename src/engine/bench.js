'use strict';
/**
 * The benchmark itself.
 *
 * Four phases, and the reason for each:
 *
 *   connect  open each transport. A DoT resolver pays its TCP+TLS handshake
 *            here, and that cost is reported as the resolver's setup time.
 *   warm     resolve every name that will later be used as a cached sample,
 *            once, untimed, so the cached column measures cache hits instead of
 *            measuring who happened to be asked first. For DoH the first
 *            request also establishes TLS + the HTTP session, and its cost
 *            becomes the setup time.
 *   timed    round-robin: every surviving resolver answers one cached, one
 *            uncached and one dot-com question per round, with all resolvers
 *            running in parallel. Interleaving matters — a resolver measured
 *            alone gets the network to itself, and a resolver measured while a
 *            neighbour hammers the link does not.
 *   probes   the one-shot characterisation questions: typo hijacking, DNS
 *            rebinding protection, and (optionally) DNSSEC validation.
 *
 * Resolvers that never answer are marked dead and skipped from then on, which
 * is what GRC's "Remove dead nameservers" is about. Stop aborts where it
 * stands and still reports the samples collected so far.
 */

const { createClient } = require('./transports');
const stats = require('./stats');
const corpusTools = require('./corpus');

const DEFAULTS = {
  timeoutMs: 1200,
  dnssec: false,
  rebinding: true,
  hijack: true,
};

const PHASES = ['connect', 'warm', 'timed', 'probes'];

function endpointLabel(server) {
  switch (server.transport) {
    case 'doh':
      return (server.url || '').replace(/^https:\/\//, '').replace(/\/$/, '');
    case 'dot':
      return `${server.host}:${server.port || 853}`;
    default:
      return `${server.ip || server.host}:${server.port || 53}`;
  }
}

async function runBenchmark(options) {
  const opts = { ...DEFAULTS, ...options };
  const servers = options.servers || [];
  const plan = options.plan || corpusTools.buildPlan();
  const onEvent = options.onEvent || (() => {});
  const signal = options.signal;
  const startedAt = Date.now();

  const state = new Map();
  for (const server of servers) {
    state.set(server.id, {
      server,
      client: null,
      status: 'pending',
      setupMs: null,
      samples: { cached: [], uncached: [], dotcom: [] },
      lost: { cached: 0, uncached: 0, dotcom: 0 },
      sent: { cached: 0, uncached: 0, dotcom: 0 },
      errors: new Map(),
      notes: [],
      probes: {},
      lastError: null,
    });
  }

  const entries = () => [...state.values()];
  const isAborted = () => !!(signal && signal.aborted);
  const isAlive = (entry) => entry.status === 'ok' || entry.status === 'unreliable';

  const recordError = (entry, result) => {
    const key = result.error || (result.rcodeName ? `rcode-${result.rcodeName}` : 'unknown');
    entry.errors.set(key, (entry.errors.get(key) || 0) + 1);
    entry.lastError = key;
  };

  /** One question, one sample. Never throws, never leaves a hole in the counts. */
  async function ask(entry, metric, name) {
    if (!entry.client || isAborted()) return null;
    entry.sent[metric] += 1;
    const result = await entry.client.query(name, { timeoutMs: opts.timeoutMs });

    if (result.error) {
      entry.lost[metric] += 1;
      recordError(entry, result);
    } else {
      // Any reply counts as a reply: NXDOMAIN and REFUSED answer the
      // reliability question even though they carry no addresses.
      entry.samples[metric].push(result.ms);
    }
    onEvent({ type: 'sample', serverId: entry.server.id, metric, name, result });
    return result;
  }

  let lastUpdate = 0;
  const emitUpdate = (force = false) => {
    const now = Date.now();
    if (!force && now - lastUpdate < 120) return;
    lastUpdate = now;
    onEvent({ type: 'update', servers: entries().map(snapshot) });
  };

  // --- phase 1: connect -----------------------------------------------------
  async function phaseConnect() {
    await Promise.all(
      servers.map(async (server) => {
        const entry = state.get(server.id);
        try {
          entry.client = createClient(server, { timeoutMs: opts.timeoutMs });
          const opened = await entry.client.open();
          if (opened && opened.setupMs !== null && opened.setupMs !== undefined) {
            entry.setupMs = opened.setupMs;
          }
        } catch (err) {
          entry.status = 'dead';
          entry.notes.push(`could not open transport: ${err.message}`);
          onEvent({ type: 'server', serverId: server.id, status: 'dead', note: entry.notes.at(-1) });
        }
      }),
    );
  }

  // --- phase 2: warm ------------------------------------------------------
  async function phaseWarm() {
    const warmNames = [...new Set(plan.cachedNames)];
    await Promise.all(
      servers.map(async (server) => {
        const entry = state.get(server.id);
        if (!entry.client || entry.status === 'dead') return;
        let answered = 0;
        for (const name of warmNames) {
          if (isAborted()) return;
          try {
            // eslint-disable-next-line no-await-in-loop
            const result = await entry.client.query(name, { timeoutMs: opts.timeoutMs });
            if (result.cold && entry.setupMs === null) entry.setupMs = result.ms;
            if (result.error) recordError(entry, result);
            else answered += 1;
          } catch (err) {
            entry.notes.push(`warm-up threw: ${err.message}`);
          }
        }
        if (answered === 0) {
          entry.status = 'dead';
          const why = [...entry.errors.entries()].map(([k, v]) => `${v}× ${k}`).join(', ');
          entry.notes.push(`no reply to any warm-up query${why ? ` (${why})` : ''}`);
          onEvent({ type: 'server', serverId: server.id, status: 'dead', note: entry.notes.at(-1) });
        } else {
          entry.status = 'ok';
          onEvent({ type: 'server', serverId: server.id, status: 'ok' });
        }
      }),
    );
  }

  // --- phase 3: timed rounds ----------------------------------------------
  async function phaseTimed() {
    const rounds = Math.max(
      plan.cachedNames.length,
      plan.uncachedNames.length,
      plan.dotcomNames.length,
    );
    onEvent({ type: 'timed-start', rounds });
    const live = entries().filter((e) => e.client && isAlive(e));

    for (let round = 0; round < rounds; round += 1) {
      if (isAborted()) break;
      const jobs = [];
      for (const entry of live) {
        if (plan.cachedNames[round] !== undefined) jobs.push(ask(entry, 'cached', plan.cachedNames[round]));
        if (plan.uncachedNames[round] !== undefined) jobs.push(ask(entry, 'uncached', plan.uncachedNames[round]));
        if (plan.dotcomNames[round] !== undefined) jobs.push(ask(entry, 'dotcom', plan.dotcomNames[round]));
      }
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(jobs);
      emitUpdate();
    }
    emitUpdate(true);
  }

  // --- phase 4: characterisation probes ------------------------------------
  async function phaseProbes() {
    const live = entries().filter((e) => e.client && isAlive(e));
    await Promise.all(
      live.map(async (entry) => {
        const { client } = entry;
        const server = entry.server;

        if (opts.hijack && !isAborted()) {
          const names = corpusTools.nonExistentNames();
          const results = [];
          for (const name of names) {
            if (isAborted()) break;
            // eslint-disable-next-line no-await-in-loop
            const result = await client.query(name, { timeoutMs: opts.timeoutMs });
            results.push({
              name,
              rcode: result.rcode ?? null,
              rcodeName: result.rcodeName || result.error || null,
              addresses: result.addresses || [],
              error: result.error || null,
            });
          }
          const addresses = [...new Set(results.flatMap((r) => r.addresses))];
          const withRcode = results.filter((r) => r.rcode !== null);
          entry.probes.hijack = {
            names,
            results,
            rcode: withRcode.length ? withRcode[0].rcode : null,
            rcodeName: withRcode.length ? withRcode[0].rcodeName : results[0]?.error || null,
            addresses,
            // An address for a name that cannot exist means the resolver
            // redirected it somewhere.
            hijacked: addresses.length > 0,
            // NOERROR for a nonexistent name is not a hijack but it is not
            // NXDOMAIN either; GRC's benchmark flags that case as well.
            noError: withRcode.some((r) => r.rcode === 0),
            noErrorWithoutAnswer: withRcode.some((r) => r.rcode === 0 && r.addresses.length === 0),
            error: results.every((r) => r.error) ? results[0].error : null,
          };
          onEvent({ type: 'probe', serverId: server.id, probe: 'hijack', result: entry.probes.hijack });
        }

        if (opts.rebinding && !isAborted()) {
          const details = [];
          for (const probe of corpusTools.rebindingNames()) {
            if (isAborted()) break;
            // eslint-disable-next-line no-await-in-loop
            const result = await client.query(probe.name, { timeoutMs: opts.timeoutMs });
            const addresses = result.addresses || [];
            details.push({
              range: probe.range,
              name: probe.name,
              expected: probe.expect,
              addresses,
              // Protected means the resolver refused to hand back the private
              // address the wildcard service is advertising.
              protected: !addresses.includes(probe.expect),
              answered: !result.error,
              error: result.error || null,
            });
          }
          entry.probes.rebinding = {
            ranges: details.length,
            protectedCount: details.filter((d) => d.protected).length,
            details,
          };
          onEvent({ type: 'probe', serverId: server.id, probe: 'rebinding', result: entry.probes.rebinding });
        }

        if (opts.dnssec && !isAborted()) {
          const details = [];
          for (const probe of corpusTools.dnssecNames()) {
            if (isAborted()) break;
            // eslint-disable-next-line no-await-in-loop
            const result = await client.query(probe.name, { timeoutMs: opts.timeoutMs, dnssecOk: true });
            details.push({
              zone: probe.zone,
              ad: result.ad === true,
              rcode: result.rcode ?? null,
              rcodeName: result.rcodeName || result.error || null,
              error: result.error || null,
            });
          }
          entry.probes.dnssec = {
            zones: details.length,
            validated: details.filter((d) => d.ad).length,
            details,
          };
          onEvent({ type: 'probe', serverId: server.id, probe: 'dnssec', result: entry.probes.dnssec });
        }
      }),
    );
  }

  const phaseFns = {
    connect: phaseConnect,
    warm: phaseWarm,
    timed: phaseTimed,
    probes: phaseProbes,
  };

  for (const phase of PHASES) {
    if (isAborted()) break;
    onEvent({ type: 'phase', phase, servers: servers.length });
    // eslint-disable-next-line no-await-in-loop
    await phaseFns[phase]();
  }

  const aborted = isAborted();
  if (aborted) onEvent({ type: 'phase', phase: 'aborted' });

  for (const entry of entries()) {
    if (entry.client) entry.client.close();
  }

  const finishedAt = Date.now();
  const payload = {
    schema: 'resolverbench/1',
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    meta: {
      timeoutMs: opts.timeoutMs,
      corpusSize: plan.corpus.length,
      corpus: plan.corpus,
      samplesPerResolver: {
        cached: plan.cachedNames.length,
        uncached: plan.uncachedNames.length,
        dotcom: plan.dotcomNames.length,
      },
      probes: { hijack: opts.hijack, rebinding: opts.rebinding, dnssec: opts.dnssec },
      aborted,
      completed: !aborted,
    },
    servers: entries().map(finalize),
  };
  onEvent({ type: 'done', results: payload });
  return payload;
}

/** Live per-server statistics, computed from the raw sample arrays. */
function snapshot(entry) {
  return {
    id: entry.server.id,
    label: entry.server.label,
    status: entry.status,
    setupMs: entry.setupMs,
    cached: stats.summarize(entry.samples.cached, entry.lost.cached),
    uncached: stats.summarize(entry.samples.uncached, entry.lost.uncached),
    dotcom: stats.summarize(entry.samples.dotcom, entry.lost.dotcom),
    pending:
      entry.sent.cached +
      entry.sent.uncached +
      entry.sent.dotcom -
      (entry.samples.cached.length + entry.samples.uncached.length + entry.samples.dotcom.length + Object.values(entry.lost).reduce((a, b) => a + b, 0)),
    lastError: entry.lastError,
  };
}

function finalize(entry) {
  const { server } = entry;
  const sent = entry.sent.cached + entry.sent.uncached + entry.sent.dotcom;
  const lost = entry.lost.cached + entry.lost.uncached + entry.lost.dotcom;
  const replied = sent - lost;

  let status = entry.status;
  if (status === 'ok' && lost > 0) status = 'unreliable';
  if (sent === 0 && status !== 'pending') status = 'dead';

  return {
    id: server.id,
    label: server.label,
    transport: server.transport,
    endpoint: endpointLabel(server),
    host: server.host,
    ip: server.ip || null,
    port: server.port || null,
    url: server.url || null,
    pinned: !!server.ip,
    isSystem: !!server.isSystem,
    operator: server.operator || null,
    status,
    setupMs: entry.setupMs,
    cached: stats.summarize(entry.samples.cached, entry.lost.cached),
    uncached: stats.summarize(entry.samples.uncached, entry.lost.uncached),
    dotcom: stats.summarize(entry.samples.dotcom, entry.lost.dotcom),
    reliability: {
      sent,
      lost,
      replied,
      percent: sent === 0 ? 0 : stats.round((100 * replied) / sent, 1),
    },
    errors: Object.fromEntries([...entry.errors.entries()].sort((a, b) => b[1] - a[1])),
    transportStats: entry.client
      ? {
          connections: entry.client.connections ?? null,
          reconnects: entry.client.reconnects ?? null,
          tcpFallbacks: entry.client.tcpFallbacks ?? null,
          requests: entry.client.requests ?? null,
        }
      : null,
    probes: entry.probes,
    notes: entry.notes,
    raw: {
      cached: entry.samples.cached,
      uncached: entry.samples.uncached,
      dotcom: entry.samples.dotcom,
    },
  };
}

module.exports = { runBenchmark, PHASES };
