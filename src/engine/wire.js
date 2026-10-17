'use strict';
/**
 * Minimal DNS wire-format codec (RFC 1035 + EDNS0 / RFC 6891).
 *
 * ResolverBench does its own DNS encoding instead of using Node's resolver
 * helpers (dns.resolve4 and friends) for two reasons:
 *
 *   1. `dns.resolve*` always talks to the *system* resolver. A benchmark has to
 *      address each nameserver under test directly.
 *   2. We need the raw message: rcode, flags (AD/TD), the OPT record, and the
 *      question the server actually answered.
 *
 * Everything here is pure: buffers in, plain objects out. No sockets, no state.
 */

const TYPE = Object.freeze({
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  OPT: 41,
  DS: 43,
  RRSIG: 46,
  NSEC: 47,
  DNSKEY: 48,
});

const TYPE_NAME = Object.freeze(
  Object.fromEntries(Object.entries(TYPE).map(([k, v]) => [v, k])),
);

const RCODE_NAME = Object.freeze({
  0: 'NOERROR',
  1: 'FORMERR',
  2: 'SERVFAIL',
  3: 'NXDOMAIN',
  4: 'NOTIMP',
  5: 'REFUSED',
  6: 'YXDOMAIN',
  7: 'YXRRSET',
  8: 'NXRRSET',
  9: 'NOTAUTH',
  10: 'NOTZONE',
});

const CLASS_IN = 1;

let idCounter = Math.floor(Math.random() * 0xffff);

/** Monotonically advancing (not purely random) query ID, never 0 on wrap. */
function nextId() {
  idCounter = (idCounter + 1) & 0xffff;
  if (idCounter === 0) idCounter = 1;
  return idCounter;
}

/** Encode a domain name into length-prefixed labels (no compression). */
function encodeName(name) {
  const clean = String(name).replace(/\.$/, '');
  if (clean === '') return Buffer.from([0]);
  const chunks = [];
  for (const label of clean.split('.')) {
    const bytes = Buffer.from(label, 'ascii');
    if (bytes.length === 0) throw new Error(`empty label in name: ${name}`);
    if (bytes.length > 63) throw new Error(`label longer than 63 bytes: ${label}`);
    chunks.push(Buffer.from([bytes.length]), bytes);
  }
  chunks.push(Buffer.from([0]));
  const out = Buffer.concat(chunks);
  if (out.length > 255) throw new Error(`name longer than 255 bytes: ${name}`);
  return out;
}

/** EDNS0 OPT pseudo-record: name=root, type=41, class=payload size, ttl=flags. */
function buildOpt(payloadSize, dnssecOk) {
  const opt = Buffer.alloc(11);
  opt.writeUInt8(0, 0); // root name
  opt.writeUInt16BE(TYPE.OPT, 1);
  opt.writeUInt16BE(payloadSize, 3);
  // TTL field = extended-rcode(8) | version(8) | DO(1) | Z(15)
  opt.writeUInt32BE(dnssecOk ? 0x00008000 : 0x00000000, 5);
  opt.writeUInt16BE(0, 9); // rdlength
  return opt;
}

/**
 * Build a standard recursive query.
 * @returns {{id:number, buf:Buffer, name:string, type:number}}
 */
function buildQuery(options = {}) {
  const {
    name,
    type = TYPE.A,
    id = nextId(),
    rd = true,
    edns = true,
    ednsPayload = 1232,
    dnssecOk = false,
  } = options;
  if (!name) throw new Error('buildQuery requires a name');

  const question = Buffer.concat([encodeName(name), u16(type), u16(CLASS_IN)]);
  const additionals = edns ? [buildOpt(ednsPayload, dnssecOk)] : [];

  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(rd ? 0x0100 : 0x0000, 2);
  header.writeUInt16BE(1, 4); // qdcount
  header.writeUInt16BE(0, 6); // ancount
  header.writeUInt16BE(0, 8); // nscount
  header.writeUInt16BE(additionals.length, 10); // arcount

  return {
    id,
    name,
    type,
    buf: Buffer.concat([header, question, ...additionals]),
  };
}

function u16(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value >>> 0, 0);
  return b;
}

