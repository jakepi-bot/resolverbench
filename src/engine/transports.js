'use strict';
/**
 * Transports: one query in, one timed response out.
 *
 * Four transports are implemented, all speaking raw DNS messages so the
 * measurements are comparable:
 *
 *   udp   - classic DNS over UDP/53 (falls back to TCP when the reply is
 *           truncated, and says so)
 *   tcp   - DNS over TCP/53, length-prefixed (RFC 1035 4.2.2)
 *   dot   - DNS over TLS/853, length-prefixed (RFC 7858)
 *   doh   - DNS over HTTPS, wire format body (RFC 8484), POST or GET
 *
 * Every client exposes the same shape:
 *
 *   open()  -> { setupMs }   cost paid before the first question can be asked
 *                            (TCP+TLS handshake for doT, socket bind for udp)
 *   query() -> { ms, rcode, addresses, ... } or { error }
 *   close()
 *
 * `query()` never throws and never returns undefined: a failure is a result
 * with an `error` field, because reliability (lost replies) is one of the
 * things being measured, not an exception.
 *
 * Timing is measured with a monotonic clock around the write/read pair, so a
 * slow timer callback does not inflate a sample.
 */

const dgram = require('node:dgram');
const net = require('node:net');
const tls = require('node:tls');
const https = require('node:https');
const http2 = require('node:http2');
const wire = require('./wire');

const now = () => Number(process.hrtime.bigint()) / 1e6;

const DEFAULT_TIMEOUT = 1200;

/** Wall-clock reading of a finished exchange, in milliseconds. */
function elapsed(started) {
  return Math.round((now() - started) * 100) / 100;
}

function classifyError(err) {
  const code = err && err.code;
  if (err && err.message === 'timeout') return 'timeout';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'unreachable';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'reset';
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return `tls-${String(code).toLowerCase()}`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns-lookup-failed';
  return code ? String(code).toLowerCase() : (err && err.message) || 'error';
}

/** Fold a parsed DNS message into the uniform query result. */
function resultFromMessage(msg, id, started, extra = {}) {
  const addresses = wire.addressesOf(msg);
  const mismatch = id !== undefined && msg.id !== id;
  if (mismatch) return { ms: elapsed(started), error: 'id-mismatch', ...extra };
  return {
    ms: elapsed(started),
    rcode: msg.rcodeFull,
    rcodeName: msg.rcodeName,
    addresses,
    answers: msg.answers.length,
    authority: msg.authority.length,
    truncated: msg.tc === 1,
    ad: msg.ad === 1,
    ra: msg.ra === 1,
    aa: msg.aa === 1,
    ...extra,
  };
}

/* ------------------------------------------------------------------ UDP --- */

class UdpClient {
  constructor(server, options = {}) {
    this.server = server;
    this.host = server.ip || server.host;
    this.port = server.port || 53;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
    this.family = net.isIPv6(this.host) ? 6 : 4;
    this.transport = 'udp';
    this.received = 0;
    this.tcpFallbacks = 0;
    this.socket = null;
    this.pending = null;
    this.tcp = null;
  }

  async open() {
    const started = now();
    await new Promise((resolve, reject) => {
      const socket = dgram.createSocket(this.family === 6 ? 'udp6' : 'udp4');
      socket.on('error', (err) => {
        socket.close();
        reject(err);
      });
      socket.on('message', (buf) => this._onMessage(buf));
      socket.bind({ address: this.family === 6 ? '::' : '0.0.0.0', port: 0 }, () => {
        try {
          socket.connect(this.port, this.host);
        } catch (err) {
          socket.close();
          reject(err);
          return;
        }
        this.socket = socket;
        resolve();
      });
    });
    return { setupMs: elapsed(started) };
  }

  _onMessage(buf) {
    this.received += 1;
    const pending = this.pending;
    if (!pending) return;
    // On a connected socket only the peer can send to us, but a late reply for
    // an earlier question is still possible; anything that is not the answer to
    // the outstanding query is dropped without disturbing the timer.
    if (buf.length < 2 || buf.readUInt16BE(0) !== pending.id) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve(resultFromMessage(safeParse(buf, pending), pending.id, pending.started));
  }

