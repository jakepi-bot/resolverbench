'use strict';
/**
 * The built-in resolver catalog.
 *
 * Three families, and the same resolver usually appears in more than one so the
 * three transports can be compared like for like:
 *
 *   udp  plain DNS on 53
 *   dot  DNS-over-TLS on 853
 *   doh  DNS-over-HTTPS on 443, RFC 8484 wire format
 *
 * `ip` pins the transport to the resolver's own anycast address while the SNI /
 * Host header keeps the service name the certificate and the HTTP virtual host
 * expect. Without pinning, a DoH endpoint is measured through whichever CDN
 * edge the local system resolver happens to pick, which measures the CDN rather
 * than the resolver. Entries with no stable anycast address are left unpinned
 * and the results say `address_pinned = no`.
 *
 * This catalog is data, not truth: every entry in it was verified by an actual
 * query before release (see docs/verification.md), and the app reports
 * `dead` for anything that stops answering rather than hiding it.
 */

const CATALOG = [
  // ---------------------------------------------------------------- plain ---
  { id: 'cloudflare', label: 'Cloudflare', operator: 'Cloudflare, Inc.', transport: 'udp', host: '1.1.1.1', ip: '1.1.1.1', port: 53, aliases: ['cloudflare-1', '1.1.1.1'] },
  { id: 'cloudflare-alt', label: 'Cloudflare (secondary)', operator: 'Cloudflare, Inc.', transport: 'udp', host: '1.0.0.1', ip: '1.0.0.1', port: 53, aliases: ['cloudflare-2'] },
  { id: 'google', label: 'Google Public DNS', operator: 'Google LLC', transport: 'udp', host: '8.8.8.8', ip: '8.8.8.8', port: 53, aliases: ['google-1', '8.8.8.8'] },
  { id: 'google-alt', label: 'Google Public DNS (secondary)', operator: 'Google LLC', transport: 'udp', host: '8.8.4.4', ip: '8.8.4.4', port: 53, aliases: ['google-2'] },
  { id: 'quad9', label: 'Quad9', operator: 'Quad9 Foundation', transport: 'udp', host: '9.9.9.9', ip: '9.9.9.9', port: 53, aliases: ['quad9-1', '9.9.9.9'] },
  { id: 'quad9-alt', label: 'Quad9 (secondary)', operator: 'Quad9 Foundation', transport: 'udp', host: '149.112.112.112', ip: '149.112.112.112', port: 53, aliases: ['quad9-2'] },
  { id: 'opendns', label: 'OpenDNS', operator: 'Cisco Systems, Inc.', transport: 'udp', host: '208.67.222.222', ip: '208.67.222.222', port: 53, aliases: ['opendns-1'] },
  { id: 'opendns-alt', label: 'OpenDNS (secondary)', operator: 'Cisco Systems, Inc.', transport: 'udp', host: '208.67.220.220', ip: '208.67.220.220', port: 53, aliases: ['opendns-2'] },
  { id: 'adguard', label: 'AdGuard DNS', operator: 'AdGuard Software Ltd', transport: 'udp', host: '94.140.14.14', ip: '94.140.14.14', port: 53, aliases: ['adguard-1'] },
  { id: 'adguard-alt', label: 'AdGuard DNS (secondary)', operator: 'AdGuard Software Ltd', transport: 'udp', host: '94.140.15.15', ip: '94.140.15.15', port: 53, aliases: ['adguard-2'] },
  { id: 'verisign', label: 'Verisign Public DNS', operator: 'Verisign, Inc.', transport: 'udp', host: '64.6.64.6', ip: '64.6.64.6', port: 53, aliases: ['verisign-1'] },
  { id: 'lumen', label: 'Lumen / Level3', operator: 'Lumen Technologies', transport: 'udp', host: '4.2.2.1', ip: '4.2.2.1', port: 53, aliases: ['level3'] },
  { id: 'comodo', label: 'Comodo Secure DNS', operator: 'Xcitium / Comodo', transport: 'udp', host: '8.26.56.26', ip: '8.26.56.26', port: 53, aliases: ['comodo-1'] },
  { id: 'dnssb', label: 'DNS.SB', operator: 'DNS.SB', transport: 'udp', host: '185.222.222.222', ip: '185.222.222.222', port: 53, aliases: ['dns.sb'] },
  { id: 'dnssb-alt', label: 'DNS.SB (secondary)', operator: 'DNS.SB', transport: 'udp', host: '45.11.45.11', ip: '45.11.45.11', port: 53 },
  { id: 'mullvad', label: 'Mullvad DNS', operator: 'Mullvad VPN AB', transport: 'udp', host: '194.242.2.2', ip: '194.242.2.2', port: 53, aliases: ['mullvad-1'] },
  { id: 'controld', label: 'Control D Free', operator: 'Control D', transport: 'udp', host: '76.76.2.0', ip: '76.76.2.0', port: 53, aliases: ['controld-1'] },
  { id: 'cleanbrowsing', label: 'CleanBrowsing Security', operator: 'CleanBrowsing', transport: 'udp', host: '185.228.168.9', ip: '185.228.168.9', port: 53 },
  { id: 'yandex', label: 'Yandex DNS', operator: 'Yandex', transport: 'udp', host: '77.88.8.8', ip: '77.88.8.8', port: 53 },
  { id: 'hurricane', label: 'Hurricane Electric', operator: 'Hurricane Electric', transport: 'udp', host: '74.82.42.42', ip: '74.82.42.42', port: 53, aliases: ['he'] },
  { id: 'gcore', label: 'Gcore Public DNS', operator: 'Gcore', transport: 'udp', host: '95.85.95.85', ip: '95.85.95.85', port: 53 },
  { id: 'neustar', label: 'Neustar UltraDNS', operator: 'Neustar / TransUnion', transport: 'udp', host: '156.154.70.1', ip: '156.154.70.1', port: 53, aliases: ['ultradns'] },
  // dns0.eu (plain, DoT and DoH) is deliberately absent: a pre-release
  // verification pass measured every catalog entry, and none of dns0.eu's
  // anycast addresses answered from either test network.
  { id: 'dns4eu', label: 'DNS4EU', operator: 'DNS4EU (EU consortium)', transport: 'udp', host: '86.54.11.13', ip: '86.54.11.13', port: 53, notes: 'EU-based; ~105 ms from a US network.' },

  // -------------------------------------------------------- DNS over TLS ---
  { id: 'cloudflare-dot', label: 'Cloudflare (DoT)', operator: 'Cloudflare, Inc.', transport: 'dot', host: 'one.one.one.one', ip: '1.1.1.1', port: 853, sni: 'cloudflare-dns.com', aliases: ['dot-cloudflare'] },
  { id: 'google-dot', label: 'Google Public DNS (DoT)', operator: 'Google LLC', transport: 'dot', host: 'dns.google', ip: '8.8.8.8', port: 853, sni: 'dns.google', aliases: ['dot-google'] },
  { id: 'quad9-dot', label: 'Quad9 (DoT)', operator: 'Quad9 Foundation', transport: 'dot', host: 'dns.quad9.net', ip: '9.9.9.9', port: 853, sni: 'dns.quad9.net', aliases: ['dot-quad9'] },
  { id: 'adguard-dot', label: 'AdGuard DNS (DoT)', operator: 'AdGuard Software Ltd', transport: 'dot', host: 'dns.adguard-dns.com', ip: '94.140.14.14', port: 853, sni: 'dns.adguard-dns.com' },
  { id: 'dnssb-dot', label: 'DNS.SB (DoT)', operator: 'DNS.SB', transport: 'dot', host: 'dot.sb', port: 853, sni: 'dot.sb' },
  { id: 'mullvad-dot', label: 'Mullvad DNS (DoT)', operator: 'Mullvad VPN AB', transport: 'dot', host: 'dns.mullvad.net', ip: '194.242.2.2', port: 853, sni: 'dns.mullvad.net' },
  { id: 'controld-dot', label: 'Control D Free (DoT)', operator: 'Control D', transport: 'dot', host: 'freedns.controld.com', ip: '76.76.2.11', port: 853, sni: 'freedns.controld.com' },
  { id: 'cleanbrowsing-dot', label: 'CleanBrowsing Security (DoT)', operator: 'CleanBrowsing', transport: 'dot', host: 'security-filter-dns.cleanbrowsing.org', ip: '185.228.168.9', port: 853, sni: 'security-filter-dns.cleanbrowsing.org' },
  { id: 'libredns-dot', label: 'LibreDNS (DoT)', operator: 'LibreOps', transport: 'dot', host: 'dot.libredns.gr', port: 853, sni: 'dot.libredns.gr' },
  { id: 'opendns-dot', label: 'OpenDNS (DoT)', operator: 'Cisco Systems, Inc.', transport: 'dot', host: 'dns.opendns.com', ip: '208.67.222.222', port: 853, sni: 'dns.opendns.com' },
  { id: 'yandex-dot', label: 'Yandex DNS (DoT)', operator: 'Yandex', transport: 'dot', host: 'common.dot.dns.yandex.net', ip: '77.88.8.8', port: 853, sni: 'common.dot.dns.yandex.net', notes: 'Geo-distant from US networks.' },
  { id: 'appliedprivacy-dot', label: 'Applied Privacy (DoT)', operator: 'Applied Privacy', transport: 'dot', host: 'dot1.applied-privacy.net', port: 853, sni: 'dot1.applied-privacy.net' },
  { id: 'iij-dot', label: 'IIJ Public DNS (DoT)', operator: 'Internet Initiative Japan', transport: 'dot', host: 'public.dns.iij.jp', port: 853, sni: 'public.dns.iij.jp' },

  // ------------------------------------------------------ DNS over HTTPS ---
  { id: 'cloudflare-doh', label: 'Cloudflare (DoH)', operator: 'Cloudflare, Inc.', transport: 'doh', host: 'cloudflare-dns.com', ip: '1.1.1.1', url: 'https://cloudflare-dns.com/dns-query', aliases: ['doh-cloudflare'] },
  { id: 'google-doh', label: 'Google Public DNS (DoH)', operator: 'Google LLC', transport: 'doh', host: 'dns.google', ip: '8.8.8.8', url: 'https://dns.google/dns-query', aliases: ['doh-google'] },
  { id: 'quad9-doh', label: 'Quad9 (DoH)', operator: 'Quad9 Foundation', transport: 'doh', host: 'dns.quad9.net', ip: '9.9.9.9', url: 'https://dns.quad9.net/dns-query', aliases: ['doh-quad9'] },
  { id: 'adguard-doh', label: 'AdGuard DNS (DoH)', operator: 'AdGuard Software Ltd', transport: 'doh', host: 'dns.adguard-dns.com', ip: '94.140.14.14', url: 'https://dns.adguard-dns.com/dns-query' },
  { id: 'opendns-doh', label: 'OpenDNS (DoH)', operator: 'Cisco Systems, Inc.', transport: 'doh', host: 'doh.opendns.com', url: 'https://doh.opendns.com/dns-query' },
  { id: 'dnssb-doh', label: 'DNS.SB (DoH)', operator: 'DNS.SB', transport: 'doh', host: 'doh.sb', url: 'https://doh.sb/dns-query' },
  { id: 'mullvad-doh', label: 'Mullvad DNS (DoH)', operator: 'Mullvad VPN AB', transport: 'doh', host: 'dns.mullvad.net', ip: '194.242.2.2', url: 'https://dns.mullvad.net/dns-query' },
  { id: 'controld-doh', label: 'Control D Free (DoH)', operator: 'Control D', transport: 'doh', host: 'freedns.controld.com', ip: '76.76.2.0', url: 'https://freedns.controld.com/p0' },
  { id: 'cleanbrowsing-doh', label: 'CleanBrowsing Security (DoH)', operator: 'CleanBrowsing', transport: 'doh', host: 'doh.cleanbrowsing.org', ip: '185.228.168.9', url: 'https://doh.cleanbrowsing.org/doh/security-filter/' },
  { id: 'libredns-doh', label: 'LibreDNS (DoH)', operator: 'LibreOps', transport: 'doh', host: 'doh.libredns.gr', url: 'https://doh.libredns.gr/dns-query' },
  { id: 'adguard-family-doh', label: 'AdGuard Family (DoH)', operator: 'AdGuard Software Ltd', transport: 'doh', host: 'family.adguard-dns.com', ip: '94.140.14.15', url: 'https://family.adguard-dns.com/dns-query' },
  { id: 'cloudflare-security-doh', label: 'Cloudflare Security (DoH)', operator: 'Cloudflare, Inc.', transport: 'doh', host: 'security.cloudflare-dns.com', ip: '1.1.1.2', url: 'https://security.cloudflare-dns.com/dns-query' },
  { id: 'cloudflare-family-doh', label: 'Cloudflare Family (DoH)', operator: 'Cloudflare, Inc.', transport: 'doh', host: 'family.cloudflare-dns.com', ip: '1.1.1.3', url: 'https://family.cloudflare-dns.com/dns-query' },
  { id: 'appliedprivacy-doh', label: 'Applied Privacy (DoH)', operator: 'Applied Privacy', transport: 'doh', host: 'doh.applied-privacy.net', url: 'https://doh.applied-privacy.net/query', notes: 'Answers over HTTP/2 only; the client negotiates that automatically.' },
  { id: 'iij-doh', label: 'IIJ Public DNS (DoH)', operator: 'Internet Initiative Japan', transport: 'doh', host: 'public.dns.iij.jp', url: 'https://public.dns.iij.jp/dns-query' },
];

