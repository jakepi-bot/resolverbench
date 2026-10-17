#!/usr/bin/env node
'use strict';
/**
 * Headless ResolverBench.
 *
 * Same engine the app uses, no window: this is what CI runs on the Apple
 * silicon runner to prove the benchmark actually performs lookups on the target
 * architecture, and it is the mode for unattended/scheduled runs (GRC's tool
 * has a Task Scheduler mode too — the log/CSV output is the point).
 *
 *   node src/engine/cli.js --quick --top 10 --csv results.csv --json results.json
 *
 * Exit codes: 0 = at least one resolver answered, 2 = none answered,
 *             3 = usage error, 4 = interrupted.
 */

const fs = require('node:fs');
const path = require('node:path');

const { runBenchmark } = require('./bench');
const corpusTools = require('./corpus');
const { select, CATALOG } = require('./resolvers');
const systemTools = require('./system');
const conclusions = require('./conclusions');
const csvTools = require('./csv');

const HELP = `
ResolverBench (headless) — benchmark plain DNS, DNS-over-HTTPS and DNS-over-TLS resolvers.

Usage: node src/engine/cli.js [options]

  --quick                 short run (8 cached / 6 uncached / 6 dot-com samples)
  --full                  full run (20 / 15 / 15, the default)
  --servers <list>        catalog ids, or 'system', comma separated ('all' = everything)
  --transports <list>     subset of: plain,doh,dot,tcp  (default: plain,doh,dot)
  --include-system        also benchmark the resolvers this machine is configured to use
  --domains <file>        replace the built-in domain corpus (one domain per line)
  --corpus <n>            truncate the built-in corpus to n domains
  --timeout <ms>          per-query timeout (default 1200)
  --top <n>               how many rows to print (default 15)
  --json <file>           write the full result payload
  --csv <file>            write the CSV export
  --delimiter <char>      CSV delimiter (default ',')
  --dnssec                also probe DNSSEC validation (AD bit)
  --no-rebinding          skip the DNS rebinding probes
  --no-hijack             skip the nonexistent-name hijack probe
  --quiet                 conclusions only
  --json-stdout           print the full payload to stdout
  --help                  this text
`;