/**
 * Decode a (possibly compressed) domain name.
 * @returns {{name:string, offset:number}} offset = first byte after the name.
 */
function decodeName(buf, offset) {
  const labels = [];
  let pos = offset;
  let after = offset;
  let jumped = false;
  let hops = 0;
  const seen = new Set();

  for (;;) {
    if (pos >= buf.length) throw new Error('name runs past end of message');
    const len = buf[pos];

    if (len === 0) {
      pos += 1;
      if (!jumped) after = pos;
      break;
    }

    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error('truncated compression pointer');
      const ptr = ((len & 0x3f) << 8) | buf[pos + 1];
      if (!jumped) after = pos + 2;
      jumped = true;
      if (seen.has(ptr)) throw new Error('compression pointer loop');
      seen.add(ptr);
      hops += 1;
      if (hops > 64) throw new Error('too many compression pointers');
      pos = ptr;
      continue;
    }

    if ((len & 0xc0) !== 0) {
      throw new Error(`unsupported label length 0x${len.toString(16)}`);
    }
    if (pos + 1 + len > buf.length) throw new Error('truncated label');
    labels.push(buf.toString('latin1', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }

  return { name: labels.join('.'), offset: after };
}

function formatV6(bytes) {
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i] << 8) | bytes[i + 1]);
  // longest run of zero groups (length >= 2) collapses to "::"
  let bestStart = -1;
  let bestLen = 0;
  let start = -1;
  for (let i = 0; i <= groups.length; i += 1) {
    if (i < groups.length && groups[i] === 0) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const len = i - start;
      if (len > bestLen) {
        bestLen = len;
        bestStart = start;
      }
      start = -1;
    }
  }
  if (bestLen < 2) return groups.map((g) => g.toString(16)).join(':');
  const head = groups.slice(0, bestStart).map((g) => g.toString(16)).join(':');
  const tail = groups
    .slice(bestStart + bestLen)
    .map((g) => g.toString(16))
    .join(':');
  return `${head}::${tail}`;
}

function decodeRdata(buf, type, rdStart, rdlen) {
  const end = rdStart + rdlen;
  if (end > buf.length) throw new Error('rdata runs past end of message');

  switch (type) {
    case TYPE.A:
      if (rdlen !== 4) return { kind: 'raw', hex: buf.toString('hex', rdStart, end) };
      return {
        kind: 'A',
        address: `${buf[rdStart]}.${buf[rdStart + 1]}.${buf[rdStart + 2]}.${buf[rdStart + 3]}`,
      };
    case TYPE.AAAA:
      if (rdlen !== 16) return { kind: 'raw', hex: buf.toString('hex', rdStart, end) };
      return { kind: 'AAAA', address: formatV6(buf.subarray(rdStart, end)) };
    case TYPE.CNAME:
    case TYPE.NS:
    case TYPE.PTR: {
      const { name } = decodeName(buf, rdStart);
      return { kind: TYPE_NAME[type], name };
    }
    case TYPE.SOA: {
      const { name: mname, offset: o1 } = decodeName(buf, rdStart);
      const { name: rname, offset: o2 } = decodeName(buf, o1);
      if (o2 + 20 > buf.length) return { kind: 'SOA', mname, rname };
      return {
        kind: 'SOA',
        mname,
        rname,
        serial: buf.readUInt32BE(o2),
        refresh: buf.readUInt32BE(o2 + 4),
        retry: buf.readUInt32BE(o2 + 8),
        expire: buf.readUInt32BE(o2 + 12),
        minimum: buf.readUInt32BE(o2 + 16),
      };
    }
    case TYPE.TXT: {
      const parts = [];
      let p = rdStart;
      while (p < end) {
        const len = buf[p];
        p += 1;
        if (p + len > end) break;
        parts.push(buf.toString('utf8', p, p + len));
        p += len;
      }
      return { kind: 'TXT', text: parts.join('') };
    }
    case TYPE.OPT:
      return { kind: 'OPT', payloadSize: 0, doBit: false, extRcode: 0 };
    default:
      return { kind: TYPE_NAME[type] || `TYPE${type}`, hex: buf.toString('hex', rdStart, end) };
  }
}

