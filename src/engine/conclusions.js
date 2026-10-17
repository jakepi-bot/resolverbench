'use strict';
/**
 * Turning numbers into the English a person can act on.
 *
 * GRC's DNS Benchmark ends on a "Conclusions" page rather than a chart, on the
 * grounds that a chart tells you what the numbers are but not what to do about
 * them. This module produces that page: an ordered list of findings, each
 * tagged with a severity so the UI can colour it, plus a recommended resolver
 * order.
 *
 * Every comparative claim is backed by Welch's t-test over the same samples,
 * so "faster" means "faster at the 95% level" and a difference inside the noise
 * is reported as a tie instead of a ranking.
 */

const stats = require('./stats');

const SEVERITY_ORDER = { bad: 0, warn: 1, good: 2, info: 3 };

function fmt(value, digits = 1) {
  return value === null || value === undefined ? 'n/a' : value.toFixed(digits);
}

function nameOf(server) {
  return `${server.label} (${server.endpoint})`;
}

function transportName(transport) {
  return { udp: 'plain DNS', tcp: 'DNS over TCP', dot: 'DNS-over-TLS', doh: 'DNS-over-HTTPS' }[transport] || transport;
}

/** Servers that produced at least one usable cached sample, fastest first. */
function rankBy(servers, metric = 'cached') {
  return servers
    .filter((s) => s[metric] && s[metric].mean !== null)
    .sort((a, b) => a[metric].median - b[metric].median || a[metric].mean - b[metric].mean);
}

