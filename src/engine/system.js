'use strict';
/**
 * Finding the resolvers the machine is already configured to use.
 *
 * Node's `dns.getServers()` reads the platform's own configuration
 * (/etc/resolv.conf on Linux, the system resolver configuration on macOS), so
 * the benchmark can compare "what you use now" against the public catalog —
 * which is the comparison GRC's tool is built around.
 *
 * On macOS an encrypted-DNS profile (or iCloud Private Relay) can mean the
 * addresses the system hands out are not the ones doing the resolving. The
 * benchmark states what it found rather than guessing; a resolver reported
 * here is one the application can address directly.
 */

const dns = require('node:dns');
const fs = require('node:fs');
const os = require('node:os');

function normalize(address) {
  // IPv6 addresses may arrive bracketed or with a zone index.
  return String(address).replace(/^\[|\]$/g, '').split('%')[0];
}

function fromResolvConf() {
  try {
    const text = fs.readFileSync('/etc/resolv.conf', 'utf8');
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*nameserver\s+(\S+)/i.exec(line);
      if (match) out.push(normalize(match[1]));
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * @returns {{id:string,label:string,transport:string,host:string,ip:string,port:number,isSystem:boolean,primary:boolean}[]}
 */
function detectSystemResolvers(options = {}) {
  let addresses = [];
  try {
    addresses = dns.getServers() || [];
  } catch {
    addresses = [];
  }
  if (addresses.length === 0 && os.platform() !== 'win32') {
    addresses = fromResolvConf();
  }

  const seen = new Set();
  const out = [];
  for (const raw of addresses) {
    const address = normalize(raw);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    out.push(address);
  }

  return out.map((ip, index) => ({
    id: `system-${ip}`,
    label: `System resolver ${ip}${index === 0 ? ' (primary)' : ''}`,
    transport: 'udp',
    host: ip,
    ip,
    port: options.port || 53,
    isSystem: true,
    primary: index === 0,
    operator: 'Configured on this Mac',
  }));
}

module.exports = { detectSystemResolvers, normalize };
