'use strict';
/**
 * Name lists used by the benchmark.
 *
 * GRC's DNS Benchmark ships two replaceable lists: a resolver list and a
 * "tested domains" list of the fifty most popular domain names, and its
 * documentation makes the sampling argument explicit — fifty lookups per
 * resolver was the point at which statistical significance, repeatability and
 * running time balanced out (docs/resources: "IMPORTANT NOTE").
 *
 * We keep the same shape and the same replaceability (a plain text file, one
 * domain per line, loaded with --domains / -Domains), but the default list is
 * a current one rather than the 2009 Alexa top 50, because a stale corpus
 * quietly benchmarks resolvers against domains nobody visits.
 *
 * Four kinds of name are issued:
 *
 *   cached    - the corpus names themselves, after a warm-up pass, so the
 *               resolver answers from its own cache (GRC's red bar)
 *   uncached  - <random>.<corpus domain>, a name that cannot be cached, which
 *               forces the resolver out to the authoritative servers (green)
 *   dotcom    - <random>.com, which forces the resolver to consult the .com
 *               TLD servers before it can even find an authoritative server
 *               (purple)
 *   probes    - one-shot names for the characterisation tests: a guaranteed
 *               nonexistent name (typo hijacking), private-IP names produced by
 *               a public wildcard service (DNS rebinding protection), and
 *               DNSSEC-signed zones (AD bit)
 */

const crypto = require('node:crypto');
const fs = require('node:fs');

/** Fifty current, high-traffic, brand-safe second-level domains. */
const DEFAULT_CORPUS = Object.freeze([
  'google.com',
  'youtube.com',
  'facebook.com',
  'instagram.com',
  'amazon.com',
  'apple.com',
  'microsoft.com',
  'netflix.com',
  'wikipedia.org',
  'reddit.com',
  'linkedin.com',
  'tiktok.com',
  'yahoo.com',
  'bing.com',
  'office.com',
  'zoom.us',
  'dropbox.com',
  'github.com',
  'stackoverflow.com',
  'cloudflare.com',
  'paypal.com',
  'ebay.com',
  'walmart.com',
  'cnn.com',
  'nytimes.com',
  'bbc.co.uk',
  'spotify.com',
  'pinterest.com',
  'twitch.tv',
  'adobe.com',
  'salesforce.com',
  'oracle.com',
  'ibm.com',
  'intel.com',
  'nvidia.com',
  'samsung.com',
  'sony.com',
  'espn.com',
  'weather.com',
  'chase.com',
  'bankofamerica.com',
  'wellsfargo.com',
  'usps.com',
  'ups.com',
  'fedex.com',
  'target.com',
  'bestbuy.com',
  'homedepot.com',
  'costco.com',
  'att.com',
]);

/**
 * Zones that are DNSSEC-signed and serve NSEC/NSEC3 proofs, used for the
 * optional "does this resolver validate?" probe. The AD bit set on a response
 * for one of these means the resolver validated the chain itself.
 */
const DNSSEC_ZONES = Object.freeze([
  'cloudflare.com',
  'internetsociety.org',
  'isc.org',
  'ietf.org',
]);

/**
 * Public wildcard-DNS service that encodes the address in the name
 * (sslip.io): <random>.10-0-0-1.sslip.io resolves to 10.0.0.1 for anyone who
 * asks. A resolver that refuses to hand those addresses back is filtering
 * private-range answers, which is what DNS rebinding protection is.
 */
const REBIND_ZONES = Object.freeze([
  { range: '10.0.0.0/8', label: '10-0-0-1', expect: '10.0.0.1' },
  { range: '172.16.0.0/12', label: '172-16-0-1', expect: '172.16.0.1' },
  { range: '192.168.0.0/16', label: '192-168-0-1', expect: '192.168.0.1' },
  { range: '127.0.0.0/8', label: '127-0-0-1', expect: '127.0.0.1' },
]);

const REBIND_SUFFIX = 'sslip.io';

let counter = 0;

