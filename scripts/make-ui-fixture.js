#!/usr/bin/env node
'use strict';
/**
 * Build a UI fixture from a real benchmark run.
 *
 * The renderer is plain HTML/CSS/JS, so it can be opened in any browser with a
 * fixture standing in for the Electron bridge (see fallbackBridge in app.js).
 * This script generates that fixture by actually measuring resolvers — the UI
 * check then renders real numbers instead of mock-ups that would hide layout
 * bugs a long label or a dead resolver would expose.
 *
 *   node scripts/make-ui-fixture.js --out=/tmp/fixture.json [id1 id2 …]
 */

const fs = require('node:fs');
const path = require('node:path');

const { runBenchmark } = require('../src/engine/bench');
const corpusTools = require('../src/engine/corpus');
const resolvers = require('../src/engine/resolvers');
const conclusions = require('../src/engine/conclusions');
const systemTools = require('../src/engine/system');
const pkg = require('../package.json');

const DEFAULT_IDS = [
  'cloudflare',
  'google',
  'quad9',
  'adguard',
  'opendns',
  'dnssb',
  'cloudflare-dot',
  'google-dot',
  'quad9-dot',
  'cloudflare-doh',
  'google-doh',
  'adguard-doh',
];

async function main() {
  const args = process.argv.slice(2);
  const outFlag = args.find((a) => a.startsWith('--out='));
  const outPath = outFlag ? outFlag.slice('--out='.length) : path.join(process.cwd(), 'ui-fixture.json');
  const ids = args.filter((a) => !a.startsWith('--'));
  const includeSystem = args.includes('--include-system');

  const servers = resolvers.select({ ids: ids.length ? ids : DEFAULT_IDS });
  if (includeSystem) servers.unshift(...systemTools.detectSystemResolvers());

  const plan = corpusTools.buildPlan({
    corpus: corpusTools.DEFAULT_CORPUS.slice(0, 12),
    cachedSamples: 8,
    uncachedSamples: 6,
    dotcomSamples: 6,
  });

  process.stderr.write(`measuring ${servers.length} resolvers × ${plan.totalTimed} lookups…\n`);
  const results = await runBenchmark({ servers, plan, timeoutMs: 1500, dnssec: true });

  const fixture = {
    info: {
      name: pkg.productName,
      version: pkg.version,
      electron: 'fixture',
      chrome: 'fixture',
      node: process.version,
      platform: `${process.platform} (fixture)`,
      arch: process.arch,
      projectUrl: pkg.homepage,
    },
    catalog: resolvers.CATALOG.map(resolvers.materialize),
    system: systemTools.detectSystemResolvers(),
    results,
    findings: conclusions.findingsFor(results),
  };

  fs.writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`);
  const answered = results.servers.filter((s) => s.status !== 'dead').length;
  process.stderr.write(`wrote ${outPath} (${answered}/${servers.length} resolvers answered)\n`);
}

main().catch((err) => {
  process.stderr.write(`fixture failed: ${err && err.stack ? err.stack : err}\n`);
  process.exitCode = 1;
});