  async query(name, options = {}) {
    const q = wire.buildQuery({
      name,
      type: options.type ?? wire.TYPE.A,
      dnssecOk: !!options.dnssecOk,
    });
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const started = now();

    if (!this.socket) return { ms: 0, error: 'socket-closed' };

    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending && this.pending.id === q.id) this.pending = null;
        resolve({ ms: elapsed(started), error: 'timeout' });
      }, timeoutMs);
      this.pending = { id: q.id, started, resolve, timer };
      this.socket.send(q.buf, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending = null;
          resolve({ ms: elapsed(started), error: classifyError(err) });
        }
      });
    });

    // A truncated UDP reply means the answer exists but did not fit: the
    // question is re-asked over TCP, which is what any stub resolver does.
    if (outcome.truncated) {
      this.tcpFallbacks += 1;
      const tcpResult = await this._tcpQuery(q, timeoutMs);
      return { ...tcpResult, viaTcp: true, truncated: true };
    }
    return outcome;
  }

  async _tcpQuery(q, timeoutMs) {
    const started = now();
    return new Promise((resolve) => {
      const socket = net.connect({ host: this.host, port: this.port });
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(timeoutMs, () => done({ ms: elapsed(started), error: 'timeout' }));
      socket.on('error', (err) => done({ ms: elapsed(started), error: classifyError(err) }));
      socket.on('connect', () => {
        const prefix = Buffer.alloc(2);
        prefix.writeUInt16BE(q.buf.length, 0);
        socket.write(Buffer.concat([prefix, q.buf]));
      });
      let buffered = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.length < 2) return;
        const len = buffered.readUInt16BE(0);
        if (buffered.length < 2 + len) return;
        done(resultFromMessage(safeParse(buffered.subarray(2, 2 + len), q), q.id, started));
      });
    });
  }

  close() {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* already closed */
      }
      this.socket = null;
    }
  }
}

function safeParse(buf, q) {
  try {
    return wire.parseMessage(buf);
  } catch (err) {
    return {
      id: q && q.id,
      rcodeFull: -1,
      rcodeName: 'MALFORMED',
      answers: [],
      authority: [],
      additional: [],
      tc: 0,
      ad: 0,
      ra: 0,
      aa: 0,
      parseError: err.message,
    };
  }
}

/* --------------------------------------------- stream transports (TCP/TLS) */

class StreamClient {
  /**
   * @param {object} server
   * @param {object} options
   * @param {boolean} options.secure  TLS (853) when true, bare TCP (53) when false
   */
  constructor(server, options = {}) {
    this.server = server;
    this.host = server.ip || server.host;
    this.port = server.port ?? (options.secure ? 853 : 53);
    this.servername = server.sni || server.host;
    this.secure = !!options.secure;
    this.transport = this.secure ? 'dot' : 'tcp';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = null;
    this.connections = 0;
    this.reconnects = 0;
    this.verifyCert = options.verifyCert === true;
  }

  async open() {
    const started = now();
    await this._connect();
    return { setupMs: elapsed(started), connections: this.connections };
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const onConnect = () => {
        this.connections += 1;
        if (this.connections > 1) this.reconnects += 1;
        this.socket = socket;
        resolve();
      };
      const socket = this.secure
        ? tls.connect({
            host: this.host,
            port: this.port,
            servername: net.isIP(this.servername) ? undefined : this.servername,
            rejectUnauthorized: this.verifyCert,
            ALPNProtocols: ['dot'],
          })
        : net.connect({ host: this.host, port: this.port });

      socket.setNoDelay(true);
      socket.setTimeout(0);

      const fail = (err) => {
        socket.removeAllListeners();
        socket.destroy();
        reject(err);
      };

      socket.once('error', fail);
      socket.once('close', () => {
        this.socket = null;
        if (this.pending) {
          const p = this.pending;
          this.pending = null;
          clearTimeout(p.timer);
          p.resolve({ ms: elapsed(p.started), error: 'connection-closed' });
        }
      });

      if (this.secure) {
        socket.once('secureConnect', () => onConnect());
      } else {
        socket.once('connect', () => onConnect());
      }

      socket.on('data', (chunk) => this._onData(chunk));
    });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const len = this.buffer.readUInt16BE(0);
      if (this.buffer.length < 2 + len) return;
      const message = this.buffer.subarray(2, 2 + len);
      this.buffer = this.buffer.subarray(2 + len);
      const pending = this.pending;
      if (!pending) continue;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.resolve(resultFromMessage(safeParse(message, pending.q), pending.q.id, pending.started));
    }
  }

  async query(name, options = {}) {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    if (!this.socket) {
      // The server hung up between questions; reconnecting is part of what we
      // are measuring, so try once and report the reconnect in the result.
      try {
        await this._connect();
      } catch (err) {
        return { ms: 0, error: classifyError(err) };
      }
    }
    if (this.pending) return { ms: 0, error: 'busy' };

    const q = wire.buildQuery({
      name,
      type: options.type ?? wire.TYPE.A,
      dnssecOk: !!options.dnssecOk,
    });
    const started = now();

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending && this.pending.q.id === q.id) {
          this.pending = null;
          // A timed-out stream connection is discarded: a half-read response
          // would corrupt the framing of the next question.
          if (this.socket) {
            this.socket.destroy();
            this.socket = null;
          }
        }
        resolve({ ms: elapsed(started), error: 'timeout' });
      }, timeoutMs);

      this.pending = { q, started, resolve, timer };
      const prefix = Buffer.alloc(2);
      prefix.writeUInt16BE(q.buf.length, 0);
      this.socket.write(Buffer.concat([prefix, q.buf]), (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending = null;
          resolve({ ms: elapsed(started), error: classifyError(err) });
        }
      });
    });
  }

  close() {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}