const BY_ID = new Map();
for (const entry of CATALOG) {
  BY_ID.set(entry.id, entry);
  for (const alias of entry.aliases || []) BY_ID.set(alias, entry);
}

/** A stable, copy-safe copy of an entry (the catalog is mutated nowhere). */
function materialize(entry) {
  return {
    id: entry.id,
    label: entry.label,
    operator: entry.operator,
    transport: entry.transport,
    host: entry.host,
    ip: entry.ip || null,
    port: entry.port,
    url: entry.url || null,
    sni: entry.sni || null,
    notes: entry.notes || null,
    isSystem: false,
  };
}

/**
 * Select catalog entries.
 * @param {object} [options]
 * @param {string[]} [options.ids]         ids or aliases; null = all
 * @param {string[]} [options.transports]  subset of udp/tcp/dot/doh
 * @param {boolean} [options.plainOnly]
 */
function select(options = {}) {
  const transports = options.transports ? new Set(options.transports) : null;
  let entries = CATALOG;
  if (options.ids && options.ids.length > 0) {
    const wanted = options.ids.map((id) => id.trim().toLowerCase()).filter(Boolean);
    if (!(wanted.length === 1 && (wanted[0] === 'all' || wanted[0] === '*'))) {
      const missing = [];
      entries = [];
      for (const id of wanted) {
        const entry = BY_ID.get(id);
        if (!entry) missing.push(id);
        else if (!entries.includes(entry)) entries.push(entry);
      }
      if (missing.length > 0) {
        throw new Error(
          `unknown resolver id(s): ${missing.join(', ')}. Try --servers all, or one of: ${CATALOG.map((e) => e.id).join(', ')}`,
        );
      }
    }
  }
  if (transports) entries = entries.filter((e) => transports.has(e.transport));
  return entries.map(materialize);
}