/** Lowercase hex label, unique per call, drawn from a CSPRNG. */
function randomLabel(bytes = 5) {
  counter += 1;
  const rand = crypto.randomBytes(bytes).toString('hex');
  return `${rand}${counter.toString(16).padStart(4, '0')}`;
}

function uncachedName(corpusDomain) {
  return `${randomLabel()}.${corpusDomain}`;
}

function dotcomName() {
  return `${randomLabel()}.com`;
}

/**
 * Names that cannot exist, for the typo-hijacking probe.
 *
 * Two of them, because "guaranteed nonexistent" has a trap in it: the reserved
 * example.com / example.org zones answer NOERROR with an empty answer (NODATA)
 * rather than NXDOMAIN — verified against Cloudflare, Google and Quad9 — so a
 * name under them says nothing about hijacking. What does work:
 *
 *   - <random>.com   a twelve-hex-character second-level label under .com
 *                    cannot be registered, and .com has no wildcard
 *   - <random>.invalid  the RFC 2606 reserved TLD, which exists to never resolve
 *
 * A resolver that returns an *address* for either is redirecting names it cannot
 * resolve, which is what typo hijacking is. A resolver that returns NOERROR with
 * no answer is not hijacking, but is not answering NXDOMAIN either — GRC's
 * benchmark flags that case too, and so does this one.
 */
function nonExistentNames() {
  return [`${randomLabel()}.com`, `${randomLabel()}.invalid`];
}

/** Kept for callers that only want one name. */
function nonExistentName() {
  return nonExistentNames()[0];
}

function rebindingNames() {
  return REBIND_ZONES.map((z) => ({
    range: z.range,
    expect: z.expect,
    name: `${randomLabel()}.${z.label}.${REBIND_SUFFIX}`,
  }));
}

function dnssecNames() {
  return DNSSEC_ZONES.map((zone) => ({ zone, name: zone }));
}

/**
 * Parse a domain list file: one domain per line, '#' or ';' comments, blanks
 * ignored. Accepts a comma-separated line too, so a file copied out of the
 * GRC documentation works.
 */
function parseDomainList(text) {
  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/(#|;).*$/, '').trim();
    if (!line) continue;
    for (const token of line.split(/[\s,]+/)) {
      const name = token.trim();
      if (!name) continue;
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(name)) {
        throw new Error(`not a valid domain name: ${name}`);
      }
      out.push(name.toLowerCase());
    }
  }
  return out;
}

function loadDomainList(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const list = parseDomainList(text);
  if (list.length === 0) throw new Error(`no usable domains in ${filePath}`);
  return list;
}

/**
 * Build the sample plan. The default 20 + 15 + 15 = 50 samples per resolver
 * matches the fifty-lookups-per-resolver figure GRC's documentation arrives at.
 */
function buildPlan(options = {}) {
  const corpus = options.corpus && options.corpus.length ? options.corpus : [...DEFAULT_CORPUS];
  const cached = options.cachedSamples ?? 20;
  const uncached = options.uncachedSamples ?? 15;
  const dotcom = options.dotcomSamples ?? 15;

  const cachedNames = [];
  for (let i = 0; i < cached; i += 1) cachedNames.push(corpus[i % corpus.length]);

  const uncachedNames = [];
  for (let i = 0; i < uncached; i += 1) {
    const domain = corpus[(i * 7 + 3) % corpus.length];
    uncachedNames.push(uncachedName(domain));
  }

  const dotcomNames = [];
  for (let i = 0; i < dotcom; i += 1) dotcomNames.push(dotcomName());

  return {
    corpus,
    cachedNames,
    uncachedNames,
    dotcomNames,
    totalTimed: cached + uncached + dotcom,
  };
}

module.exports = {
  DEFAULT_CORPUS,
  DNSSEC_ZONES,
  REBIND_ZONES,
  REBIND_SUFFIX,
  randomLabel,
  uncachedName,
  dotcomName,
  nonExistentName,
  nonExistentNames,
  rebindingNames,
  dnssecNames,
  parseDomainList,
  loadDomainList,
  buildPlan,
};