class DotClient extends StreamClient {
  constructor(server, options = {}) {
    super(server, { ...options, secure: true, port: server.port ?? 853 });
  }
}

class TcpClient extends StreamClient {
  constructor(server, options = {}) {
    super(server, { ...options, secure: false, port: server.port ?? 53 });
  }
}

/* ------------------------------------------------------------------ DoH --- */

class DohClient {
  constructor(server, options = {}) {
    const url = new URL(server.url || server.host);
    this.server = server;
    this.url = url;
    this.transport = 'doh';
    this.method = (server.method || options.method || 'POST').toUpperCase();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
    this.requests = 0;
    this.connections = 0;
    this.errors = 0;
    // Some DoH services refuse HTTP/1.1 outright (Quad9, Applied Privacy and
    // CZ.NIC answer 505 to an h1 POST) and one (Mullvad) accepts only GET over
    // h2. Both are detected from the response rather than hard-coded per
    // endpoint, so a service that changes its mind keeps working.
    this.preferH2 = options.preferH2 === true;
    this.http2Session = null;
    this.protocol = 'h1';
    this.h2Attempted = false;

    const pinned = server.ip || null;
    this.pinned = pinned;
    const agentOptions = {
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 1,
      maxFreeSockets: 1,
    };
    if (pinned) {
      // Resolve the endpoint name to the resolver's own address so the
      // measurement is of the resolver, not of whichever CDN edge the local
      // system resolver happened to pick. SNI and Host keep the real name.
      //
      // `all: true` is what Node passes when happy-eyeballs (autoSelectFamily)
      // is on: the callback must then return an array, and returning a bare
      // string there fails the request with ERR_INVALID_IP_ADDRESS.
      agentOptions.lookup = (hostname, opts, cb) => {
        const family = net.isIPv6(pinned) ? 6 : 4;
        if (opts && opts.all) {
          cb(null, [{ address: pinned, family }]);
          return;
        }
        cb(null, pinned, family);
      };
      agentOptions.autoSelectFamily = false;
    }
    this.agent = new https.Agent(agentOptions);
    const originalCreate = this.agent.createConnection.bind(this.agent);
    this.agent.createConnection = (...args) => {
      this.connections += 1;
      return originalCreate(...args);
    };
  }

  async open() {
    // Nothing to establish up front: the first query pays for TCP+TLS+HTTP and
    // that cost is reported as the resolver's setup time.
    return { setupMs: null };
  }

  /**
   * Send one query, negotiating the HTTP version and method the endpoint
   * actually accepts. A refusal (505 = HTTP version not supported, 405/415/501
   * = method not allowed) is retried once with the other option and then
   * remembered, because paying that retry on every sample would pollute the
   * timings.
   */
  async query(name, options = {}) {
    if (this.preferH2) {
      const viaH2 = await this._queryH2(name, options);
      if (!viaH2.protocolError) return viaH2;
      this.preferH2 = false;
      this._dropSession();
    }

    const result = await this._queryH1(name, options);

    // Two shapes of "not over HTTP/1.1": a status code (Quad9, Applied Privacy
    // and CZ.NIC answer 505; a few answer 426) or the connection being dropped
    // outright (Mullvad resets an h1 connection). Either way, try h2 once, and
    // only once per client so a genuinely dead endpoint does not pay for a
    // second attempt on every sample.
    const dropped = ['reset', 'connection-closed', 'refused', 'unreachable'].includes(result.error);
    const wantsH2 = result.httpStatus === 505 || result.httpStatus === 426 || (dropped && !this.h2Attempted);

    if (wantsH2) {
      this.h2Attempted = true;
      const h2 = await this._queryH2(name, options);
      if (!h2.error) {
        this.preferH2 = true;
        this.protocol = 'h2';
        return { ...h2, upgraded: 'http2' };
      }
      // If h1 failed on a status, the h2 error is the more informative one;
      // if h1 failed at the connection level, keep the original reason.
      return result.httpStatus === undefined ? { ...result, h2Error: h2.error } : h2;
    }

    if ([400, 405, 415, 501].includes(result.httpStatus) && this.method === 'POST') {
      // GET carries the query in the URL (?dns=<base64url>), which some
      // endpoints require.
      this.method = 'GET';
      const retried = await this._queryH1(name, options);
      if (!retried.error) return { ...retried, upgraded: 'get' };
      this.method = 'POST';
      return retried;
    }

    return result;
  }