function parseArgs(argv) {
  const opts = {
    mode: 'full',
    servers: null,
    transports: ['plain', 'doh', 'dot'],
    includeSystem: false,
    domains: null,
    corpus: null,
    timeoutMs: 1200,
    top: 15,
    json: null,
    csv: null,
    delimiter: ',',
    dnssec: false,
    rebinding: true,
    hijack: true,
    quiet: false,
    jsonStdout: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--quick':
        opts.mode = 'quick';
        break;
      case '--full':
        opts.mode = 'full';
        break;
      case '--servers':
      case '-s':
        opts.servers = next();
        break;
      case '--transports':
      case '-t':
        opts.transports = next().split(',').map((t) => t.trim().toLowerCase());
        break;
      case '--include-system':
        opts.includeSystem = true;
        break;
      case '--domains':
      case '-Domains':
        opts.domains = next();
        break;
      case '--corpus':
        opts.corpus = Number(next());
        break;
      case '--timeout':
        opts.timeoutMs = Number(next());
        break;
      case '--top':
        opts.top = Number(next());
        break;
      case '--json':
        opts.json = next();
        break;
      case '--csv':
        opts.csv = next();
        break;
      case '--delimiter':
        opts.delimiter = next();
        break;
      case '--dnssec':
        opts.dnssec = true;
        break;
      case '--no-rebinding':
        opts.rebinding = false;
        break;
      case '--no-hijack':
        opts.hijack = false;
        break;
      case '--quiet':
        opts.quiet = true;
        break;
      case '--json-stdout':
        opts.jsonStdout = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return opts;
}

const TRANSPORT_ALIASES = {
  plain: 'udp',
  udp: 'udp',
  tcp: 'tcp',
  dot: 'dot',
  tls: 'dot',
  doh: 'doh',
  https: 'doh',
};

function buildCatalog(opts) {
  const wanted = new Set(opts.transports.map((t) => TRANSPORT_ALIASES[t] || t));
  let servers = select({ transports: [...wanted], ids: opts.servers ? opts.servers.split(',').map((s) => s.trim()) : null });

  if (opts.includeSystem || (opts.servers || '').toLowerCase() === 'system') {
    const system = systemTools.detectSystemResolvers();
    const known = new Set(servers.map((s) => s.ip));
    servers = [...system.filter((s) => !known.has(s.ip)), ...servers];
  }
  return servers;
}

function fmtMs(value, digits = 1) {
  if (value === null || value === undefined) return '—';
  return value.toFixed(digits);
}

function printTable(results, top) {
  const ranked = conclusions.rankBy(results.servers, 'cached');
  const width = Math.max(20, ...ranked.map((s) => s.label.length));
  const lines = [];
  lines.push(
    `${'#'.padStart(3)} ${'resolver'.padEnd(width)} ${'transport'.padEnd(8)} ${'endpoint'.padEnd(26)} ` +
      `${'cached'.padStart(8)} ${'uncached'.padStart(9)} ${'dotcom'.padStart(8)} ${'setup'.padStart(8)} ${'rel%'.padStart(6)}  flags`,
  );
  ranked.slice(0, top).forEach((s, i) => {
    const flags = [];
    if (s.isSystem) flags.push('system');
    if (s.probes.hijack && s.probes.hijack.hijacked) flags.push('hijack');
    if (s.probes.rebinding && s.probes.rebinding.protectedCount < s.probes.rebinding.ranges) flags.push('rebind-open');
    if (s.probes.dnssec && s.probes.dnssec.validated > 0) flags.push('dnssec');
    if (s.reliability.lost > 0) flags.push(`${s.reliability.lost} lost`);
    lines.push(
      `${String(i + 1).padStart(3)} ${s.label.padEnd(width)} ${s.transport.padEnd(8)} ${s.endpoint.padEnd(26)} ` +
        `${fmtMs(s.cached.median).padStart(8)} ${fmtMs(s.uncached.median).padStart(9)} ${fmtMs(s.dotcom.median).padStart(8)} ` +
        `${fmtMs(s.setupMs, 0).padStart(8)} ${String(s.reliability.percent).padStart(6)}  ${flags.join(' ')}`,
    );
  });
  const dead = results.servers.filter((s) => s.status === 'dead');
  if (dead.length > 0) {
    lines.push('');
    lines.push(`dead (no reply): ${dead.map((s) => `${s.label} ${s.endpoint}`).join(', ')}`);
  }
  lines.push('');
  lines.push('cached/uncached/dotcom/setup are medians in milliseconds.');
  return lines.join('\n');
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n${HELP}`);
    process.exitCode = 3;
    return;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  const servers = buildCatalog(opts);
  if (servers.length === 0) {
    process.stderr.write(`no resolvers selected. Known ids:\n${CATALOG.map((s) => `  ${s.id}`).join('\n')}\n`);
    process.exitCode = 3;
    return;
  }

  let corpus = corpusTools.DEFAULT_CORPUS;
  if (opts.domains) corpus = corpusTools.loadDomainList(path.resolve(opts.domains));
  if (opts.corpus) corpus = corpus.slice(0, opts.corpus);

  const plan =
    opts.mode === 'quick'
      ? corpusTools.buildPlan({ corpus, cachedSamples: 8, uncachedSamples: 6, dotcomSamples: 6 })
      : corpusTools.buildPlan({ corpus });

  if (!opts.quiet) {
    process.stdout.write(
      `ResolverBench: ${servers.length} resolvers × ${plan.totalTimed} lookups ` +
        `(${plan.cachedNames.length} cached / ${plan.uncachedNames.length} uncached / ${plan.dotcomNames.length} dot-com), ` +
        `timeout ${opts.timeoutMs} ms\n\n`,
    );
  }

  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  const started = Date.now();
  const results = await runBenchmark({
    servers,
    plan,
    timeoutMs: opts.timeoutMs,
    dnssec: opts.dnssec,
    rebinding: opts.rebinding,
    hijack: opts.hijack,
    signal: controller.signal,
    onEvent: opts.quiet
      ? () => {}
      : (event) => {
          if (event.type === 'phase') process.stderr.write(`\r  phase: ${event.phase}          \n`);
          if (event.type === 'timed-start') process.stderr.write(`\r  phase: timed (${event.rounds} rounds)          \n`);
        },
  });

  if (results.meta.aborted) {
    process.stderr.write('interrupted — reporting partial results\n');
    process.exitCode = 4;
  }

  const answered = results.servers.filter((s) => s.status !== 'dead');

  if (!opts.jsonStdout) {
    process.stdout.write(`${printTable(results, opts.top)}\n\n`);
  }

  process.stdout.write(`${conclusions.toText(results)}\n`);

  if (opts.json) {
    fs.writeFileSync(opts.json, `${JSON.stringify(results, null, 2)}\n`);
    if (!opts.quiet) process.stdout.write(`\nwrote ${opts.json}\n`);
  }
  if (opts.csv) {
    const text = csvTools.toCSV(results, {
      delimiter: opts.delimiter,
      decimalComma: opts.delimiter === ';',
      recommended: conclusions.rankBy(results.servers, 'cached').slice(0, 3).map((s) => s.label),
    });
    fs.writeFileSync(opts.csv, text);
    if (!opts.quiet) process.stdout.write(`wrote ${opts.csv}\n`);
  }
  if (opts.jsonStdout) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  }

  if (answered.length === 0) {
    process.stderr.write(
      `\nFAILED: none of the ${servers.length} resolvers answered (${((Date.now() - started) / 1000).toFixed(1)} s)\n`,
    );
    process.exitCode = 2;
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err && err.stack ? err.stack : err}\n`);
  process.exitCode = 1;
});