/** Parse a complete DNS response into a plain object. Throws on malformed input. */
function parseMessage(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error('parseMessage requires a Buffer');
  if (buf.length < 12) throw new Error(`message shorter than a DNS header (${buf.length} bytes)`);

  const flags = buf.readUInt16BE(2);
  const msg = {
    id: buf.readUInt16BE(0),
    qr: (flags >> 15) & 1,
    opcode: (flags >> 11) & 0x0f,
    aa: (flags >> 10) & 1,
    tc: (flags >> 9) & 1,
    rd: (flags >> 8) & 1,
    ra: (flags >> 7) & 1,
    z: (flags >> 6) & 1,
    ad: (flags >> 5) & 1,
    cd: (flags >> 4) & 1,
    rcode: flags & 0x0f,
    questions: [],
    answers: [],
    authority: [],
    additional: [],
    payloadSize: 0,
    doBit: false,
    extRcode: 0,
  };

  const qdCount = buf.readUInt16BE(4);
  const anCount = buf.readUInt16BE(6);
  const nsCount = buf.readUInt16BE(8);
  const arCount = buf.readUInt16BE(10);

  let off = 12;

  for (let i = 0; i < qdCount; i += 1) {
    const { name, offset } = decodeName(buf, off);
    off = offset;
    if (off + 4 > buf.length) throw new Error('truncated question section');
    msg.questions.push({
      name,
      type: buf.readUInt16BE(off),
      class: buf.readUInt16BE(off + 2),
    });
    off += 4;
  }

  const readSection = (count, target) => {
    for (let i = 0; i < count; i += 1) {
      const { name, offset } = decodeName(buf, off);
      off = offset;
      if (off + 10 > buf.length) throw new Error('truncated resource record');
      const type = buf.readUInt16BE(off);
      const rrClass = buf.readUInt16BE(off + 2);
      const ttl = buf.readUInt32BE(off + 4);
      const rdlen = buf.readUInt16BE(off + 8);
      const rdStart = off + 10;
      if (rdStart + rdlen > buf.length) throw new Error('truncated rdata');

      if (type === TYPE.OPT) {
        msg.payloadSize = rrClass;
        msg.extRcode = (ttl >>> 24) & 0xff;
        msg.doBit = ((ttl >>> 15) & 1) === 1;
      }

      target.push({
        name,
        type,
        typeName: TYPE_NAME[type] || `TYPE${type}`,
        class: rrClass,
        ttl,
        data: decodeRdata(buf, type, rdStart, rdlen),
      });
      off = rdStart + rdlen;
    }
  };

  readSection(anCount, msg.answers);
  readSection(nsCount, msg.authority);
  readSection(arCount, msg.additional);

  msg.rcodeFull = (msg.extRcode << 4) | msg.rcode;
  msg.rcodeName = RCODE_NAME[msg.rcodeFull] || `RCODE${msg.rcodeFull}`;
  return msg;
}

/** A records from the answer section, in order. */
function addressesOf(msg, type) {
  const wanted = type === undefined ? [TYPE.A, TYPE.AAAA] : [type];
  const out = [];
  for (const rr of msg.answers) {
    if (wanted.includes(rr.type) && rr.data && rr.data.address) out.push(rr.data.address);
  }
  return out;
}

/** True when the response carries a usable answer (NOERROR + at least one address). */
function isResolved(msg) {
  return msg.rcodeFull === 0 && addressesOf(msg).length > 0;
}

/** Everything an operator wants to know about a failed exchange. */
function describeResponse(msg) {
  return {
    rcode: msg.rcodeFull,
    rcodeName: msg.rcodeName,
    answers: msg.answers.length,
    truncated: msg.tc === 1,
    ad: msg.ad === 1,
    ra: msg.ra === 1,
    aa: msg.aa === 1,
  };
}

module.exports = {
  TYPE,
  TYPE_NAME,
  RCODE_NAME,
  CLASS_IN,
  buildQuery,
  buildOpt,
  encodeName,
  decodeName,
  parseMessage,
  addressesOf,
  isResolved,
  describeResponse,
  nextId,
};