  _queryH1(name, options = {}) {
    let q;
    try {
      q = wire.buildQuery({
        name,
        type: options.type ?? wire.TYPE.A,
        dnssecOk: !!options.dnssecOk,
      });
    } catch (err) {
      return Promise.resolve({ ms: 0, error: `encode:${err.message}` });
    }

    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    let path = `${this.url.pathname}${this.url.search || ''}`;
    const headers = { accept: 'application/dns-message' };
    let body = null;

    if (this.method === 'GET') {
      path += `${path.includes('?') ? '&' : '?'}dns=${q.buf.toString('base64url')}`;
    } else {
      body = q.buf;
      headers['content-type'] = 'application/dns-message';
      headers['content-length'] = String(body.length);
    }

    const started = now();
    const firstRequest = this.requests === 0;
    this.requests += 1;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const req = https.request(
        {
          hostname: this.url.hostname,
          port: this.url.port || 443,
          path,
          method: this.method,
          headers,
          agent: this.agent,
          autoSelectFamily: false,
          servername: net.isIP(this.url.hostname) ? undefined : this.url.hostname,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const ms = elapsed(started);
            const ctype = String(res.headers['content-type'] || '').toLowerCase();
            if (res.statusCode !== 200) {
              this.errors += 1;
              finish({ ms, error: `http-${res.statusCode}`, httpStatus: res.statusCode, cold: firstRequest });
              return;
            }
            if (!ctype.includes('application/dns-message')) {
              this.errors += 1;
              finish({ ms, error: `content-type:${ctype.split(';')[0] || 'none'}`, cold: firstRequest });
              return;
            }
            const msg = safeParse(Buffer.concat(chunks), q);
            finish({ ...resultFromMessage(msg, q.id, started), cold: firstRequest, via: this.method, protocol: 'h1' });
          });
          res.on('error', (err) => {
            this.errors += 1;
            finish({ ms: elapsed(started), error: classifyError(err), cold: firstRequest });
          });
        },
      );

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error('timeout'));
      });
      req.on('error', (err) => {
        this.errors += 1;
        finish({ ms: elapsed(started), error: classifyError(err), cold: firstRequest });
      });

      if (body) req.write(body);
      req.end();
    });
  }

  /** A kept-alive HTTP/2 session, pinned to the resolver's address when known. */
  _session() {
    if (this.http2Session && !this.http2Session.closed && !this.http2Session.destroyed) {
      return this.http2Session;
    }
    const origin = `${this.url.protocol}//${this.url.host}`;
    const options = {
      servername: net.isIP(this.url.hostname) ? undefined : this.url.hostname,
      rejectUnauthorized: this.verifyCert === true,
    };
    if (this.pinned) {
      options.lookup = (hostname, opts, cb) => {
        const family = net.isIPv6(this.pinned) ? 6 : 4;
        if (opts && opts.all) cb(null, [{ address: this.pinned, family }]);
        else cb(null, this.pinned, family);
      };
      options.autoSelectFamily = false;
    }
    this.connections += 1;
    const session = http2.connect(origin, options);
    session.setTimeout(0);
    session.on('error', () => this._dropSession());
    session.on('goaway', () => this._dropSession());
    session.on('close', () => {
      if (this.http2Session === session) this.http2Session = null;
    });
    this.http2Session = session;
    return session;
  }

  _dropSession() {
    const session = this.http2Session;
    this.http2Session = null;
    if (session) {
      try {
        session.destroy();
      } catch {
        /* already gone */
      }
    }
  }

  _queryH2(name, options = {}) {
    let q;
    try {
      q = wire.buildQuery({
        name,
        type: options.type ?? wire.TYPE.A,
        dnssecOk: !!options.dnssecOk,
      });
    } catch (err) {
      return Promise.resolve({ ms: 0, error: `encode:${err.message}`, protocol: 'h2' });
    }

    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const basePath = `${this.url.pathname}${this.url.search || ''}`;
    const started = now();
    const firstRequest = this.requests === 0;
    this.requests += 1;

    const send = (method) => {
      const path = method === 'GET'
        ? `${basePath}${basePath.includes('?') ? '&' : '?'}dns=${q.buf.toString('base64url')}`
        : basePath;
      const headers = { ':method': method, ':path': path, accept: 'application/dns-message' };
      if (method === 'POST') {
        headers['content-type'] = 'application/dns-message';
        headers['content-length'] = String(q.buf.length);
      }
      return { path, headers, body: method === 'POST' ? q.buf : null };
    };

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve({ protocol: 'h2', ...result });
      };

      let session;
      try {
        session = this._session();
      } catch (err) {
        finish({ ms: elapsed(started), error: `h2-connect:${err.message}`, protocolError: true });
        return;
      }

      const attempt = (method, allowGetFallback) => {
        const { headers, body } = send(method);
        let req;
        try {
          req = session.request(headers);
        } catch (err) {
          finish({ ms: elapsed(started), error: `h2-request:${err.message}`, protocolError: true, cold: firstRequest });
          return;
        }

        const timer = setTimeout(() => {
          try {
            req.close(http2.constants.NGHTTP2_CANCEL);
          } catch {
            /* stream already closed */
          }
          this._dropSession();
          finish({ ms: elapsed(started), error: 'timeout', cold: firstRequest });
        }, timeoutMs);

        let status = 0;
        const chunks = [];
        req.on('response', (responseHeaders) => {
          status = Number(responseHeaders[':status']) || 0;
        });
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          clearTimeout(timer);
          const ms = elapsed(started);
          if (status !== 200) {
            this.errors += 1;
            if (allowGetFallback && [400, 405, 415, 501].includes(status)) {
              attempt('GET', false);
              return;
            }
            finish({ ms, error: `http-${status}`, httpStatus: status, cold: firstRequest });
            return;
          }
          const msg = safeParse(Buffer.concat(chunks), q);
          finish({ ...resultFromMessage(msg, q.id, started), cold: firstRequest, via: method });
        });
        req.on('error', (err) => {
          clearTimeout(timer);
          // A stream error is not necessarily a transport failure; a GOAWAY or
          // a dead session is.
          const fatal = ['ERR_HTTP2_GOAWAY_SESSION', 'ERR_HTTP2_SESSION_ERROR', 'ECONNRESET', 'EPIPE'].includes(err.code);
          if (fatal) this._dropSession();
          this.errors += 1;
          finish({
            ms: elapsed(started),
            error: `h2:${err.code || err.message}`,
            protocolError: fatal,
            cold: firstRequest,
          });
        });

        if (body) req.end(body);
        else req.end();
      };

      attempt(this.method, true);
    });
  }

  close() {
    this._dropSession();
    this.agent.destroy();
  }
}