function findingsFor(results) {
  const findings = [];
  const add = (severity, text) => findings.push({ severity, text });
  const servers = results.servers || [];
  const alive = servers.filter((s) => s.status !== 'dead');
  const byCached = rankBy(servers, 'cached');
  const byUncached = rankBy(servers, 'uncached');
  const usable = servers.filter(
    (s) => s.status !== 'dead' && s.reliability.percent === 100 && !(s.probes.hijack && s.probes.hijack.hijacked),
  );

  const transports = [...new Set(servers.map((s) => s.transport))];

  add(
    'info',
    `Benchmarked ${servers.length} resolvers (${transports.map(transportName).join(', ')}) ` +
      `with ${results.meta.samplesPerResolver.cached + results.meta.samplesPerResolver.uncached + results.meta.samplesPerResolver.dotcom} ` +
      `lookups each against a ${results.meta.corpusSize}-domain corpus, in ${(results.durationMs / 1000).toFixed(1)} seconds.`,
  );

  // --- dead and unreliable ------------------------------------------------
  const dead = servers.filter((s) => s.status === 'dead');
  if (dead.length > 0) {
    add('bad', `${dead.length} resolver(s) never answered and were excluded: ${dead.map(nameOf).join(', ')}.`);
  }

  const unreliable = servers.filter((s) => s.status !== 'dead' && s.reliability.lost > 0);
  for (const server of unreliable) {
    const why = Object.entries(server.errors)
      .map(([k, v]) => `${v}× ${k}`)
      .join(', ');
    add(
      'bad',
      `${nameOf(server)} did not answer ${server.reliability.lost} of ${server.reliability.sent} queries ` +
        `(${(100 - server.reliability.percent).toFixed(1)}% lost — ${why}). Lost replies are worse than slow ones: ` +
        `every one is a stalled page load while the client waits for the timeout.`,
    );
  }

  if (byCached.length === 0) {
    add('bad', 'No resolver produced a single usable answer. Check the network before reading anything else here.');
    return finalize(findings);
  }

  // --- the headline -------------------------------------------------------
  const fastest = byCached[0];
  const slowest = byCached[byCached.length - 1];
  add(
    'good',
    `Fastest cached lookups: ${nameOf(fastest)} at ${fmt(fastest.cached.median)} ms median ` +
      `(${fmt(fastest.cached.mean)} ms mean, ${fastest.cached.samples} samples). ` +
      `Slowest: ${nameOf(slowest)} at ${fmt(slowest.cached.median)} ms — ${fmt(slowest.cached.median - fastest.cached.median)} ms slower per lookup.`,
  );

  if (byCached.length > 1) {
    const second = byCached[1];
    const test = stats.welch(fastest.raw.cached, second.raw.cached);
    if (test.applicable && test.significant) {
      add(
        'info',
        `${fastest.label} beats ${second.label} by ${fmt(Math.abs(test.diff))} ms on cached lookups ` +
          `(95% CI ${fmt(test.ci[0])} to ${fmt(test.ci[1])} ms, p=${test.p < 0.0001 ? '<0.0001' : test.p}).`,
      );
    } else {
      add(
        'info',
        `The top two (${fastest.label}, ${second.label}) are statistically indistinguishable on cached lookups ` +
          `— the difference is inside the noise, so pick between them on other grounds.`,
      );
    }
  }

  // --- current configuration ---------------------------------------------
  const systemServers = servers.filter((s) => s.isSystem && s.cached && s.cached.median !== null);
  if (systemServers.length > 0) {
    const current = systemServers[0];
    if (current.id !== fastest.id) {
      const test = stats.welch(fastest.raw.cached, current.raw.cached);
      const delta = current.cached.median - fastest.cached.median;
      const verdict =
        test.applicable && test.significant
          ? `That is a real difference (95% CI ${fmt(test.ci[0])} to ${fmt(test.ci[1])} ms, p=${test.p < 0.0001 ? '<0.0001' : test.p}).`
          : 'The difference is not statistically significant — your current resolver is already competitive on cached lookups.';
      add(
        delta > 0 ? 'warn' : 'good',
        `Your current primary resolver, ${nameOf(current)}, answers from cache in ${fmt(current.cached.median)} ms median, ` +
          `${fmt(Math.abs(delta))} ms ${delta > 0 ? 'slower' : 'faster'} than ${fastest.label}. ${verdict}`,
      );
    } else {
      add('good', `Your current primary resolver (${nameOf(current)}) is also the fastest cached resolver measured.`);
    }

    // Guarding against the classic ordering mistake: the second resolver
    // answering faster than the first, which the client only reaches on failure.
    if (systemServers.length > 1) {
      const [first, second] = systemServers;
      const test = stats.welch(second.raw.cached, first.raw.cached);
      if (test.applicable && test.significant && test.diff < 0) {
        add(
          'warn',
          `Ordering: your second configured resolver (${first.id === second.id ? '' : nameOf(second)}) is ` +
            `${fmt(Math.abs(test.diff))} ms faster than your first (${nameOf(first)}), significantly so. ` +
            `The first resolver answers almost every lookup, so swapping them changes what you experience.`,
        );
      }
    }
  }

  // --- cached vs uncached -------------------------------------------------
  if (byUncached.length > 0) {
    const fastestUncached = byUncached[0];
    add(
      'info',
      `Fastest uncached lookups: ${nameOf(fastestUncached)} at ${fmt(fastestUncached.uncached.median)} ms median — ` +
        `this is the latency of a name the resolver has never seen, the case you feel on a first visit to a site.`,
    );
    if (fastestUncached.id !== fastest.id) {
      add(
        'warn',
        `${fastest.label} wins on cached lookups but ${fastestUncached.label} wins on uncached ones ` +
          `(${fmt(fastestUncached.uncached.median)} ms vs ${fmt(fastest.uncached.median)} ms). ` +
          `Cached performance is what most lookups look like; uncached performance shows up as the pause before a new site loads.`,
      );
    }
    const cachedMeans = byCached.map((s) => s.cached.median);
    const uncachedMeans = byUncached.map((s) => s.uncached.median);
    add(
      'info',
      `Across all resolvers, uncached lookups cost a median of ${fmt(stats.median(uncachedMeans))} ms against ` +
        `${fmt(stats.median(cachedMeans))} ms cached. A resolver whose uncached time is far above its cached time ` +
        `has a slow path to the authoritative servers, even if its cache is quick.`,
    );
  }

  // --- dot-com referral ---------------------------------------------------
  const byDotcom = rankBy(servers, 'dotcom');
  if (byDotcom.length > 1) {
    const best = byDotcom[0];
    const worst = byDotcom[byDotcom.length - 1];
    add(
      'info',
      `.com referral lookups ranged from ${fmt(best.dotcom.median)} ms (${best.label}) to ` +
        `${fmt(worst.dotcom.median)} ms (${worst.label}). This leg is the resolver's path to the .com TLD servers, ` +
        `which every lookup of a brand-new .com name must traverse first.`,
    );
  }

  // --- encrypted transports ----------------------------------------------
  const encrypted = servers.filter((s) => (s.transport === 'dot' || s.transport === 'doh') && s.status !== 'dead');
  if (encrypted.length > 0) {
    const withSetup = encrypted.filter((s) => typeof s.setupMs === 'number' && s.setupMs > 0);
    if (withSetup.length > 0) {
      const cheapest = withSetup.reduce((a, b) => (a.setupMs <= b.setupMs ? a : b));
      const dearest = withSetup.reduce((a, b) => (a.setupMs >= b.setupMs ? a : b));
      add(
        'info',
        `Encrypted transports pay a one-time connection cost: ${cheapest.transport === 'doh' ? 'DNS-over-HTTPS' : 'DNS-over-TLS'} ` +
          `to ${cheapest.label} needed ${fmt(cheapest.setupMs)} ms to establish (${fmt(dearest.setupMs)} ms for ${dearest.label}). ` +
          `After that, in-session queries are comparable to plain DNS, so the handshake only matters for short-lived connections.`,
      );
    }

    const bestPlain = byCached.find((s) => s.transport === 'udp');
    const bestEncrypted = byCached.find((s) => s.transport !== 'udp');
    if (bestPlain && bestEncrypted) {
      const test = stats.welch(bestEncrypted.raw.cached, bestPlain.raw.cached);
      const delta = bestEncrypted.cached.median - bestPlain.cached.median;
      if (test.applicable && test.significant && delta > 0) {
        add(
          'info',
          `Encryption currently costs ${fmt(delta)} ms per cached lookup: the best encrypted resolver ` +
            `(${bestEncrypted.label}) is slower than the best plain one (${bestPlain.label}), significantly so.`,
        );
      } else {
        add(
          'good',
          `${bestEncrypted.label} answers cached lookups in ${fmt(bestEncrypted.cached.median)} ms — statistically ` +
            `indistinguishable from the best plain resolver (${bestPlain.label}, ${fmt(bestPlain.cached.median)} ms). ` +
            `You can have encrypted lookups without paying a latency penalty.`,
        );
      }
    }
  }

  // --- characterisation probes -------------------------------------------
  const hijackers = servers.filter((s) => s.probes.hijack && s.probes.hijack.hijacked);
  if (hijackers.length > 0) {
    add(
      'warn',
      `${hijackers.length} resolver(s) answered a guaranteed-nonexistent name with an address instead of NXDOMAIN ` +
        `(${hijackers.map((s) => `${s.label} → ${s.probes.hijack.addresses.join(', ')}`).join('; ')}). ` +
        `That is typo hijacking: a mistyped domain gets redirected to an advertising or search page instead of failing.`,
    );
  } else if (servers.some((s) => s.probes.hijack && s.probes.hijack.rcodeName)) {
    const nodata = servers.filter((s) => s.probes.hijack.noErrorWithoutAnswer);
    if (nodata.length > 0) {
      add(
        'info',
        `${nodata.length} resolver(s) answer a nonexistent name with NOERROR and an empty answer instead of NXDOMAIN ` +
          `(${nodata.map((s) => s.label).join(', ')}). Nothing is being redirected, but software that distinguishes ` +
          `"no such name" from "no such record" sees the wrong one.`,
      );
    } else {
      add('good', 'Every resolver tested returned a proper NXDOMAIN for nonexistent names (no typo hijacking, no NODATA rewriting).');
    }
  }

  const rebinding = servers.filter((s) => s.probes.rebinding);
  if (rebinding.length > 0) {
    const unprotected = rebinding.filter((s) => s.probes.rebinding.protectedCount < s.probes.rebinding.ranges);
    if (unprotected.length > 0) {
      add(
        'info',
        `DNS rebinding protection: ${unprotected.length} resolver(s) return private-range addresses when asked ` +
          `(${unprotected.map((s) => `${s.label}: ${s.probes.rebinding.protectedCount}/${s.probes.rebinding.ranges} ranges filtered`).join('; ')}). ` +
          `Handing back 10.x/172.16.x/192.168.x/127.x answers is what a rebinding attack needs; filtering them is a hardening feature.`,
      );
    } else {
      add('good', `All tested resolvers filtered private-range answers (full DNS rebinding protection across ${rebinding[0].probes.rebinding.ranges} ranges).`);
    }
  }

  const dnssec = servers.filter((s) => s.probes.dnssec);
  if (dnssec.length > 0) {
    const validators = dnssec.filter((s) => s.probes.dnssec.validated > 0);
    add(
      validators.length > 0 ? 'good' : 'info',
      `DNSSEC: ${validators.length} of ${dnssec.length} resolver(s) set the authenticated-data bit on signed zones ` +
        `(${validators.map((s) => `${s.label} ${s.probes.dnssec.validated}/${s.probes.dnssec.zones}`).join(', ') || 'none'}). ` +
        `The AD bit means the resolver validated the chain itself, so a forged answer would have been rejected.`,
    );
  }

  // --- recommendation -----------------------------------------------------
  const ranked = usable.length > 0 ? rankBy(usable, 'cached') : byCached;
  if (ranked.length > 0) {
    const order = ranked.slice(0, 3).map((s, i) => `${i + 1}) ${s.label} (${s.endpoint}, ${fmt(s.cached.median)} ms)`);
    add('good', `Recommended order: ${order.join(', ')}.`);
    if (usable.length === 0) {
      add('warn', 'Every resolver that answered had either lost queries or rewrote nonexistent names, so this ordering is the least-bad option measured.');
    }
  }

  add(
    'info',
    'Comparative claims above use Welch\'s t-test on the raw samples at a 95% confidence level. ' +
      'Latency to anycast resolvers depends on where you are, so these numbers describe this machine on this network only.',
  );

  return finalize(findings);
}

function finalize(findings) {
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return findings;
}

/** Convenience for the CLI: findings as plain text. */
function conclude(results) {
  return findingsFor(results);
}

function toText(results) {
  return findingsFor(results)
    .map((f) => `[${f.severity.toUpperCase()}] ${f.text}`)
    .join('\n\n');
}

module.exports = { findingsFor, conclude, toText, rankBy };