function groupByTransport(servers) {
  const groups = new Map();
  for (const server of servers) {
    if (!groups.has(server.transport)) groups.set(server.transport, []);
    groups.get(server.transport).push(server);
  }
  return groups;
}

/** Default selection for the app and for `--servers all`: a representative set. */
const DEFAULT_IDS = [
  'cloudflare',
  'google',
  'quad9',
  'adguard',
  'opendns',
  'dnssb',
  'mullvad',
  'controld',
  'cloudflare-dot',
  'google-dot',
  'quad9-dot',
  'adguard-dot',
  'cloudflare-doh',
  'google-doh',
  'quad9-doh',
  'adguard-doh',
];

/**
 * Parse one user-supplied endpoint.
 *
 * Accepts the forms a person actually types, and the forms a list file
 * contains:
 *
 *   1.1.1.1                     plain DNS on 53
 *   1.1.1.1:5353                plain DNS on a custom port
 *   2606:4700:4700::1111        IPv6
 *   udp://dns.example           explicit plain DNS
 *   tcp://dns.example           DNS over TCP
 *   tls://dns.example           DNS over TLS (853; sni = host)
 *   dot://dns.example:8853      DNS over TLS on a custom port
 *   https://dns.example/dns-query   DNS over HTTPS
 *
 * Anything else throws, with the offending text in the message: silently
 * dropping a line the user asked to benchmark is worse than refusing it.
 */