/* -------------------------------------------------------------- factory --- */

const TRANSPORTS = Object.freeze(['udp', 'tcp', 'dot', 'doh']);

/**
 * One question in flight per resolver, ever.
 *
 * Two concurrent questions on one connection would make each one's round-trip
 * time include the other's queueing delay, which is not latency to that
 * resolver at all — and on a client with a single in-flight slot the second
 * call would silently replace the first. Callers may therefore fire a batch
 * (the timed phase does, three metrics at once) and the questions are answered
 * in order instead of colliding.
 */
function serializeQueries(client) {
  let chain = Promise.resolve();
  const original = client.query.bind(client);
  client.query = (name, options) => {
    const run = () => original(name, options);
    const next = chain.then(run, run);
    chain = next.then(
      () => {},
      () => {},
    );
    return next;
  };
  return client;
}

function createClient(server, options = {}) {
  switch (server.transport) {
    case 'udp':
      return serializeQueries(new UdpClient(server, options));
    case 'tcp':
      return serializeQueries(new TcpClient(server, options));
    case 'dot':
      return serializeQueries(new DotClient(server, options));
    case 'doh':
      return serializeQueries(new DohClient(server, options));
    default:
      throw new Error(`unknown transport: ${server.transport}`);
  }
}

module.exports = {
  createClient,
  TRANSPORTS,
  UdpClient,
  TcpClient,
  DotClient,
  DohClient,
  classifyError,
  DEFAULT_TIMEOUT,
};