function parseCustomEndpoint(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.startsWith('#') || raw.startsWith(';')) return null;
  const cleaned = raw.replace(/^["']|["']$/g, '');

  const schemeMatch = /^([a-z0-9+.-]+):\/\/(.*)$/i.exec(cleaned);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    const rest = schemeMatch[2];
    if (scheme === 'https' || scheme === 'doh') {
      const url = scheme === 'https' ? `https://${rest}` : `https://${rest}`;
      const parsed = new URL(url);
      return {
        id: `custom-${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`,
        label: parsed.hostname,
        operator: 'Custom',
        transport: 'doh',
        host: parsed.hostname,
        ip: null,
        port: Number(parsed.port) || 443,
        url,
        sni: parsed.hostname,
        isCustom: true,
      };
    }
    if (scheme === 'tls' || scheme === 'dot' || scheme === 'dns-over-tls') {
      const [host, port] = rest.split(':');
      return {
        id: `custom-dot-${host}${port ? `-${port}` : ''}`,
        label: host,
        operator: 'Custom',
        transport: 'dot',
        host,
        ip: null,
        port: Number(port) || 853,
        url: null,
        sni: host,
        isCustom: true,
      };
    }
    if (scheme === 'tcp') {
      const [host, port] = rest.split(':');
      return {
        id: `custom-tcp-${host}${port ? `-${port}` : ''}`,
        label: host,
        operator: 'Custom',
        transport: 'tcp',
        host,
        ip: host,
        port: Number(port) || 53,
        url: null,
        sni: null,
        isCustom: true,
      };
    }
    if (scheme === 'udp' || scheme === 'dns') {
      const [host, port] = rest.split(':');
      return {
        id: `custom-udp-${host}${port ? `-${port}` : ''}`,
        label: host,
        operator: 'Custom',
        transport: 'udp',
        host,
        ip: host,
        port: Number(port) || 53,
        url: null,
        sni: null,
        isCustom: true,
      };
    }
    throw new Error(`unsupported scheme "${scheme}://" in "${raw}"`);
  }

  const address = cleaned.replace(/^\[|\]$/g, '');
  const [host, portText] = address.split(':');
  if (!host) throw new Error(`cannot read an endpoint from "${raw}"`);
  const port = portText ? Number(portText) : 53;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`bad port in "${raw}"`);
  }
  if (!/^[a-z0-9.:_-]+$/i.test(host)) throw new Error(`not an address or hostname: "${raw}"`);
  return {
    id: `custom-udp-${host}${port === 53 ? '' : `-${port}`}`,
    label: host,
    operator: 'Custom',
    transport: 'udp',
    host,
    ip: host,
    port,
    url: null,
    sni: null,
    isCustom: true,
  };
}

/**
 * Parse a list file — one endpoint per line, '#'/';' comments, and tolerant of
 * GRC's dnsbench.ini shape so a nameserver list built for that tool can be
 * reused verbatim (any token that parses as an endpoint is taken).
 */
function parseCustomList(text) {
  const found = new Map();
  const rejected = [];
  for (const line of String(text).split(/\r?\n/)) {
    const body = line.replace(/(#|;).*$/, '').trim();
    if (!body || /^\[/.test(body)) continue;
    for (const token of body.split(/[\s,=]+/)) {
      const candidate = token.trim();
      if (!candidate) continue;
      // Skip ini scaffolding and anything that cannot be an endpoint.
      if (/^(nameserver|resolver|server|host|port|address)$/i.test(candidate)) continue;
      try {
        const entry = parseCustomEndpoint(candidate);
        if (entry) found.set(entry.id, entry);
      } catch {
        rejected.push(candidate);
      }
    }
  }
  return { servers: [...found.values()], rejected };
}

module.exports = {
  CATALOG,
  DEFAULT_IDS,
  BY_ID,
  select,
  groupByTransport,
  materialize,
  parseCustomEndpoint,
  parseCustomList,
};
